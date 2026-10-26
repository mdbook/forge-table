package forge.bridge.proj;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import forge.card.CardStateName;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.card.CardView.CardStateView;
import forge.game.combat.CombatView;
import forge.game.player.PlayerView;
import forge.game.spellability.StackItemView;
import forge.trackable.TrackableProperty;
import forge.util.collect.FCollection;

/**
 * Projects a {@link GameView} into the JSON model one viewer is allowed to see, and diffs it against what
 * was last sent.
 *
 * <p><b>Client ids.</b> Every card the viewer can see gets a string id. A face-up card, or a face-down card
 * whose face the viewer may see, is {@code "c<id>"}. A face-down card the viewer may not identify is
 * {@code "f<hiddenId>"}, so its real id never leaves the server. A card in a hidden zone (library, an
 * opponent's hand, face-down exile) has no card object at all: its zone lists it under an opaque id
 * ({@code "x…"}) that is re-randomized whenever it enters a zone and when its library is shuffled.
 *
 * <p><b>Diffing.</b> The projector rebuilds the full model and compares each object with its last-sent
 * JSON, so a lost dirty bit can never desynchronize the client. That's a full rebuild per event; the
 * per-consumer dirty sets on {@code TrackableObject} are the planned optimization if it is too slow.
 *
 * <p>Not thread-safe: the {@code Outbox} serializes all calls under its lock.
 */
public final class ViewProjector {

    /** CardView properties a viewer may see on a face-down card it cannot identify. */
    private static final Set<TrackableProperty> FACE_DOWN_PUBLIC = EnumSet.of(
            TrackableProperty.Owner, TrackableProperty.Controller, TrackableProperty.Zone,
            TrackableProperty.Facedown, TrackableProperty.FacedownImageKey, TrackableProperty.HiddenId,
            TrackableProperty.Tapped, TrackableProperty.Sickness, TrackableProperty.Attacking,
            TrackableProperty.Blocking, TrackableProperty.PhasedOut, TrackableProperty.Damage,
            TrackableProperty.AssignedDamage, TrackableProperty.LethalDamage, TrackableProperty.ShieldCount,
            TrackableProperty.PreventNextDamage, TrackableProperty.Counters, TrackableProperty.AttachedCards,
            TrackableProperty.EntityAttachedTo, TrackableProperty.ExertedThisTurn, TrackableProperty.Detained,
            TrackableProperty.PlayerMayLook, TrackableProperty.GamePieceType);

    private static final Set<TrackableProperty> NOT_ON_FACE_DOWN;
    static {
        final EnumSet<TrackableProperty> all = EnumSet.allOf(TrackableProperty.class);
        all.removeAll(FACE_DOWN_PUBLIC);
        NOT_ON_FACE_DOWN = all;
    }

    private final PlayerView viewer;
    private final SecureRandom random = new SecureRandom();

    /** Opaque slot ids for cards in hidden zones: real id -> (zone key, opaque id). */
    private final Map<Integer, String[]> opaque = new HashMap<>();

    // Last-sent mirror.
    private JsonObject lastGame = new JsonObject();
    private final Map<String, JsonObject> lastPlayers = new LinkedHashMap<>();
    private final Map<String, JsonObject> lastCards = new LinkedHashMap<>();
    private final Map<String, CardView> cardsByClientId = new HashMap<>();
    private final Map<Integer, String> clientIdByCard = new HashMap<>();

    /**
     * The id a card had before its id last changed (e.g. the hidden library slot a drawn card left), kept
     * until a change-zone beat consumes it. Settles from other threads may carry a move before the engine's
     * change-zone event, so "the id before this beat" is not reliable on its own.
     */
    private final Map<Integer, String> priorIds = new HashMap<>();

    /**
     * The last id of each card a pass did not see at all. A move is two zone updates (out of the library, into the
     * hand), so a settle from another thread can land between them and find the card in no zone; when it shows up
     * again its new id must still know the old one (else a draw beat goes out with a null {@code fromId}).
     */
    private final Map<Integer, String> limbo = new HashMap<>();

    /**
     * Cards in an opponent's hand that were revealed to the viewer (Forge's reveal: Thoughtseize, Duress, a card
     * revealed as a cost…): shown face up there until they leave the hand (the opponent's hand view). Forge's
     * own rule ({@code canBeShownTo}) forgets a reveal at once.
     */
    private final Set<Integer> revealedInHand = new java.util.HashSet<>();

    /**
     * The viewer's own hand cards that an opponent currently knows about (reveal, Duress-style look,
     * revealed-top, etc.; the inverse of {@link #revealedInHand}). Forgotten once the card leaves the
     * viewer's hand, same as the engine itself forgets a reveal at once.
     */
    private final Set<Integer> revealedToOpponent = new java.util.HashSet<>();

    /**
     * Cards in a library the viewer knows (an opponent reveals a card and puts it on top): revealed there, or put
     * on top as the only card a resolution put into that library, known when it went in (see {@link #onResolved}).
     * Card id -> that library's zone key; forgotten when the library is shuffled, the card moves within it (a scry or
     * a reorder must not show the owner's hidden choice) or leaves it.
     */
    private final Map<Integer, String> knownInLibrary = new HashMap<>();

    /** Cards revealed to the viewer since the last spell or ability resolved. */
    private final Set<Integer> revealedRecently = new java.util.HashSet<>();

    /** Cards put into each library (zone key) since the last resolution, in order, and the library's player. */
    private final Map<String, List<Integer>> enteredLibrary = new HashMap<>();
    private final Map<String, PlayerView> libraryOwners = new HashMap<>();

    /** Of those, the cards the viewer knew as they went in. */
    private final Set<Integer> enteredKnown = new java.util.HashSet<>();

    /** Cards seen entering the stack before their stack item exists (the engine adds it afterwards). */
    private final Map<Integer, CardView> enteringStack = new HashMap<>();

    // Per-pass scratch.
    private final Map<Integer, String> passIds = new HashMap<>();
    private final ViewCodec.Refs refs = card -> card == null ? null : passIds.get(card.getId());

    public ViewProjector(final PlayerView viewer) {
        this.viewer = viewer;
    }

    public PlayerView getViewer() {
        return viewer;
    }

    /** The client id the viewer last received for {@code card}, if any (visible or opaque). */
    public String clientId(final CardView card) {
        return card == null ? null : clientIdByCard.get(card.getId());
    }

    /** The id {@code card} had before its last id change, consumed by the change-zone beat that names it. */
    public String takePriorId(final CardView card) {
        return card == null ? null : priorIds.remove(card.getId());
    }

    /** A copy of the card-to-client-id map as last sent. */
    public Map<Integer, String> copyClientIds() {
        return new HashMap<>(clientIdByCard);
    }

    /** The card behind a client id the viewer was sent, or {@code null} if it is not (or no longer) valid. */
    public CardView resolve(final String clientId) {
        return cardsByClientId.get(clientId);
    }

    /** Refs that resolve to the ids in the last-sent mirror (for prompts and beats). */
    public ViewCodec.Refs sentRefs() {
        return card -> {
            if (card == null) {
                return null;
            }
            final String id = clientIdByCard.get(card.getId());
            return id != null && !id.startsWith("x") ? id : null;
        };
    }

    /** Whether the viewer was sent a card object for this client id. */
    public boolean hasCard(final String clientId) {
        return lastCards.containsKey(clientId);
    }

    /** A card just moved to the stack; project it until its stack item (or another zone) takes over. */
    public void noteStackCard(final CardView card) {
        if (card != null) {
            enteringStack.put(card.getId(), card);
        }
    }

    /** Remember cards revealed to the viewer that sit in a hand (call under the outbox lock). */
    public void onRevealed(final Iterable<CardView> cards) {
        for (final CardView cv : cards) {
            if (cv == null) {
                continue;
            }
            revealedRecently.add(cv.getId());
            if (cv.getZone() == forge.game.zone.ZoneType.Hand) {
                revealedInHand.add(cv.getId());
            } else if (cv.getZone() == forge.game.zone.ZoneType.Library && cv.getOwner() != null) {
                knownInLibrary.put(cv.getId(), zoneKey(cv.getOwner(), "library"));
            }
        }
    }

    /** A reveal showed one of the viewer's own hand cards to someone else (call under the outbox lock). */
    public void onRevealedToOpponent(final Iterable<CardView> cards) {
        for (final CardView cv : cards) {
            if (cv != null && cv.getZone() == forge.game.zone.ZoneType.Hand && viewer != null && viewer.equals(cv.getOwner())) {
                revealedToOpponent.add(cv.getId());
            }
        }
    }

    /**
     * A card went into {@code library} (from {@code from}). It is forgotten for now; {@link #onResolved} decides. The
     * viewer knew it if it was revealed this resolution, or, coming from outside a library, identified to them (a
     * public zone, a revealed hand card). Within a library only a reveal counts: a scry or a reorder is hidden.
     */
    public void onToLibrary(final CardView card, final forge.game.zone.ZoneType from, final PlayerView library) {
        if (card == null || library == null) {
            return;
        }
        final int id = card.getId();
        final String key = zoneKey(library, "library");
        knownInLibrary.remove(id);
        enteredLibrary.computeIfAbsent(key, k -> new ArrayList<>()).add(id);
        libraryOwners.put(key, library);
        final boolean fromLibrary = from == forge.game.zone.ZoneType.Library;
        if (revealedRecently.contains(id) || !fromLibrary && (revealedInHand.contains(id) || identified(clientIdByCard.get(id))
                || identified(limbo.get(id)) || identified(priorIds.get(id)))) {
            enteredKnown.add(id);
        }
    }

    private static boolean identified(final String clientId) {
        return clientId != null && clientId.startsWith("c");
    }

    /**
     * A spell or ability resolved. A library that got exactly one card, known as it went in and now on top, keeps it
     * known (a tutor's reveal-shuffle-top, Griptide, Memory Lapse). Several cards put into one library were ordered
     * by a hidden choice, so none of them is. Its reveals no longer vouch for where cards go next.
     */
    public void onResolved() {
        enteredLibrary.forEach((key, ids) -> {
            if (ids.size() != 1 || !enteredKnown.contains(ids.get(0))) {
                return;
            }
            final List<CardView> library = zoneCards(libraryOwners.get(key), TrackableProperty.Library);
            if (!library.isEmpty() && library.get(0).getId() == ids.get(0)) {
                knownInLibrary.put(ids.get(0), key);
            }
        });
        enteredLibrary.clear();
        libraryOwners.clear();
        enteredKnown.clear();
        revealedRecently.clear();
    }

    /** Forget library slot ids (and what the viewer knew of its cards) for a player whose library was shuffled. */
    public void onShuffle(final PlayerView player) {
        final String library = zoneKey(player, "library");
        opaque.values().removeIf(v -> v[0].equals(library));
        knownInLibrary.values().removeIf(library::equals);
        enteredLibrary.remove(library);
    }

    /** Full model as last sent. */
    public JsonObject snapshot() {
        final JsonObject s = new JsonObject();
        s.add("game", lastGame.deepCopy());
        final JsonObject players = new JsonObject();
        lastPlayers.forEach((k, v) -> players.add(k, v.deepCopy()));
        s.add("players", players);
        final JsonObject cards = new JsonObject();
        lastCards.forEach((k, v) -> cards.add(k, v.deepCopy()));
        s.add("cards", cards);
        return s;
    }

    /**
     * Project {@code gv}, update the mirror, and return the patch since the last call, or {@code null}
     * if nothing visible changed. Patch shape: {@code {game?, players?: {id: obj}, cards?: {id: obj|null}}}.
     */
    public JsonObject diff(final GameView gv) {
        if (gv == null) {
            return null;
        }
        Model m = null;
        for (int attempt = 0; m == null; attempt++) {
            try {
                m = project(gv);
            } catch (final ConcurrentModificationException | NullPointerException e) {
                // The engine mutated a collection mid-walk (the projector may run off the game thread while the
                // game thread is blocked in an input, or on a helper thread). Re-walk; the state is converging.
                if (attempt >= 4) {
                    throw e;
                }
            }
        }
        final JsonObject patch = new JsonObject();
        if (!m.game.equals(lastGame)) {
            patch.add("game", m.game);
            lastGame = m.game;
        }
        final JsonObject pp = diffMap(lastPlayers, m.players);
        if (pp != null) {
            patch.add("players", pp);
        }
        final JsonObject cp = diffMap(lastCards, m.cards);
        if (cp != null) {
            patch.add("cards", cp);
        }
        cardsByClientId.clear();
        cardsByClientId.putAll(m.cardViews);
        final Map<Integer, String> previous = new HashMap<>(clientIdByCard);
        clientIdByCard.clear();
        m.cardViews.forEach((cid, cv) -> clientIdByCard.put(cv.getId(), cid));
        previous.forEach((real, old) -> {
            final String now = clientIdByCard.get(real);
            if (now == null) {
                limbo.putIfAbsent(real, old);
            } else if (!now.equals(old)) {
                priorIds.putIfAbsent(real, old); // keep the earliest id since the last consumed move
            }
        });
        clientIdByCard.forEach((real, now) -> {
            final String old = previous.containsKey(real) ? null : limbo.get(real);
            if (old != null && !old.equals(now)) {
                priorIds.putIfAbsent(real, old);
            }
        });
        limbo.keySet().removeAll(clientIdByCard.keySet());
        if (limbo.size() > 1024) {
            limbo.clear(); // cards that left the game for good (tokens, conjured copies)
        }
        priorIds.keySet().retainAll(clientIdByCard.keySet());
        return patch.size() == 0 ? null : patch;
    }

    private static JsonObject diffMap(final Map<String, JsonObject> last, final Map<String, JsonObject> now) {
        JsonObject out = null;
        for (final Map.Entry<String, JsonObject> e : now.entrySet()) {
            final JsonObject prev = last.get(e.getKey());
            if (!e.getValue().equals(prev)) {
                if (out == null) {
                    out = new JsonObject();
                }
                out.add(e.getKey(), e.getValue());
            }
        }
        for (final String k : last.keySet()) {
            if (!now.containsKey(k)) {
                if (out == null) {
                    out = new JsonObject();
                }
                out.add(k, JsonNull.INSTANCE);
            }
        }
        last.clear();
        last.putAll(now);
        return out;
    }

    private static final class Model {
        JsonObject game;
        final Map<String, JsonObject> players = new LinkedHashMap<>();
        final Map<String, JsonObject> cards = new LinkedHashMap<>();
        final Map<String, CardView> cardViews = new HashMap<>();
    }

    private Model project(final GameView gv) {
        final Model m = new Model();
        passIds.clear();
        final Map<Integer, String> seenOpaque = new HashMap<>();

        // Pass 1: assign client ids to every card in a zone, so references resolve regardless of order.
        final List<CardView> visible = new ArrayList<>();
        final Map<Integer, CardView> hidden = new HashMap<>();
        final List<PlayerView> players = new ArrayList<>();
        gv.getPlayers().forEach(players::add);
        final Set<Integer> passLibrary = new java.util.HashSet<>();
        for (final PlayerView p : players) {
            for (final TrackableProperty zone : ViewCodec.PLAYER_ZONES) {
                final String zk = zoneKey(p, ViewCodec.key(zone));
                for (final CardView cv : zoneCards(p, zone)) {
                    if (zone == TrackableProperty.Library) {
                        passLibrary.add(cv.getId());
                    }
                    final String id = assign(cv, zk, seenOpaque);
                    if (id.startsWith("x")) {
                        hidden.put(cv.getId(), cv);
                    } else {
                        visible.add(cv);
                    }
                }
            }
        }
        for (final StackItemView si : stackItems(gv)) {
            final CardView src = si.getSourceCard();
            if (src != null && !passIds.containsKey(src.getId())) {
                final String id = assign(src, "stack", seenOpaque);
                if (!id.startsWith("x")) {
                    visible.add(src);
                }
            }
        }
        for (final java.util.Iterator<CardView> it = enteringStack.values().iterator(); it.hasNext();) {
            final CardView cv = it.next();
            if (cv.getZone() != forge.game.zone.ZoneType.Stack || passIds.containsKey(cv.getId())) {
                it.remove();
                continue;
            }
            final String id = assign(cv, "stack", seenOpaque);
            if (!id.startsWith("x")) {
                visible.add(cv);
            }
        }
        opaque.keySet().retainAll(seenOpaque.keySet());
        // A revealed card that left the hand is unknown again if it ever comes back (shuffled in, drawn again).
        revealedInHand.removeIf(id -> {
            final CardView cv = handCard(players, id);
            return cv == null;
        });
        // Same rule for the inverse: a card the opponent knew about clears once it leaves the hand.
        revealedToOpponent.removeIf(id -> handCard(players, id) == null);
        knownInLibrary.keySet().retainAll(passLibrary);

        // Pass 2: encode.
        for (final CardView cv : visible) {
            final String cid = passIds.get(cv.getId());
            if (!m.cards.containsKey(cid)) {
                m.cards.put(cid, encodeCard(cv, cid));
                m.cardViews.put(cid, cv);
            }
        }
        hidden.forEach((id, cv) -> m.cardViews.put(passIds.get(id), cv));
        m.cardViews.values().removeIf(v -> v == null);
        for (final PlayerView p : players) {
            m.players.put(refs.player(p), encodePlayer(p));
        }
        m.game = encodeGame(gv);
        return m;
    }

    /** A copy of one of a player's zone lists (copied so a concurrent engine write can't break the walk). */
    static List<CardView> zoneCards(final PlayerView p, final TrackableProperty zone) {
        final Object v = p.<Map<TrackableProperty, Object>>getProps().get(zone);
        final List<CardView> out = new ArrayList<>();
        if (v instanceof Iterable<?> it) {
            for (final Object o : it) {
                if (o instanceof CardView cv) {
                    out.add(cv);
                }
            }
        }
        return out;
    }

    private static List<StackItemView> stackItems(final GameView gv) {
        final List<StackItemView> out = new ArrayList<>();
        final Iterable<StackItemView> stack = gv.getStack();
        if (stack != null) {
            for (final StackItemView si : stack) {
                out.add(si);
            }
        }
        return out;
    }

    private CardView handCard(final List<PlayerView> players, final int id) {
        for (final PlayerView p : players) {
            for (final CardView cv : zoneCards(p, TrackableProperty.Hand)) {
                if (cv.getId() == id) {
                    return cv;
                }
            }
        }
        return null;
    }

    private static String zoneKey(final PlayerView p, final String zone) {
        return p.getId() + ":" + zone;
    }

    private String assign(final CardView cv, final String zoneKey, final Map<Integer, String> seenOpaque) {
        final String existing = passIds.get(cv.getId());
        if (existing != null) {
            return existing;
        }
        final String id;
        if (viewer != null && (cv.canBeShownTo(viewer) || cv.getZone() == forge.game.zone.ZoneType.Hand && revealedInHand.contains(cv.getId())
                || zoneKey.equals(knownInLibrary.get(cv.getId())))) {
            if (cv.isFaceDown() && !cv.canFaceDownBeShownTo(viewer)) {
                id = "f" + cv.getHiddenId();
            } else {
                id = "c" + cv.getId();
            }
        } else {
            String[] slot = opaque.get(cv.getId());
            if (slot == null || !slot[0].equals(zoneKey)) {
                slot = new String[] { zoneKey, newOpaqueId() };
                opaque.put(cv.getId(), slot);
            }
            id = slot[1];
            seenOpaque.put(cv.getId(), id);
        }
        passIds.put(cv.getId(), id);
        return id;
    }

    private String newOpaqueId() {
        final StringBuilder sb = new StringBuilder("x");
        for (int i = 0; i < 10; i++) {
            sb.append(Character.forDigit(random.nextInt(36), 36));
        }
        return sb.toString();
    }

    private JsonObject encodeCard(final CardView cv, final String cid) {
        final JsonObject out = new JsonObject();
        out.addProperty("id", cid);
        final boolean identified = cid.startsWith("c");
        ViewCodec.encodeProps(cv, refs, out, identified ? null : NOT_ON_FACE_DOWN);
        final CardStateView cur = cv.getCurrentState();
        if (!identified) {
            // An unidentified face-down card only ever shows its face-down face. Never trust the current
            // state here: during reveals the engine can switch it to the real face while Facedown is set.
            out.add("state", faceDownState(cur));
            return out;
        }
        if (cur != null) {
            out.add("state", ViewCodec.state(cur, refs));
        }
        if (revealedToOpponent.contains(cv.getId())) {
            out.addProperty("revealedToOpponent", true);
        }
        {
            final CardStateView alt = cv.getAlternateState();
            if (alt != null) {
                out.add("alt", ViewCodec.state(alt, refs));
            }
            if (cv.isSplitCard()) {
                final CardStateView left = cv.getLeftSplitState();
                final CardStateView right = cv.getRightSplitState();
                if (left != null) {
                    out.add("left", ViewCodec.state(left, refs));
                }
                if (right != null) {
                    out.add("right", ViewCodec.state(right, refs));
                }
            }
        }
        return out;
    }

    /** The public face of an unidentified face-down card: its face-down characteristics, nothing else. */
    private JsonObject faceDownState(final CardStateView cur) {
        if (cur != null && cur.getState() == CardStateName.FaceDown) {
            return ViewCodec.state(cur, refs);
        }
        final JsonObject o = new JsonObject();
        o.addProperty("face", CardStateName.FaceDown.name());
        return o;
    }

    private JsonObject encodePlayer(final PlayerView p) {
        final JsonObject out = new JsonObject();
        out.addProperty("id", refs.player(p));
        ViewCodec.encodeProps(p, refs, out, null);
        final JsonObject zones = new JsonObject();
        for (final TrackableProperty zone : ViewCodec.PLAYER_ZONES) {
            final JsonArray ids = new JsonArray();
            for (final CardView cv : zoneCards(p, zone)) {
                final String id = passIds.get(cv.getId());
                if (id != null) {
                    ids.add(id);
                }
            }
            if (ids.size() > 0) {
                zones.add(ViewCodec.key(zone), ids);
            }
        }
        out.add("zones", zones);
        return out;
    }

    private JsonObject encodeGame(final GameView gv) {
        final JsonObject out = new JsonObject();
        ViewCodec.encodeProps(gv, refs, out, null);
        String priority = null;
        for (final PlayerView p : gv.getPlayers()) {
            if (p.getHasPriority()) {
                priority = refs.player(p);
            }
        }
        if (priority != null) {
            out.addProperty("priority", priority);
        }
        final JsonArray stack = new JsonArray();
        for (final StackItemView si : stackItems(gv)) {
            stack.add(encodeStackItem(si));
        }
        out.add("stack", stack);
        final CombatView combat = gv.getCombat();
        if (combat != null) {
            out.add("combat", encodeCombat(combat));
        }
        return out;
    }

    private JsonObject encodeStackItem(final StackItemView si) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", "s" + si.getId());
        o.addProperty("text", si.getText());
        final String src = refs.card(si.getSourceCard());
        if (src != null) {
            o.addProperty("source", src);
        }
        if (si.getActivatingPlayer() != null) {
            o.addProperty("activator", refs.player(si.getActivatingPlayer()));
        }
        o.addProperty("ability", si.isAbility());
        o.addProperty("trigger", si.isTrigger());
        if (si.isOptionalTrigger()) {
            o.addProperty("optionalTrigger", true);
        }
        final JsonArray targets = new JsonArray();
        for (final CardView t : si.getTargetCards()) {
            final String id = refs.card(t);
            if (id != null) {
                targets.add(id);
            }
        }
        for (final PlayerView t : si.getTargetPlayers()) {
            targets.add(refs.player(t));
        }
        o.add("targets", targets);
        return o;
    }

    private JsonArray encodeCombat(final CombatView combat) {
        final JsonArray out = new JsonArray();
        for (final CardView attacker : combat.getAttackers()) {
            final String aid = refs.card(attacker);
            if (aid == null) {
                continue;
            }
            final JsonObject a = new JsonObject();
            a.addProperty("attacker", aid);
            final GameEntityView def = combat.getDefender(attacker);
            if (def != null) {
                final JsonElement d = ViewCodec.entity(def, refs);
                if (!d.isJsonNull()) {
                    a.add("defender", d);
                }
            }
            a.add("blockers", ids(combat.getBlockers(attacker)));
            final FCollection<CardView> planned = combat.getPlannedBlockers(attacker);
            if (planned != null && !planned.isEmpty()) {
                a.add("planned", ids(planned));
            }
            out.add(a);
        }
        return out;
    }

    private JsonArray ids(final Iterable<CardView> cards) {
        final JsonArray arr = new JsonArray();
        if (cards != null) {
            for (final CardView cv : cards) {
                final String id = refs.card(cv);
                if (id != null) {
                    arr.add(id);
                }
            }
        }
        return arr;
    }
}

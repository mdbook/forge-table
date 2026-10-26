package forge.bridge.match;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.commons.lang3.tuple.Pair;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.LobbyPlayer;
import forge.StaticData;
import forge.bridge.proj.ViewCodec;
import forge.bridge.proj.ViewProjector;
import forge.card.ICardFace;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.GameState;
import forge.game.GameView;
import forge.card.MagicColor;
import forge.game.card.CardFaceView;
import forge.game.card.CardView;
import forge.game.card.CardView.CardStateView;
import forge.game.card.CounterEnumType;
import forge.game.event.GameEvent;
import forge.game.event.GameEventTurnPhase;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.AbstractGuiGame;
import forge.gui.FThreads;
import forge.interfaces.IGameController;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.localinstance.skin.FSkinProp;
import forge.model.FModel;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;
import forge.game.zone.ZoneType;

/**
 * The Forge Table {@link forge.gui.interfaces.IGuiGame}. Extends {@link AbstractGuiGame} like the
 * Swing and mobile match UIs do, so controller bookkeeping, yields and the await-next-input timer behave
 * exactly as they do there.
 *
 * <p>Repaint-style methods are no-ops: beats and patches already carry that state. Prompt-state mutators
 * are marshalled to {@code bridge-ui} in call order and accumulated; {@link TableSession} flushes them once
 * per {@code bridge-ui} task. Blocking choice methods become {@link PromptService} prompts whose replies are
 * indices, validated and mapped back to the original objects here.
 */
public final class BridgeGuiGame extends AbstractGuiGame {

    /** Supplies a GUI for spectated (no-human) matches. */
    public interface Factory {
        BridgeGuiGame create();
    }

    private final TableSession table;

    // Prompt state, touched only on bridge-ui.
    private String promptMessage = "";
    private CardView promptCard;
    private String okLabel = "";
    private String cancelLabel = "";
    private boolean okEnabled;
    private boolean cancelEnabled;
    private boolean focusOk;
    private long messagePid;
    private final Set<CardView> selectables = new HashSet<>();
    /** Insertion order = pick order (Forge highlights each pick as it is made): the client numbers picks 1, 2, 3. */
    private final Set<GameEntityView> highlighted = new LinkedHashSet<>();
    private final Map<CardView, Integer> weak = new LinkedHashMap<>();
    /** Hand spells that cost other than printed right now (setAdjustedCosts): the prompt's {@code costs}. */
    private final Map<CardView, String> costs = new LinkedHashMap<>();
    private int selMin;
    private int selMax;
    private boolean promptDirty;

    /** Bridge-owned phase stop table: player id -> stop per PhaseType ordinal. */
    private final Map<Integer, boolean[]> stops = Collections.synchronizedMap(new HashMap<>());

    public BridgeGuiGame(final TableSession table) {
        this.table = table;
    }

    public TableSession table() {
        return table;
    }

    // ---------------------------------------------------------------- plumbing

    @Override
    public void setGameView(final GameView gameView) {
        super.setGameView(gameView);
        if (gameView != null) {
            table.attachGame(gameView);
        }
    }

    @Override
    public void openView(final TrackableCollection<PlayerView> myPlayers) {
        final PlayerView seat = myPlayers == null || myPlayers.isEmpty() ? null : myPlayers.get(0);
        seedStops();
        table.openView(getGameView(), seat);
    }

    @Override
    public void setOriginalGameController(final PlayerView player, final IGameController gameController) {
        super.setOriginalGameController(player, gameController);
        table.installController(gameController, true);
    }

    @Override
    public void setGameController(final PlayerView player, final IGameController gameController) {
        super.setGameController(player, gameController);
        if (gameController != null) {
            table.installController(gameController, false);
        }
    }

    @Override
    protected void updateCurrentPlayer(final PlayerView player) {
        // Seat changes arrive in the snapshot/prompt; nothing to repaint.
    }

    @Override
    public void finishGame() {
        table.gameFinished();
    }

    @Override
    public void afterGameEnd() {
        super.afterGameEnd();
        table.afterGameEnd();
    }

    @Override
    public void handleGameEvent(final GameEvent event) {
        // Local games receive the event stream through EventTap. HostedMatch injects GameEventTurnPhase at
        // SubgameEnd to refresh the phase display; a settle carries that refresh.
        if (event instanceof GameEventTurnPhase) {
            table.outbox().settle();
        }
    }

    // ---------------------------------------------------------------- repaint hooks: beats/patches carry these

    @Override public void showCombat() { }
    @Override public void enableOverlay() { }
    @Override public void disableOverlay() { }
    @Override public void showManaPool(final PlayerView player) { }
    @Override public void hideManaPool(final PlayerView player) { }
    @Override public void updateShards(final Iterable<PlayerView> shardsUpdate) { }
    @Override public void setPanelSelection(final CardView hostCard) { }
    @Override public void setCard(final CardView card) { }
    @Override public void setPlayerAvatar(final LobbyPlayer player, final IHasIcon ihi) { }
    @Override public GameState getGamestate() { return null; }

    @Override
    public void updateRevealedCards(final TrackableCollection<CardView> collection) {
        final ViewProjector projector = table.outbox().projector();
        if (projector != null) {
            synchronized (table.outbox().lock()) {
                projector.onRevealed(collection);
            }
        }
        super.updateRevealedCards(collection);
        settleLater();
    }

    @Override
    public void updateZones(final Iterable<PlayerZoneUpdate> zonesToUpdate) {
        // Zone changes always come with engine events; their beats carry the patch.
    }

    private void settleLater() {
        FThreads.invokeInEdtNowOrLater(() -> table.outbox().settle());
    }

    // ---------------------------------------------------------------- zones (the zone strip)

    @Override
    public Iterable<PlayerZoneUpdate> tempShowZones(final PlayerView controller, final Iterable<PlayerZoneUpdate> zonesToUpdate) {
        final List<PlayerZoneUpdate> shown = new ArrayList<>();
        final JsonArray zones = new JsonArray();
        for (final PlayerZoneUpdate update : zonesToUpdate) {
            for (final ZoneType zone : update.getZones()) {
                if (zone == ZoneType.Battlefield || (zone == ZoneType.Hand && update.getPlayer().equals(controller))) {
                    continue;
                }
                final JsonObject z = new JsonObject();
                z.addProperty("player", "p" + update.getPlayer().getId());
                z.addProperty("zone", zone.name());
                zones.add(z);
                if (!shown.contains(update)) {
                    shown.add(update);
                }
            }
        }
        if (zones.size() > 0) {
            final JsonObject n = new JsonObject();
            n.add("show", zones);
            table.notice("zones", n);
        }
        settleLater();
        return shown;
    }

    @Override
    public void hideZones(final PlayerView controller, final Iterable<PlayerZoneUpdate> zonesToUpdate) {
        final JsonObject n = new JsonObject();
        n.addProperty("hide", true);
        table.notice("zones", n);
    }

    @Override
    public PlayerZoneUpdates openZones(final PlayerView controller, final Collection<ZoneType> zones, final Map<PlayerView, Object> players, final boolean backupLastZones) {
        final PlayerZoneUpdates updates = new PlayerZoneUpdates();
        for (final PlayerView view : players.keySet()) {
            for (final ZoneType zone : zones) {
                if (zone != ZoneType.Battlefield && zone != ZoneType.Hand && zone != ZoneType.Stack) {
                    updates.add(new PlayerZoneUpdate(view, zone));
                }
            }
        }
        tempShowZones(controller, updates);
        return updates;
    }

    @Override
    public void restoreOldZones(final PlayerView playerView, final PlayerZoneUpdates playerZoneUpdates) {
        hideZones(playerView, playerZoneUpdates);
    }

    // ---------------------------------------------------------------- prompt bar (marshalled to bridge-ui)

    private void onUi(final Runnable r) {
        if (FThreads.isGuiThread()) {
            r.run();
        } else {
            FThreads.invokeInEdtLater(r);
        }
    }

    /**
     * True when the call comes from AbstractGuiGame's await-next-input timer ("Waiting for …"). That timer
     * can fire just after a new Input went up but before its showMessageInitial cancels the timer, so its
     * message would briefly sit on a live Input. While a real Input is shown it is ignored; the Input's own
     * showMessageInitial always follows and paints the right prompt.
     */
    private static boolean fromAwaitTimer() {
        return StackWalker.getInstance().walk(frames -> frames.limit(8).anyMatch(f ->
                f.getClassName().equals(AbstractGuiGame.class.getName())
                && (f.getMethodName().equals("updatePromptForAwait") || f.getMethodName().equals("updateWaitingDisplay"))));
    }

    private boolean ignoreAwaitMessage() {
        return fromAwaitTimer() && !"waiting".equals(InputDescriber.kind(table.shownInput()));
    }

    @Override
    public void showPromptMessage(final PlayerView playerView, final String message, final CardView card) {
        onUi(() -> {
            if (ignoreAwaitMessage()) {
                return;
            }
            promptMessage = message == null ? "" : message;
            promptCard = card;
            messagePid = table.consistentPid();
            promptDirty = true;
        });
    }

    @Override
    public void showPromptMessageNoCancel(final PlayerView playerView, final String message) {
        showPromptMessage(playerView, message, null);
    }

    @Override
    public void updateButtons(final PlayerView owner, final String label1, final String label2, final boolean enable1, final boolean enable2, final boolean focus1) {
        onUi(() -> {
            if (ignoreAwaitMessage()) {
                return;
            }
            okLabel = label1 == null ? "" : label1;
            cancelLabel = label2 == null ? "" : label2;
            okEnabled = enable1;
            cancelEnabled = enable2;
            focusOk = focus1;
            promptDirty = true;
        });
    }

    @Override
    public void flashIncorrectAction() {
        table.notice("flash", new JsonObject());
    }

    @Override
    public void alertUser() {
        table.notice("alert", new JsonObject());
    }

    @Override
    public void setSelectables(final Iterable<CardView> cards, final int min, final int max) {
        final List<CardView> copy = new ArrayList<>();
        cards.forEach(copy::add);
        onUi(() -> {
            super.setSelectables(copy, min, max);
            selectables.addAll(copy);
            selMin = min;
            selMax = max;
            promptDirty = true;
        });
    }

    @Override
    public void clearSelectables() {
        onUi(() -> {
            super.clearSelectables();
            selectables.clear();
            selMin = 0;
            selMax = 0;
            promptDirty = true;
        });
    }

    @Override
    public void setHighlighted(final Iterable<GameEntityView> entities, final boolean b) {
        final List<GameEntityView> copy = new ArrayList<>();
        entities.forEach(copy::add);
        onUi(() -> {
            super.setHighlighted(copy, b);
            if (b) {
                highlighted.addAll(copy);
            } else {
                highlighted.removeAll(copy);
            }
            promptDirty = true;
        });
    }

    @Override
    public void setWeaklySelectable(final Iterable<CardView> cards) {
        final List<CardView> copy = new ArrayList<>();
        cards.forEach(copy::add);
        onUi(() -> {
            super.setWeaklySelectable(copy);
            weak.clear();
            for (final CardView cv : copy) {
                weak.merge(cv, 1, Integer::sum);
            }
            promptDirty = true;
        });
    }

    @Override
    public void setAdjustedCosts(final Map<CardView, String> adjusted) {
        final Map<CardView, String> copy = new LinkedHashMap<>(adjusted);
        onUi(() -> {
            costs.clear();
            costs.putAll(copy);
            promptDirty = true;
        });
    }

    @Override
    public void clearWeaklySelectable() {
        onUi(() -> {
            super.clearWeaklySelectable();
            weak.clear();
            promptDirty = true;
        });
    }

    boolean isPromptDirty() {
        return promptDirty;
    }

    void clearPromptDirty() {
        promptDirty = false;
    }

    long messagePid() {
        return messagePid;
    }

    /** The prompt bar as JSON for {@code projector}'s viewer (bridge-ui, under the outbox lock). */
    JsonObject describePrompt(final ViewProjector projector) {
        final ViewCodec.Refs refs = projector.sentRefs();
        final JsonObject p = new JsonObject();
        p.addProperty("message", promptMessage);
        if (promptCard != null) {
            final String id = refs.card(promptCard);
            if (id != null) {
                p.addProperty("card", id);
            }
        }
        final JsonObject ok = new JsonObject();
        ok.addProperty("label", okLabel);
        ok.addProperty("enabled", okEnabled);
        p.add("ok", ok);
        final JsonObject cancel = new JsonObject();
        cancel.addProperty("label", cancelLabel);
        cancel.addProperty("enabled", cancelEnabled);
        p.add("cancel", cancel);
        p.addProperty("focusOk", focusOk);
        final JsonArray sel = new JsonArray();
        for (final CardView cv : selectables) {
            final String id = refs.card(cv);
            if (id != null) {
                sel.add(id);
            }
        }
        p.add("selectable", sel);
        if (selMin != 0 || selMax != 0) {
            p.addProperty("selMin", selMin);
            p.addProperty("selMax", selMax);
        }
        final JsonArray hl = new JsonArray();
        for (final GameEntityView ge : highlighted) {
            final JsonElement e = ViewCodec.entity(ge, refs);
            if (!e.isJsonNull()) {
                hl.add(e);
            }
        }
        p.add("highlighted", hl);
        final JsonObject w = new JsonObject();
        weak.forEach((cv, n) -> {
            final String id = refs.card(cv);
            if (id != null) {
                w.addProperty(id, n);
            }
        });
        p.add("weak", w);
        if (!costs.isEmpty()) {
            final JsonObject cs = new JsonObject();
            costs.forEach((cv, cost) -> {
                final String id = refs.card(cv);
                if (id != null) {
                    cs.addProperty(id, cost);
                }
            });
            p.add("costs", cs);
        }
        return p;
    }

    // ---------------------------------------------------------------- phase stops

    private void seedStops() {
        final GameView gv = getGameView();
        if (gv == null) {
            return;
        }
        for (final PlayerView pv : gv.getPlayers()) {
            final FPref[] keys = isLocalPlayer(pv) ? FPref.PHASES_HUMAN : FPref.PHASES_AI;
            final PhaseType[] phases = PhaseType.values();
            final boolean[] s = new boolean[phases.length];
            for (int i = 1; i < phases.length && i - 1 < keys.length; i++) {
                s[i] = FModel.getPreferences().getPrefBoolean(keys[i - 1]);
            }
            stops.put(pv.getId(), s);
        }
    }

    /** Whether there is a stop at {@code phase} on {@code player}'s turn. */
    public boolean isStop(final PlayerView player, final PhaseType phase) {
        final boolean[] s = stops.get(player.getId());
        return s != null && s[phase.ordinal()];
    }

    public void setStop(final PlayerView player, final PhaseType phase, final boolean stop) {
        stops.computeIfAbsent(player.getId(), k -> new boolean[PhaseType.values().length])[phase.ordinal()] = stop;
    }

    /** Stop table as JSON: {@code {"p1": ["MAIN1", …]}}. */
    public JsonObject describeStops() {
        final JsonObject out = new JsonObject();
        synchronized (stops) {
            stops.forEach((id, s) -> {
                final JsonArray arr = new JsonArray();
                for (final PhaseType p : PhaseType.values()) {
                    if (s[p.ordinal()]) {
                        arr.add(p.name());
                    }
                }
                out.add("p" + id, arr);
            });
        }
        return out;
    }

    @Override
    public boolean isUiSetToSkipPhase(final PlayerView playerTurn, final PhaseType phase) {
        // Mirrors CMatchUI: a mind-slaved turn stops only if both the slave's and the master's ladders stop.
        final PlayerView master = playerTurn.getMindSlaveMaster();
        boolean skipped = true;
        if (master != null) {
            skipped = !isStop(master, phase);
        }
        return skipped && !isStop(playerTurn, phase);
    }

    /** A yield changed (Forge's interrupts run on the game thread): run a bridge-ui task so the session's
     *  after-task flush sends {@code notice{autoPass}} now rather than with the next prompt. */
    @Override
    public void refreshYieldUi(final PlayerView player) {
        onUi(() -> { });
    }

    // ---------------------------------------------------------------- notifications

    @Override
    public void message(final String message, final String title) {
        table.toast("info", title, message);
    }

    @Override
    public void showErrorDialog(final String message, final String title) {
        table.toast("error", title, message);
    }

    // ---------------------------------------------------------------- blocking prompts

    private JsonObject base(final String title, final String message) {
        final JsonObject o = new JsonObject();
        if (title != null) {
            o.addProperty("title", title);
        }
        if (message != null) {
            o.addProperty("message", message);
        }
        return o;
    }

    /** Display item for a choice. Engine objects stay on the server; the client sees labels and ids. */
    private JsonObject item(final int idx, final Object choice, final FSerializableFunction<Object, String> display, final ViewProjector projector,
            final boolean markPlayable) {
        final JsonObject it = new JsonObject();
        it.addProperty("idx", idx);
        final ViewCodec.Refs refs = projector.sentRefs();
        if (choice instanceof CardView cv) {
            final String id = refs.card(cv);
            if (id != null) {
                it.addProperty("card", id);
                it.addProperty("label", display != null ? display.apply(choice) : cardName(cv));
            } else if (cv.getZone() == null || cv.canBeShownTo(projector.getViewer())) {
                // A card outside every zone (e.g. a card-name or token choice): send its face inline.
                it.add("cardData", inlineCard(cv, refs));
                it.addProperty("label", display != null ? display.apply(choice) : cardName(cv));
            } else {
                it.addProperty("label", "Hidden card");
            }
        } else if (choice instanceof PlayerView pv) {
            it.addProperty("player", "p" + pv.getId());
            it.addProperty("label", display != null ? display.apply(choice) : pv.getName());
        } else if (choice instanceof SpellAbilityView sa) {
            final String host = refs.card(sa.getHostCard());
            if (host != null) {
                it.addProperty("card", host);
            }
            it.addProperty("label", display != null ? display.apply(choice) : sa.getDescription());
            if (markPlayable) {
                // Only the ability menu greys out abilities that can't be activated now; in any other choice
                // (copy, choose a mode, …) every listed ability is a valid answer.
                it.addProperty("enabled", sa.canPlay());
            }
        } else if (choice instanceof CardFaceView face) {
            // Name a card: the name, plus its type line so the client can tell look-alike names apart.
            it.addProperty("label", display != null ? display.apply(choice) : face.getName());
            final ICardFace f = StaticData.instance().getCommonCards().getFaceByName(face.getName());
            it.addProperty("sub", f == null || f.getType() == null ? "" : f.getType().toString());
        } else {
            it.addProperty("label", display != null ? display.apply(choice) : String.valueOf(choice));
        }
        return it;
    }

    private static String cardName(final CardView cv) {
        return cv.getCurrentState() == null ? cv.toString() : cv.getCurrentState().getName();
    }

    private static JsonObject inlineCard(final CardView cv, final ViewCodec.Refs refs) {
        final JsonObject o = new JsonObject();
        if (cv.getCurrentState() != null) {
            o.add("state", ViewCodec.state(cv.getCurrentState(), refs));
        }
        return o;
    }

    private JsonArray items(final List<?> choices, final FSerializableFunction<Object, String> display) {
        return items(choices, display, false);
    }

    private JsonArray items(final List<?> choices, final FSerializableFunction<Object, String> display, final boolean markPlayable) {
        final JsonArray arr = new JsonArray();
        synchronized (table.outbox().lock()) {
            final ViewProjector projector = table.outbox().projector();
            for (int i = 0; i < choices.size(); i++) {
                arr.add(item(i, choices.get(i), display, projector, markPlayable));
            }
        }
        return arr;
    }

    /** Parse {@code [i, j, …]}: distinct, in range, {@code min..max} long. */
    static List<Integer> indices(final JsonElement reply, final int size, final int min, final int max) {
        if (reply == null || !reply.isJsonArray()) {
            throw new PromptService.InvalidReply("Expected a list of choices");
        }
        final List<Integer> out = new ArrayList<>();
        for (final JsonElement e : reply.getAsJsonArray()) {
            final int i = e.getAsInt();
            if (i < 0 || i >= size || out.contains(i)) {
                throw new PromptService.InvalidReply("Invalid choice " + i);
            }
            out.add(i);
        }
        if (out.size() < min || (max >= 0 && out.size() > max)) {
            throw new PromptService.InvalidReply("Choose " + (min == max ? String.valueOf(min) : min + "–" + max));
        }
        return out;
    }

    private static JsonArray firstN(final int n) {
        final JsonArray arr = new JsonArray();
        for (int i = 0; i < n; i++) {
            arr.add(i);
        }
        return arr;
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> List<T> getChoices(final String message, final int min, final int max, final List<T> choices, final List<T> selected, final FSerializableFunction<T, String> display) {
        if (choices == null || choices.isEmpty()) {
            return new ArrayList<>();
        }
        final boolean reveal = min < 0 && max < 0;
        final JsonObject payload = base(null, message);
        payload.add("items", items(choices, (FSerializableFunction<Object, String>) display));
        payload.addProperty("min", Math.max(min, 0));
        payload.addProperty("max", max < 0 ? choices.size() : max);
        if (reveal) {
            payload.addProperty("reveal", true);
        }
        if (selected != null && !selected.isEmpty()) {
            final JsonArray pre = new JsonArray();
            for (final T s : selected) {
                final int i = choices.indexOf(s);
                if (i >= 0) {
                    pre.add(i);
                }
            }
            payload.add("selected", pre);
        }
        final int lo = reveal ? 0 : Math.max(min, 0);
        final int hi = reveal ? choices.size() : (max < 0 ? choices.size() : max);
        return table.prompts().ask("choose", payload, table.spawningPid(), reply -> {
            if (reveal) {
                return new ArrayList<T>();
            }
            final List<T> out = new ArrayList<>();
            for (final int i : indices(reply, choices.size(), lo, hi)) {
                out.add(choices.get(i));
            }
            return out;
        }, firstN(lo));
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> OrderResult<T> order(final String title, final String top, final int remainingObjectsMin, final int remainingObjectsMax,
            final List<T> sourceChoices, final List<T> destChoices, final CardView referenceCard, final boolean sideboardingMode, final boolean showRememberCheckbox) {
        final List<T> all = new ArrayList<>(sourceChoices);
        final int preset = destChoices == null ? 0 : destChoices.size();
        if (destChoices != null) {
            all.addAll(destChoices);
        }
        final int total = all.size();
        // Remaining (unchosen) count must lie in [remainingMin, remainingMax]; negative bounds are open.
        final int minRemaining = Math.max(0, remainingObjectsMin);
        final int maxRemaining = remainingObjectsMax < 0 ? total : remainingObjectsMax;
        final int minChosen = Math.max(0, total - maxRemaining);
        final int maxChosen = total - minRemaining;
        if (total == 0) {
            return new OrderResult<>(new ArrayList<>(), false);
        }
        final JsonObject payload = base(title, top);
        payload.add("items", items(all, null));
        payload.addProperty("min", minChosen);
        payload.addProperty("max", maxChosen);
        payload.addProperty("ordered", true);
        if (preset > 0) {
            final JsonArray pre = new JsonArray();
            for (int i = sourceChoices.size(); i < total; i++) {
                pre.add(i);
            }
            payload.add("selected", pre);
        }
        if (showRememberCheckbox) {
            payload.addProperty("remember", true);
        }
        if (referenceCard != null) {
            synchronized (table.outbox().lock()) {
                final String id = table.outbox().projector().sentRefs().card(referenceCard);
                if (id != null) {
                    payload.addProperty("card", id);
                }
            }
        }
        final JsonObject cancel = new JsonObject();
        cancel.add("order", firstN(Math.max(minChosen, Math.min(maxChosen, total))));
        return table.prompts().ask("order", payload, table.spawningPid(), reply -> {
            final JsonObject r = reply.getAsJsonObject();
            final List<T> out = new ArrayList<>();
            for (final int i : indices(r.get("order"), total, minChosen, maxChosen)) {
                out.add(all.get(i));
            }
            final boolean remember = r.has("remember") && r.get("remember").getAsBoolean();
            return new OrderResult<>(out, remember);
        }, cancel);
    }

    @Override
    public List<PaperCard> sideboard(final CardPool sideboard, final CardPool main, final String message) {
        // Bo1 only until sideboarding lands: keep the main deck as is.
        return main.toFlatList();
    }

    @Override
    @SuppressWarnings("unchecked")
    public GameEntityView chooseSingleEntityForEffect(final String title, final List<? extends GameEntityView> optionList, final DelayedReveal delayedReveal, final boolean isOptional) {
        if (delayedReveal != null) {
            reveal(delayedReveal.getMessagePrefix(), delayedReveal.getCards());
        }
        final List<GameEntityView> options = (List<GameEntityView>) optionList;
        return isOptional ? oneOrNone(title, options) : one(title, options);
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<GameEntityView> chooseEntitiesForEffect(final String title, final List<? extends GameEntityView> optionList, final int min, final int max, final DelayedReveal delayedReveal) {
        if (delayedReveal != null) {
            reveal(delayedReveal.getMessagePrefix(), delayedReveal.getCards());
        }
        return getChoices(title, min, max, (List<GameEntityView>) optionList, null, null);
    }

    /**
     * Scry: with Forge's default "select from card displays" pref, every scry lands here. Only
     * the manipulable cards are sent, never the rest of the library. The reply puts each of them in the top
     * or the bottom lane, each lane listed from the top of the library down; the answer is the whole library
     * in its new order, as Swing's {@code ListCardArea} returns it.
     */
    @Override
    public List<CardView> manipulateCardList(final String title, final Iterable<CardView> cards, final Iterable<CardView> manipulable, final boolean toTop, final boolean toBottom, final boolean toAnywhere) {
        final List<CardView> all = new ArrayList<>();
        cards.forEach(all::add);
        final List<CardView> moving = new ArrayList<>();
        for (final CardView c : manipulable) {
            if (all.contains(c) && !moving.contains(c)) {
                moving.add(c);
            }
        }
        if (moving.isEmpty() || (!toTop && !toBottom)) {
            return all;
        }
        final JsonObject payload = base(title, null);
        payload.add("items", items(moving, null));
        payload.addProperty("top", toTop);
        payload.addProperty("bottom", toBottom);
        // Cancel / teardown: as dealt (everything stays where it is), or all to the only lane allowed.
        final JsonObject keep = new JsonObject();
        keep.add(toTop ? "top" : "bottom", firstN(moving.size()));
        keep.add(toTop ? "bottom" : "top", new JsonArray());
        return table.prompts().ask("arrange", payload, table.spawningPid(), reply -> {
            if (reply == null || !reply.isJsonObject()) {
                throw new PromptService.InvalidReply("Expected top and bottom lanes");
            }
            final JsonObject r = reply.getAsJsonObject();
            final List<Integer> top = indices(r.has("top") ? r.get("top") : new JsonArray(), moving.size(), 0, -1);
            final List<Integer> bottom = indices(r.has("bottom") ? r.get("bottom") : new JsonArray(), moving.size(), 0, -1);
            if ((!toTop && !top.isEmpty()) || (!toBottom && !bottom.isEmpty())) {
                throw new PromptService.InvalidReply(toTop ? "These cards can only go on top" : "These cards can only go on the bottom");
            }
            if (top.size() + bottom.size() != moving.size() || top.stream().anyMatch(bottom::contains)) {
                throw new PromptService.InvalidReply("Put every card on the top or the bottom");
            }
            return arranged(all, moving, top, bottom);
        }, keep);
    }

    /**
     * Surveil two or more cards: scry's lanes with a Graveyard lane (one card stays a confirm). The reply puts each card in
     * the top lane, listed from the top of the library down, or the graveyard lane.
     */
    @Override
    public Pair<List<CardView>, List<CardView>> surveil(final List<CardView> cards) {
        final JsonObject payload = base("Surveil " + cards.size(), null);
        payload.add("items", items(cards, null));
        payload.addProperty("top", true);
        payload.addProperty("bottom", false);
        payload.addProperty("graveyard", true);
        final JsonObject keep = new JsonObject();
        keep.add("top", firstN(cards.size()));
        keep.add("graveyard", new JsonArray());
        return table.prompts().ask("arrange", payload, table.spawningPid(), reply -> {
            if (reply == null || !reply.isJsonObject()) {
                throw new PromptService.InvalidReply("Expected top and graveyard lanes");
            }
            final JsonObject r = reply.getAsJsonObject();
            final List<Integer> top = indices(r.has("top") ? r.get("top") : new JsonArray(), cards.size(), 0, -1);
            final List<Integer> grave = indices(r.has("graveyard") ? r.get("graveyard") : new JsonArray(), cards.size(), 0, -1);
            if (top.size() + grave.size() != cards.size() || top.stream().anyMatch(grave::contains)) {
                throw new PromptService.InvalidReply("Put every card on top or in the graveyard");
            }
            final List<CardView> toTop = new ArrayList<>();
            top.forEach(i -> toTop.add(cards.get(i)));
            final List<CardView> toGrave = new ArrayList<>();
            grave.forEach(i -> toGrave.add(cards.get(i)));
            return Pair.of(toTop, toGrave);
        }, keep);
    }

    /**
     * The library after an arrange: {@code top} lane, the untouched cards, then the bottom lane. The bottom lane
     * goes in reversed: {@code PlayerControllerHuman.arrangeForMove} reads it back from the end and
     * {@code GameAction.scry} moves each card to the bottom in that order, which flips it again, so the card
     * listed last in the lane really ends up at the very bottom. (When the arranged cards are the whole library,
     * {@code arrangeForMove} reads all of it as the top, in order, so nothing is reversed.)
     */
    static <C> List<C> arranged(final List<C> all, final List<C> moving, final List<Integer> top, final List<Integer> bottom) {
        final List<C> out = new ArrayList<>(all.size());
        top.forEach(i -> out.add(moving.get(i)));
        for (final C c : all) {
            if (!moving.contains(c)) {
                out.add(c);
            }
        }
        final boolean wholeLibrary = out.size() == top.size();
        for (int k = 0; k < bottom.size(); k++) {
            out.add(moving.get(bottom.get(wholeLibrary ? k : bottom.size() - 1 - k)));
        }
        return out;
    }

    @Override
    public SpellAbilityView getAbilityToPlay(final CardView hostCard, final List<SpellAbilityView> abilities, final ITriggerEvent triggerEvent) {
        if (abilities.isEmpty()) {
            return null;
        }
        if (abilities.size() == 1) {
            return abilities.get(0); // as CMatchUI does when no menu is needed
        }
        final JsonObject payload = base(null, "Choose an ability");
        payload.add("items", items(abilities, null, true));
        payload.addProperty("min", 0);
        payload.addProperty("max", 1);
        synchronized (table.outbox().lock()) {
            final String id = table.outbox().projector().sentRefs().card(hostCard);
            if (id != null) {
                payload.addProperty("card", id);
            }
        }
        return table.prompts().ask("ability", payload, table.spawningPid(), reply -> {
            final List<Integer> idx = indices(reply, abilities.size(), 0, 1);
            if (idx.isEmpty()) {
                return null;
            }
            final SpellAbilityView sa = abilities.get(idx.get(0));
            if (!sa.canPlay()) {
                throw new PromptService.InvalidReply("That ability can't be activated right now");
            }
            return sa;
        }, new JsonArray());
    }

    /**
     * Combat damage assignment: the blockers in damage order, then the defender if the attacker may assign it damage
     * (trample, or "divide as you choose"). The reply is one amount per target; {@code null} skips (assign
     * another attacker first) when {@code maySkip}. Rules as Swing's {@code VAssignCombatDamage}, see
     * {@link #combatError}.
     */
    @Override
    public Map<CardView, Integer> assignCombatDamage(final CardView attacker, final List<CardView> blockers, final int damage, final GameEntityView defender, final boolean overrideOrder, final boolean maySkip) {
        final CardStateView st = attacker.getCurrentState();
        final boolean deathtouch = st != null && st.hasDeathtouch();
        final boolean divide = st != null && st.hasDivideDamage() && overrideOrder;
        final boolean toDefender = defender != null && (divide || (st != null && st.hasTrample()));
        final List<GameEntityView> targets = new ArrayList<>(blockers);
        if (toDefender) {
            targets.add(defender);
        }
        if (targets.isEmpty()) {
            return new LinkedHashMap<>();
        }
        final int[] lethal = new int[targets.size()];
        for (int i = 0; i < targets.size(); i++) {
            lethal[i] = lethalDamage(targets.get(i), deathtouch, st != null && st.hasInfect());
        }
        final String rule = divide ? "free" : overrideOrder ? "lethalFirst" : "inOrder";
        final JsonObject payload = base("Assign " + cardName(attacker) + "'s combat damage", null);
        payload.add("items", items(targets, null));
        payload.addProperty("amount", damage);
        payload.addProperty("label", "damage");
        payload.add("lethal", ints(lethal));
        payload.addProperty("rule", rule);
        if (toDefender) {
            payload.addProperty("defender", true);
        }
        if (maySkip) {
            payload.addProperty("skip", true);
        }
        sourceCard(payload, attacker);
        return table.prompts().ask("split", payload, table.spawningPid(), reply -> {
            if (reply == null || reply.isJsonNull()) {
                if (!maySkip) {
                    throw new PromptService.InvalidReply("Assign all the damage");
                }
                return null;
            }
            final int[] a = amounts(reply, targets.size());
            final String error = combatError(a, lethal, damage, rule, toDefender);
            if (error != null) {
                throw new PromptService.InvalidReply(error);
            }
            final Map<CardView, Integer> out = new LinkedHashMap<>();
            for (int i = 0; i < blockers.size(); i++) {
                out.put(blockers.get(i), a[i]);
            }
            if (toDefender) {
                out.put(null, a[blockers.size()]);
            }
            return out;
        }, ints(autoCombat(lethal, damage)));
    }

    /**
     * Damage a target needs to be destroyed (or, for the defender, to lose): Swing's {@code getDamageToKill}, plus
     * a battle's defense.
     */
    private int lethalDamage(final GameEntityView target, final boolean deathtouch, final boolean infect) {
        if (target instanceof PlayerView p) {
            return infect ? getGameView().getPoisonCountersToLose() - p.getCounters(CounterEnumType.POISON) : p.getLife();
        }
        final CardView c = (CardView) target;
        final CardStateView s = c.getCurrentState();
        if (s != null && s.isPlaneswalker()) {
            return parseOr(s.getLoyalty(), 0);
        }
        if (s != null && s.isBattle() && c.getZone() == ZoneType.Battlefield && !s.isCreature()) {
            return parseOr(s.getDefense(), 0);
        }
        final int lethal = Math.max(0, c.getLethalDamage());
        return deathtouch ? Math.min(lethal, 1) : lethal;
    }

    private static int parseOr(final String s, final int fallback) {
        try {
            return Integer.parseInt(s);
        } catch (final NumberFormatException | NullPointerException e) {
            return fallback;
        }
    }

    /**
     * Why a combat damage assignment is invalid, or {@code null}. Every point must be assigned. {@code rule}:
     * {@code inOrder} (legacy damage assignment order: a target may only be assigned damage once every target
     * before it has lethal), {@code lethalFirst} (any blocker; the defender only once every blocker has lethal),
     * {@code free} (divided as you choose). The defender, if any, is the last target.
     */
    static String combatError(final int[] a, final int[] lethal, final int total, final String rule, final boolean defender) {
        int sum = 0;
        for (final int x : a) {
            if (x < 0) {
                return "Damage can't be negative";
            }
            sum += x;
        }
        if (sum != total) {
            return "Assign all " + total + " damage (" + sum + " assigned)";
        }
        final int n = a.length;
        for (int i = 1; i < n; i++) {
            if (a[i] == 0) {
                continue;
            }
            final boolean last = defender && i == n - 1;
            final int upTo = "inOrder".equals(rule) || ("lethalFirst".equals(rule) && last) ? i : 0;
            for (int j = 0; j < upTo; j++) {
                if (a[j] < lethal[j]) {
                    return last ? "Assign lethal damage to every blocker first" : "Assign lethal damage in order";
                }
            }
        }
        return null;
    }

    /** Swing's Auto: lethal to each target in order, whatever is left to the last one (the defender, if any). */
    static int[] autoCombat(final int[] lethal, final int total) {
        final int[] a = new int[lethal.length];
        int left = total;
        for (int i = 0; i < a.length && left > 0; i++) {
            a[i] = Math.min(lethal[i], left);
            left -= a[i];
        }
        if (a.length > 0) {
            a[a.length - 1] += left;
        }
        return a;
    }

    /**
     * Amount split: divided damage, prevention shields, a mana combination. {@code target} maps each choice
     * (a card, a player or a {@code MagicColor.Color}) to the most it may get, {@code null} for no limit. The reply
     * is one amount per target, adding up to {@code amount}.
     */
    @Override
    public Map<Object, Integer> assignGenericAmount(final CardView effectSource, final Map<Object, Integer> target, final int amount, final boolean atLeastOne, final String amountLabel) {
        final List<Object> keys = new ArrayList<>(target.keySet());
        if (keys.isEmpty()) {
            return new LinkedHashMap<>();
        }
        final int[] min = new int[keys.size()];
        final int[] max = new int[keys.size()];
        int room = 0;
        for (int i = 0; i < keys.size(); i++) {
            final Integer m = target.get(keys.get(i));
            max[i] = m == null ? amount : Math.min(m, amount);
            min[i] = atLeastOne ? Math.min(1, max[i]) : 0;
            room += max[i];
        }
        final int total = Math.min(amount, room); // ponytail: an impossible split assigns what fits, never hangs
        final List<Object> shown = new ArrayList<>(keys.size());
        for (final Object k : keys) {
            shown.add(k instanceof MagicColor.Color c ? c.getTranslatedName() : k);
        }
        final JsonObject payload = base("Divide " + amount + " " + amountLabel, null);
        payload.add("items", items(shown, null));
        payload.addProperty("amount", total);
        payload.addProperty("label", amountLabel);
        payload.add("min", ints(min));
        payload.add("max", ints(max));
        payload.addProperty("rule", "free");
        sourceCard(payload, effectSource);
        return table.prompts().ask("split", payload, table.spawningPid(), reply -> {
            final int[] a = amounts(reply, keys.size());
            final String error = splitError(a, min, max, total);
            if (error != null) {
                throw new PromptService.InvalidReply(error);
            }
            final Map<Object, Integer> out = new LinkedHashMap<>();
            for (int i = 0; i < keys.size(); i++) {
                out.put(keys.get(i), a[i]);
            }
            return out;
        }, ints(autoSplit(min, max, total)));
    }

    /** Why a split is invalid, or {@code null}: each amount within its bounds, adding up to {@code total}. */
    static String splitError(final int[] a, final int[] min, final int[] max, final int total) {
        int sum = 0;
        for (int i = 0; i < a.length; i++) {
            if (a[i] < min[i]) {
                return "Each target needs at least " + min[i];
            }
            if (a[i] > max[i]) {
                return "At most " + max[i] + " on one target";
            }
            sum += a[i];
        }
        return sum == total ? null : "Divide all " + total + " (" + sum + " assigned)";
    }

    /** The minimum on each target, then the rest in order as far as each maximum allows. */
    static int[] autoSplit(final int[] min, final int[] max, final int total) {
        final int[] a = min.clone();
        int left = total;
        for (final int x : a) {
            left -= x;
        }
        for (int i = 0; i < a.length && left > 0; i++) {
            final int add = Math.min(left, max[i] - a[i]);
            a[i] += add;
            left -= add;
        }
        return a;
    }

    /** Parse {@code [n, …]}: exactly {@code size} whole numbers. */
    private static int[] amounts(final JsonElement reply, final int size) {
        if (reply == null || !reply.isJsonArray() || reply.getAsJsonArray().size() != size) {
            throw new PromptService.InvalidReply("Expected one amount per target");
        }
        final int[] a = new int[size];
        for (int i = 0; i < size; i++) {
            a[i] = reply.getAsJsonArray().get(i).getAsInt();
        }
        return a;
    }

    private static JsonArray ints(final int[] a) {
        final JsonArray arr = new JsonArray();
        for (final int x : a) {
            arr.add(x);
        }
        return arr;
    }

    private void sourceCard(final JsonObject payload, final CardView c) {
        if (c == null) {
            return;
        }
        synchronized (table.outbox().lock()) {
            final String id = table.outbox().projector().sentRefs().card(c);
            if (id != null) {
                payload.addProperty("card", id);
            }
        }
    }

    @Override
    public boolean confirm(final CardView c, final String question, final boolean defaultIsYes, final List<String> options) {
        final List<String> opts = options == null || options.isEmpty() ? List.of("Yes", "No") : options;
        final JsonObject payload = base(null, question);
        final JsonArray labels = new JsonArray();
        opts.forEach(labels::add);
        payload.add("options", labels);
        payload.addProperty("default", defaultIsYes ? 0 : 1);
        if (c != null) {
            synchronized (table.outbox().lock()) {
                final ViewProjector projector = table.outbox().projector();
                final String id = projector.sentRefs().card(c);
                if (id != null) {
                    payload.addProperty("card", id);
                } else if (c.getZone() == null || c.canBeShownTo(projector.getViewer())) {
                    // e.g. scry 1 / surveil 1: a library card the client has no face for
                    payload.add("cardData", inlineCard(c, projector.sentRefs()));
                }
            }
        }
        return table.prompts().ask("confirm", payload, table.spawningPid(), reply -> {
            final int i = reply.getAsInt();
            if (i < 0 || i >= opts.size()) {
                throw new PromptService.InvalidReply("Invalid option");
            }
            return i == 0;
        }, new JsonPrimitive(defaultIsYes ? 0 : 1));
    }

    @Override
    public boolean showConfirmDialog(final String message, final String title, final String yesButtonText, final String noButtonText, final boolean defaultYes) {
        final JsonObject payload = base(title, message);
        final JsonArray labels = new JsonArray();
        labels.add(yesButtonText);
        labels.add(noButtonText);
        payload.add("options", labels);
        payload.addProperty("default", defaultYes ? 0 : 1);
        return table.prompts().ask("confirm", payload, table.spawningPid(), reply -> {
            final int i = reply.getAsInt();
            if (i < 0 || i > 1) {
                throw new PromptService.InvalidReply("Invalid option");
            }
            return i == 0;
        }, new JsonPrimitive(defaultYes ? 0 : 1));
    }

    @Override
    public int showOptionDialog(final String message, final String title, final FSkinProp icon, final List<String> options, final int defaultOption) {
        return table.askOptions(title, message, options, defaultOption);
    }

    @Override
    public String showInputDialog(final String message, final String title, final FSkinProp icon, final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
        return table.askText(title, message, initialInput, inputOptions, isNumeric);
    }
}

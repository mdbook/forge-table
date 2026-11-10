package forge.bridge;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.ai.AiProfileUtil;
import forge.bridge.art.CardArtIndex;
import forge.bridge.art.CardArtService;
import forge.bridge.match.TableSession;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.GameRules;
import forge.game.GameState;
import forge.game.GameType;
import forge.game.player.RegisteredPlayer;
import forge.gamemodes.match.HostedMatch;
import forge.gui.interfaces.IGuiGame;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.player.LobbyPlayerHuman;
import forge.util.BuildInfo;

/**
 * The sidecar's application state: the connected client, the current match, and the allow-listed RPC
 * methods (no filesystem paths in the protocol). One match per sidecar; router mode runs one sidecar per game.
 *
 * <p>Seats. Against the AI there is one seat (0), whoever holds the token. With {@code --pvp} (a game between two
 * people behind the router) there are two, and the router stamps each browser's
 * {@code hello} with its {@code seat} and {@code name} (a browser never picks its seat: only a hello carrying this
 * process's token gets here). Each seat has its own connection, client settings, deck folders and, once both have
 * picked a deck, its own {@link TableSession} (outbox, pacer, prompts and GUI), so everything sent to a seat is
 * projected for that seat's player only.
 */
public final class BridgeApp implements BridgeGuiBase.DialogRouter {

    /** Options from the command line. */
    public static final class Options {
        public int port;
        public String assetsDir;
        public String webDir;
        public final List<String> deckDirs = new ArrayList<>();
        public String deck;
        public String oppDeck;
        /** AI profile; null means Neural when it can be seated here, else Default. */
        public String ai;
        public String state;
        public double speed = 1.0;
        public String record;
        public boolean openBrowser;
        public boolean testPrefs;
        /** curated | printed | off; null means curated (off with --test-prefs). */
        public String cardArt;
        /** A {@code card_images.json} to use instead of building one from Scryfall. */
        public String cardImageMap;
        /**
         * Decks by bare name from the deck folders only, and no board-state file from the client (router mode
         * passes it: a browser must not name paths).
         */
        public boolean namesOnly;
        /** Print boot progress lines before the ready line (router mode passes it). */
        public boolean progress;
        /** Two people, seat 0 and seat 1, each from a router-stamped hello. */
        public boolean pvp;
        /** pvp: seat 1's own deck folder (the router drops the deck its player joined with there). */
        public String seat1Decks;
        /** {@link Formats#BRAWL}, {@link Formats#STANDARD}, or null for Constructed: the lobby's choice for this game (a client may pick it too, but not in pvp). */
        public String format;
        /** pvp: how long a seat must have been away before the other may claim the win (2 min). */
        public long claimAfterMs = 120_000;
        /** Where to keep the game in progress ({@link Checkpointer}); null keeps nothing. */
        public String checkpoint;
        /** Start by picking up the game saved in {@link #checkpoint}, not from the start screen. */
        public boolean resume;
        /** Operator-only text logs; null disables them. Separate from training captures and uploads. */
        public String gameLogDir;
        public String gameLogId;
        public int gameLogKeep = 200;
        public long gameLogMaxBytes = 4 * 1024 * 1024;
    }

    /** One person at the table. Fields change under {@code clientLock}; the volatile ones are also read without it. */
    private static final class Seat {
        final int index;
        volatile Consumer<String> sink;
        JsonObject clientInfo;
        volatile TableSession table;
        /** pvp: the name the router stamped into this seat's hello (null until it has connected once). */
        volatile String name;
        /** pvp: the deck picked with match.start; the match starts once both seats have one. */
        volatile Deck deck;
        /** pvp: when this seat last connected or left. Always written before {@link #sink}. */
        volatile long since = System.currentTimeMillis();
        /** pvp, after a game: this seat asked for (or said yes to) a rematch. */
        volatile boolean wantsRematch;
        /** pvp, after a game: this seat pressed Leave, so there is no rematch unless it asks for one after all. */
        volatile boolean left;

        Seat(final int index) {
            this.index = index;
        }
    }

    private final BridgeGuiBase base;
    private final Options options;
    private final String token;
    private final String sessionId;
    private final NeuralStatus neural;
    private final String defaultAi;
    private final CardArtService art;
    /** Null without {@code --checkpoint}. */
    private final Checkpointer checkpointer;
    private final TextGameLogs gameLogs;
    /** pvp {@code --resume}: the board to pick up once both seats are back (clientLock); null when not waiting. */
    private volatile List<String> pvpResume;

    private final Object clientLock = new Object();
    private final Seat[] seats = {new Seat(0), new Seat(1)};
    /** Which seat each open connection said hello for (clientLock). */
    private final Map<Consumer<String>, Seat> sinkSeats = new IdentityHashMap<>();
    private volatile HostedMatch match;
    private volatile boolean played;
    /** Each game this process saw end, oldest first, for the router's results ({@code /status} {@code results}). */
    private final List<JsonObject> results = new ArrayList<>();
    private final Set<Integer> resultIds = new java.util.HashSet<>();
    /**
     * pvp: a game was played and a seat asked for a rematch. Both seats are back on the start screen (decks cleared),
     * and the next match starts once both are ready again, as the first one did.
     */
    private volatile boolean rematch;
    private volatile Writer recorder;

    /**
     * The last non-pvp {@code match.start}'s deck choices, remembered so a Rematch ({@code act nextGame NEW})
     * can re-roll any seat whose choice was "Random deck" instead of Java's own restart, which just
     * reuses the same {@code RegisteredPlayer}s and so the same resolved decks.
     */
    private volatile boolean deckWasRandom;
    private volatile boolean oppDeckWasRandom;
    private volatile String lastFormat;
    private volatile String lastAi;
    private volatile String lastDeckName;
    private volatile String lastOppDeckName;

    public BridgeApp(final BridgeGuiBase base, final Options options, final String token, final String sessionId) {
        this.base = base;
        this.options = options;
        this.token = token;
        this.sessionId = sessionId;
        this.neural = NeuralStatus.probe();
        this.defaultAi = options.ai != null ? options.ai : neural.ok() ? GamePlayerUtil.NEURAL_PROFILE : "Default";
        if (!neural.ok()) {
            BridgeLog.info("Neural opponent unavailable: " + neural.reason());
        }
        final CardArtService.Mode artMode = options.cardArt != null ? CardArtService.Mode.parse(options.cardArt)
                : options.testPrefs ? CardArtService.Mode.OFF : CardArtService.Mode.CURATED;
        final Path tableCache = Path.of(ForgeConstants.CACHE_DIR, "table");
        this.art = new CardArtService(artMode, tableCache.resolve("art"),
                options.cardImageMap != null ? Path.of(options.cardImageMap) : CardArtIndex.builtFile(tableCache),
                options.cardImageMap != null, BuildInfo.getUserAgent() + " ForgeTable");
        this.checkpointer = options.checkpoint == null ? null : new Checkpointer(Path.of(options.checkpoint));
        this.gameLogs = options.gameLogDir == null || options.gameLogDir.isBlank() ? null
                : new TextGameLogs(Path.of(options.gameLogDir), options.gameLogId == null ? sessionId : options.gameLogId,
                        options.gameLogKeep, options.gameLogMaxBytes);
        base.setDialogRouter(this);
    }

    public String token() { return token; }

    /** Waits for the checkpoint writes queued so far (before the process exits, and for tests). */
    public void flushCheckpoint() {
        if (checkpointer != null) {
            checkpointer.flush();
        }
    }
    /** The match being played, or null (tests look at the engine through it). */
    HostedMatch match() { return match; }
    public Options options() { return options; }
    public CardArtService art() { return art; }

    /**
     * waiting (no match yet), playing, or over (no game running or starting, and one was played). Router mode polls
     * it and closes an "over" game after a grace period, so anything still in play must read "playing".
     */
    public String state() {
        final HostedMatch hm = match;
        if (hm == null) {
            return state(false, false, false, played);
        }
        final forge.game.Game g = hm.getGame();
        return state(true, g != null && !g.isGameOver(), hm.isMatchOver(), played);
    }

    /**
     * The table for the lobby's game card ({@code /status}'s {@code table}): the turn, whose turn it is
     * (a seat: the order the players were registered in, so the human is 0 against the AI) and per seat its life,
     * deck name and the card whose art stands for the deck. Null before a game is dealt. Read off the game's thread:
     * a stale number is fine, a throw is not.
     */
    public JsonObject table() {
        final HostedMatch hm = match;
        final forge.game.Game g = hm == null ? null : hm.getGame();
        if (g == null) {
            return null;
        }
        try {
            final List<forge.game.player.Player> ps = new ArrayList<>(g.getRegisteredPlayers());
            final JsonObject t = new JsonObject();
            t.addProperty("turn", g.getPhaseHandler().getTurn());
            t.addProperty("active", ps.indexOf(g.getPhaseHandler().getPlayerTurn()));
            final JsonArray seats = new JsonArray();
            for (final forge.game.player.Player p : ps) {
                final JsonObject seat = new JsonObject();
                seat.addProperty("life", p.getLife());
                final Deck d = p.getRegisteredPlayer() == null ? null : p.getRegisteredPlayer().getDeck();
                if (d != null) {
                    seat.addProperty("deck", d.getName());
                    final String key = keyCard(d);
                    if (key != null) {
                        seat.addProperty("key", key);
                    }
                }
                seats.add(seat);
            }
            t.add("seats", seats);
            return t;
        } catch (final RuntimeException e) {
            return null;
        }
    }

    /** At most this many results kept in memory (a game process plays a handful; the router keeps its own copy). */
    static final int MAX_RESULTS = 200;

    /**
     * A game ended: remember its result once (both seats of a pvp game report it). Per seat, in registration order
     * (the seats of {@link #table()}): its deck name and "won", "lost" or "draw", and whether it conceded.
     */
    void gameFinished(final forge.game.Game g) {
        if (checkpointer != null) {
            checkpointer.clear();
        }
        final forge.game.GameOutcome o = g.getOutcome();
        if (o == null) {
            return;
        }
        final JsonObject r = new JsonObject();
        r.addProperty("g", g.getId());
        final JsonArray seats = new JsonArray();
        for (final forge.game.player.Player p : g.getRegisteredPlayers()) {
            final JsonObject seat = new JsonObject();
            final RegisteredPlayer rp = p.getRegisteredPlayer();
            final Deck d = rp == null ? null : rp.getDeck();
            if (d != null && d.getName() != null) {
                seat.addProperty("deck", d.getName());
            }
            seat.addProperty("r", o.isDraw() ? "draw" : rp != null && o.isWinner(rp) ? "won" : "lost");
            if (p.getOutcome() != null && p.getOutcome().lossState == forge.game.player.GameLossReason.Conceded) {
                seat.addProperty("conceded", true);
            }
            seats.add(seat);
        }
        r.add("seats", seats);
        synchronized (results) {
            if (!resultIds.add(g.getId())) {
                return;
            }
            results.add(r);
            if (results.size() > MAX_RESULTS) {
                // both seats report a game as it ends, never 200 games later: its id can go with it
                resultIds.remove(results.remove(0).get("g").getAsInt());
            }
        }
    }

    /** Both logging and checkpointing subscribe before the game asks for its first priority. */
    private void gameAttached(final forge.game.Game game) {
        if (gameLogs != null) {
            gameLogs.watch(game);
        }
        if (checkpointer != null) {
            checkpointer.watch(game);
        }
    }

    /** The games this process saw end ({@code /status} {@code results}): {@code [{g, seats: [{deck?, r, conceded?}]}]}. */
    public JsonArray results() {
        final JsonArray a = new JsonArray();
        synchronized (results) {
            results.forEach(r -> a.add(r.deepCopy()));
        }
        return a;
    }

    /** {@link forge.bridge.router.DeckSummary#key}'s rule on a loaded deck. */
    static String keyCard(final Deck d) {
        final List<forge.item.PaperCard> cmd = d.getCommanders();
        final Map<String, Integer> main = new LinkedHashMap<>();
        for (final Map.Entry<forge.item.PaperCard, Integer> e : d.getMain()) {
            if (!e.getKey().getRules().getType().isBasicLand()) {
                main.merge(e.getKey().getName(), e.getValue(), Integer::sum);
            }
        }
        return forge.bridge.router.DeckSummary.key(cmd.isEmpty() ? null : cmd.get(0).getName(), main);
    }

    /**
     * {@link #state()} from its parts. A game in progress is "playing" whatever the match says: after a rematch or
     * the next game, HostedMatch's match-over flag stays set from the game before until the new one ends. A match
     * between games (or whose first game isn't dealt yet) is "playing" too, unless it is over.
     */
    static String state(final boolean hasMatch, final boolean gameInProgress, final boolean matchOver, final boolean played) {
        if (gameInProgress) {
            return "playing";
        }
        if (hasMatch) {
            return matchOver ? "over" : "playing";
        }
        return played ? "over" : "waiting";
    }

    // ---------------------------------------------------------------- connection

    /**
     * A client sent a hello carrying this process's token. Called on the network thread.
     *
     * @return false (close the socket) when a pvp hello names no seat: only the router, which knows the token,
     *         stamps one, so that is never a real browser.
     */
    public boolean onHello(final Consumer<String> newSink, final JsonObject hello) {
        final Seat s = seatOf(hello);
        if (s == null) {
            BridgeLog.warn("Refused a hello without a seat");
            return false;
        }
        final JsonObject client = hello.has("client") ? hello.getAsJsonObject("client") : new JsonObject();
        final TableSession t;
        synchronized (clientLock) {
            final Consumer<String> old = s.sink;
            final TableSession cur = s.table;
            if (old != null && cur != null) {
                cur.detach(old);
            }
            if (options.pvp) {
                final String n = cleanName(hello.get("name"));
                if (n != null) {
                    s.name = n;
                }
                s.since = System.currentTimeMillis();
            }
            s.sink = newSink;
            s.clientInfo = client;
            sinkSeats.put(newSink, s);
            t = cur;
        }
        final JsonObject welcome = new JsonObject();
        welcome.addProperty("t", "welcome");
        welcome.addProperty("proto", 1);
        welcome.addProperty("session", sessionId);
        welcome.addProperty("forgeVersion", base.getCurrentVersion());
        final JsonArray features = new JsonArray();
        features.add("pid");
        features.add("settle");
        welcome.add("features", features);
        welcome.addProperty("match", t != null);
        if (t != null && !options.pvp && lastAi != null) {
            welcome.addProperty("ai", lastAi); // the running match's AI, as match.start answered it
        }
        final JsonObject defaults = new JsonObject();
        final String deck = defaultDeck(s);
        if (deck != null) {
            defaults.addProperty("deck", deck);
        }
        if (options.oppDeck != null && !options.pvp) {
            defaults.addProperty("oppDeck", options.oppDeck);
        }
        defaults.addProperty("ai", defaultAi);
        welcome.add("defaults", defaults);
        if (options.format != null) {
            welcome.addProperty("format", options.format);
        }
        welcome.add("neural", neural.toJson(listDecks(s), art.mode() != CardArtService.Mode.OFF));
        if (options.pvp) {
            final JsonObject pvp = lobby(s);
            pvp.remove("t");
            pvp.remove("kind");
            pvp.addProperty("seat", s.index);
            welcome.add("pvp", pvp);
        }
        welcome.addProperty("cardArt", art.mode().name().toLowerCase());
        // A packaged build says what it is in version.json beside res/ (forge_sha, built_at); a dev run has none.
        try {
            final JsonObject v = JsonParser.parseString(Files.readString(Path.of(options.assetsDir, "version.json"))).getAsJsonObject();
            final JsonObject build = new JsonObject();
            build.addProperty("sha", v.get("forge_sha").getAsString());
            build.addProperty("builtAt", v.get("built_at").getAsString());
            welcome.add("build", build);
        } catch (final java.io.IOException | RuntimeException e) {
            // not a packaged build
        }
        newSink.accept(Outboxes.toJson(welcome));
        if (t != null) {
            t.attach(newSink, client);
        }
        if (options.pvp) {
            final Seat o = other(s);
            if (match == null) {
                send(s, lobby(s));
                send(o, lobby(o));
            }
            send(s, presence(s, true));
            send(o, presence(o, true));
            synchronized (clientLock) {
                // A resumed game goes on once both seats are back (after their welcomes: the deal attaches them).
                if (pvpResume != null && match == null && seats[0].sink != null && seats[1].sink != null) {
                    final List<String> state = pvpResume;
                    pvpResume = null;
                    startPvpMatch(state);
                }
            }
        }
        return true;
    }

    public void onClose(final Consumer<String> closed) {
        final Seat s;
        synchronized (clientLock) {
            s = sinkSeats.remove(closed);
            if (s == null || s.sink != closed) {
                return;
            }
            if (options.pvp) {
                s.since = System.currentTimeMillis();
            }
            s.sink = null;
            final TableSession t = s.table;
            if (t != null) {
                t.detach(closed);
            }
        }
        if (options.pvp) {
            final Seat o = other(s);
            send(o, presence(o, true));
        }
    }

    /** A message from the authenticated client. Called on the network thread. */
    public void onMessage(final Consumer<String> from, final JsonObject msg) {
        final Seat s;
        synchronized (clientLock) {
            s = sinkSeats.get(from);
        }
        if (s == null) {
            return; // its socket has closed meanwhile
        }
        final String t = msg.has("t") ? msg.get("t").getAsString() : "";
        if ("rpc".equals(t)) {
            final String id = msg.has("id") ? msg.get("id").getAsString() : "";
            final String method = msg.has("method") ? msg.get("method").getAsString() : "";
            final JsonObject params = msg.has("params") && msg.get("params").isJsonObject() ? msg.getAsJsonObject("params") : new JsonObject();
            base.serviceExecutor().execute(() -> answerRpc(from, s, id, method, params));
            return;
        }
        if ("act".equals(t)) {
            if (options.pvp && !pvpAct(s, msg)) {
                return;
            }
            if (!options.pvp && !handleRematch(msg)) {
                return;
            }
            rememberClientPref(s, msg);
        }
        final TableSession cur = s.table;
        if (cur != null) {
            cur.onClientMessage(msg);
        }
    }

    /** Per-viewer toggles sent as acts outlive the match: the next match starts from them, not the hello's. */
    private void rememberClientPref(final Seat s, final JsonObject act) {
        final String kind = act.has("kind") ? act.get("kind").getAsString() : "";
        final String key;
        final JsonElement value;
        switch (kind) {
            case "autoSkip" -> {
                key = "autoSkip";
                value = act.get("on");
            }
            case "speed" -> {
                key = "speed";
                value = act.get("value");
            }
            default -> {
                return;
            }
        }
        if (value == null || !value.isJsonPrimitive()) {
            return;
        }
        synchronized (clientLock) {
            final JsonObject c = s.clientInfo == null ? new JsonObject() : s.clientInfo.deepCopy();
            c.add(key, value);
            s.clientInfo = c;
        }
    }

    private void answerRpc(final Consumer<String> to, final Seat s, final String id, final String method, final JsonObject params) {
        final JsonObject res = new JsonObject();
        res.addProperty("t", "rpcResult");
        res.addProperty("id", id);
        try {
            final JsonElement value = rpc(s, method, params);
            res.addProperty("ok", true);
            if (value != null) {
                res.add("value", value);
            }
        } catch (final RuntimeException e) {
            BridgeLog.error("rpc " + method + " failed", e);
            res.addProperty("ok", false);
            res.addProperty("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        to.accept(Outboxes.toJson(res));
    }

    private JsonElement rpc(final Seat s, final String method, final JsonObject params) {
        switch (method) {
            case "decks.list": {
                final JsonArray arr = new JsonArray();
                listDecks(s, format(params, s)).forEach(arr::add);
                return arr;
            }
            case "decks.problems":
                return deckProblems(s, format(params, s));
            case "ai.profiles": {
                final JsonArray arr = new JsonArray();
                AiProfileUtil.getProfilesDisplayList().forEach(arr::add);
                return arr;
            }
            case "decks.import":
                if (options.pvp && s.index != 0) {
                    throw new IllegalArgumentException("Import decks in the lobby, then join with one of them.");
                }
                return DeckImport.run(params, new File(ForgeConstants.DECK_CONSTRUCTED_DIR), this::deckExists);
            case "match.start":
                return options.pvp ? pvpReady(s, params) : startMatch(params);
            case "match.leave":
                if (options.pvp) {
                    concedeSeat(s.index);
                } else {
                    endMatch();
                }
                return null;
            default:
                throw new IllegalArgumentException("Unknown method " + method);
        }
    }

    // ---------------------------------------------------------------- matches

    private JsonElement startMatch(final JsonObject params) {
        if (options.namesOnly && params.has("state")) {
            throw new IllegalArgumentException("Board states aren't available here");
        }
        final Seat me = seats[0];
        if (me.table != null) {
            endMatch();
        }
        final String format = format(params, me);
        final String deckName = str(params, "deck", options.deck);
        final String ai = usableAi(str(params, "ai", defaultAi));
        final boolean neuralSeat = GamePlayerUtil.NEURAL_PROFILE.equalsIgnoreCase(ai);
        // Neural's own default is the strongest deck it was trained on (the start screen preselects the same). Only in
        // Constructed: the trained decks are Pauper, so a Standard game falls through to my own deck (as with Forge AI)
        // and a Brawl game to a random Brawl deck.
        final List<String> trained = neuralSeat && format == null ? neural.decksIn(listDecks(me)) : List.of();
        if (deckName == null) {
            throw new IllegalArgumentException("No deck given");
        }
        final Deck mine = loadDeck(deckName, me, format);
        checkDeck(format, mine);
        final String oppName = str(params, "oppDeck", options.oppDeck != null ? options.oppDeck : !trained.isEmpty() ? trained.get(0)
                : Formats.isBrawl(format) ? null : deckName);
        // Brawl without an opponent's deck: one of the shared Brawl decks that is legal, at random.
        final Deck theirs = oppName != null ? loadDeck(oppName, me, format) : randomBrawlDeck();
        checkDeck(format, theirs);

        // Remembered for Rematch: whether each seat's choice was "Random deck", not just the
        // concrete deck it resolved to here.
        deckWasRandom = params.has("deckRandom") && params.get("deckRandom").getAsBoolean();
        oppDeckWasRandom = params.has("oppDeckRandom") && params.get("oppDeckRandom").getAsBoolean();
        // The client-facing (file) name, not Deck.getName() (the [metadata] Name, which can differ: a sanitized
        // file name, a hand-renamed .dck) -- this is what loadDeck resolves and what the reroll pool is named by.
        return beginMatch(format, ai, deckName, mine, oppName != null ? oppName : theirs.getName(), theirs,
                readState(str(params, "state", options.state)));
    }

    /** {@code ai}, or the Default Forge AI (saying so) when it is Neural and Neural can't be seated here. */
    private String usableAi(final String ai) {
        if (GamePlayerUtil.NEURAL_PROFILE.equalsIgnoreCase(ai) && !neural.ok()) {
            toast("error", "Neural opponent unavailable", neural.reason() + ". This game uses the Default Forge AI.");
            return "Default";
        }
        return ai;
    }

    /**
     * {@code --resume}: picks up the game saved in the checkpoint, with the decks saved beside it. Against the AI it
     * is dealt at once (the player finds it in progress when they connect); between two people it waits until
     * both seats are back ({@link #onHello}). A checkpoint that can't be resumed is moved aside
     * ({@link Checkpointer#discard}) and leaves the start screen, as without {@code --resume}.
     */
    public void resume() {
        if (checkpointer == null || !options.resume) {
            return;
        }
        try {
            final JsonObject c = Checkpointer.read(checkpointer.file());
            final List<String> state = Checkpointer.stateLines(c);
            final Deck d0 = Checkpointer.deck(checkpointer.file(), 0);
            final Deck d1 = Checkpointer.deck(checkpointer.file(), 1);
            BridgeLog.info("resuming the game saved at turn " + c.get("turn") + ", " + c.get("phase"));
            if (options.pvp) {
                synchronized (clientLock) {
                    seats[0].deck = d0;
                    seats[1].deck = d1;
                    final JsonArray names = c.has("names") ? c.getAsJsonArray("names") : new JsonArray();
                    for (int i = 0; i < names.size() && i < seats.length; i++) {
                        seats[i].name = names.get(i).getAsString();
                    }
                    pvpResume = state;
                }
                return;
            }
            deckWasRandom = c.has("deckRandom") && c.get("deckRandom").getAsBoolean();
            oppDeckWasRandom = c.has("oppDeckRandom") && c.get("oppDeckRandom").getAsBoolean();
            beginMatch(str(c, "format", options.format), usableAi(str(c, "ai", defaultAi)), str(c, "deck", d0.getName()), d0,
                    str(c, "oppDeck", d1.getName()), d1, state);
        } catch (final RuntimeException e) {
            BridgeLog.error("could not resume the saved game", e);
            checkpointer.discard();
        }
    }

    /**
     * Deals a match against the AI with decks already loaded, from {@code stateLines} (a board state) when not null,
     * and answers what it started ({@code match.start}'s value).
     */
    private JsonObject beginMatch(final String format, final String ai, final String deckName, final Deck mine,
            final String oppName, final Deck theirs, final List<String> stateLines) {
        final Seat me = seats[0];
        if (me.table != null) {
            endMatch();
        }
        final boolean neuralSeat = GamePlayerUtil.NEURAL_PROFILE.equalsIgnoreCase(ai);
        lastFormat = format;
        lastAi = ai;
        lastDeckName = deckName;
        lastOppDeckName = oppName;

        final RegisteredPlayer human = registered(format, mine);
        human.setPlayer(GamePlayerUtil.getGuiPlayer());
        final RegisteredPlayer opp = registered(format, theirs);
        // A board fixture replaces the opening hands, as puzzles do: no mulligan, state applied at turn 1.
        final Map<RegisteredPlayer, Integer> handSizes = stateLines != null ? withoutOpeningHands(List.of(human, opp)) : null;
        // Constructing the lobby player loads the Neural model when that profile is chosen (bridge-svc).
        opp.setPlayer(GamePlayerUtil.createAiPlayer(theirs.getName(), ai));

        final GameRules rules = new GameRules(GameType.Constructed);
        rules.setGamesPerMatch(1); // Bo1 until sideboarding lands
        rules.setManaBurn(FModel.getPreferences().getPrefBoolean(FPref.LEGACY_MANABURN));
        rules.setOrderCombatants(FModel.getPreferences().getPrefBoolean(FPref.LEGACY_ORDER_COMBATANTS));
        rules.setUseGrayText(FModel.getPreferences().getPrefBoolean(FPref.UI_GRAY_INACTIVE_TEXT));
        // Forge's "the AI can't play these cards well" warning is about its own AI, not the Neural one.
        rules.setWarnAboutAICards(!neuralSeat);

        final TableSession t = new TableSession(base);
        t.setOnGameFinished(this::gameFinished);
        t.setOnGameAttached(this::gameAttached);
        if (options.speed != 1.0) {
            t.pacer().setSpeed(options.speed);
        }
        final Writer rec = recorder();
        if (rec != null) {
            t.outbox().setRecorder(rec);
        }
        if (checkpointer != null) {
            final JsonObject settings = new JsonObject();
            if (format != null) {
                settings.addProperty("format", format);
            }
            settings.addProperty("ai", ai);
            settings.addProperty("deck", deckName);
            settings.addProperty("oppDeck", oppName);
            settings.addProperty("deckRandom", deckWasRandom);
            settings.addProperty("oppDeckRandom", oppDeckWasRandom);
            checkpointer.begin(settings, mine, theirs);
        }
        final HostedMatch hm = new HostedMatch();
        if (stateLines != null) {
            hm.setStartGameHook(() -> applyBoard(hm.getGame(), stateLines, handSizes));
        }
        t.setOnMatchEnded(() -> {
            if (me.table == t) {
                me.table = null;
                match = null;
            }
        });
        base.setAfterUiTask(t::flushPrompt);
        synchronized (clientLock) {
            me.table = t;
            match = hm;
            played = true;
            if (me.sink != null) {
                t.attach(me.sink, me.clientInfo);
            }
        }
        base.invokeInEdtLater(() -> hm.startMatch(rules, variants(format), List.of(human, opp), human, t.gui()));
        final JsonObject res = new JsonObject();
        res.addProperty("deck", mine.getName());
        res.addProperty("oppDeck", theirs.getName());
        res.addProperty("ai", ai);
        if (format != null) {
            res.addProperty("format", format);
        }
        return res;
    }

    /**
     * Registers {@code players} to be dealt no opening hand (a board state replaces it, as puzzles do) and answers each
     * one's real hand size, for {@link #applyBoard} to put back. Forge keeps one number per player for both the
     * opening draw and the maximum hand size ({@code Game} copies {@code RegisteredPlayer.startingHand} into both, and a
     * static effect ending resets the maximum to it), so zeroing it alone left a board or resumed game with a maximum
     * hand size of 0: cleanup made the player discard the whole hand.
     */
    static Map<RegisteredPlayer, Integer> withoutOpeningHands(final List<RegisteredPlayer> players) {
        final Map<RegisteredPlayer, Integer> sizes = new IdentityHashMap<>();
        for (final RegisteredPlayer rp : players) {
            sizes.put(rp, rp.getStartingHand());
            rp.setStartingHand(0);
        }
        return sizes;
    }

    /**
     * The start hook of a game from a board state: once the (empty) opening hands are dealt, puts back each player's
     * real hand size ({@link #withoutOpeningHands}) and lays the board on the game.
     */
    static void applyBoard(final forge.game.Game game, final List<String> stateLines, final Map<RegisteredPlayer, Integer> handSizes) {
        for (final forge.game.player.Player p : game.getRegisteredPlayers()) {
            final Integer size = handSizes.get(p.getRegisteredPlayer());
            if (size == null) {
                throw new IllegalStateException("no registered hand size for " + p);
            }
            p.setStartingHandSize(size);
            p.setMaxHandSize(size);
        }
        final GameState gs = new GameState();
        gs.parse(stateLines);
        gs.applyToGame(game);
    }

    /**
     * Acts this (non-pvp) bridge answers itself before {@code TableSession} sees them: a Rematch (act
     * {@code nextGame NEW}) when the match just played had a seat whose deck choice was "Random deck".
     * Java's own restart ({@code HostedMatch.restartMatch}) just replays the same {@code RegisteredPlayer}s, so
     * the same resolved decks; a random seat needs a fresh draw instead. Other acts, and a
     * Rematch where nothing was random, pass through unchanged. False: handled, nothing more to do.
     */
    private boolean handleRematch(final JsonObject act) {
        if (!(deckWasRandom || oppDeckWasRandom)) {
            return true;
        }
        final String kind = act.has("kind") ? act.get("kind").getAsString() : "";
        if (!"nextGame".equals(kind) || !act.has("decision") || !"NEW".equals(act.get("decision").getAsString())) {
            return true;
        }
        // Loads decks from disk, as match.start's rpc handler does: off the network thread, same as that rpc.
        base.serviceExecutor().execute(this::rematch);
        return false;
    }

    /**
     * Starts a brand new match reusing the last one's format and AI, re-rolling the deck for any seat whose
     * choice was "Random deck" and keeping the other seat's as is, then runs it through {@link #startMatch}
     * exactly like a fresh Start press (it already tears down the just-finished table first). The re-roll flags
     * carry over, so the next Rematch re-rolls again too.
     */
    private void rematch() {
        final Seat me = seats[0];
        final JsonObject params = new JsonObject();
        if (lastFormat != null) {
            params.addProperty("format", lastFormat);
        }
        if (lastAi != null) {
            params.addProperty("ai", lastAi);
        }
        params.addProperty("deck", deckWasRandom ? reroll(legalDeckNames(me, lastFormat), lastDeckName, ThreadLocalRandom.current()) : lastDeckName);
        params.addProperty("deckRandom", deckWasRandom);
        params.addProperty("oppDeck",
                oppDeckWasRandom ? reroll(legalDeckNames(me, lastFormat), lastOppDeckName, ThreadLocalRandom.current()) : lastOppDeckName);
        params.addProperty("oppDeckRandom", oppDeckWasRandom);
        startMatch(params);
    }

    /**
     * A fresh deck for a Rematch re-roll: one of {@code pool}, skipping {@code previous} when the pool has another
     * to draw (no immediate repeat). Keeps {@code previous} when the pool is empty (nothing else to play) or
     * down to just the one deck. Pure over the pool, so a unit test can drive it with a seeded {@code Random}
     * without booting the engine.
     */
    static String reroll(final List<String> pool, final String previous, final java.util.Random rng) {
        if (pool.isEmpty()) {
            return previous;
        }
        if (pool.size() == 1) {
            return pool.get(0);
        }
        String pick;
        do {
            pick = pool.get(rng.nextInt(pool.size()));
        } while (previous != null && pick.equalsIgnoreCase(previous));
        return pick;
    }

    /**
     * The deck names seat {@code s} can currently choose from: {@link #listDecks}, narrowed to the legal ones when
     * {@code format} is set: the same pool its "Random deck" picker lists and draws from.
     */
    private List<String> legalDeckNames(final Seat s, final String format) {
        return legalDeckNames(deckDirs(s, format), format);
    }

    /** {@link #legalDeckNames(Seat, String)}, from the deck folders directly (no format: every name, filesystem only). */
    static List<String> legalDeckNames(final List<File> dirs, final String format) {
        final List<String> names = deckNames(dirs);
        if (format == null) {
            return names;
        }
        final List<String> legal = new ArrayList<>();
        for (final String n : names) {
            try {
                if (Formats.problem(format, loadNamedDeck(n, dirs)) == null) {
                    legal.add(n);
                }
            } catch (final RuntimeException e) {
                // Unreadable: not legal, not worth drawing (consistent with deckProblems/randomBrawlDeck).
            }
        }
        return legal;
    }

    // ---------------------------------------------------------------- formats

    /**
     * The format a request plays in: the game's ({@code --format}). Only a local run (not pvp, not router-hosted with
     * {@code --names-only}) lets the client choose.
     */
    private String format(final JsonObject params, final Seat s) {
        return options.pvp || options.namesOnly ? options.format : Formats.parse(str(params, "format", options.format));
    }

    /** Refuses a deck that can't be played in {@code format}, saying why. */
    private static void checkDeck(final String format, final Deck deck) {
        final String problem = Formats.problem(format, deck);
        if (problem != null) {
            throw new IllegalArgumentException(problem);
        }
    }

    /** Brawl seats a commander from the deck's Commander section and starts at 25 life (two players). */
    private static RegisteredPlayer registered(final String format, final Deck deck) {
        return !Formats.isBrawl(format) ? new RegisteredPlayer(deck) : RegisteredPlayer.forVariants(2, variants(format), deck, null, false, null, null);
    }

    /** Forge's Brawl variant: command zone, commander tax, the first mulligan free, no commander damage. Standard: none. */
    private static Set<GameType> variants(final String format) {
        return Formats.isBrawl(format) ? EnumSet.of(GameType.Brawl) : null;
    }

    /** The shared Brawl decks (from the wiki's mtg/brawl pages), shipped in res/. */
    private static File brawlDecks() {
        return new File(ForgeConstants.RES_DIR + "forge-table" + File.separator + "brawl-decks");
    }

    /**
     * One of the shared Brawl decks that is legal, at random: the AI's deck when none is chosen. A deck that can't be
     * read is skipped, not the game (a non-ASCII file name under a non-UTF-8 locale).
     */
    static Deck randomBrawlDeck() {
        final List<File> dirs = List.of(brawlDecks());
        final List<Deck> legal = new ArrayList<>();
        for (final String n : deckNames(dirs)) {
            final Deck d;
            try {
                d = loadNamedDeck(n, dirs);
            } catch (final RuntimeException e) {
                BridgeLog.info("Brawl deck skipped, can't be read: " + n);
                continue;
            }
            if (Formats.problem(Formats.BRAWL, d) == null) {
                legal.add(d);
            }
        }
        if (legal.isEmpty()) {
            throw new IllegalArgumentException("No Brawl deck for the AI. Pick one.");
        }
        return legal.get(ThreadLocalRandom.current().nextInt(legal.size()));
    }

    /** {@code decks.problems}: each of the seat's decks that can't be played in {@code format}, with why. */
    private JsonObject deckProblems(final Seat s, final String format) {
        final JsonObject out = new JsonObject();
        if (format == null) {
            return out;
        }
        final List<File> dirs = deckDirs(s, format);
        for (final String n : deckNames(dirs)) {
            String problem;
            try {
                problem = Formats.problem(format, loadNamedDeck(n, dirs));
            } catch (final RuntimeException e) {
                problem = n + " can't be read";
            }
            if (problem != null) {
                out.addProperty(n, problem);
            }
        }
        return out;
    }

    private void endMatch() {
        final TableSession t = seats[0].table;
        final HostedMatch hm = match;
        seats[0].table = null;
        match = null;
        if (checkpointer != null) {
            checkpointer.clear();
        }
        if (t != null) {
            t.close();
            base.invokeInEdtLater(() -> {
                for (final forge.interfaces.IGameController c : t.gui().getOriginalGameControllers()) {
                    c.concede();
                }
                if (hm != null && hm.getGame() != null && !hm.isMatchOver()) {
                    hm.endCurrentGame();
                }
            });
        }
    }

    /** Lines of a GameState file ({@code --state}): the {@code [state]} section of a .pzl, or the whole file. */
    private static List<String> readState(final String path) {
        if (path == null) {
            return null;
        }
        try {
            final List<String> all = java.nio.file.Files.readAllLines(new File(path).toPath(), StandardCharsets.UTF_8);
            final int idx = all.indexOf("[state]");
            return idx < 0 ? all : all.subList(idx + 1, all.size());
        } catch (final java.io.IOException e) {
            throw new IllegalArgumentException("Cannot read state " + path + ": " + e.getMessage());
        }
    }

    private static String str(final JsonObject o, final String key, final String dflt) {
        return o.has(key) && !o.get(key).isJsonNull() && !o.get(key).getAsString().isEmpty() ? o.get(key).getAsString() : dflt;
    }

    /**
     * A seat's deck folders: the shared ones ({@code --decks}), then its own. Seat 0's own are the user's constructed
     * decks; in pvp, seat 1's own are only the deck it joined with ({@code --seat1-decks}), never seat 0's. A Brawl
     * game also offers the shared Brawl decks ({@link #brawlDecks()}), last, so a deck of the player's own wins a name clash.
     */
    private List<File> deckDirs(final Seat s, final String format) {
        final List<File> dirs = new ArrayList<>();
        for (final String d : options.deckDirs) {
            dirs.add(new File(d));
        }
        if (s.index == 0) {
            dirs.add(new File(ForgeConstants.DECK_CONSTRUCTED_DIR));
        } else if (options.seat1Decks != null) {
            dirs.add(new File(options.seat1Decks));
        }
        if (Formats.isBrawl(format)) {
            dirs.add(brawlDecks());
        }
        return dirs;
    }

    /** Whether a deck file of this base name exists in any of seat 0's deck folders (case-insensitive, as listed). */
    private boolean deckExists(final String baseName) {
        for (final String n : listDecks(seats[0], null)) {
            if (n.equalsIgnoreCase(baseName)) {
                return true;
            }
        }
        return false;
    }

    private List<String> listDecks(final Seat s) {
        return listDecks(s, null);
    }

    private List<String> listDecks(final Seat s, final String format) {
        return deckNames(deckDirs(s, format));
    }

    private static List<String> deckNames(final List<File> dirs) {
        final TreeSet<String> names = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        for (final File dir : dirs) {
            final File[] files = dir.listFiles((d, n) -> n.toLowerCase().endsWith(".dck"));
            if (files != null) {
                for (final File f : files) {
                    names.add(f.getName().substring(0, f.getName().length() - 4));
                }
            }
        }
        return new ArrayList<>(names);
    }

    /** A deck by path, or by name from the --decks directories and the user's constructed decks. */
    public Deck loadDeck(final String spec) {
        return loadDeck(spec, seats[0], null);
    }

    /** {@link #loadDeck(String)} from one seat's deck folders; in pvp only by name, and only that seat's. */
    private Deck loadDeck(final String spec, final Seat s, final String format) {
        if (options.namesOnly || options.pvp) {
            return loadNamedDeck(spec, deckDirs(s, format));
        }
        final File direct = new File(spec);
        if (direct.isFile()) {
            return DeckSerializer.fromFile(direct);
        }
        final String file = spec.toLowerCase().endsWith(".dck") ? spec : spec + ".dck";
        for (final File dir : deckDirs(s, format)) {
            final File f = new File(dir, file);
            if (f.isFile()) {
                final Deck d = DeckSerializer.fromFile(f);
                if (d != null) {
                    return d;
                }
            }
        }
        throw new IllegalArgumentException("Deck not found: " + spec);
    }

    /**
     * {@code --names-only}: a bare name (no separators, no leading '.' or '-', not absolute), resolved inside a deck
     * folder and still inside it after following links. Every failure is the same "Unknown deck", so the answer
     * says nothing about paths or which files exist.
     */
    private static Deck loadNamedDeck(final String name, final List<File> dirs) {
        final IllegalArgumentException unknown = new IllegalArgumentException("Unknown deck");
        if (name == null || name.isEmpty() || name.length() > 200 || name.contains("/") || name.contains("\\") || name.startsWith(".")
                || name.startsWith("-") || name.chars().anyMatch(Character::isISOControl) || new File(name).isAbsolute()) {
            throw unknown;
        }
        final String file = name.toLowerCase().endsWith(".dck") ? name : name + ".dck";
        for (final File dir : dirs) {
            try {
                final Path root = dir.toPath().toRealPath();
                final Path f = root.resolve(file).normalize();
                if (!f.startsWith(root) || !java.nio.file.Files.isRegularFile(f)) {
                    continue;
                }
                final Path real = f.toRealPath();
                if (!real.startsWith(root)) {
                    continue; // a link out of the deck folder
                }
                final Deck d = DeckSerializer.fromFile(real.toFile());
                if (d != null) {
                    return d;
                }
            } catch (final java.io.IOException | RuntimeException e) {
                // a missing folder or an unreadable file: try the next folder
            }
        }
        throw unknown;
    }

    private Writer recorder() {
        if (options.record == null) {
            return null;
        }
        if (recorder == null) {
            try {
                recorder = new OutputStreamWriter(new FileOutputStream(options.record, false), StandardCharsets.UTF_8);
            } catch (final java.io.IOException e) {
                BridgeLog.error("Cannot record to " + options.record, e);
                options.record = null;
            }
        }
        return recorder;
    }

    // ---------------------------------------------------------------- two people (pvp)

    /** The seat a hello is for: always 0 against the AI; in pvp the router's stamp, which must be 0 or 1. */
    private Seat seatOf(final JsonObject hello) {
        if (!options.pvp) {
            return seats[0];
        }
        final JsonElement e = hello.get("seat");
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            return null;
        }
        final int n = e.getAsInt();
        return n == 0 || n == 1 ? seats[n] : null;
    }

    private Seat other(final Seat s) {
        return seats[1 - s.index];
    }

    /** A display name from the hello: trimmed, at most 64 characters, no control characters; null if none. */
    static String cleanName(final JsonElement e) {
        if (e == null || !e.isJsonPrimitive()) {
            return null;
        }
        final String n = e.getAsString().replaceAll("\\p{Cntrl}", "").trim();
        return n.isEmpty() ? null : n.length() > 64 ? n.substring(0, 64) : n;
    }

    private static String nameOf(final Seat s) {
        final String n = s.name;
        return n != null ? n : "Player " + (s.index + 1);
    }

    /** The deck a seat's start screen preselects: seat 0's from --deck; pvp seat 1's is the one it joined with. */
    private String defaultDeck(final Seat s) {
        if (s.index == 0) {
            return options.deck;
        }
        final List<String> joined = options.seat1Decks == null ? List.of() : deckNames(List.of(new File(options.seat1Decks)));
        return joined.isEmpty() ? null : joined.get(0);
    }

    /** {@code {t:'pvp', kind:'lobby', you, opponent, youReady, oppReady}} for seat {@code s}. */
    private JsonObject lobby(final Seat s) {
        final Seat o = other(s);
        final JsonObject m = new JsonObject();
        m.addProperty("t", "pvp");
        m.addProperty("kind", "lobby");
        m.addProperty("you", nameOf(s));
        m.addProperty("opponent", o.name);
        m.addProperty("youReady", s.deck != null);
        m.addProperty("oppReady", o.deck != null);
        if (rematch) {
            m.addProperty("rematch", true);
        }
        if (pvpResume != null) {
            m.addProperty("resuming", true); // a saved game: it goes on when both are here, no deck to pick
        }
        if (o.wantsRematch) {
            m.addProperty("oppRematch", true);
        }
        if (o.left) {
            m.addProperty("oppLeft", true);
        }
        return m;
    }

    /**
     * What seat {@code s} is told about the other one: connected or not since when, and while it is away during a
     * match, when Claim win unlocks. No locks (snapshots read it under the outbox lock).
     */
    private JsonObject presence(final Seat s, final boolean asMessage) {
        final Seat o = other(s);
        final boolean connected = o.sink != null; // read after since's write (see Seat.since), so since is current
        final long since = o.since;
        final JsonObject m = new JsonObject();
        if (asMessage) {
            m.addProperty("t", "pvp");
            m.addProperty("kind", "presence");
        }
        m.addProperty("opponentConnected", connected);
        m.addProperty("since", since);
        if (!connected && inProgress()) {
            m.addProperty("claimableAt", since + options.claimAfterMs);
        }
        return m;
    }

    /** A game is being played: dealt (conceding while Forge is still laying out the zones breaks it) and not over. */
    private boolean inProgress() {
        final HostedMatch hm = match;
        final forge.game.Game g = hm == null ? null : hm.getGame();
        return g != null && g.getAge() != forge.game.GameStage.BeforeMulligan && !g.isGameOver();
    }

    private static void send(final Seat s, final JsonObject msg) {
        final Consumer<String> k = s.sink;
        if (k != null) {
            k.accept(Outboxes.toJson(msg));
        }
    }

    /**
     * pvp {@code match.start {deck}}: this seat is ready with that deck (again: it changes deck). The match starts
     * once both seats are; until then both are told {@code pvp lobby} on every change. Answers {@code {deck}} only:
     * nothing about the other seat's deck.
     */
    private JsonElement pvpReady(final Seat s, final JsonObject params) {
        if (params.has("state")) {
            throw new IllegalArgumentException("Board states aren't available here");
        }
        if (str(params, "oppDeck", null) != null || str(params, "ai", null) != null) {
            throw new IllegalArgumentException("Against another player you only choose your own deck");
        }
        final String deckName = str(params, "deck", null);
        if (deckName == null) {
            throw new IllegalArgumentException("No deck given");
        }
        final Deck d = loadDeck(deckName, s, options.format);
        checkDeck(options.format, d);
        synchronized (clientLock) {
            if (pvpResume != null) {
                throw new IllegalArgumentException("This game picks up where it left off once you're both back.");
            }
            if (match != null || played && !rematch) {
                throw new IllegalArgumentException("This game has already started");
            }
            if (rematch && other(s).left) {
                throw new IllegalArgumentException(nameOf(other(s)) + " has left, so there's no rematch.");
            }
            s.deck = d;
            if (rematch) {
                s.wantsRematch = true; // Ready on the rematch's start screen is a yes to it
                s.left = false;
            }
            if (seats[0].deck != null && seats[1].deck != null) {
                startPvpMatch(null);
            }
        }
        if (match == null) {
            for (final Seat x : seats) {
                send(x, lobby(x));
            }
        }
        final JsonObject res = new JsonObject();
        res.addProperty("deck", d.getName());
        return res;
    }

    /**
     * Both seats picked a deck (clientLock held): two human players, each its own {@link LobbyPlayerHuman} named as
     * the router said and its own {@link TableSession}, in HostedMatch's {player → gui} map. Same rules as against the
     * AI (Bo1, 20 life; Brawl: its variant, 25 life). Never recorded beyond seat 0, never captured (the router starts pvp games without).
     */
    /** Deals the match between the seats' decks, from {@code stateLines} (a resumed game's board) when not null. Under clientLock. */
    private void startPvpMatch(final List<String> stateLines) {
        final RegisteredPlayer[] players = new RegisteredPlayer[2];
        final TableSession[] tables = new TableSession[2];
        final Map<RegisteredPlayer, IGuiGame> guis = new LinkedHashMap<>();
        for (final Seat s : seats) {
            final RegisteredPlayer rp = registered(options.format, s.deck);
            rp.setPlayer(new LobbyPlayerHuman(nameOf(s)));
            final TableSession t = new TableSession(base);
            t.setOnGameFinished(this::gameFinished);
            t.setOnGameAttached(this::gameAttached);
            if (options.speed != 1.0) {
                t.pacer().setSpeed(options.speed);
            }
            t.setPresence(() -> presence(s, false));
            players[s.index] = rp;
            tables[s.index] = t;
            guis.put(rp, t.gui());
        }
        tables[0].pairWith(tables[1]);
        final Writer rec = recorder();
        if (rec != null) {
            tables[0].outbox().setRecorder(rec);
        }
        final GameRules rules = new GameRules(GameType.Constructed);
        rules.setGamesPerMatch(1);
        rules.setManaBurn(FModel.getPreferences().getPrefBoolean(FPref.LEGACY_MANABURN));
        rules.setOrderCombatants(FModel.getPreferences().getPrefBoolean(FPref.LEGACY_ORDER_COMBATANTS));
        rules.setUseGrayText(FModel.getPreferences().getPrefBoolean(FPref.UI_GRAY_INACTIVE_TEXT));
        rules.setWarnAboutAICards(false);
        final HostedMatch hm = new HostedMatch();
        if (stateLines != null) {
            // The board replaces the opening hands.
            final Map<RegisteredPlayer, Integer> handSizes = withoutOpeningHands(List.of(players));
            hm.setStartGameHook(() -> applyBoard(hm.getGame(), stateLines, handSizes));
        }
        if (checkpointer != null) {
            final JsonObject settings = new JsonObject();
            settings.addProperty("pvp", true);
            if (options.format != null) {
                settings.addProperty("format", options.format);
            }
            final JsonArray names = new JsonArray();
            names.add(nameOf(seats[0]));
            names.add(nameOf(seats[1]));
            settings.add("names", names);
            checkpointer.begin(settings, seats[0].deck, seats[1].deck);
        }
        final Runnable ended = () -> {
            synchronized (clientLock) {
                if (seats[0].table == tables[0]) {
                    seats[0].table = null;
                    seats[1].table = null;
                    match = null;
                }
            }
        };
        // One bridge-ui thread drives both seats' GUIs: after every task each seat's prompt bar is flushed.
        base.setAfterUiTask(() -> {
            tables[0].flushPrompt();
            tables[1].flushPrompt();
        });
        for (final Seat s : seats) {
            final TableSession t = tables[s.index];
            t.setOnMatchEnded(ended);
            s.table = t;
        }
        match = hm;
        played = true;
        rematch = false;
        for (final Seat s : seats) {
            s.wantsRematch = false;
            if (s.sink != null) {
                tables[s.index].attach(s.sink, s.clientInfo);
            }
        }
        BridgeLog.info("pvp match starting: " + nameOf(seats[0]) + " vs " + nameOf(seats[1]));
        base.invokeInEdtLater(() -> hm.startMatch(rules, variants(options.format), List.of(players[0], players[1]), guis, null));
    }

    /**
     * Seat {@code index} concedes (its act or rpc {@code match.leave}, the router's DELETE, or a claimed win against
     * it): the other seat wins and both get the normal game over. False when no match is in progress (pvp only).
     */
    public boolean concedeSeat(final int index) {
        if (!options.pvp || index < 0 || index > 1) {
            return false;
        }
        final TableSession t = seats[index].table;
        if (t == null || !inProgress()) {
            return false;
        }
        BridgeLog.info("pvp seat " + index + " concedes");
        t.concede();
        return true;
    }

    /** Acts the pvp table handles itself. False: the act is done with (claimWin, a refused rematch). */
    private boolean pvpAct(final Seat s, final JsonObject act) {
        final String kind = act.has("kind") ? act.get("kind").getAsString() : "";
        if ("claimWin".equals(kind)) {
            claimWin(s);
            return false;
        }
        if (!"nextGame".equals(kind)) {
            return true;
        }
        final String decision = act.has("decision") ? act.get("decision").getAsString() : "";
        if ("NEW".equals(decision)) {
            pvpRematch(s);
            return false;
        }
        if (!"QUIT".equals(decision)) {
            seatToast(s, "error", null, "A game against another player is a single game: Rematch or Leave.");
            return false;
        }
        // QUIT ends the match for both seats: only once the game is over. Mid-game it is this seat conceding.
        final HostedMatch hm = match;
        final forge.game.Game g = hm == null ? null : hm.getGame();
        if (hm == null || g != null && g.isGameOver()) {
            if (played) {
                pvpLeft(s);
            }
            return true;
        }
        if (!concedeSeat(s.index)) {
            seatToast(s, "error", null, "The game hasn't started yet.");
        }
        return false;
    }

    /**
     * pvp Rematch ({@code act nextGame NEW}) once the game is over: the finished match ends for both seats (detached
     * first, so its last frames reach nobody), both decks are cleared and both seats get {@code pvp lobby} with
     * {@code rematch}. The asking seat's page goes back to the start screen; the other's game-over panel says they want
     * a rematch until it says yes (its Rematch, or Ready on the start screen) or Leave. The next match starts as the
     * first one did, once both seats are ready.
     */
    void pvpRematch(final Seat s) {
        final Seat o = other(s);
        final TableSession old;
        final String refused;
        synchronized (clientLock) {
            final HostedMatch hm = match;
            final forge.game.Game g = hm == null ? null : hm.getGame();
            // Left first: the other seat's Leave ends the finished match, and until it is gone its game reads null.
            if (played && o.left) {
                refused = nameOf(o) + " has left, so there's no rematch.";
                old = null;
            } else if (!played || hm != null && (g == null || !g.isGameOver())) {
                refused = "The game isn't over yet.";
                old = null;
            } else {
                refused = null;
                old = s.table;
                if (hm != null) {
                    for (final Seat x : seats) {
                        final TableSession t = x.table;
                        if (t != null && x.sink != null) {
                            t.detach(x.sink);
                        }
                        x.table = null;
                    }
                    match = null; // the old tables' onMatchEnded then finds nothing of theirs to clear
                }
                if (!rematch) {
                    rematch = true;
                    seats[0].deck = null;
                    seats[1].deck = null;
                }
                s.wantsRematch = true;
                s.left = false;
            }
        }
        if (refused != null) {
            seatToast(s, "error", null, refused);
            send(s, lobby(s));
            return;
        }
        if (old != null) {
            // Ends the finished HostedMatch (one seat's QUIT ends it for both) and frees its game thread.
            final JsonObject quit = new JsonObject();
            quit.addProperty("t", "act");
            quit.addProperty("kind", "nextGame");
            quit.addProperty("decision", "QUIT");
            old.onClientMessage(quit);
        }
        BridgeLog.info("pvp seat " + s.index + " wants a rematch");
        for (final Seat x : seats) {
            send(x, lobby(x));
        }
    }

    /** pvp: seat {@code s} pressed Leave after a game, so no rematch; the other seat is told. */
    private void pvpLeft(final Seat s) {
        synchronized (clientLock) {
            s.left = true;
            s.wantsRematch = false;
            s.deck = null;
        }
        BridgeLog.info("pvp seat " + s.index + " left after the game");
        final Seat o = other(s);
        send(o, lobby(o));
    }

    /** Claim win: only once the other seat has been gone {@link Options#claimAfterMs} without a break. */
    private void claimWin(final Seat s) {
        final Seat o = other(s);
        final boolean away = o.sink == null;
        final long since = o.since;
        if (away && inProgress() && System.currentTimeMillis() - since >= options.claimAfterMs) {
            BridgeLog.info("pvp seat " + s.index + " claims the win; seat " + o.index + " away since " + since);
            concedeSeat(o.index);
            return;
        }
        seatToast(s, "error", "Not yet", away && !inProgress()
                ? "The cards aren't dealt yet, so there's no win to claim. Leave ends the game."
                : away
                ? "You can claim the win once " + nameOf(o) + " has been away for " + options.claimAfterMs / 1000 + " seconds."
                : nameOf(o) + " is here.");
    }

    private void seatToast(final Seat s, final String level, final String title, final String message) {
        final TableSession t = s.table;
        if (t != null) {
            t.toast(level, title, message);
            return;
        }
        final JsonObject n = new JsonObject();
        n.addProperty("t", "notice");
        n.addProperty("kind", "toast");
        n.addProperty("level", level);
        if (title != null) {
            n.addProperty("title", title);
        }
        n.addProperty("message", message == null ? "" : message);
        send(s, n);
    }

    // ---------------------------------------------------------------- IGuiBase dialogs

    // IGuiBase-level dialogs belong to no player. Against the AI they go to the one seat. In pvp nobody can be asked
    // (either seat might be the wrong one to see it): a choice takes its default, a notice goes to both.

    @Override
    public int showOptionDialog(final String message, final String title, final List<String> options, final int defaultOption) {
        final TableSession t = seats[0].table;
        final boolean oneButton = options == null || options.size() <= 1;
        if (!oneButton && this.options.pvp) {
            BridgeLog.info("pvp: an option dialog for no seat takes its default: " + title);
            return defaultOption;
        }
        if (oneButton || t == null) {
            // One-button dialogs (errors, notices) are toasts and never block.
            toast(oneButton ? "error" : "info", title, message);
            return defaultOption;
        }
        return t.askOptions(title, message, options, defaultOption);
    }

    @Override
    public String showInputDialog(final String message, final String title, final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
        final TableSession t = seats[0].table;
        if (t == null || options.pvp) {
            return initialInput;
        }
        return t.askText(title, message, initialInput, inputOptions, isNumeric);
    }

    @Override
    public void toast(final String level, final String title, final String message) {
        if (options.pvp) {
            // clipboard / openUrl carry text one player asked for: never shown to the other
            if (!"clipboard".equals(level) && !"openUrl".equals(level)) {
                for (final Seat s : seats) {
                    seatToast(s, level, title, message);
                }
            }
            BridgeLog.info("[" + level + "] " + title + ": " + message);
            return;
        }
        final TableSession t = seats[0].table;
        if (t != null) {
            t.toast(level, title, message);
            return;
        }
        final Consumer<String> s = seats[0].sink;
        if (s != null) {
            final JsonObject n = new JsonObject();
            n.addProperty("t", "notice");
            n.addProperty("kind", "toast");
            n.addProperty("level", level);
            if (title != null) {
                n.addProperty("title", title);
            }
            n.addProperty("message", message == null ? "" : message);
            s.accept(Outboxes.toJson(n));
        }
        BridgeLog.info("[" + level + "] " + title + ": " + message);
    }
}

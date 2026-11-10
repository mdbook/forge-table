package forge.bridge.router;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Writer;
import java.lang.management.ManagementFactory;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;
import io.netty.buffer.Unpooled;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaderValues;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame;
import io.netty.handler.codec.http.websocketx.PingWebSocketFrame;
import io.netty.handler.codec.http.websocketx.PongWebSocketFrame;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketFrameAggregator;
import io.netty.handler.codec.http.websocketx.WebSocketServerHandshaker;
import io.netty.handler.codec.http.websocketx.WebSocketServerHandshakerFactory;

/**
 * A {@link GameHost} that runs each game in its own sidecar JVM ({@code forge.bridge.Main}, the same program
 * as the zip), bound to 127.0.0.1 on a port the child picks. The child's token never leaves this class: it is
 * put into the {@code hello} frame and the {@code ft} cookie on the way in.
 *
 * <p>Each child gets {@code <data>/matches/<id>/home} as {@code user.home}, so it has its own Forge user folder
 * (and profile lock). Two links in it point back to shared folders: {@code .cache/forge/table} to
 * {@code <data>/cache/table} (card art is downloaded once) and {@code .forge/decks/constructed} to the owner's
 * {@code <data>/users/<user>/decks} (imports outlive the game). The child exits when its stdin closes, so it never outlives the router.
 * When a game ends its folder (with {@code child.log}) moves to {@code <data>/ended/<id>}, kept for a day (at most
 * {@link Config#keepEnded} of them) so a game that went away can still be looked into.
 */
public final class ChildProcessHost implements GameHost {

    /**
     * Largest browser → game message. The biggest legitimate one is a deck import: the client allows deck files up
     * to 1 MiB, which JSON escaping can grow a little.
     */
    static final int MAX_FRAME = 2 * 1024 * 1024;
    /**
     * Browser messages, and their total size, waiting for the game socket before the browser is cut off (reading
     * pauses meanwhile). A reconnecting client flushes its whole outbox at once (connection.ts), hence the room.
     */
    static final int MAX_QUEUED = 64;
    static final int MAX_QUEUED_CHARS = 4 * 1024 * 1024;
    /** Sockets one seat of a game accepts at once (a tab, plus a reload overlapping it). */
    static final int MAX_SOCKETS = 2;

    /** How to start a child. The defaults reuse this JVM's java, options and classpath. */
    public static final class Config {
        public String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        public List<String> jvmArgs = inheritedJvmArgs();
        public String classpath = System.getProperty("java.class.path");
        /** Arguments every child gets ({@code --assets}, {@code --web}, {@code --decks} …). */
        public final List<String> childArgs = new ArrayList<>();
        public Path dataDir;
        public long readyTimeoutMs = 180_000;
        /** Close a game nobody has had open for this long. */
        public long idleMs = 30 * 60_000L;
        /** Close a finished game this long after its match ended and no browser has it open (unless a new one starts). */
        public long graceMs = 15 * 60_000L;
        /** Ended games' folders kept in {@code <data>/ended/} (for their logs): at most this many, none older than {@link #keepEndedMs}. */
        public int keepEnded = 20;
        public long keepEndedMs = 24 * 60 * 60_000L;
        /** Consent markers ({@code <data>/neural-games/consent/<owner>/<game>}) older than this are pruned. */
        public long keepConsentMs = 7 * 24 * 60 * 60_000L;
        public long tickMs = 15_000;
        /**
         * Close a browser socket that hasn't answered the pings sent every tick for this long. A tab that vanished
         * without closing (sleep, dropped network, a reset the router never read) would otherwise count as open, and
         * hold its game, forever.
         */
        public long silentMs = 60_000;
        /** A paused game is kept this long, then ended. */
        public long pausedKeepMs = 30L * 24 * 60 * 60_000L;
        /** At a router restart, a game played this recently (or open now) is resumed by itself; the rest stay paused. */
        public long activeMs = 5 * 60_000L;
    }

    static List<String> inheritedJvmArgs() {
        return childJvmArgs(ManagementFactory.getRuntimeMXBean().getInputArguments());
    }

    /**
     * The router's JVM options a child copies: heap and stack sizes, module opens/exports and system properties
     * (except its home and stdin handling, which the router sets, and JMX/RMI ones, which would open ports).
     * Everything else (agents, -XX flags, debug ports …) stays with the router.
     */
    static List<String> childJvmArgs(final List<String> routerArgs) {
        final List<String> out = new ArrayList<>();
        for (final String a : routerArgs) {
            final boolean allowed = a.startsWith("-Xmx") || a.startsWith("-Xms") || a.startsWith("-Xss")
                    || a.startsWith("--add-opens=") || a.startsWith("--add-exports=") || a.startsWith("-D");
            if (allowed && !a.startsWith("-Duser.home=") && !a.startsWith("-Dforge.table.ignoreStdin")
                    && !a.startsWith("-Dcom.sun.management.") && !a.startsWith("-Djava.rmi.")) {
                out.add(a);
            }
        }
        return out;
    }

    private static final class Child {
        final String id;
        final String owner;
        /** A game between two people: seat 1's deck folder is {@code <dir>/seat1/decks}. */
        final boolean pvp;
        /** forge.bridge.Formats: "brawl", or null for Constructed. */
        final String format;
        /** The AI profile asked for, or null (pvp, or the game's default). */
        final String ai;
        final long created;
        final Path dir;
        /** Browser sockets open on the game, and per seat. */
        final AtomicInteger clients = new AtomicInteger();
        final AtomicInteger[] seatClients = {new AtomicInteger(), new AtomicInteger()};
        volatile Status status = Status.STARTING;
        volatile String error;
        volatile Process process;
        volatile int port;
        volatile String token;
        volatile long lastSeen = System.currentTimeMillis();
        volatile long overSince;
        volatile long crashedSince;
        volatile boolean ended;
        /** How many times it was resumed: each run is a new process, whose games are numbered from 1 again. */
        int run;
        /** When it was paused ({@link Status#PAUSED}). */
        volatile long pausedSince;
        /** The table as the last poll saw it, null before a game is dealt. */
        volatile Table table;
        final StartProgress progress = new StartProgress();
        /** The browser sockets open on this game. */
        final java.util.Set<Relay> relays = ConcurrentHashMap.newKeySet();

        Child(final String id, final String owner, final Path dir, final boolean pvp, final String format) {
            this(id, owner, dir, pvp, format, null, System.currentTimeMillis());
        }

        Child(final String id, final String owner, final Path dir, final boolean pvp, final String format, final String ai, final long created) {
            this.id = id;
            this.owner = owner;
            this.dir = dir;
            this.pvp = pvp;
            this.format = format;
            this.ai = ai;
            this.created = created;
        }

        /** The same game with no process: paused since {@code since}. */
        Child paused(final long since) {
            final Child p = new Child(id, owner, dir, pvp, format, ai, created);
            p.run = run;
            p.status = Status.PAUSED;
            p.pausedSince = since;
            p.table = table; // the board as last seen, for the lobby
            return p;
        }

        /** The same game, starting again (from its save). */
        Child again() {
            final Child c = new Child(id, owner, dir, pvp, format, ai, created);
            c.run = run + 1;
            return c;
        }

        Path checkpoint() {
            return dir.resolve("checkpoint.json");
        }

        Path seat1Decks() {
            return dir.resolve("seat1").resolve("decks");
        }

        Game view() {
            final Status s = status;
            return new Game(id, owner, s, created, error, s == Status.STARTING ? progress.view() : null, format,
                    s == Status.PLAYING || s == Status.PAUSED ? table : null);
        }

        /** What the reaper's poll saw. A crashed or stopping game never goes back to running. */
        synchronized void polled(final Status s) {
            if (status != Status.READY && status != Status.PLAYING && status != Status.OVER) {
                return;
            }
            if (s == Status.OVER && status != Status.OVER) {
                overSince = System.currentTimeMillis();
            }
            status = s;
        }

        synchronized void crashed(final String why) {
            if (ended) {
                return;
            }
            if (error == null) {
                error = why;
            }
            crashedSince = System.currentTimeMillis();
            status = Status.CRASHED;
        }

        /** True the first time: the game is now stopping. */
        synchronized boolean stopping() {
            if (ended) {
                return false;
            }
            ended = true;
            status = Status.STOPPING;
            return true;
        }
    }

    private final Config cfg;
    /**
     * {@code <data>/neural-games}: the mtg-ai Neural seat's training trajectories and upload retry queue, written
     * only by games whose owner consented to upload. Outside
     * {@code matches/}, which the constructor wipes on every router restart: this one is channel-wide and must
     * outlive restarts for the retry queue to mean anything.
     */
    private final Path neuralGamesDir;
    /**
     * {@code <neural-games>/consent/<ownerKey>/<game id>/}: one folder per consenting game, made at spawn and passed as
     * {@code mtgai.neural.consent}. mtg-ai marks each of the game's trajectories in it and sends a queued file only
     * while its mark exists, so deleting an owner's folder ({@link #withdrawUpload}) withdraws every game of theirs
     * not yet sent, running or ended (backoff retries too). Never deleted at game end, only pruned by age.
     */
    private final Path consentDir;
    /** Orders consent folder creation (spawn) against withdrawal and pruning. */
    private final Object consentLock = new Object();
    private volatile java.util.function.Predicate<String> consents = owner -> false; // until a router says who
    /** Told each finished game the children report (the router's results store), or null. */
    private volatile java.util.function.Consumer<Finished> finished;
    private final Map<String, Child> games = new ConcurrentHashMap<>();
    /** What {@link #announce} asked every browser to be told, or null. */
    private volatile java.util.function.Supplier<String> announcement;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
    private final ExecutorService workers = Executors.newCachedThreadPool(r -> {
        final Thread t = new Thread(r, "child-host");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        final Thread t = new Thread(r, "child-reaper");
        t.setDaemon(true);
        return t;
    });

    public ChildProcessHost(final Config cfg) throws IOException {
        this.cfg = cfg;
        // A router restart keeps the saved games (paused; the ones being played resume by themselves) and clears
        // the rest of the earlier run's scratch space.
        Files.createDirectories(cfg.dataDir.resolve("matches"));
        final List<String> resumeNow = restore(cfg.dataDir.resolve("matches"));
        neuralGamesDir = cfg.dataDir.resolve("neural-games");
        Files.createDirectories(neuralGamesDir);
        quarantineUnattributed(neuralGamesDir);
        consentDir = neuralGamesDir.resolve("consent");
        Files.createDirectories(consentDir);
        sweepWithdrawn();
        pruneEnded();
        pruneConsent();
        timer.scheduleWithFixedDelay(this::tick, cfg.tickMs, cfg.tickMs, TimeUnit.MILLISECONDS);
        resumeNow.forEach(this::resume);
    }

    /** {@code <game>/game.json}: what a saved game needs to be listed and resumed after a router restart. */
    private static final String GAME_FILE = "game.json";
    /** {@code <game>/router.json}: {@link #remember}. */
    private static final String ROUTER_FILE = "router.json";
    /** {@code <game>/autoresume}: written at shutdown for a game being played then. */
    private static final String AUTORESUME = "autoresume";

    /**
     * The games an earlier run left in {@code matches}: each with a save is paused again, every other folder is
     * deleted. Returns the ids to resume now. (Who sits where in a pvp game is the router's: {@link #remembered}.)
     */
    private List<String> restore(final Path matches) {
        final List<String> again = new ArrayList<>();
        final List<Path> dirs;
        try (java.util.stream.Stream<Path> s = Files.list(matches)) {
            dirs = s.toList();
        } catch (final IOException e) {
            BridgeLog.warn("could not list old games in " + matches + ": " + e);
            return again;
        }
        for (final Path d : dirs) {
            final Child c;
            try {
                c = savedGame(d);
            } catch (final IOException | RuntimeException e) {
                quarantine(d, e); // a save we can't list: kept aside for a look, never deleted
                continue;
            }
            if (c == null) {
                try {
                    deleteTree(d);
                } catch (final IOException e) {
                    BridgeLog.warn("could not clear old game " + d + ": " + e);
                }
                continue;
            }
            games.put(c.id, c);
            final boolean auto = Files.exists(d.resolve(AUTORESUME));
            try {
                Files.deleteIfExists(d.resolve(AUTORESUME));
            } catch (final IOException e) {
                // resumed anyway; at worst once more next restart
            }
            BridgeLog.info("game " + c.id + " (" + c.owner + ") kept from the last run" + (auto ? ", resuming" : ", paused"));
            if (auto) {
                again.add(c.id);
            }
        }
        return again;
    }

    /** {@link #GAME_FILE}: the game's facts, for listing and resuming it after a router restart. */
    private static void writeGameFile(final Child c) throws IOException {
        final JsonObject g = new JsonObject();
        g.addProperty("id", c.id);
        g.addProperty("owner", c.owner);
        g.addProperty("pvp", c.pvp);
        if (c.format != null) {
            g.addProperty("format", c.format);
        }
        if (c.ai != null) {
            g.addProperty("ai", c.ai);
        }
        g.addProperty("created", c.created);
        g.addProperty("run", c.run);
        writeAtomically(c.dir.resolve(GAME_FILE), g.toString());
    }

    /** Replaces {@code f} with {@code text} in one step: a reader (or the next start, after a crash) sees the old file or the new one. */
    private static void writeAtomically(final Path f, final String text) throws IOException {
        final Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
        Files.writeString(tmp, text, StandardCharsets.UTF_8);
        Files.move(tmp, f, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }

    /**
     * Moves a game folder with a save the router can't read to {@code unreadable/} (its links to shared folders
     * dropped), where nothing prunes it: a person can look, and put it back.
     */
    private void quarantine(final Path d, final Exception why) {
        try {
            final Path to = cfg.dataDir.resolve("unreadable").resolve(d.getFileName() + "-" + System.currentTimeMillis());
            Files.createDirectories(to.getParent());
            Files.deleteIfExists(d.resolve("home").resolve(".cache").resolve("forge").resolve("table"));
            Files.deleteIfExists(d.resolve("home").resolve(".forge").resolve("decks").resolve("constructed"));
            Files.move(d, to, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            BridgeLog.warn("game folder " + d.getFileName() + " has a save but can't be listed (" + why + "); moved to " + to);
        } catch (final IOException e) {
            BridgeLog.warn("game folder " + d + " has a save but can't be listed (" + why + "), nor moved aside: " + e + "; left in place");
        }
    }

    /**
     * The paused game saved in folder {@code d}, or null when there is none to keep (no save; a pvp game nobody
     * signed in joined). Throws when there is a save but its folder can't be read.
     */
    private static Child savedGame(final Path d) throws IOException {
        final Path cp = d.resolve("checkpoint.json");
        if (!Files.isRegularFile(cp)) {
            return null;
        }
        final JsonObject g = JsonParser.parseString(Files.readString(d.resolve(GAME_FILE), StandardCharsets.UTF_8)).getAsJsonObject();
        if (!d.getFileName().toString().equals(g.get("id").getAsString())) {
            throw new IOException(GAME_FILE + " is for game " + g.get("id").getAsString());
        }
        final boolean pvp = g.has("pvp") && g.get("pvp").getAsBoolean();
        if (pvp && !Files.isRegularFile(d.resolve(ROUTER_FILE))) {
            return null; // a pvp game nobody signed in joined: nothing to sit back down at
        }
        final Child c = new Child(g.get("id").getAsString(), g.get("owner").getAsString(), d, pvp,
                g.has("format") ? g.get("format").getAsString() : null, g.has("ai") ? g.get("ai").getAsString() : null,
                g.get("created").getAsLong());
        c.run = g.has("run") ? g.get("run").getAsInt() : 0;
        return c.paused(Files.getLastModifiedTime(cp).toMillis());
    }

    @Override
    public Game resume(final String id) {
        final Child old = games.get(id);
        if (old == null || old.status != Status.PAUSED) {
            return null;
        }
        final Child c = old.again();
        if (!games.replace(id, old, c)) {
            return null; // resumed or ended meanwhile
        }
        BridgeLog.info("game " + id + " (" + c.owner + ") resuming");
        workers.execute(() -> spawn(c, null, null, c.ai, null, true)); // a resumed game is never captured for training
        return c.view();
    }

    @Override
    public void remember(final String id, final JsonObject facts) {
        final Child c = games.get(id);
        if (c == null) {
            return;
        }
        try {
            Files.createDirectories(c.dir); // the game may still be starting
            writeAtomically(c.dir.resolve(ROUTER_FILE), facts.toString());
        } catch (final IOException e) {
            BridgeLog.warn("game " + id + ": could not keep the router's facts: " + e);
        }
    }

    @Override
    public JsonObject remembered(final String id) {
        final Child c = games.get(id);
        try {
            return c == null ? null : JsonParser.parseString(Files.readString(c.dir.resolve(ROUTER_FILE), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (final IOException | RuntimeException e) {
            return null;
        }
    }

    @Override
    public String ai(final String id) {
        final Child c = games.get(id);
        return c == null ? null : c.ai;
    }

    /** Stop a game but keep it, paused, when it has a save; else end it ({@code reason} for the log). */
    private void pause(final Child c, final String reason) {
        if (!c.stopping()) {
            return;
        }
        BridgeLog.info("game " + c.id + " (" + c.owner + ") pausing: " + reason);
        workers.execute(() -> stop(c, true));
    }

    // ---------------------------------------------------------------- GameHost

    @Override
    public Game create(final String owner, final String deck, final String oppDeck, final String ai) {
        return create(owner, deck, oppDeck, ai, null);
    }

    @Override
    public Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl) {
        return create(owner, deck, oppDeck, ai, neuralUploadUrl, null);
    }

    @Override
    public Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl,
            final String format) {
        final String id = randomHex(8);
        final Child c = new Child(id, owner, cfg.dataDir.resolve("matches").resolve(id), false, format, ai, System.currentTimeMillis());
        games.put(id, c);
        workers.execute(() -> spawn(c, deck, oppDeck, ai, neuralUploadUrl, false));
        return c.view();
    }

    /** A game between two people: no opponent deck, no AI, no upload (so no capture). */
    @Override
    public Game createPvp(final String owner, final String deck) {
        return createPvp(owner, deck, null);
    }

    @Override
    public Game createPvp(final String owner, final String deck, final String format) {
        final String id = randomHex(8);
        final Child c = new Child(id, owner, cfg.dataDir.resolve("matches").resolve(id), true, format);
        games.put(id, c);
        workers.execute(() -> spawn(c, deck, null, null, null, false));
        return c.view();
    }

    /** The shared deck folders every game gets ({@code --decks}, in order). */
    private List<Path> sharedDeckDirs() {
        final List<Path> out = new ArrayList<>();
        for (int i = 0; i + 1 < cfg.childArgs.size(); i++) {
            if ("--decks".equals(cfg.childArgs.get(i))) {
                out.add(Path.of(cfg.childArgs.get(i + 1)));
            }
        }
        return out;
    }

    /**
     * The shared Brawl decks, in the children's res/ ({@code --assets}, else the working folder, as the child does).
     * Main takes {@code --assets DIR} as two arguments only, so that's the one form to look for.
     */
    private Path brawlDeckDir() {
        return resDir().resolve("forge-table").resolve("brawl-decks");
    }

    /** The children's Forge res/ ({@code --assets}, else the working folder). */
    private Path resDir() {
        String assets = ".";
        for (int i = 0; i + 1 < cfg.childArgs.size(); i++) {
            if ("--assets".equals(cfg.childArgs.get(i))) {
                assets = cfg.childArgs.get(i + 1);
            }
        }
        return Path.of(assets, "res");
    }

    /** Standard as the lobby judges it, from the children's res/ (made on first use). */
    private StandardPool standard;

    /** The children's card scripts, for the deck peek and Standard's copy limits (made with {@link #standard}). */
    private CardScripts scripts;

    private synchronized StandardPool standard() {
        final Path res = resDir();
        if (standard == null || !standard.res().equals(res)) {
            scripts = new CardScripts(res);
            standard = new StandardPool(res, scripts);
        }
        return standard;
    }

    @Override
    public CardScripts.Info cardInfo(final String name) {
        standard();
        return scripts.info(name);
    }

    @Override
    public boolean standardChecked() {
        return standard().ready();
    }

    /**
     * A user's deck folders, as their game sees them: the shared ones, then their own (none for a null user), then in a
     * Brawl game the shared Brawl decks (last, as the child orders them, so the user's own deck wins a name clash).
     */
    private List<Path> deckDirs(final String user, final String format) {
        final List<Path> dirs = sharedDeckDirs();
        if (user != null) {
            dirs.add(userDir(user).resolve("decks"));
        }
        if (forge.bridge.Formats.isBrawl(format)) {
            dirs.add(brawlDeckDir());
        }
        return dirs;
    }

    @Override
    public List<String> decks(final String user) {
        return decks(user, null);
    }

    @Override
    public List<String> decks(final String user, final String format) {
        final java.util.TreeSet<String> names = new java.util.TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        for (final Path dir : deckDirs(user, format)) {
            try (java.util.stream.Stream<Path> s = Files.list(dir)) {
                s.map(f -> f.getFileName().toString()).filter(n -> n.toLowerCase().endsWith(".dck") && n.length() > 4)
                        .forEach(n -> names.add(n.substring(0, n.length() - 4)));
            } catch (final IOException e) {
                // a missing folder: nothing from it
            }
        }
        return new ArrayList<>(names);
    }

    @Override
    public java.util.Map<String, DeckSummary> deckSummaries(final String user, final String format) {
        final java.util.Map<String, DeckSummary> out = new java.util.LinkedHashMap<>();
        for (final String name : decks(user, format)) {
            final List<String> lines = deckLines(user, format, name);
            if (lines == null) {
                continue; // unreadable, or not UTF-8: listed, just without details
            }
            try {
                DeckSummary d = DeckSummary.parse(lines);
                if (!forge.bridge.Formats.isBrawl(format) && d.commander() == null) {
                    d = d.withStandard(standard().problem(DeckSummary.sections(lines)));
                }
                out.put(name, d);
            } catch (final RuntimeException e) {
                // listed without details
            }
        }
        return out;
    }

    @Override
    public java.util.Map<String, java.util.Map<String, Integer>> deckCards(final String user, final String format, final String name) {
        final List<String> lines = deckLines(user, format, name);
        return lines == null ? null : DeckSummary.sections(lines);
    }

    /** {@link #findDeck}'s lines, or null: no such deck, too big ({@link DeckSummary#MAX_BYTES}), or unreadable. */
    private List<String> deckLines(final String user, final String format, final String name) {
        final Path f = findDeck(user, format, name);
        try {
            return f != null && Files.size(f) <= DeckSummary.MAX_BYTES ? Files.readAllLines(f, java.nio.charset.StandardCharsets.UTF_8) : null;
        } catch (final IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * The file a game loads for deck {@code name}: the first {@code <name>.dck} in {@link #deckDirs} that is a regular
     * file still inside its folder after following links. Null when there is none, or the name is a path.
     */
    private Path findDeck(final String user, final String format, final String name) {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.startsWith(".")) {
            return null;
        }
        final String file = name.toLowerCase().endsWith(".dck") ? name : name + ".dck";
        for (final Path dir : deckDirs(user, format)) {
            try {
                final Path root = dir.toRealPath();
                final Path f = root.resolve(file).normalize();
                if (!f.startsWith(root) || !Files.isRegularFile(f)) {
                    continue;
                }
                final Path real = f.toRealPath();
                if (real.startsWith(root)) {
                    return real;
                }
            } catch (final IOException e) {
                // a missing folder: try the next one
            }
        }
        return null;
    }

    /**
     * Copy one deck into seat 1's folder of a pvp game: {@link #findDeck}, from the shared folders, then the user's own
     * (as the game itself loads by name). The game never sees the user's other decks.
     */
    @Override
    public boolean seatDeck(final String id, final String user, final String name) {
        final Child c = games.get(id);
        if (c == null || !c.pvp) {
            return false;
        }
        final Path real = findDeck(user, c.format, name);
        if (real == null) {
            return false;
        }
        try {
            final Path to = c.seat1Decks();
            Files.createDirectories(to);
            final String file = name.toLowerCase().endsWith(".dck") ? name : name + ".dck";
            Files.copy(real, to.resolve(file), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (final IOException e) {
            return false;
        }
    }

    /** Ask the game to let {@code seat} concede ({@code POST /seat/concede} with its token on its loopback port). */
    @Override
    public CompletableFuture<Boolean> concede(final String id, final int seat) {
        final Child c = games.get(id);
        if (c == null || !c.pvp || c.token == null || c.ended) {
            return CompletableFuture.completedFuture(false);
        }
        final HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + c.port + "/seat/concede?seat=" + seat))
                .header("Cookie", "ft=" + c.token).timeout(Duration.ofSeconds(5)).POST(HttpRequest.BodyPublishers.noBody()).build();
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofString())
                .thenApply(res -> res.statusCode() == 200 && JsonParser.parseString(res.body()).getAsJsonObject().get("conceded").getAsBoolean())
                .exceptionally(e -> false);
    }

    @Override
    public List<Game> list() {
        final List<Game> out = new ArrayList<>();
        for (final Child c : games.values()) {
            out.add(c.view());
        }
        out.sort(Comparator.comparingLong(Game::created));
        return out;
    }

    /** The game's process id (tests). */
    long pid(final String id) {
        final Child c = games.get(id);
        final Process p = c == null ? null : c.process;
        return p == null ? -1 : p.pid();
    }

    @Override
    public boolean connected(final String id) {
        final Child c = games.get(id);
        return c != null && c.clients.get() > 0;
    }

    @Override
    public boolean connected(final String id, final int seat) {
        final Child c = games.get(id);
        return c != null && seat >= 0 && seat < c.seatClients.length && c.seatClients[seat].get() > 0;
    }

    @Override
    public long lastSeen(final String id) {
        final Child c = games.get(id);
        return c == null ? 0 : c.lastSeen;
    }

    @Override
    public void announce(final java.util.function.Supplier<String> message) {
        announcement = message;
        for (final Child c : games.values()) {
            for (final Relay r : c.relays) {
                r.tell(message.get());
            }
        }
    }

    @Override
    public Game status(final String id) {
        final Child c = games.get(id);
        return c == null ? null : c.view();
    }

    /** The owner turned upload off: drop the consent of all their games, so nothing of theirs not yet sent is sent. */
    @Override
    public boolean withdrawUpload(final String owner) {
        final boolean ok;
        synchronized (consentLock) {
            ok = tombstone(ownerConsentDir(owner));
        }
        sweepWithdrawn();
        return ok;
    }

    @Override
    public void retainUploadOnly(final java.util.Set<String> owners) {
        final java.util.Set<Path> keep = new java.util.HashSet<>();
        for (final String o : owners) {
            keep.add(ownerConsentDir(o));
        }
        synchronized (consentLock) {
            try (java.util.stream.Stream<Path> s = Files.list(consentDir)) {
                for (final Path o : s.toList()) {
                    if (!keep.contains(o)) {
                        tombstone(o);
                    }
                }
            } catch (final IOException e) {
                BridgeLog.error("could not reconcile upload consent in " + consentDir, e);
            }
        }
        sweepWithdrawn();
    }

    @Override
    public void uploadConsent(final java.util.function.Predicate<String> consents) {
        this.consents = consents;
    }

    /**
     * Withdraw in one atomic step: rename the owner's folder out of {@code consent/} (a half-deleted tree would leave
     * marks that still authorise sends). Caller holds {@link #consentLock}. False: it is still there.
     */
    private boolean tombstone(final Path ownerDir) {
        if (!Files.exists(ownerDir, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return true;
        }
        try {
            final Path withdrawn = neuralGamesDir.resolve("withdrawn");
            Files.createDirectories(withdrawn);
            Files.move(ownerDir, withdrawn.resolve(randomHex(8)), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (final IOException e) {
            BridgeLog.error("could not withdraw upload consent in " + ownerDir, e);
            return false;
        }
    }

    /** Delete withdrawn consent folders; best effort, retried at the next withdrawal or start. */
    private void sweepWithdrawn() {
        final Path withdrawn = neuralGamesDir.resolve("withdrawn");
        synchronized (consentLock) {
            if (!Files.isDirectory(withdrawn)) {
                return;
            }
            try (java.util.stream.Stream<Path> s = Files.list(withdrawn)) {
                for (final Path t : s.toList()) {
                    deleteTree(t);
                }
            } catch (final IOException e) {
                BridgeLog.warn("could not clear " + withdrawn + ": " + e);
            }
        }
    }

    /** Its owner ended it (the lobby's End or Remove). */
    @Override
    public void end(final String id) {
        end(id, "ended by its owner");
    }

    /** Stop a game, saying why in the log ({@code reason}: owner, admin, idle, finished, crashed, update). */
    @Override
    public void end(final String id, final String reason) {
        final Child c = games.get(id);
        if (c == null || !c.stopping()) {
            return;
        }
        BridgeLog.info("game " + id + " (" + c.owner + ") ending: " + reason);
        workers.execute(() -> stop(c));
    }

    /**
     * Router shutdown: close every game's stdin (a game saves and exits on EOF), SIGTERM whatever is still running 5 s
     * later, SIGKILL 5 s after that. Folders stay: the next start keeps the saved games, and resumes by itself each one
     * being played now (open, or open within {@link Config#activeMs}).
     */
    @Override
    public void close() {
        timer.shutdownNow();
        final long now = System.currentTimeMillis();
        final List<Process> running = new ArrayList<>();
        for (final String id : List.copyOf(games.keySet())) {
            final Child c = games.remove(id);
            if (c != null) {
                // Crashed too: stopped by the same signal as the router, it may have died a moment before this ran.
                // Starting with a save: being resumed right now.
                final boolean active = (c.status == Status.PLAYING || c.status == Status.CRASHED) && (c.clients.get() > 0 || now - c.lastSeen < cfg.activeMs)
                        || c.status == Status.STARTING && Files.isRegularFile(c.checkpoint());
                BridgeLog.info("game " + id + " (" + c.owner + ") stopping with the router" + (active ? ", resumes at the next start" : ""));
                final Process p;
                synchronized (c) { // a child being spawned right now either exists after this, or never will
                    c.ended = true;
                    p = c.process;
                }
                if (active) {
                    try {
                        Files.writeString(c.dir.resolve(AUTORESUME), "", StandardCharsets.UTF_8);
                    } catch (final IOException e) {
                        BridgeLog.warn("game " + id + ": could not mark it to resume: " + e);
                    }
                }
                if (p != null && p.isAlive()) {
                    try {
                        p.getOutputStream().close();
                    } catch (final IOException ignored) {
                        // gone already
                    }
                    running.add(p);
                }
            }
        }
        for (final boolean force : new boolean[] {false, true}) {
            final long until = System.currentTimeMillis() + 5_000;
            for (final Process p : running) {
                try {
                    if (!p.waitFor(Math.max(0, until - System.currentTimeMillis()), TimeUnit.MILLISECONDS)) {
                        if (force) {
                            p.destroyForcibly();
                        } else {
                            p.destroy();
                        }
                    }
                } catch (final InterruptedException e) {
                    p.destroyForcibly();
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    @Override
    public void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path) {
        attach(id, ctx, req, path, 0, null);
    }

    @Override
    public void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path, final int seat,
            final String name) {
        final Child c = games.get(id);
        if (c == null) {
            Router.sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "This game is over", "It ended, or the server restarted since. Start a new one from the lobby.");
            return;
        }
        if (c.status == Status.PAUSED) {
            Router.sendPage(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "This game is paused", "It was saved. Resume it from the lobby.");
            return;
        }
        if (c.token == null || c.ended || c.status == Status.STARTING || c.status == Status.CRASHED) {
            Router.sendPage(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "This game isn't running", "It is still starting, or it stopped. Give it a moment, or start a new one from the lobby.");
            return;
        }
        if ((path.equals("/ws") || path.startsWith("/ws?")) && req.headers().contains(HttpHeaderNames.UPGRADE, HttpHeaderValues.WEBSOCKET, true)) {
            relay(c, ctx, req, seat == 1 ? 1 : 0, name);
            return;
        }
        if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
            Router.sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
            return;
        }
        proxy(c, ctx, req, path);
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * Start the game and follow its stdout. What the lobby shows on failure is generic; the details (paths,
     * exceptions) go to the router's log only.
     */
    private void spawn(final Child c, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl,
            final boolean resume) {
        final Path log = c.dir.resolve("child.log");
        Process p = null;
        try {
            p = start(c, log, deck, oppDeck, ai, neuralUploadUrl, resume);
            if (p == null) {
                return; // ended before it started
            }
            final Process proc = p;
            p.onExit().thenRun(() -> exited(c));
            timer.schedule(() -> {
                if (c.status == Status.STARTING && !c.ended) {
                    BridgeLog.warn("game " + c.id + " did not start within " + cfg.readyTimeoutMs / 1000 + " s");
                    c.error = "the game didn't start in time"; // shown once it has exited
                    proc.destroyForcibly();
                }
            }, cfg.readyTimeoutMs, TimeUnit.MILLISECONDS);
            readStdout(c, p, log);
        } catch (final IOException | RuntimeException e) {
            if (c.ended) {
                return;
            }
            BridgeLog.error("game " + c.id + " (" + c.owner + ") failed", e);
            c.crashed("the game could not start");
            if (p != null) {
                p.destroyForcibly(); // a crashed entry never keeps a live process
            }
        }
    }

    /** Lay out the game's folder and start its process, under the game's lock so {@link #stop} never races it. */
    private Process start(final Child c, final Path log, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl,
            final boolean resume) throws IOException {
        synchronized (c) {
            if (c.ended) {
                return null;
            }
            // Only leaf folders are shared: Forge creates its profile folders with mkdirs, which two children
            // booting at once would race on.
            final Path home = c.dir.resolve("home");
            final Path cache = home.resolve(".cache").resolve("forge");
            Files.createDirectories(cache);
            final Path art = cfg.dataDir.resolve("cache").resolve("table").toAbsolutePath();
            Files.createDirectories(art);
            Files.deleteIfExists(cache.resolve("table")); // a resumed game's folder has its links already
            Files.createSymbolicLink(cache.resolve("table"), art);
            final Path deckDir = home.resolve(".forge").resolve("decks");
            Files.createDirectories(deckDir);
            if (c.pvp) {
                Files.createDirectories(c.seat1Decks());
            }
            final Path decks = userDir(c.owner).resolve("decks").toAbsolutePath();
            Files.createDirectories(decks);
            Files.deleteIfExists(deckDir.resolve("constructed"));
            Files.createSymbolicLink(deckDir.resolve("constructed"), decks);
            writeGameFile(c);

            Path consent = null;
            if (neuralUploadUrl != null && !neuralUploadUrl.isBlank()) {
                synchronized (consentLock) { // after a withdrawal, never before it with the folder surviving
                    if (consents.test(c.owner)) {
                        consent = ownerConsentDir(c.owner).resolve(c.id);
                        Files.createDirectories(consent);
                    }
                }
            }
            final List<String> cmd = c.pvp ? pvpCommand(home, deck, c.seat1Decks()) : command(home, deck, oppDeck, ai, neuralUploadUrl, consent);
            addOpt(cmd, "--format", c.format);
            addOpt(cmd, "--checkpoint", c.checkpoint().toAbsolutePath().toString());
            if (resume) {
                cmd.add("--resume");
            }
            c.process = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.appendTo(log.toFile())).start();
            return c.process;
        }
    }

    /**
     * A child's command line. {@code --names-only} is always there: a game behind the router loads decks by bare
     * name from its deck folders only, and takes no board-state file.
     */
    List<String> command(final Path home, final String deck, final String oppDeck, final String ai) {
        return command(home, deck, oppDeck, ai, null, null);
    }

    /**
     * Files a trajectory queued in {@code <games>/traj/} before upload consent gated the capture (marker
     * {@code .consent-gate} absent) cannot be tied to a game's owner: the names are bare game ids and the contents
     * hold no user. mtg-ai's flush uploads everything in {@code traj/}, so the next consenting game would have shipped
     * a non-consenting user's hand, library and actions. Fail closed, once: move them to {@code quarantine/}, which
     * is never flushed (an operator may inspect or delete it). From then on only consenting games write to
     * {@code traj/} (see {@link #command}), so the queue is clean.
     */
    static void quarantineUnattributed(final Path games) {
        final Path marker = games.resolve(".consent-gate");
        if (Files.exists(marker)) {
            return;
        }
        final Path traj = games.resolve("traj");
        try {
            if (Files.isDirectory(traj)) {
                final Path quarantine = games.resolve("quarantine");
                Files.createDirectories(quarantine);
                int n = 0;
                try (java.util.stream.Stream<Path> s = Files.list(traj)) {
                    for (final Path f : s.filter(Files::isRegularFile).toList()) {
                        Files.move(f, quarantine.resolve(f.getFileName()), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        n++;
                    }
                }
                if (n > 0) {
                    BridgeLog.warn("moved " + n + " unattributable trajectory file(s) from " + traj + " to " + quarantine + ": never uploaded");
                }
            }
            Files.writeString(marker, "trajectories queued before this marker were quarantined\n", StandardCharsets.UTF_8);
        } catch (final IOException e) {
            // no marker: tried again at the next start; the games below still get the gated command line
            BridgeLog.warn("could not quarantine old trajectories in " + traj + ": " + e);
        }
    }

    /**
     * As above; {@code neuralUploadUrl} turns on the Neural seat's upload of this game's training trajectory. Only
     * then does the game get the shared {@code neural-games} dir: mtg-ai flushes every file in its {@code traj/}, so a
     * game that did not consent must write nothing there. An EMPTY {@code mtgai.neural.games} is mtg-ai's
     * "no capture, no flush" switch (NeuralSeat / HumanGameLog treat a blank value as null dir); an absent one would
     * fall back to a default dir that still writes and flushes. {@code consent} is the game's consent folder (see
     * {@link #consentDir}); a consenting game without one gets no shared dir either.
     */
    List<String> command(final Path home, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl, final Path consent) {
        final List<String> cmd = new ArrayList<>();
        cmd.add(cfg.java);
        cmd.addAll(cfg.jvmArgs);
        cmd.add("-Duser.home=" + home.toAbsolutePath());
        if (neuralUploadUrl != null && !neuralUploadUrl.isBlank() && consent != null) {
            cmd.add("-Dmtgai.neural.games=" + neuralGamesDir.toAbsolutePath());
            cmd.add("-Dmtgai.neural.upload=" + neuralUploadUrl);
            cmd.add("-Dmtgai.neural.consent=" + consent.toAbsolutePath());
        } else {
            cmd.add("-Dmtgai.neural.games=");
        }
        cmd.add("-cp");
        cmd.add(cfg.classpath);
        cmd.add("forge.bridge.Main");
        cmd.add("--port");
        cmd.add("0");
        cmd.add("--names-only");
        cmd.add("--progress");
        cmd.addAll(cfg.childArgs);
        // The router's game id, not a browser value: correlate text logs with the lobby and child.log.
        addOpt(cmd, "--game-log-id", home.toAbsolutePath().getParent().getFileName().toString());
        addOpt(cmd, "--deck", deck);
        addOpt(cmd, "--opp-deck", oppDeck);
        addOpt(cmd, "--ai", ai);
        return cmd;
    }

    /**
     * A pvp child's command line: {@link #command} without an upload (so {@code -Dmtgai.neural.games=} is empty: no capture)
     * and without any other {@code -Dmtgai.*} the router itself runs with, plus {@code --pvp} and seat 1's deck
     * folder.
     */
    List<String> pvpCommand(final Path home, final String deck, final Path seat1Decks) {
        final List<String> cmd = new ArrayList<>(command(home, deck, null, null, null, null));
        cmd.removeIf(a -> a.startsWith("-Dmtgai.") && !a.equals("-Dmtgai.neural.games="));
        cmd.add("--pvp");
        cmd.add("--seat1-decks");
        cmd.add(seat1Decks.toAbsolutePath().toString());
        return cmd;
    }

    private static void addOpt(final List<String> cmd, final String opt, final String value) {
        if (value != null) {
            cmd.add(opt);
            cmd.add(value);
        }
    }

    /**
     * Follows the boot ({@code FORGE_TABLE_PROGRESS} lines) until FORGE_TABLE_READY, then keeps draining stdout into
     * the log until the child exits.
     */
    private void readStdout(final Child c, final Process p, final Path log) throws IOException {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
                Writer out = Files.newBufferedWriter(log, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.startsWith("FORGE_TABLE_READY ") && c.token == null) {
                    final JsonObject ready = JsonParser.parseString(line.substring("FORGE_TABLE_READY ".length())).getAsJsonObject();
                    c.port = ready.get("port").getAsInt();
                    c.token = ready.get("token").getAsString();
                    c.lastSeen = System.currentTimeMillis();
                    synchronized (c) {
                        if (c.status == Status.STARTING) {
                            c.status = Status.READY;
                        }
                    }
                    BridgeLog.info("game " + c.id + " (" + c.owner + ") ready on 127.0.0.1:" + c.port);
                    out.write("FORGE_TABLE_READY (token withheld)\n");
                } else {
                    if (c.token == null && StartProgress.isProgress(line)) {
                        c.progress.accept(line);
                    } else if (line.startsWith("FORGE_TABLE_ERROR ")) {
                        BridgeLog.warn("game " + c.id + " reported " + line);
                        c.error = "the game reported an error at start-up"; // shown once it has exited
                    }
                    out.write(line);
                    out.write('\n');
                }
                out.flush();
            }
        }
    }

    private void exited(final Child c) {
        if (c.ended) {
            return;
        }
        final int code = c.process.exitValue();
        c.crashed("the game stopped unexpectedly (code " + code + ")");
        BridgeLog.warn("game " + c.id + " (" + c.owner + ") exited with code " + code + ": " + c.error + "; log in " + c.dir.resolve("child.log"));
    }

    /**
     * Close stdin (a running child shuts down on EOF; a booting one is told to stop at once, since it isn't
     * watching stdin yet), then insist; then move the folder to {@code ended/} (its log is kept a while). The game
     * stays in {@link #games}, counted against the caps, until its process has exited.
     */
    /** Hand the child's finished games ({@code /status} {@code results}) to the listener, if any. */
    private void reportFinished(final Child c, final JsonObject body) {
        final java.util.function.Consumer<Finished> l = finished;
        if (l == null || !body.has("results")) {
            return;
        }
        for (final Finished f : Finished.parse(c.id, body.get("results"))) {
            try {
                // A resumed run numbers its games from 1 again: keep them apart from the earlier runs' (one result each).
                l.accept(c.run == 0 ? f : new Finished(f.game(), c.run * 10_000 + f.n(), f.seats()));
            } catch (final RuntimeException e) {
                BridgeLog.error("game " + c.id + ": recording a result", e);
            }
        }
    }

    @Override
    public void onFinished(final java.util.function.Consumer<Finished> l) {
        this.finished = l;
    }

    /**
     * One last {@code /status} before a game is stopped, so a game ended right after it finished (Remove, Leave) still
     * has its result recorded; at most 2 s, and never for a game with no listener or that never came up.
     */
    private void lastResults(final Child c) {
        if (finished == null || c.token == null || c.status == Status.STARTING || c.status == Status.CRASHED) {
            return;
        }
        try {
            final HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + c.port + "/status"))
                    .header("Cookie", "ft=" + c.token).timeout(Duration.ofSeconds(2)).GET().build();
            final HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 200) {
                reportFinished(c, JsonParser.parseString(res.body()).getAsJsonObject());
            }
        } catch (final IOException | RuntimeException e) {
            // gone already: the polls had what there was
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void stop(final Child c) {
        stop(c, false);
    }

    /** {@link #stop(Child)}; with {@code pause}, a game whose process left a save behind stays, {@link Status#PAUSED}. */
    private void stop(final Child c, final boolean pause) {
        lastResults(c);
        final Process p;
        synchronized (c) {
            p = c.process; // a game ended while starting waits here until its process exists (or never will)
        }
        try {
            if (p != null) {
                try {
                    p.getOutputStream().close();
                } catch (final IOException ignored) {
                    // already gone
                }
                if (c.token == null) {
                    p.destroy();
                }
                if (!p.waitFor(5, TimeUnit.SECONDS)) {
                    p.destroy();
                    if (!p.waitFor(5, TimeUnit.SECONDS)) {
                        while (!p.destroyForcibly().waitFor(5, TimeUnit.SECONDS)) {
                            BridgeLog.warn("game " + c.id + " still running after SIGKILL");
                        }
                    }
                }
            }
            if (pause && Files.isRegularFile(c.checkpoint()) && games.replace(c.id, c, c.paused(System.currentTimeMillis()))) {
                BridgeLog.info("game " + c.id + " (" + c.owner + ") paused");
                return;
            }
            retire(c);
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (final IOException e) {
            BridgeLog.warn("could not clean up " + c.dir + ": " + e.getMessage());
        } finally {
            games.remove(c.id, c);
            BridgeLog.info("game " + c.id + " (" + c.owner + ") ended");
        }
    }

    /** Polls each running child's state, then closes finished games past the grace period and idle ones. */
    private void tick() {
        final long now = System.currentTimeMillis();
        for (final Child c : games.values()) {
            try {
                tick(c, now);
            } catch (final RuntimeException e) {
                // An exception out of a scheduled task cancels it: one bad game must not stop the reaper for all.
                BridgeLog.error("reaper: game " + c.id, e);
            }
        }
    }

    private void tick(final Child c, final long now) {
        if (c.ended) {
            return;
        }
        if (c.status == Status.PAUSED) {
            if (now - c.pausedSince >= cfg.pausedKeepMs) {
                end(c.id, "paused for " + (now - c.pausedSince) / (24 * 60 * 60_000L) + " days");
            }
            return;
        }
        for (final Relay r : c.relays) {
            r.check(now);
        }
        final String why = reapReason(c.status, c.clients.get(), c.overSince, c.crashedSince, c.lastSeen, now, cfg.graceMs, cfg.idleMs);
        if (why != null) {
            if (Files.isRegularFile(c.checkpoint())) {
                pause(c, why); // a game in progress: kept, paused, for its owner to resume
            } else {
                end(c.id, why); // drops the entry; its folder moves to ended/
            }
            return;
        }
        if (c.status == Status.STARTING || c.status == Status.CRASHED || c.token == null) {
            return;
        }
        final HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + c.port + "/status"))
                .header("Cookie", "ft=" + c.token).timeout(Duration.ofSeconds(5)).GET().build();
        http.sendAsync(req, HttpResponse.BodyHandlers.ofString()).thenAccept(res -> {
            if (res.statusCode() != 200) {
                return;
            }
            final JsonObject body = JsonParser.parseString(res.body()).getAsJsonObject();
            final String state = body.get("state").getAsString();
            c.table = Table.parse(body.get("table"));
            reportFinished(c, body);
            c.polled(switch (state) {
                case "playing" -> Status.PLAYING;
                case "over" -> Status.OVER;
                default -> Status.READY;
            });
        });
    }

    /**
     * Why the reaper ends a game now, or null to keep it. A game a browser has open is never reaped, whatever its
     * child says: "finished" waits for the grace period after both the match ended and the last browser left.
     */
    static String reapReason(final Status status, final int clients, final long overSince, final long crashedSince, final long lastSeen,
            final long now, final long graceMs, final long idleMs) {
        if (status == Status.CRASHED) {
            return now - crashedSince >= graceMs ? "crashed " + minutes(now - crashedSince) + " ago" : null;
        }
        if (status != Status.READY && status != Status.PLAYING && status != Status.OVER || clients > 0) {
            return null;
        }
        if (status == Status.OVER && now - Math.max(overSince, lastSeen) >= graceMs) {
            return "finished, nobody connected for " + minutes(now - lastSeen);
        }
        if (now - lastSeen >= idleMs) {
            return "idle, nobody connected for " + minutes(now - lastSeen);
        }
        return null;
    }

    private static String minutes(final long ms) {
        return ms >= 60_000 ? ms / 60_000 + " min" : ms / 1000 + " s";
    }

    // ---------------------------------------------------------------- traffic

    private static final String[] COPIED_HEADERS = {"content-type", "cache-control", "retry-after", "x-content-type-options", "x-card-artist"};

    /** Plain GET/HEAD to the child, with its token as the {@code ft} cookie. Nothing else from the browser is passed on. */
    private void proxy(final Child c, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path) {
        final boolean head = req.method() == HttpMethod.HEAD;
        final boolean keepAlive = HttpUtil.isKeepAlive(req);
        final HttpRequest.Builder b;
        try {
            b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + c.port + path)).timeout(Duration.ofSeconds(60))
                    .header("Cookie", "ft=" + c.token).method(head ? "HEAD" : "GET", HttpRequest.BodyPublishers.noBody());
        } catch (final IllegalArgumentException e) {
            Router.sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad path");
            return;
        }
        final String accept = req.headers().get(HttpHeaderNames.ACCEPT);
        if (accept != null) {
            b.header("Accept", accept);
        }
        http.sendAsync(b.build(), HttpResponse.BodyHandlers.ofByteArray()).whenComplete((res, e) -> ctx.executor().execute(() -> {
            if (!ctx.channel().isActive()) {
                return;
            }
            if (e != null) {
                Router.sendText(ctx, HttpResponseStatus.BAD_GATEWAY, "game unreachable");
                return;
            }
            final byte[] body = res.body() == null ? new byte[0] : res.body();
            final FullHttpResponse out = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.valueOf(res.statusCode()),
                    head ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
            for (final String h : COPIED_HEADERS) {
                res.headers().firstValue(h).ifPresent(v -> out.headers().set(h, v));
            }
            if (res.statusCode() != 204) {
                out.headers().set(HttpHeaderNames.CONTENT_LENGTH, head ? res.headers().firstValue("content-length").orElse("0") : String.valueOf(body.length));
            }
            if (keepAlive) {
                out.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.KEEP_ALIVE);
                ctx.writeAndFlush(out);
            } else {
                ctx.writeAndFlush(out).addListener(ChannelFutureListener.CLOSE);
            }
        }));
    }

    /**
     * Takes over the channel as a WebSocket and relays it frame by frame to the child's {@code /ws}. At most
     * {@link #MAX_SOCKETS} per game; browser frames are capped at {@link #MAX_FRAME}, and reading from the browser
     * pauses while its messages wait for the game.
     */
    private void relay(final Child c, final ChannelHandlerContext ctx, final FullHttpRequest req, final int seat, final String name) {
        final WebSocketServerHandshaker hs = new WebSocketServerHandshakerFactory("ws://localhost" + req.uri(), null, false, MAX_FRAME)
                .newHandshaker(req);
        if (hs == null) {
            WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel());
            return;
        }
        if (c.seatClients[seat].incrementAndGet() > MAX_SOCKETS) {
            c.seatClients[seat].decrementAndGet();
            Router.sendText(ctx, HttpResponseStatus.TOO_MANY_REQUESTS, "this game is already open in " + MAX_SOCKETS + " places");
            return;
        }
        c.clients.incrementAndGet();
        c.lastSeen = System.currentTimeMillis();
        final Channel ch = ctx.channel();
        final Relay relay = new Relay(c, ch, seat, name);
        final ChannelPipeline p = ctx.pipeline();
        if (p.get(Router.READ_TIMEOUT) != null) {
            p.remove(Router.READ_TIMEOUT); // an open game may sit quiet for a long time
        }
        p.addLast(new WebSocketFrameAggregator(MAX_FRAME), relay);
        p.remove(ctx.handler());
        hs.handshake(ch, req).addListener(f -> {
            if (f.isSuccess()) {
                relay.open();
            } else {
                ch.close();
            }
        });
    }

    private final class Relay extends SimpleChannelInboundHandler<WebSocketFrame> implements WebSocket.Listener {
        private final Child c;
        private final Channel ch;
        private final int seat;
        private final String name;
        private final List<String> pending = new ArrayList<>();
        private final StringBuilder partial = new StringBuilder();
        private volatile WebSocket up;
        private CompletableFuture<?> sending = CompletableFuture.completedFuture(null);
        /** Browser messages received and not yet handed to the game socket, and their size (event loop only). */
        private int queued;
        private long queuedChars;
        private boolean first = true;
        private boolean counted = true; // the socket slot taken in relay()
        /** The game's first message (its welcome) has reached the browser: announcements may follow. */
        private volatile boolean welcomed;
        /** When the browser last sent anything, a pong included. */
        private volatile long heard = System.currentTimeMillis();

        Relay(final Child c, final Channel ch, final int seat, final String name) {
            this.c = c;
            this.ch = ch;
            this.seat = seat;
            this.name = name;
        }

        /** A message from the router itself (an announcement), once the game has welcomed the browser. */
        void tell(final String text) {
            if (!welcomed) {
                return; // it gets the current one with the welcome
            }
            ch.eventLoop().execute(() -> {
                if (ch.isActive()) {
                    ch.writeAndFlush(new TextWebSocketFrame(text));
                }
            });
        }

        /** The reaper's tick: ping the browser, or close the socket if it has stopped answering (its count drops on close). */
        void check(final long now) {
            ch.eventLoop().execute(() -> {
                if (!ch.isActive()) {
                    return;
                }
                if (now - heard >= cfg.silentMs) {
                    BridgeLog.info("game " + c.id + ": a browser socket was silent for " + minutes(now - heard) + ", closing it");
                    ch.close();
                    return;
                }
                ch.writeAndFlush(new PingWebSocketFrame()).addListener(ChannelFutureListener.CLOSE_ON_FAILURE);
            });
        }

        /** Handshake done: dial the child (on the channel's event loop). */
        void open() {
            c.relays.add(this);
            http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(10)).buildAsync(URI.create("ws://127.0.0.1:" + c.port + "/ws"), this)
                    .whenComplete((ws, e) -> ch.eventLoop().execute(() -> {
                        if (e != null) {
                            closeBrowser(1011, "game unreachable");
                            return;
                        }
                        if (!ch.isActive()) {
                            ws.abort();
                            return;
                        }
                        up = ws;
                        for (final String t : pending) {
                            sendUp(t);
                        }
                        pending.clear();
                    }));
        }

        @Override
        protected void channelRead0(final ChannelHandlerContext ctx, final WebSocketFrame frame) {
            heard = System.currentTimeMillis();
            if (frame instanceof TextWebSocketFrame t) {
                String text = t.text();
                if (first) {
                    first = false;
                    text = rewriteHello(text, c.token, seat, name);
                    if (text == null) {
                        closeBrowser(4001, "unauthorized");
                        return;
                    }
                }
                queuedChars += text.length();
                if (++queued > MAX_QUEUED || queuedChars > MAX_QUEUED_CHARS) {
                    closeBrowser(1008, "too many messages");
                    return;
                }
                ch.config().setAutoRead(false); // read on once the game has taken it
                if (up == null) {
                    pending.add(text);
                } else {
                    sendUp(text);
                }
            } else if (frame instanceof PingWebSocketFrame) {
                ctx.writeAndFlush(new PongWebSocketFrame(frame.content().retain()));
            } else if (frame instanceof CloseWebSocketFrame) {
                ctx.channel().close();
            }
        }

        private void sendUp(final String text) {
            final WebSocket ws = up;
            sending = sending.thenCompose(v -> ws.sendText(text, true)).whenComplete((v, e) -> ch.eventLoop().execute(() -> {
                queuedChars -= text.length();
                if (e != null) {
                    closeBrowser(1011, "game unreachable");
                } else if (--queued == 0 && ch.isActive()) {
                    ch.config().setAutoRead(true);
                }
            }));
        }

        private void closeBrowser(final int code, final String reason) {
            if (ch.isActive()) {
                ch.writeAndFlush(new CloseWebSocketFrame(code, reason)).addListener(ChannelFutureListener.CLOSE);
            }
        }

        @Override
        public void exceptionCaught(final ChannelHandlerContext ctx, final Throwable cause) {
            // An oversized frame (TooLongFrameException) or a broken socket.
            BridgeLog.debug("game " + c.id + " socket: " + cause);
            closeBrowser(1009, "message too big");
        }

        @Override
        public void channelInactive(final ChannelHandlerContext ctx) throws Exception {
            c.relays.remove(this);
            if (counted) {
                counted = false;
                c.seatClients[seat].decrementAndGet();
                c.clients.decrementAndGet();
                c.lastSeen = System.currentTimeMillis();
            }
            final WebSocket ws = up;
            if (ws != null) {
                ws.abort();
            }
            super.channelInactive(ctx);
        }

        // Child side (java.net.http): reassemble partial messages, forward whole frames, ask for the next once written.

        @Override
        public void onOpen(final WebSocket ws) {
            ws.request(1);
        }

        @Override
        public CompletionStage<?> onText(final WebSocket ws, final CharSequence data, final boolean last) {
            partial.append(data);
            if (!last) {
                ws.request(1);
                return null;
            }
            final String text = partial.toString();
            partial.setLength(0);
            if (!ch.isActive()) {
                ws.abort();
                return null;
            }
            ch.writeAndFlush(new TextWebSocketFrame(text)).addListener(f -> ws.request(1));
            if (!welcomed) {
                welcomed = true;
                final java.util.function.Supplier<String> a = announcement;
                if (a != null) {
                    ch.writeAndFlush(new TextWebSocketFrame(a.get()));
                }
            }
            return null;
        }

        @Override
        public CompletionStage<?> onClose(final WebSocket ws, final int statusCode, final String reason) {
            // 1005/1006 are "no code" markers that may not be sent; pass the rest (4001 stops the client retrying).
            final int code = statusCode == 1005 || statusCode == 1006 || statusCode < 1000 ? 1000 : statusCode;
            ch.eventLoop().execute(() -> closeBrowser(code, reason == null ? "" : reason));
            return null;
        }

        @Override
        public void onError(final WebSocket ws, final Throwable error) {
            ch.eventLoop().execute(() -> closeBrowser(1011, "game unreachable"));
        }
    }

    /**
     * The browser's first frame as the game gets it: its hello with the game's token, and the seat and name of the member
     * the router let in, in place of anything the browser put there (a browser never picks its seat). Null if it isn't a
     * hello.
     */
    static String rewriteHello(final String text, final String token, final int seat, final String name) {
        try {
            final JsonElement e = JsonParser.parseString(text);
            if (!e.isJsonObject() || !e.getAsJsonObject().has("t") || !"hello".equals(e.getAsJsonObject().get("t").getAsString())) {
                return null;
            }
            final JsonObject hello = e.getAsJsonObject();
            hello.addProperty("token", token);
            hello.addProperty("seat", seat);
            if (name != null) {
                hello.addProperty("name", name);
            } else {
                hello.remove("name");
            }
            return hello.toString();
        } catch (final RuntimeException ex) {
            return null;
        }
    }

    // ---------------------------------------------------------------- files

    /** {@code <data>/users/<name>}: the user name made filesystem-safe, plus a hash so different names never collide. */
    Path userDir(final String owner) {
        final String safe = owner.replaceAll("[^A-Za-z0-9._-]", "_");
        final String trimmed = safe.length() > 48 ? safe.substring(0, 48) : safe;
        try {
            final byte[] h = MessageDigest.getInstance("SHA-256").digest(owner.getBytes(StandardCharsets.UTF_8));
            return cfg.dataDir.resolve("users").resolve(trimmed + "-" + HexFormat.of().formatHex(h, 0, 4));
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** An ended game's folder goes to {@code ended/<id>} (its links to shared folders are dropped), then old ones are pruned. */
    private void retire(final Child c) throws IOException {
        if (!Files.exists(c.dir, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        final Path ended = cfg.dataDir.resolve("ended");
        Files.createDirectories(ended);
        final Path to = ended.resolve(c.id);
        deleteTree(to);
        try {
            Files.deleteIfExists(c.dir.resolve("home").resolve(".cache").resolve("forge").resolve("table"));
            Files.deleteIfExists(c.dir.resolve("home").resolve(".forge").resolve("decks").resolve("constructed"));
            Files.move(c.dir, to, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            Files.setLastModifiedTime(to, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis()));
        } catch (final IOException e) {
            BridgeLog.warn("could not keep " + c.dir + " (" + e + "); deleting it");
            deleteTree(c.dir);
        }
        pruneEnded();
        pruneConsent();
    }

    /** {@code consent/<first 16 hex of SHA-256(owner)>}: no user names on disk next to the upload queue. */
    Path ownerConsentDir(final String owner) {
        try {
            final byte[] h = MessageDigest.getInstance("SHA-256").digest(owner.getBytes(StandardCharsets.UTF_8));
            return consentDir.resolve(HexFormat.of().formatHex(h, 0, 8));
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Drop games' consent folders older than {@link Config#keepConsentMs}, then owner folders left empty. */
    void pruneConsent() {
        final long cutoff = System.currentTimeMillis() - cfg.keepConsentMs;
        synchronized (consentLock) {
            pruneConsent(cutoff);
        }
    }

    private void pruneConsent(final long cutoff) {
        try (java.util.stream.Stream<Path> owners = Files.list(consentDir)) {
            for (final Path o : owners.filter(Files::isDirectory).toList()) {
                try (java.util.stream.Stream<Path> s = Files.list(o)) {
                    for (final Path g : s.toList()) {
                        if (modified(g) < cutoff) {
                            deleteTree(g);
                        }
                    }
                }
                try {
                    Files.deleteIfExists(o);
                } catch (final java.nio.file.DirectoryNotEmptyException e) {
                    // still has games
                }
            }
        } catch (final IOException e) {
            BridgeLog.warn("could not prune " + consentDir + ": " + e);
        }
    }

    /** Keep the newest {@link Config#keepEnded} ended folders, none older than {@link Config#keepEndedMs}. */
    synchronized void pruneEnded() {
        final Path ended = cfg.dataDir.resolve("ended");
        if (!Files.isDirectory(ended)) {
            return;
        }
        final long cutoff = System.currentTimeMillis() - cfg.keepEndedMs;
        try (java.util.stream.Stream<Path> s = Files.list(ended)) {
            final List<Path> dirs = new ArrayList<>(s.toList());
            dirs.sort(Comparator.comparingLong(ChildProcessHost::modified).reversed());
            for (int i = 0; i < dirs.size(); i++) {
                if (i >= cfg.keepEnded || modified(dirs.get(i)) < cutoff) {
                    deleteTree(dirs.get(i));
                }
            }
        } catch (final IOException e) {
            BridgeLog.warn("could not prune " + ended + ": " + e);
        }
    }

    private static long modified(final Path p) {
        try {
            return Files.getLastModifiedTime(p, java.nio.file.LinkOption.NOFOLLOW_LINKS).toMillis();
        } catch (final IOException e) {
            return 0;
        }
    }

    /** Delete a tree without following links (the shared cache and deck folders are links in it). */
    static void deleteTree(final Path root) throws IOException {
        if (!Files.exists(root, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(final Path file, final BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(final Path dir, final IOException e) throws IOException {
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static String randomHex(final int bytes) {
        final byte[] b = new byte[bytes];
        new SecureRandom().nextBytes(b);
        return HexFormat.of().formatHex(b);
    }
}

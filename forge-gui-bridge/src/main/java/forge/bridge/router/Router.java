package forge.bridge.router;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;
import forge.bridge.auth.Sessions;
import forge.bridge.auth.UserStore;
import forge.bridge.art.CachedCrops;
import forge.bridge.net.BridgeServer;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.Unpooled;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaderValues;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpServerCodec;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.codec.http.QueryStringDecoder;
import io.netty.handler.timeout.ReadTimeoutException;
import io.netty.handler.timeout.ReadTimeoutHandler;
import io.netty.util.AttributeKey;

/**
 * Router mode: one listener that serves the lobby and its JSON API at
 * {@code /}, and carries each game's page, WebSocket and images under {@code /m/<id>/} to its {@link GameHost}.
 *
 * <pre>
 * java … forge.bridge.Main --router [--bind ADDR] [--port N] [--data DIR]
 *      [--trust-proxy-header X-authentik-username [--require-group NAME] [--admin-group NAME] [--name-header X-authentik-name]]
 *      [--max-matches N | --reserve-mb MB --game-mb MB] [--max-per-user N] [--idle-minutes M] [--grace-minutes M]
 *      [--admin-port N] [--drain-timeout M] [--mtgai-upload on|optin|off] [--mtgai-upload-url URL]
 *      [--assets DIR] [--web DIR] [--decks DIR]… [--card-art MODE] [--card-image-map FILE] [--test-prefs] [--debug]
 *      [--guests [--real-ip-header X-Real-IP]] [--fonts DIR]
 * </pre>
 *
 * <p>Who is asking: with {@code --trust-proxy-header H}, the user named by header {@code H} (set by Authentik
 * behind the reverse proxy; missing is 401, repeated or empty is 400). Without it, a single user {@code local}
 * who proves itself with the token printed in {@code FORGE_TABLE_READY} (as {@code #t=} on the lobby URL, then
 * the {@code X-Forge-Table-Token} header, the {@code ft} cookie or {@code ?t=}), like the plain sidecar. Users
 * only see, open and end the games they are a member of: their own games against the AI, and games between two
 * people they started or joined, where each one only ever gets their own seat.
 * With {@code --name-header N}, what other people see of a user is the first word of header {@code N} (Authentik's
 * full name: so a first name, never the login); without it, or when it is empty, their login.
 *
 * <p>Admins (the lobby's Admin section, {@code /api/admin/*}): with the proxy header, members of
 * {@code --admin-group} (same strict reading of {@code X-authentik-groups} as {@code --require-group}; no flag, no
 * admins); without it, the one local user. Admins see and end every game, and can restart the server now.
 *
 * <p>Guests ({@code --guests}, proxy mode only; plans/forge-pvp.md "Guests"): a game's creator may let a link work for
 * someone without a login. Everything such a guest's browser loads lives under {@code /g/} (the one prefix the proxy
 * lets through without Authentik); there the only identity is the guest's own cookie, for its own game's
 * {@code /g/<id>/}, and everywhere else that cookie means nothing. Without {@code --guests} every {@code /g/} path is a 404.
 *
 * <p>Online now: signed-in users seen in the last minute, or at a table, are listed to the other signed-in
 * users by their shown name and a random handle (never the login). A pvp game can be made for one of them: seat 1 is held
 * for that user (a direct invite, 15 min), whose lobby shows an invite card to accept or decline; the link works as usual.
 *
 * <p>Binding: loopback only without the proxy header; with it, loopback
 * or one explicit address, never a wildcard.
 */
public final class Router {

    /** Per-game RSS measured on a full game (docs/forge-table/RUNBOOK.md "Multi-game server"), rounded up. */
    public static final long DEFAULT_GAME_MB = 1536;
    public static final long DEFAULT_RESERVE_MB = 2048;
    static final String TOKEN_HEADER = "X-Forge-Table-Token";
    /** Pipeline name of the HTTP read timeout; a game's WebSocket removes it after the upgrade. */
    static final String READ_TIMEOUT = "read-timeout";
    static final Set<String> AIS = Set.of("Neural", "Default");
    /**
     * Exit code after an admin's "update now" that no deploy asked for: not 0, so the unit's {@code Restart=on-failure}
     * starts the server again (a deploy's own drain still ends with 0, and the deploy script restarts it).
     */
    public static final int RESTART_EXIT = 75;
    static final long DAY_MS = 24 * 60 * 60_000L;

    /** Command-line options. */
    public static final class Options {
        public String bind = "127.0.0.1";
        public int port;
        public String trustHeader;
        /** The proxy's full-name header (Authentik: X-authentik-name): its first word is the name others see. Null: the login. */
        public String nameHeader;
        public String requireGroup;
        /**
         * The proxy's group-list header (Authentik: X-authentik-groups, oauth2-proxy: X-Forwarded-Groups), read for
         * --require-group and --admin-group, which need it. No default: the proxy must strip this header from clients,
         * so the operator names the one it sets.
         */
        public String groupsHeader;
        /** What the group list is joined with (Authentik: |). */
        public String groupsSeparator = ",";
        /** https://host[:port] for absolute links (og: tags, invites) when the request's Host header is missing or unusable. */
        public String publicUrl;
        /** Members of this group are admins (proxy mode only; null: nobody is). */
        public String adminGroup;
        /**
         * --auth: how people sign in. {@code token} (one user, the ready line's link), {@code header} (a login proxy in
         * front, --trust-proxy-header) or {@code users} (Forge Table's own accounts and sign-in page). Empty: header when
         * --trust-proxy-header is set, else token, so configs from before --auth mean what they always meant.
         */
        public final Set<String> auth = new java.util.LinkedHashSet<>();
        /** Native sign-in: a session ends after this long unused, and this long after sign-in at the latest. */
        public long sessionIdleMs = 14 * DAY_MS;
        public long sessionMaxMs = 30 * DAY_MS;
        /** Native sign-in over plain http (a LAN without TLS): session cookies without Secure. */
        public boolean insecureCookies;
        /** Header mode: where the lobby's "Sign out" goes (the proxy's sign-out URL); null: no such button. */
        public String logoutUrl;
        /**
         * --auth oidc: the provider's issuer URL (exactly as its discovery document names it), this client's id, and a
         * file holding its secret (none: a public client, PKCE only). The redirect URI is --public-url + /auth/oidc/callback.
         */
        public String oidcIssuer;
        public String oidcClientId;
        public Path oidcClientSecretFile;
        public String oidcScopes = "openid profile email";
        /** The ID token claim that is the login (the key of a person's folder), and the claims tried for their name. */
        public String oidcLoginClaim = "preferred_username";
        public String oidcNameClaim = "given_name,name";
        /** The claim with the groups --require-group and --admin-group look in. */
        public String oidcGroupsClaim = "groups";
        /** The sign-in page's button. */
        public String oidcLabel = "Sign in with SSO";
        /** {@code local}: Sign out ends the Forge Table session; {@code provider}: and then the provider's too. */
        public String oidcLogout = "local";
        /** An http issuer (a local test provider). */
        public boolean oidcInsecure;
        /**
         * An OIDC sign-in whose login matches an account with no link to that provider takes that account (once), instead
         * of being refused. For moving from header mode to OIDC with the same provider; off again afterwards.
         */
        public boolean linkByLogin;

        /** Whether Forge Table signs people in itself (--auth users, oidc). */
        public boolean sessions() {
            return auth.contains("users") || auth.contains("oidc");
        }

        /** Whether some sign-in reports groups for --require-group and --admin-group (a proxy's header, OIDC). */
        boolean groupsKnown() {
            return trustHeader != null || auth.contains("oidc");
        }

        /** Whether people sign in at all (a proxy or Forge Table's own sign-in), rather than the one local user. */
        public boolean multiUser() {
            return trustHeader != null || sessions();
        }

        /** The sign-in mode /api/me reports: token, header or users. */
        String mode() {
            return sessions() ? "users" : trustHeader != null ? "header" : "token";
        }
        /** "Update now": how long open games are warned before they end. */
        public long updateCountdownMs = 60_000;
        public Path dataDir = Path.of(System.getProperty("user.home"), ".forge-table-router");
        public String webDir;
        /**
         * The operator's own Framed-face fonts ({@link #FONT_FILES}, served at {@code <base>/fonts/<name>}); null: none,
         * and the client uses the open fonts in its bundle.
         */
        public Path fontsDir;
        /** How the lobby fetches an art crop no game has fetched yet; null: from Scryfall ({@link CachedCrops#scryfall}). */
        public CachedCrops.Download cropDownload;
        /** Hard cap on games; 0 means derived from RAM. */
        public int maxMatches;
        public long reserveMb = DEFAULT_RESERVE_MB;
        public long gameMb = DEFAULT_GAME_MB;
        public int maxPerUser = 3;
        /**
         * Close an HTTP connection that sends nothing for this long (not WebSockets). Longer than Caddy's 2-minute
         * upstream keep-alive, so the proxy never reuses a connection the router is closing.
         */
        public int readTimeoutSec = 150;
        /** In drain mode, end the remaining games and exit after this long. */
        public long drainTimeoutMs = 120 * 60_000L;
        public long drainTickMs = 1000;
        /**
         * A second listener on 127.0.0.1 for /healthz and /admin/* only (0: none). Needed when --bind is the host's
         * private address, which local scripts can't reach as a loopback peer.
         */
        public int adminPort;
        /** "on" (sent by default, a user may turn it off), "optin" (off by default) or "off" (never, toggle hidden). */
        public String uploadMode = "off";
        /** Where a game's training trajectory is PUT once it ends; null disables uploading regardless of {@link #uploadMode}. */
        public String uploadUrl;
        public final ChildProcessHost.Config child = new ChildProcessHost.Config();
        /** pvp: an invite link works this long after it was made. */
        public long inviteMs = 15 * 60_000L;
        /** pvp: a game nobody joined within this long is ended. */
        public long waitingMs = 30 * 60_000L;
        /** pvp: at most this many invite links per person per {@link #mintWindowMs}. */
        public int mintLimit = 10;
        public long mintWindowMs = 10 * 60_000L;
        public long waitingTickMs = 15_000;
        /** Serve /g/* and let a pvp link's creator allow guests (no login). Needs the proxy header. */
        public boolean guests;
        /**
         * The one header the proxy puts the client's address in (Caddy: {@code header_up X-Real-IP {remote_host}}), for the
         * guest join limit. Null: the socket's peer. An unconfigured header is never read.
         */
        public String realIpHeader;
        /** A guest token works at most this long. */
        public long guestMs = 4 * 60 * 60_000L;
        /** At most this many guest joins per client address per {@link #guestJoinWindowMs}. */
        public int guestJoinLimit = 5;
        public long guestJoinWindowMs = 10 * 60_000L;
        /** At most this many games with a guest at once (each is a JVM of about 1.5 GB). */
        public int maxGuestGames = 2;
        /** At most this many client addresses tracked by the guest join limit; when full, a new address is refused (429). */
        public int guestJoinAddresses = 10_000;
        /** A user counts as online ("Online now") this long after their last request, and while a game's socket is open. */
        public long onlineMs = 60_000;
        /** At most this many users tracked as online; when full, a new one isn't (until quiet ones are forgotten). */
        public int onlineMax = 1_000;
        /** The clock guest tokens, the guest join limit, presence and direct invites read (tests move it). */
        public java.util.function.LongSupplier clock = System::currentTimeMillis;
    }

    /** What kind of person a {@link Principal} is: a USER signed in (Authentik, or the local user), or a GUEST without a login. */
    public enum Kind { USER, GUEST }

    /**
     * Who is asking. For a USER, {@code id} is the login (the proxy header's user, a native account's login, or
     * "local"): the same string as a game's owner, the key of their deck folder, upload choice and caps. {@code name} is
     * what the other player sees. {@code admin} is decided once, by {@link Router#identify}, for whichever sign-in mode.
     */
    public record Principal(Kind kind, String id, String name, boolean admin) {
        Principal(final Kind kind, final String id, final String name) {
            this(kind, id, name, false);
        }

        static Principal user(final String id) {
            return new Principal(Kind.USER, id, id);
        }

        /**
         * A guest: a random id (never a login, so it owns no folders, choices or caps) and the typed name, already
         * {@link Router#guestName cleaned}, marked as a guest's wherever it is shown.
         */
        static Principal guest(final String name) {
            return new Principal(Kind.GUEST, GUEST_ID + ChildProcessHost.randomHex(16), name + " (guest)");
        }

        private static final String GUEST_ID = "guest-";

        /** Whether a game owner's id is a guest's (a guest lives in one router run: nothing of theirs outlives it). */
        static boolean isGuestId(final String id) {
            return id.startsWith(GUEST_ID);
        }

        /** The login whose folders (decks, upload choice) this is, or null: only a USER has any. */
        String userOrNull() {
            return kind == Kind.USER ? id : null;
        }

        boolean same(final Principal o) {
            return o != null && kind == o.kind && id.equals(o.id);
        }
    }

    /** Someone at a game: seat 0 started it, seat 1 joined (a game between two people). */
    public record Member(Principal who, int seat) { }

    /** "{creator} wants to play": seat 1 of a waiting pvp game is held for {@code to} alone until {@code expires} ({@link Options#clock}). */
    record DirectInvite(Principal to, long expires) { }

    /** Set on a connection once its WebSocket upgrade has counted toward its user's open game sockets. */
    private static final AttributeKey<Boolean> AT_TABLE = AttributeKey.valueOf("forge.router.atTable");

    /**
     * A signed-in user the router has seen ("Online now"): their latest principal (the name may change), when, how many of
     * their game sockets are open, and the random handle others invite them by (never their login).
     */
    private static final class Seen {
        final String key = ChildProcessHost.randomHex(16);
        Principal who;
        long last;
        int sockets;
    }

    /** A game between two people as the router knows it: who sits where, and its invite (fields under capLock). */
    private static final class PvpGame {
        final String id;
        final Principal creator;
        final boolean listed;
        final long created = System.currentTimeMillis();
        volatile Principal joiner;
        /** Set under capLock once it is being cancelled or reaped while nobody had joined: no join may land after. */
        boolean closed;
        /** The live invite code, or null (none made yet, used, or expired); and when it stops working. */
        String code;
        long codeExpires;
        /** The creator allows guests: the code also works at /g/join/ (a new link keeps this unless asked otherwise). */
        boolean guests;
        /** A direct invite to one user online, or null (none, declined, used); written under capLock. */
        volatile DirectInvite direct;

        PvpGame(final String id, final Principal creator, final boolean listed, final boolean guests) {
            this.id = id;
            this.creator = creator;
            this.listed = listed;
            this.guests = guests;
        }

        List<Member> members() {
            final Principal j = joiner;
            return j == null ? List.of(new Member(creator, 0)) : List.of(new Member(creator, 0), new Member(j, 1));
        }
    }

    private final Options o;
    private final GameHost host;
    /** Native sign-in (--auth users): the accounts, their sessions and the sign-in routes; all null in the other modes. */
    private final UserStore users;
    private final Sessions sessions;
    private final AuthRoutes authRoutes;
    private final InetAddress bindAddr;
    private final int maxMatches;
    private final UploadPrefs uploadPrefs;
    private final String token = ChildProcessHost.randomHex(16);
    private final Object capLock = new Object();
    private final String[] build = buildInfo();
    /** When this router started (the Admin sheet's uptime). */
    private final long started = System.currentTimeMillis();
    /** Games between two people, by id; and their live invite codes, code → game id. */
    private final java.util.Map<String, PvpGame> pvp = new java.util.concurrent.ConcurrentHashMap<>();
    /** The AI asked for at create (Neural or Default; unset = the game's default), echoed on the lobby's game card. */
    private final java.util.Map<String, String> aiByGame = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Map<String, String> invites = new java.util.concurrent.ConcurrentHashMap<>();
    /** When each person made their recent invite links (capLock). */
    private final java.util.Map<String, java.util.ArrayDeque<Long>> mints = new java.util.HashMap<>();
    /** Live guest tokens by their SHA-256 (hex); the token itself is only ever in the guest's cookie. */
    private final java.util.Map<String, GuestSeat> guestSeats = new java.util.concurrent.ConcurrentHashMap<>();
    /** When each client address made its recent guest joins (capLock). */
    private final java.util.Map<String, java.util.ArrayDeque<Long>> guestJoins = new java.util.HashMap<>();
    /** Users seen lately, by login, and the same entries by their handle (both guarded by {@code presence} itself). */
    private final java.util.Map<String, Seen> presence = new java.util.HashMap<>();
    private final java.util.Map<String, Seen> presenceByKey = new java.util.HashMap<>();
    private volatile boolean draining;
    /** A deploy asked for the drain (POST /admin/drain): exit 0, the deploy script restarts the server. */
    private volatile boolean drainRequested;
    /** An admin's "update now" is counting down: when the games end (epoch ms), or 0. */
    private volatile long restartAt;
    private volatile Runnable onDrained = () -> { };
    private final java.util.concurrent.ScheduledExecutorService drainTimer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
        final Thread t = new Thread(r, "router-drain");
        t.setDaemon(true);
        return t;
    });
    private EventLoopGroup boss;
    private EventLoopGroup workers;
    private Channel channel;
    private Channel adminChannel;
    private int port;

    /** The lobby's cached art crops ({@code GET /api/art/crop/…}); null when the games show no curated art. */
    private final CachedCrops crops;
    /** Every finished game's result, for records and "last played" ({@code <data>/results.jsonl}). */
    private final Results results;
    /** When each signed-in user was last seen, by login (presence forgets quiet users; "away · 2 days ago" needs this). */
    private final java.util.Map<String, Long> lastSeen = new java.util.LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(final java.util.Map.Entry<String, Long> e) {
            return size() > 10_000;
        }
    };

    public Router(final Options o, final GameHost host) {
        this.o = o;
        this.host = host;
        this.bindAddr = checkBind(o.bind, o.multiUser());
        if (o.sessions()) {
            final forge.bridge.auth.OidcLogin oidc = o.auth.contains("oidc") ? oidc(o) : null; // a bad secret file stops us first
            final Path db = o.dataDir.resolve("forge-table.db");
            try {
                this.users = new UserStore(db);
            } catch (final java.sql.SQLException e) {
                throw new IllegalArgumentException("Cannot open " + db + ": " + e.getMessage(), e);
            }
            this.sessions = new Sessions(users, o.sessionIdleMs, o.sessionMaxMs, o.insecureCookies, o.clock);
            this.authRoutes = new AuthRoutes(this, o, users, sessions, oidc);
        } else {
            this.users = null;
            this.sessions = null;
            this.authRoutes = null;
        }
        this.maxMatches = o.maxMatches > 0 ? o.maxMatches : ramCap(o.reserveMb, o.gameMb);
        this.uploadPrefs = new UploadPrefs(o.dataDir.resolve("mtgai-upload-prefs.json"));
        this.crops = cachedCrops(o);
        this.results = new Results(o.dataDir.resolve("results.jsonl"));
        host.onFinished(this::finished);
        host.uploadConsent(this::uploadEffective);
        for (final GameHost.Game g : host.list()) { // games kept from the last run
            if (Principal.isGuestId(g.owner())) {
                host.end(g.id(), "a guest's game isn't kept over a restart");
                continue;
            }
            final String ai = host.ai(g.id());
            if (ai != null) {
                aiByGame.put(g.id(), ai);
            }
            final JsonObject facts = host.remembered(g.id());
            if (facts != null && facts.has("pvp")) {
                final PvpGame p = keptPvp(g.id(), facts.getAsJsonObject("pvp"));
                if (p != null) {
                    pvp.put(g.id(), p);
                } else {
                    host.end(g.id(), "a game with a guest isn't kept over a restart");
                }
            }
        }
        reconcileUpload();
    }

    /**
     * The crops the games put in {@code <data>/cache/table} (their {@code .cache/forge/table}), read as a game would
     * resolve them: from the {@code --card-image-map} the games get, else the map they build there; none unless the
     * games' art is curated ({@code --card-art}, whose default is curated, or off with {@code --test-prefs}, as in Main).
     */
    static CachedCrops cachedCrops(final Options o) {
        final List<String> args = o.child.childArgs;
        String mode = args.contains("--test-prefs") ? "off" : "curated";
        String userMap = null;
        for (int i = 0; i + 1 < args.size(); i++) {
            if ("--card-art".equals(args.get(i))) {
                mode = args.get(i + 1);
            } else if ("--card-image-map".equals(args.get(i))) {
                userMap = args.get(i + 1);
            }
        }
        if (!"curated".equalsIgnoreCase(mode.trim())) {
            return null;
        }
        return new CachedCrops(o.dataDir.resolve("cache").resolve("table"), userMap == null ? null : Path.of(userMap),
                o.cropDownload != null ? o.cropDownload : CachedCrops.scryfall(forge.util.BuildInfo.getUserAgent() + " ForgeTable"));
    }

    /**
     * Start from the saved choices: withdraw the consent of everyone who doesn't consent now (a crash between saving a
     * choice and withdrawing, or the operator switching the channel's default off, must not leave them sending).
     */
    private void reconcileUpload() {
        if (!uploadKnown()) {
            host.retainUploadOnly(Set.of());
        } else if ("on".equals(o.uploadMode)) {
            uploadPrefs.all().forEach((user, on) -> {
                if (!on) {
                    host.withdrawUpload(user);
                }
            });
        } else {
            final Set<String> yes = new java.util.HashSet<>();
            uploadPrefs.all().forEach((user, on) -> {
                if (on) {
                    yes.add(user);
                }
            });
            host.retainUploadOnly(yes);
        }
    }

    public static void main(final String[] args) throws Exception {
        final Options o;
        try {
            o = parse(args);
            checkBind(o.bind, o.multiUser());
        } catch (final IllegalArgumentException e) {
            System.out.println("FORGE_TABLE_ERROR " + error(e.getMessage()));
            System.exit(2);
            return;
        }
        o.child.dataDir = o.dataDir;
        final Router r;
        try {
            r = new Router(o, new ChildProcessHost(o.child));
        } catch (final IllegalArgumentException e) {
            System.out.println("FORGE_TABLE_ERROR " + error(e.getMessage()));
            System.exit(2);
            return;
        }
        r.start();
        r.onDrained(() -> System.exit(r.exitCode())); // drain mode: the deploy script waits for this exit
        Runtime.getRuntime().addShutdownHook(new Thread(r.host::close, "router-shutdown"));

        final JsonObject ready = new JsonObject();
        ready.addProperty("mode", "router");
        ready.addProperty("port", r.port());
        ready.addProperty("maxMatches", r.maxMatches());
        ready.addProperty("maxPerUser", o.maxPerUser);
        final String base = "http://" + (r.bindAddr.getHostAddress().contains(":") ? "[" + r.bindAddr.getHostAddress() + "]" : r.bindAddr.getHostAddress())
                + ":" + r.port() + "/";
        if (!o.multiUser()) {
            ready.addProperty("token", r.token());
            ready.addProperty("url", base + "#t=" + r.token());
        } else {
            ready.addProperty("url", base);
        }
        System.out.println("FORGE_TABLE_READY " + ready);
        System.out.flush();
        BridgeLog.info("router on " + base + " (" + (o.sessions() ? "sign-in: " + String.join(", ", o.auth)
                : o.trustHeader == null ? "local user" : "user from " + o.trustHeader)
                + "), up to " + r.maxMatches() + " games, " + o.maxPerUser + " per user");
        if (o.sessions()) {
            r.authRoutes.startupNotes();
        }

        final Thread watchdog = new Thread(() -> {
            try (InputStream in = System.in) {
                while (in.read() != -1) {
                    // drain
                }
            } catch (final IOException ignored) {
                // treat as EOF
            }
            if (!Boolean.getBoolean("forge.table.ignoreStdin")) {
                BridgeLog.info("stdin closed; shutting down");
                r.stop();
                System.exit(0);
            }
        }, "stdin-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        Thread.currentThread().join();
    }

    /** Router flags that take no value. */
    static final Set<String> SWITCHES = Set.of("--guests", "--test-prefs", "--debug", "--insecure-cookies", "--oidc-insecure", "--link-by-login");
    /** Router flags that take a value (keep in step with {@link #parse}). */
    static final List<String> VALUE_FLAGS = List.of("--bind", "--port", "--data", "--trust-proxy-header", "--name-header",
            "--require-group", "--admin-group", "--groups-header", "--groups-separator", "--public-url", "--max-matches",
            "--reserve-mb", "--game-mb", "--max-per-user", "--idle-minutes", "--grace-minutes", "--admin-port", "--mtgai-upload",
            "--mtgai-upload-url", "--drain-timeout", "--web", "--assets", "--decks", "--card-art", "--card-image-map",
            "--game-log-dir", "--game-log-keep", "--game-log-max-bytes",
            "--real-ip-header", "--fonts", "--auth", "--session-idle-days", "--session-max-days", "--logout-url",
            "--oidc-issuer", "--oidc-client-id", "--oidc-client-secret-file", "--oidc-scopes", "--oidc-login-claim", "--oidc-name-claim",
            "--oidc-groups-claim", "--oidc-label", "--oidc-logout");

    static Options parse(final String[] args) {
        return uploadNeedsPlugin(parseArgs(withDefaults(args, System.getenv())), forge.bridge.NeuralStatus.pluginInstalled());
    }

    /**
     * Uploading sends the Neural AI plugin's training data, so with no plugin installed there is nothing to send and the
     * lobby's upload switch would lie: upload is off, with a warning (not a refusal: a missing plugin must not take the
     * whole server down).
     */
    static Options uploadNeedsPlugin(final Options o, final boolean pluginInstalled) {
        if (!pluginInstalled && o.uploadUrl != null && !"off".equals(o.uploadMode)) {
            BridgeLog.info("--mtgai-upload " + o.uploadMode + " ignored: no Neural AI plugin is installed; upload is off");
            o.uploadMode = "off";
            o.uploadUrl = null;
        }
        return o;
    }

    /**
     * The --data directory as the router resolves it from these arguments, the environment and --config, so
     * {@code --users} works on the same {@code forge-table.db} as the server it sits next to.
     */
    public static Path dataDir(final String[] args) {
        final String[] all = withDefaults(args, System.getenv());
        Path dir = new Options().dataDir;
        for (int i = 0; i + 1 < all.length; i++) {
            if (all[i].equals("--data")) {
                dir = Path.of(all[i + 1]);
            }
        }
        return dir;
    }

    /** FT_MAX_MATCHES for --max-matches. */
    static String envName(final String flag) {
        return "FT_" + flag.substring(2).replace('-', '_').toUpperCase(java.util.Locale.ROOT);
    }

    /**
     * The command line with every flag it lacks filled in from the environment ({@code FT_<FLAG>}: --max-matches is
     * FT_MAX_MATCHES), else from the {@code --config FILE} (or FT_CONFIG) file, which takes the same FT_ names as
     * KEY=VALUE lines, so a systemd EnvironmentFile works as one. Command line beats environment beats file beats the
     * built-in default. A blank value is no value; a switch (--guests) is on for true, 1, yes or on.
     */
    static String[] withDefaults(final String[] args, final java.util.Map<String, String> env) {
        final List<String> given = new java.util.ArrayList<>();
        final Set<String> named = new java.util.HashSet<>(); // flags on the command line, not their values
        String config = env.get("FT_CONFIG");
        for (int i = 0; i < args.length; i++) {
            if (args[i].equals("--config")) {
                if (i + 1 >= args.length) {
                    throw new IllegalArgumentException("--config needs a file");
                }
                config = args[++i];
                continue;
            }
            given.add(args[i]);
            named.add(args[i]);
            if (VALUE_FLAGS.contains(args[i]) && i + 1 < args.length) {
                given.add(args[++i]);
            }
        }
        final java.util.Properties file = new java.util.Properties();
        if (config != null && !config.isBlank()) {
            try (java.io.Reader in = java.nio.file.Files.newBufferedReader(Path.of(config), StandardCharsets.UTF_8)) {
                file.load(in);
            } catch (final IOException e) {
                throw new IllegalArgumentException("Cannot read --config " + config + ": " + e.getMessage());
            }
        }
        final List<String> out = new java.util.ArrayList<>();
        final java.util.function.Function<String, String> value = flag -> {
            String v = env.get(envName(flag));
            if (v == null || v.isBlank()) {
                v = file.getProperty(envName(flag));
                if (v != null && v.length() >= 2 && (v.startsWith("\"") && v.endsWith("\"")
                        || v.startsWith("'") && v.endsWith("'"))) {
                    v = v.substring(1, v.length() - 1); // EnvironmentFile quoting
                }
            }
            return v == null || v.isBlank() ? null : v.trim();
        };
        for (final String flag : VALUE_FLAGS) {
            final String v = named.contains(flag) ? null : value.apply(flag);
            if (v != null) {
                out.add(flag);
                out.add(v);
            }
        }
        for (final String flag : SWITCHES) {
            final String v = named.contains(flag) ? null : value.apply(flag);
            if (v != null && Set.of("true", "1", "yes", "on").contains(v.toLowerCase(java.util.Locale.ROOT))) {
                out.add(flag);
            }
        }
        out.addAll(given);
        return out.toArray(new String[0]);
    }

    static Options parseArgs(final String[] args) {
        final Options o = new Options();
        final List<String> child = o.child.childArgs;
        for (int i = 0; i < args.length; i++) {
            final String a = args[i];
            switch (a) {
                case "--router" -> { }
                case "--bind" -> o.bind = args[++i];
                case "--port" -> o.port = Integer.parseInt(args[++i]);
                case "--data" -> o.dataDir = Path.of(args[++i]);
                case "--trust-proxy-header" -> o.trustHeader = args[++i];
                case "--name-header" -> o.nameHeader = args[++i];
                case "--require-group" -> o.requireGroup = args[++i];
                case "--admin-group" -> o.adminGroup = args[++i];
                case "--groups-header" -> o.groupsHeader = args[++i];
                case "--groups-separator" -> o.groupsSeparator = args[++i];
                case "--public-url" -> o.publicUrl = args[++i];
                case "--max-matches" -> o.maxMatches = Integer.parseInt(args[++i]);
                case "--reserve-mb" -> o.reserveMb = Long.parseLong(args[++i]);
                case "--game-mb" -> o.gameMb = Long.parseLong(args[++i]);
                case "--max-per-user" -> o.maxPerUser = Integer.parseInt(args[++i]);
                case "--idle-minutes" -> o.child.idleMs = (long) (Double.parseDouble(args[++i]) * 60_000);
                case "--grace-minutes" -> o.child.graceMs = (long) (Double.parseDouble(args[++i]) * 60_000);
                case "--admin-port" -> o.adminPort = Integer.parseInt(args[++i]);
                case "--mtgai-upload" -> o.uploadMode = args[++i];
                case "--mtgai-upload-url" -> o.uploadUrl = args[++i];
                case "--drain-timeout" -> o.drainTimeoutMs = (long) (Double.parseDouble(args[++i]) * 60_000);
                case "--web" -> {
                    o.webDir = args[++i];
                    child.add(a);
                    child.add(o.webDir);
                }
                case "--assets", "--decks", "--card-art", "--card-image-map", "--game-log-dir" -> {
                    child.add(a);
                    child.add(args[++i]);
                }
                case "--game-log-keep", "--game-log-max-bytes" -> {
                    final String value = args[++i];
                    final long n = Long.parseLong(value);
                    if (n < ("--game-log-keep".equals(a) ? 1 : 1024)
                            || ("--game-log-keep".equals(a) && n > Integer.MAX_VALUE)) {
                        throw new IllegalArgumentException("invalid " + a);
                    }
                    child.add(a);
                    child.add(value);
                }
                case "--test-prefs" -> child.add(a);
                case "--guests" -> o.guests = true;
                case "--real-ip-header" -> o.realIpHeader = args[++i];
                case "--fonts" -> {
                    final String dir = args[++i];
                    o.fontsDir = dir.isBlank() ? null : Path.of(dir); // empty (the unit's FT_FONTS unset): the bundled fonts
                }
                case "--debug" -> {
                    BridgeLog.setDebug(true);
                    child.add(a);
                }
                case "--auth" -> {
                    for (final String v : args[++i].split(",")) {
                        if (!v.isBlank()) {
                            o.auth.add(v.trim().toLowerCase(java.util.Locale.ROOT));
                        }
                    }
                }
                case "--session-idle-days" -> o.sessionIdleMs = days("--session-idle-days", args[++i]);
                case "--session-max-days" -> o.sessionMaxMs = days("--session-max-days", args[++i]);
                case "--insecure-cookies" -> o.insecureCookies = true;
                case "--logout-url" -> {
                    final String url = args[++i].trim();
                    o.logoutUrl = url.isEmpty() ? null : url; // empty (the unit's FT_LOGOUT_URL unset): no button
                }
                case "--oidc-issuer" -> o.oidcIssuer = args[++i].trim();
                case "--oidc-client-id" -> o.oidcClientId = args[++i].trim();
                case "--oidc-client-secret-file" -> o.oidcClientSecretFile = Path.of(args[++i].trim());
                case "--oidc-scopes" -> o.oidcScopes = args[++i].trim().replaceAll("\\s+", " ");
                case "--oidc-login-claim" -> o.oidcLoginClaim = args[++i].trim();
                case "--oidc-name-claim" -> o.oidcNameClaim = args[++i].trim();
                case "--oidc-groups-claim" -> o.oidcGroupsClaim = args[++i].trim();
                case "--oidc-label" -> o.oidcLabel = args[++i].trim();
                case "--oidc-logout" -> o.oidcLogout = args[++i].trim().toLowerCase(java.util.Locale.ROOT);
                case "--oidc-insecure" -> o.oidcInsecure = true;
                case "--link-by-login" -> o.linkByLogin = true;
                default -> throw new IllegalArgumentException("Unknown router option " + a);
            }
        }
        checkAuth(o);
        if (o.requireGroup != null && o.requireGroup.isBlank()) {
            throw new IllegalArgumentException("--require-group is empty: name a group, or leave the flag out");
        }
        if (o.requireGroup != null && !o.groupsKnown()) {
            throw new IllegalArgumentException("--require-group needs a sign-in that reports groups (--trust-proxy-header or --auth oidc)");
        }
        // an empty --admin-group (the unit's FT_ADMIN_GROUP unset or empty) means no admins, not a crash loop
        if (o.adminGroup != null && o.adminGroup.isBlank()) {
            BridgeLog.info("--admin-group is empty: no admins");
            o.adminGroup = null;
        }
        if (o.adminGroup != null && !o.groupsKnown()) {
            throw new IllegalArgumentException("--admin-group needs a sign-in that reports groups (--trust-proxy-header or --auth oidc)");
        }
        if (o.nameHeader != null && o.nameHeader.isBlank()) {
            o.nameHeader = null;
        }
        if (o.nameHeader != null && o.trustHeader == null) {
            throw new IllegalArgumentException("--name-header needs --trust-proxy-header");
        }
        // an empty --mtgai-upload-url (the unit's FT_MTGAI_UPLOAD_URL unset) means never upload, not a crash loop
        if (o.uploadUrl != null && o.uploadUrl.isBlank()) {
            o.uploadUrl = null;
        }
        if (o.guests && !o.multiUser()) {
            throw new IllegalArgumentException("--guests needs sign-in (--trust-proxy-header or --auth users or oidc)");
        }
        if (o.realIpHeader != null && o.realIpHeader.isBlank()) {
            o.realIpHeader = null;
        }
        // Behind the proxy every socket peer is the proxy: without its client-address header all guests would share one
        // join budget, and one client could use it up for everybody.
        if (o.guests && o.realIpHeader == null) {
            throw new IllegalArgumentException("--guests needs --real-ip-header (the proxy's client-address header, e.g. X-Real-IP)");
        }
        // The same for sign-in: the per-address try limit would be one shared bucket, and a stranger's wrong guesses
        // would lock everyone out. (OIDC alone has no password, so no such limit.)
        if (o.auth.contains("users") && o.realIpHeader == null) {
            throw new IllegalArgumentException("--auth users needs --real-ip-header (the proxy's client-address header, e.g. X-Real-IP)");
        }
        if (o.groupsHeader != null && o.groupsHeader.isBlank()) {
            o.groupsHeader = null;
        }
        if ((o.requireGroup != null || o.adminGroup != null) && o.trustHeader != null && o.groupsHeader == null) {
            throw new IllegalArgumentException("--require-group and --admin-group need --groups-header (the proxy's group-list header)");
        }
        if (o.groupsSeparator.isEmpty()) {
            throw new IllegalArgumentException("--groups-separator can't be empty");
        }
        if (o.publicUrl != null) {
            o.publicUrl = o.publicUrl.replaceFirst("/+$", "").toLowerCase(java.util.Locale.ROOT);
            if (!o.publicUrl.matches("https?://[a-z0-9.-]{1,253}(:[0-9]{1,5})?")) {
                throw new IllegalArgumentException("--public-url is http(s)://host[:port], nothing after it");
            }
        }
        if (!Set.of("on", "optin", "off").contains(o.uploadMode)) {
            throw new IllegalArgumentException("--mtgai-upload is on, optin or off");
        }
        if (o.fontsDir != null && !java.nio.file.Files.isDirectory(o.fontsDir)) {
            throw new IllegalArgumentException("--fonts " + o.fontsDir + " is not a directory");
        }
        return o;
    }

    /** The sign-in modes --auth knows. */
    static final Set<String> AUTH_MODES = Set.of("token", "header", "users", "oidc");

    /**
     * --auth against the rest: known modes only; token and header stand alone; header is --trust-proxy-header's mode
     * and nothing else is; the session and cookie settings only where there are sessions.
     */
    static void checkAuth(final Options o) {
        for (final String mode : o.auth) {
            if (!AUTH_MODES.contains(mode)) {
                throw new IllegalArgumentException("--auth takes token, header, users or oidc, not " + mode);
            }
        }
        checkOidc(o);
        if (o.auth.size() > 1 && (o.auth.contains("token") || o.auth.contains("header"))) {
            throw new IllegalArgumentException("--auth token and --auth header can't be combined with another mode");
        }
        if (o.auth.contains("header") && o.trustHeader == null) {
            throw new IllegalArgumentException("--auth header needs --trust-proxy-header (the header your login proxy sets)");
        }
        if (o.trustHeader != null && !o.auth.isEmpty() && !o.auth.contains("header")) {
            throw new IllegalArgumentException("--trust-proxy-header is for --auth header (a login proxy in front); with --auth "
                    + String.join(",", o.auth) + " leave it out");
        }
        if (o.insecureCookies && !o.sessions()) {
            throw new IllegalArgumentException("--insecure-cookies only applies to --auth users or oidc");
        }
        if (o.sessionIdleMs > o.sessionMaxMs) {
            throw new IllegalArgumentException("--session-idle-days can't be longer than --session-max-days");
        }
        if (o.logoutUrl != null && o.trustHeader == null) {
            throw new IllegalArgumentException("--logout-url is for --auth header (the proxy's sign-out address)");
        }
        if (o.logoutUrl != null && !o.logoutUrl.matches("(https?://|/(?![/\\\\]))[^\\s\"<>]*")) {
            throw new IllegalArgumentException("--logout-url is an http(s):// address or a path starting with /");
        }
    }

    /**
     * The --oidc-* settings: with --auth oidc an issuer (https unless --oidc-insecure), a client id, --public-url (the
     * redirect URI is built from it) and the openid scope; without it, none of them.
     */
    static void checkOidc(final Options o) {
        if (!o.auth.contains("oidc")) {
            if (o.oidcIssuer != null || o.oidcClientId != null || o.oidcClientSecretFile != null || o.oidcInsecure) {
                throw new IllegalArgumentException("the --oidc-* settings are for --auth oidc");
            }
            if (o.linkByLogin) {
                throw new IllegalArgumentException("--link-by-login is for --auth oidc");
            }
            return;
        }
        if (o.oidcIssuer == null || o.oidcIssuer.isEmpty() || o.oidcClientId == null || o.oidcClientId.isEmpty()) {
            throw new IllegalArgumentException("--auth oidc needs --oidc-issuer and --oidc-client-id");
        }
        if (!o.oidcIssuer.matches("https://[^\\s?#]+") && !(o.oidcInsecure && o.oidcIssuer.matches("http://[^\\s?#]+"))) {
            throw new IllegalArgumentException("--oidc-issuer is an https:// URL without ? or # (--oidc-insecure allows http, for a local test provider only)");
        }
        if (o.publicUrl == null || o.publicUrl.isBlank()) {
            throw new IllegalArgumentException("--auth oidc needs --public-url: the provider sends people back to it + /auth/oidc/callback");
        }
        if (!java.util.Arrays.asList(o.oidcScopes.split(" ")).contains("openid")) {
            throw new IllegalArgumentException("--oidc-scopes must include openid");
        }
        if (o.oidcLoginClaim.isEmpty() || o.oidcLabel.isEmpty()) {
            throw new IllegalArgumentException("--oidc-login-claim and --oidc-label can't be empty");
        }
        if (!o.oidcLogout.equals("local") && !o.oidcLogout.equals("provider")) {
            throw new IllegalArgumentException("--oidc-logout is local or provider");
        }
    }

    /** The OIDC client for these options: reads the client secret file (trimmed). */
    static forge.bridge.auth.OidcLogin oidc(final Options o) {
        String secret = null;
        if (o.oidcClientSecretFile != null) {
            try {
                secret = java.nio.file.Files.readString(o.oidcClientSecretFile, StandardCharsets.UTF_8).trim();
            } catch (final IOException e) {
                throw new IllegalArgumentException("Cannot read --oidc-client-secret-file " + o.oidcClientSecretFile + ": " + e.getMessage());
            }
            if (secret.isEmpty()) {
                throw new IllegalArgumentException("--oidc-client-secret-file " + o.oidcClientSecretFile + " is empty");
            }
        }
        final List<String> names = new java.util.ArrayList<>();
        for (final String n : o.oidcNameClaim.split(",")) {
            if (!n.isBlank()) {
                names.add(n.trim());
            }
        }
        // groups only matter for --require-group and --admin-group; without them the provider isn't asked for any
        final String groups = o.requireGroup == null && o.adminGroup == null || o.oidcGroupsClaim.isEmpty() ? null : o.oidcGroupsClaim;
        return new forge.bridge.auth.OidcLogin(new forge.bridge.auth.OidcLogin.Config(o.oidcIssuer, o.oidcClientId, secret, o.oidcScopes,
                o.oidcLoginClaim, names, groups, o.publicUrl + "/auth/oidc/callback", o.oidcInsecure), o.clock);
    }

    /** A whole number of days from 1 to 3650, as milliseconds. */
    static long days(final String flag, final String v) {
        final long d;
        try {
            d = Long.parseLong(v.trim());
        } catch (final NumberFormatException e) {
            throw new IllegalArgumentException(flag + " is a whole number of days");
        }
        if (d < 1 || d > 3650) {
            throw new IllegalArgumentException(flag + " is 1 to 3650 days");
        }
        return d * DAY_MS;
    }

    /**
     * Loopback always; with sign-in (proxy header, users or oidc) also one private address (RFC 1918, IPv6 unique-local: where a Docker
     * bridge lives); never a wildcard or a public address. The port is the identity boundary: only the reverse
     * proxy may reach it.
     */
    static InetAddress checkBind(final String bind, final boolean proxied) {
        final InetAddress a;
        try {
            a = InetAddress.getByName(bind);
        } catch (final UnknownHostException e) {
            throw new IllegalArgumentException("Cannot resolve --bind " + bind);
        }
        if (a.isAnyLocalAddress()) {
            throw new IllegalArgumentException("Refusing to listen on the wildcard address " + bind
                    + ": give --bind 127.0.0.1 or the one address the reverse proxy connects to");
        }
        if (!a.isLoopbackAddress() && !proxied) {
            throw new IllegalArgumentException("Refusing to listen on " + bind
                    + " without sign-in (--trust-proxy-header, --auth users or oidc): only loopback is allowed without login");
        }
        if (!a.isLoopbackAddress() && !isPrivate(a)) {
            throw new IllegalArgumentException("Refusing to listen on " + bind
                    + ": with sign-in only loopback or a private (RFC 1918 / Docker bridge) address is allowed");
        }
        return a;
    }

    private static boolean isPrivate(final InetAddress a) {
        if (a instanceof java.net.Inet4Address) {
            return a.isSiteLocalAddress(); // 10/8, 172.16/12, 192.168/16
        }
        return (a.getAddress()[0] & 0xfe) == 0xfc; // fc00::/7
    }

    /** floor((RAM − reserve) / per-game RAM), at least 1. */
    static int ramCap(final long reserveMb, final long gameMb) {
        final long totalMb = ((com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean()).getTotalMemorySize() >> 20;
        return (int) Math.max(1, (totalMb - reserveMb) / Math.max(1, gameMb));
    }

    public int port() { return port; }
    public String token() { return token; }
    public int maxMatches() { return maxMatches; }
    int adminPort() { return adminChannel == null ? 0 : ((InetSocketAddress) adminChannel.localAddress()).getPort(); }
    public boolean draining() { return draining; }

    /** How the process exits once drained: 0 for a deploy's drain, {@link #RESTART_EXIT} after an admin's update alone. */
    public int exitCode() {
        return drainRequested || restartAt == 0 ? 0 : RESTART_EXIT;
    }

    /** Run once the router has drained (or the drain timed out) and stopped. */
    public void onDrained(final Runnable r) {
        onDrained = r;
    }

    public void start() throws InterruptedException {
        boss = new NioEventLoopGroup(1);
        workers = new NioEventLoopGroup(2);
        channel = listen(bindAddr, o.port, false);
        port = ((InetSocketAddress) channel.localAddress()).getPort();
        drainTimer.scheduleWithFixedDelay(this::reapWaiting, o.waitingTickMs, o.waitingTickMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        if (o.adminPort > 0) {
            adminChannel = listen(InetAddress.getLoopbackAddress(), o.adminPort, true);
        }
    }

    /** A listener; an admin one (127.0.0.1, --admin-port) answers only /healthz and /admin/*. */
    private Channel listen(final InetAddress addr, final int listenPort, final boolean adminOnly) throws InterruptedException {
        final ServerBootstrap b = new ServerBootstrap()
                .group(boss, workers)
                .channel(NioServerSocketChannel.class)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(final SocketChannel ch) {
                        ch.pipeline().addLast(READ_TIMEOUT, new ReadTimeoutHandler(o.readTimeoutSec));
                        ch.pipeline().addLast(new HttpServerCodec());
                        ch.pipeline().addLast(new HttpObjectAggregator(1 << 16));
                        ch.pipeline().addLast(new Handler(adminOnly));
                    }
                });
        return b.bind(new InetSocketAddress(addr, listenPort)).sync().channel();
    }

    public void stop() {
        drainTimer.shutdownNow();
        host.close();
        if (authRoutes != null) {
            authRoutes.close();
            users.close();
        }
        if (channel != null) {
            channel.close();
        }
        if (adminChannel != null) {
            adminChannel.close();
        }
        if (boss != null) {
            boss.shutdownGracefully();
        }
        if (workers != null) {
            workers.shutdownGracefully();
        }
    }

    // ---------------------------------------------------------------- requests

    private final class Handler extends SimpleChannelInboundHandler<FullHttpRequest> {
        private final boolean adminOnly;

        Handler(final boolean adminOnly) {
            this.adminOnly = adminOnly;
        }

        @Override
        protected void channelRead0(final ChannelHandlerContext ctx, final FullHttpRequest req) throws IOException {
            final QueryStringDecoder q = new QueryStringDecoder(req.uri());
            final String path = q.rawPath();
            if (path.equals("/healthz") || path.startsWith("/admin/")) {
                admin(ctx, req, path);
            } else if (adminOnly) {
                sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found"); // never the lobby, API or games
            } else if (path.startsWith("/m/")) {
                game(ctx, req, q, path);
            } else if (path.startsWith("/api/")) {
                api(ctx, req, q, path);
            } else if (path.equals("/g") || path.startsWith("/g/")) {
                guest(ctx, req, q, path);
            } else if (path.equals("/auth") || path.startsWith("/auth/")) {
                if (authRoutes != null) {
                    authRoutes.handle(ctx, req, q, path);
                } else {
                    sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "Page not found", "Nothing lives at this address.");
                }
            } else if (path.startsWith(FONTS)) {
                // the lobby's own Framed faces; static, so a login only where people sign in (as for the bundle)
                if (!o.multiUser() || identify(ctx, req, q, true) != null) {
                    fontFile(ctx, req, path.substring(FONTS.length()));
                }
            } else {
                lobbyFile(ctx, req, q, path);
            }
        }

        @Override
        public void exceptionCaught(final ChannelHandlerContext ctx, final Throwable cause) {
            if (cause instanceof ReadTimeoutException) {
                BridgeLog.debug("router connection idle; closed");
            } else {
                BridgeLog.warn("router connection: " + cause);
            }
            ctx.close();
        }
    }

    /** /m/&lt;id&gt;/…: the owner's game page, socket and images. Static files need no token in local mode, as in the plain sidecar. */
    private void game(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String path) {
        final String rest = path.substring(3);
        final int slash = rest.indexOf('/');
        final String id = slash < 0 ? rest : rest.substring(0, slash);
        if (!id.matches("[0-9a-f]{1,32}")) {
            sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "Page not found", "Nothing lives at this address.");
            return;
        }
        if (slash < 0) {
            redirect(ctx, "/m/" + id + "/");
            return;
        }
        final String sub = rest.substring(slash);
        if (sub.equals("/status") || sub.startsWith("/seat/")) {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found"); // the child's reaper and concede endpoints stay internal
            return;
        }
        if (!validSub(sub)) {
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad path");
            return;
        }
        final boolean ws = sub.equals("/ws");
        final boolean data = ws || sub.startsWith("/img/");
        final Principal who = identify(ctx, req, q, o.multiUser() || data);
        if (who == null) {
            return;
        }
        if (sub.startsWith(FONTS)) {
            fontFile(ctx, req, sub.substring(FONTS.length())); // the same for every game: no seat needed
            return;
        }
        if (ws && !(sessions != null ? strictSameOrigin(req) : sameOrigin(req))) {
            BridgeLog.warn("Refused WebSocket upgrade from origin " + req.headers().get(HttpHeaderNames.ORIGIN));
            sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
            return;
        }
        final GameHost.Game g = host.status(id);
        if (g == null || g.status() == GameHost.Status.STOPPING) {
            sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "This game is over", "It ended, or the server restarted since. Start a new one from the lobby.");
            return;
        }
        final int seat = seat(g, who);
        if (seat < 0) {
            sendPage(ctx, req, HttpResponseStatus.FORBIDDEN, "Not your game", "This table belongs to another player.");
            return;
        }
        // at the table: online for as long as the socket is open. Only a real upgrade counts, once per connection
        // (a plain GET /ws on a kept-alive connection would otherwise pin "online" and pile up close listeners).
        if (ws && req.headers().containsValue(HttpHeaderNames.UPGRADE, HttpHeaderValues.WEBSOCKET, true)
                && ctx.channel().attr(AT_TABLE).setIfAbsent(Boolean.TRUE) == null) {
            seen(who, 1);
            ctx.channel().closeFuture().addListener(f -> seen(who, -1));
        }
        final String query = withoutToken(q.rawQuery());
        host.attach(id, ctx, req, sub + (query.isEmpty() ? "" : "?" + query), seat, who.name());
    }

    static void redirect(final ChannelHandlerContext ctx, final String location, final String... setCookies) {
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.FOUND);
        res.headers().set(HttpHeaderNames.LOCATION, location);
        for (final String c : setCookies) {
            res.headers().add(HttpHeaderNames.SET_COOKIE, c);
        }
        if (setCookies.length > 0) {
            res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        }
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0);
        res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE); // said, or a client reuses the closed socket
        ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
    }

    /**
     * The game decodes what the router routed raw, so: no percent-encoding outside an image key, no {@code ..},
     * backslash or control character in a decoded one (keys may hold a slash: "Fire // Ice"), and elsewhere no empty or
     * {@code .} segment either (so nothing like {@code /./status} reaches a game's internal endpoints).
     */
    static boolean validSub(final String sub) {
        final String img = sub.startsWith("/img/card/") ? "/img/card/" : sub.startsWith("/img/crop/") ? "/img/crop/" : null;
        if (img != null) {
            final String key;
            try {
                key = QueryStringDecoder.decodeComponent(sub.substring(img.length()));
            } catch (final IllegalArgumentException e) {
                return false;
            }
            return validKey(key);
        }
        return sub.indexOf('%') < 0 && !sub.contains("..") && sub.indexOf('\\') < 0 && !sub.contains("//") && !sub.contains("/./") && !sub.endsWith("/.");
    }

    /** A decoded image key or card name: not empty, and no {@code ..}, backslash or control character. */
    static boolean validKey(final String key) {
        return !key.isEmpty() && !key.contains("..") && key.indexOf('\\') < 0 && key.chars().noneMatch(Character::isISOControl);
    }

    /** The query minus the router's own token, however it was spelled ({@code t=}, {@code %74=}, after a {@code ;}). */
    static String withoutToken(final String rawQuery) {
        final List<String> keep = new java.util.ArrayList<>();
        for (final String part : rawQuery.split("[&;]")) {
            if (part.isEmpty()) {
                continue;
            }
            final int eq = part.indexOf('=');
            String name = eq < 0 ? part : part.substring(0, eq);
            try {
                name = QueryStringDecoder.decodeComponent(name);
            } catch (final IllegalArgumentException e) {
                continue; // undecodable: drop it rather than guess
            }
            if (!name.equals("t")) {
                keep.add(part);
            }
        }
        return String.join("&", keep);
    }

    /**
     * What a link preview fetches (Discord, iMessage, Zulip, Slack bots are never signed in): the lobby page's head
     * (static, no data) and its image and icons. The proxy lets these through without a login; anything else, or a
     * request that does carry the user header, is checked as usual.
     */
    static final Set<String> PUBLIC_FILES = Set.of("lobby.html", "og.png", "favicon.ico", "favicon.svg", "favicon-32.png",
            "icon-192.png", "icon-512.png", "apple-touch-icon.png", "site.webmanifest");

    static final java.util.regex.Pattern JOIN_PATH = java.util.regex.Pattern.compile("/join/[A-Za-z0-9_-]{1,64}/?");

    String origin(final FullHttpRequest req) {
        return origin(req, o.publicUrl);
    }

    /**
     * https://host from the Host header for the lobby's og: tags and invite links (a strict host[:port] only), else
     * {@code publicUrl} (--public-url), else http://localhost.
     */
    static String origin(final FullHttpRequest req, final String publicUrl) {
        final String host = req.headers().get(HttpHeaderNames.HOST);
        final String h = host == null ? "" : host.toLowerCase(java.util.Locale.ROOT);
        if (!h.matches("[a-z0-9.-]{1,253}(:[0-9]{1,5})?")) {
            return publicUrl != null ? publicUrl : "http://localhost";
        }
        final String name = h.replaceFirst(":[0-9]+$", "");
        return (name.equals("localhost") || name.matches("127(\\.[0-9]+){3}") ? "http://" : "https://") + h;
    }

    /** The lobby page and the bundle it loads (same bundle as the table page). */
    private void lobbyFile(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String path) throws IOException {
        // /join/<code> is the lobby page too; its script reads the code. Whether the code works is only ever said by
        // POST /api/join, so this page tells nobody anything about codes.
        final boolean lobby = path.equals("/") || JOIN_PATH.matcher(path).matches();
        final String asked = lobby ? "lobby.html" : path.substring(1);
        final boolean open = PUBLIC_FILES.contains(asked) && (o.trustHeader == null || !req.headers().contains(o.trustHeader));
        if (o.trustHeader != null && !open && identify(ctx, req, q, true) == null) {
            return;
        }
        // native sign-in: the sign-in page needs the bundle before anyone has signed in, so only the lobby itself (and
        // anything not in the bundle's open set) asks for a session; the bundle is the same for everyone
        if (sessions != null && (lobby || !(open || asked.startsWith("assets/") || asked.equals("login.html") || asked.startsWith("licenses")))
                && identify(ctx, req, q, true) == null) {
            return;
        }
        String rel = asked;
        if (rel.equals("licenses") || rel.equals("licenses/")) {
            rel = "THIRD-PARTY-NOTICES.txt";
        }
        // the bundle's asset URLs are relative (./assets/...); at /join/<code> they must still resolve from /
        webFile(ctx, req, rel, path.equals("/") ? null : "/");
    }

    /** The lobby page's description and link-preview text: the neural opponent only where this install has one. */
    static final String TAGLINE = forge.bridge.NeuralStatus.pluginInstalled()
            ? "Play Magic: The Gathering in your browser against a neural-net opponent."
            : "Play Magic: The Gathering in your browser.";

    /**
     * One file of the web build (static, the same for everyone), GET or HEAD. lobby.html and login.html get the request's origin and
     * {@link #TAGLINE} for its og: tags and, when {@code base} isn't null, a {@code <base href>} so its relative asset
     * URLs resolve from there.
     */
    void webFile(final ChannelHandlerContext ctx, final FullHttpRequest req, final String rel, final String base) throws IOException {
        if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
            sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
            return;
        }
        if (rel.contains("..") || rel.contains("\\") || rel.contains("%")) {
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad path");
            return;
        }
        byte[] body = BridgeServer.readWeb(o.webDir == null ? null : new File(o.webDir), rel);
        if (body == null) {
            sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "Page not found", "Nothing lives at this address.");
            return;
        }
        if (rel.equals("lobby.html") || rel.equals("login.html")) {
            String html = new String(body, StandardCharsets.UTF_8).replace("__FT_ORIGIN__", origin(req)).replace("__FT_TAGLINE__", TAGLINE);
            if (base != null) {
                html = html.replaceFirst("<head>", "<head><base href=\"" + base + "\">");
            }
            body = html.getBytes(StandardCharsets.UTF_8);
        }
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK,
                req.method() == HttpMethod.HEAD ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, BridgeServer.mime(rel));
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        res.headers().set("X-Content-Type-Options", "nosniff");
        finish(ctx, req, res);
    }

    /** Where a page asks for {@link #FONT_FILES}: under its own base ({@code /}, {@code /m/<id>/}, {@code /g/<id>/}). */
    static final String FONTS = "/fonts/";

    /**
     * The only names {@code --fonts} serves, with their types: the Framed face's title and body fonts as the client asks
     * for them (app/src/cards/m15/fonts.ts), each in two formats. Anything else is a 404, so nothing else in the folder
     * (or outside it) is ever read.
     */
    static final Map<String, String> FONT_FILES = Map.of("beleren.woff2", "font/woff2", "beleren.ttf", "font/ttf",
            "mplantin.woff2", "font/woff2", "mplantin.woff", "font/woff");

    /** Bigger than any card font; a file over it is a 404 rather than read into memory. */
    static final long MAX_FONT_BYTES = 16L << 20;

    /** {@code GET <base>/fonts/<name>}: one of {@link #FONT_FILES} from --fonts, or 404 (no --fonts, an unknown name, no such file). */
    private void fontFile(final ChannelHandlerContext ctx, final FullHttpRequest req, final String name) {
        if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
            sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
            return;
        }
        final String type = FONT_FILES.get(name);
        byte[] body = null;
        if (type != null && o.fontsDir != null) {
            final Path f = o.fontsDir.resolve(name);
            try {
                if (java.nio.file.Files.isRegularFile(f) && java.nio.file.Files.size(f) <= MAX_FONT_BYTES) {
                    body = java.nio.file.Files.readAllBytes(f);
                }
            } catch (final IOException e) {
                BridgeLog.warn("--fonts: cannot read " + f + ": " + e.getMessage());
            }
        }
        if (body == null) {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
            return;
        }
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK,
                req.method() == HttpMethod.HEAD ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, type);
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        // a browser keeps it a day; "private": the operator's fonts are for this site's users, not a shared cache
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "private, max-age=86400");
        res.headers().set("X-Content-Type-Options", "nosniff");
        finish(ctx, req, res);
    }

    // ---------------------------------------------------------------- operations (loopback only)

    /**
     * {@code GET /healthz} and {@code POST /admin/drain}: for scripts on the router's own host only. A peer that
     * isn't loopback, or a request that came through a proxy or from a browser (a forwarding header, the user
     * header, an Origin), gets 403. Nothing here names a user or a game.
     */
    private void admin(final ChannelHandlerContext ctx, final FullHttpRequest req, final String path) {
        final java.net.SocketAddress peer = ctx.channel().remoteAddress();
        final boolean local = peer instanceof InetSocketAddress isa && isa.getAddress() != null && isa.getAddress().isLoopbackAddress();
        final boolean forwarded = req.headers().contains("X-Forwarded-For") || req.headers().contains("Forwarded")
                || req.headers().contains("X-Real-IP") || req.headers().contains(HttpHeaderNames.ORIGIN)
                || o.trustHeader != null && req.headers().contains(o.trustHeader);
        if (!local || forwarded) {
            sendText(ctx, HttpResponseStatus.FORBIDDEN, "local only");
            return;
        }
        if (path.equals("/healthz") && (req.method() == HttpMethod.GET || req.method() == HttpMethod.HEAD)) {
            sendJson(ctx, req, HttpResponseStatus.OK, health());
        } else if (path.equals("/admin/drain") && req.method() == HttpMethod.POST) {
            drainRequested = true;
            drain();
            sendJson(ctx, req, HttpResponseStatus.OK, health());
        } else {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
        }
    }

    /** {ok, build, builtAt?, active, starting, stopping, draining, cap}: counts only. */
    JsonObject health() {
        final int[] n = counts();
        final JsonObject h = new JsonObject();
        h.addProperty("ok", true);
        h.addProperty("build", build[0]);
        if (build[1] != null) {
            h.addProperty("builtAt", build[1]);
        }
        h.addProperty("active", n[0]);
        h.addProperty("starting", n[1]);
        h.addProperty("stopping", n[2]);
        h.addProperty("draining", draining);
        h.addProperty("cap", maxMatches);
        return h;
    }

    /** Games with a process: running (ready, playing, over), starting, stopping. Crashed and paused ones have none. */
    private int[] counts() {
        final int[] n = new int[3];
        for (final GameHost.Game g : host.list()) {
            switch (g.status()) {
                case STARTING -> n[1]++;
                case STOPPING -> n[2]++;
                case CRASHED, PAUSED -> { }
                default -> n[0]++;
            }
        }
        return n;
    }

    /**
     * Drain mode: no new games from now on (the lobby says the server is updating). Games are saved and resume after
     * the restart, so only games with a guest (whose seat can't be kept over a restart) are waited for:
     * the router stops and calls {@link #onDrained} once none of those is running, or after the drain timeout,
     * ending whatever is still running.
     */
    public void drain() {
        synchronized (capLock) { // no create can slip in after this
            if (draining) {
                return;
            }
            draining = true;
        }
        final long until = System.currentTimeMillis() + o.drainTimeoutMs;
        BridgeLog.info("draining: no new games; exiting when the last game ends, or in " + o.drainTimeoutMs / 60_000 + " min");
        drainTimer.scheduleWithFixedDelay(() -> {
            final int left = runningUnkept();
            final boolean timedOut = System.currentTimeMillis() >= until;
            if (left > 0 && !timedOut) {
                return;
            }
            if (left > 0) {
                BridgeLog.warn("drain timed out; ending " + left + " game(s)");
            }
            BridgeLog.info("drained; stopping");
            drainTimer.shutdown(); // no further checks
            new Thread(() -> {
                stop(); // ends any games left (SIGTERM, then SIGKILL)
                onDrained.run();
            }, "router-drained").start();
        }, o.drainTickMs, o.drainTickMs, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    /** Running games that end with this run (a guest in them, or a pvp game no signed-in user has joined): a drain waits for them. */
    private int runningUnkept() {
        int n = 0;
        for (final GameHost.Game g : host.list()) {
            if (!keptOverRestart(g) && g.status() != GameHost.Status.CRASHED && g.status() != GameHost.Status.PAUSED) {
                n++;
            }
        }
        return n;
    }

    /** A signed-in user's game against the AI, or between two signed-in people: saved over a restart. A guest lives in this run only. */
    private boolean keptOverRestart(final GameHost.Game g) {
        if (Principal.isGuestId(g.owner())) {
            return false;
        }
        final PvpGame p = pvp.get(g.id());
        final Principal j = p == null ? null : p.joiner;
        return p == null || j != null && j.kind() == Kind.USER;
    }

    /** {@link #remember}'s facts: who sits where in a pvp game. */
    private static JsonObject pvpFacts(final PvpGame p) {
        final JsonObject f = new JsonObject();
        f.addProperty("creator", p.creator.id());
        final Principal j = p.joiner;
        if (j != null && j.kind() == Kind.USER) {
            f.addProperty("joiner", j.id());
        }
        f.addProperty("listed", p.listed);
        final JsonObject out = new JsonObject();
        out.add("pvp", f);
        return out;
    }

    /** A pvp game from {@link #pvpFacts}, or null when it had no signed-in joiner (nobody, or a guest). */
    private static PvpGame keptPvp(final String id, final JsonObject f) {
        if (!f.has("creator") || !f.has("joiner")) {
            return null;
        }
        final PvpGame p = new PvpGame(id, Principal.user(f.get("creator").getAsString()), f.has("listed") && f.get("listed").getAsBoolean(), false);
        p.joiner = Principal.user(f.get("joiner").getAsString());
        return p;
    }

    /** {forge sha, built_at}: from the packaged zip's version.json in the working folder, else the jar's Forge-Commit. */
    private static String[] buildInfo() {
        final java.io.File v = new java.io.File("version.json");
        if (v.isFile()) {
            try {
                final JsonObject j = JsonParser.parseString(java.nio.file.Files.readString(v.toPath())).getAsJsonObject();
                final String sha = j.has("forge_sha") ? j.get("forge_sha").getAsString() : "unknown";
                return new String[] {sha, j.has("built_at") ? j.get("built_at").getAsString() : null};
            } catch (final IOException | RuntimeException e) {
                BridgeLog.warn("unreadable version.json: " + e);
            }
        }
        try {
            final java.net.URL src = Router.class.getProtectionDomain().getCodeSource().getLocation();
            try (java.util.jar.JarFile jar = new java.util.jar.JarFile(new java.io.File(src.toURI()))) {
                final String commit = jar.getManifest().getMainAttributes().getValue("Forge-Commit");
                if (commit != null) {
                    return new String[] {commit.length() > 8 ? commit.substring(0, 8) : commit, null};
                }
            }
        } catch (final Exception e) {
            // classes directory (a dev run), or no manifest
        }
        return new String[] {"dev", null};
    }

    // ---------------------------------------------------------------- lobby API

    /** {@code GET /api/art/crop/<card name>} ({@link #artCrop}). */
    static final String ART_CROP = "/api/art/crop/";
    /** {@code GET /api/art/card/<card name>}: the whole card ({@link #artCrop}). */
    static final String ART_CARD = "/api/art/card/";
    /** {@code GET /api/neural/avatar}: the Neural AI's picture, as a game serves it at {@code img/avatar/neural}. */
    static final String NEURAL_AVATAR = "/api/neural/avatar";

    private void api(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String path) {
        final Principal who = identify(ctx, req, q, true);
        if (who == null) {
            return;
        }
        final HttpMethod m = req.method();
        if (m != HttpMethod.GET && m != HttpMethod.HEAD && !(sessions != null ? strictSameOrigin(req) : sameOrigin(req))) {
            sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
            return;
        }
        if (path.startsWith("/api/admin/")) {
            adminApi(ctx, req, path, who);
            return;
        }
        if (path.equals("/api/me") && m == HttpMethod.GET) {
            sendJson(ctx, req, HttpResponseStatus.OK, me(who));
            return;
        }
        if (path.equals("/api/matches")) {
            if (m == HttpMethod.GET) {
                sendJson(ctx, req, HttpResponseStatus.OK, matches(who, who.admin(), origin(req)));
            } else if (m == HttpMethod.POST) {
                create(ctx, req, who);
            } else {
                sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET or POST");
            }
            return;
        }
        if (path.equals("/api/decks") && m == HttpMethod.GET) {
            final List<String> f = q.parameters().get("format");
            final String format;
            try {
                format = forge.bridge.Formats.parse(f == null || f.isEmpty() ? null : f.get(0));
            } catch (final IllegalArgumentException e) {
                sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e.getMessage());
                return;
            }
            final JsonObject res = decksJson(who.userOrNull(), format);
            res.addProperty("neuralLabel", forge.bridge.NeuralStatus.label());
            if (forge.bridge.NeuralStatus.hasAvatar(crops != null)) {
                res.addProperty("neuralAvatar", true); // GET NEURAL_AVATAR has a picture (or may: a card's art is fetched on the first ask)
            }
            if (!forge.bridge.NeuralStatus.pluginInstalled()) {
                res.addProperty("neural", false); // the lobby then doesn't offer Neural
            }
            sendJson(ctx, req, HttpResponseStatus.OK, res);
            return;
        }
        if (path.equals("/api/decks/cards") && m == HttpMethod.GET) {
            deckCards(ctx, req, who, q);
            return;
        }
        if (path.startsWith(ART_CROP) && (m == HttpMethod.GET || m == HttpMethod.HEAD)) {
            artCrop(ctx, req, path.substring(ART_CROP.length()), false);
            return;
        }
        if (path.startsWith(ART_CARD) && (m == HttpMethod.GET || m == HttpMethod.HEAD)) {
            artCrop(ctx, req, path.substring(ART_CARD.length()), true);
            return;
        }
        if (path.equals(NEURAL_AVATAR) && (m == HttpMethod.GET || m == HttpMethod.HEAD)) {
            neuralAvatar(ctx, req);
            return;
        }
        if (path.equals("/api/join") && m == HttpMethod.POST) {
            join(ctx, req, who);
            return;
        }
        if (path.equals("/api/upload")) {
            if (m == HttpMethod.PUT) {
                upload(ctx, req, who);
            } else {
                sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "PUT only");
            }
            return;
        }
        if (path.startsWith("/api/matches/") && path.endsWith("/invite") && m == HttpMethod.POST) {
            invite(ctx, req, who, path.substring("/api/matches/".length(), path.length() - "/invite".length()));
            return;
        }
        if (path.startsWith("/api/matches/") && path.endsWith("/resume") && m == HttpMethod.POST) {
            resume(ctx, req, who, path.substring("/api/matches/".length(), path.length() - "/resume".length()));
            return;
        }
        if (path.startsWith("/api/matches/") && path.endsWith("/decline") && m == HttpMethod.POST) {
            decline(ctx, req, who, path.substring("/api/matches/".length(), path.length() - "/decline".length()));
            return;
        }
        if (path.startsWith("/api/matches/") && m == HttpMethod.DELETE) {
            final GameHost.Game g = host.status(path.substring("/api/matches/".length()));
            if (g == null || g.status() == GameHost.Status.STOPPING) {
                sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such game.");
            } else if (seat(g, who) < 0) {
                sendError(ctx, req, HttpResponseStatus.FORBIDDEN, "That isn't your game.");
            } else {
                leave(ctx, req, who, g);
            }
            return;
        }
        sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
    }

    private JsonObject matches(final Principal who, final boolean admin, final String origin) {
        final JsonObject res = new JsonObject();
        res.addProperty("user", who.id());
        if (admin) {
            res.addProperty("admin", true);
        }
        res.addProperty("maxPerUser", o.maxPerUser);
        res.addProperty("maxMatches", maxMatches);
        final JsonArray arr = new JsonArray();
        final JsonArray open = new JsonArray();
        final JsonArray invites = new JsonArray();
        for (final GameHost.Game g : host.list()) {
            final int seat = seat(g, who);
            if (seat >= 0) {
                arr.add(toJson(g, seat, origin));
                continue;
            }
            final PvpGame p = pvp.get(g.id());
            if (p == null || p.joiner != null || p.closed || g.status() == GameHost.Status.STOPPING || g.status() == GameHost.Status.CRASHED) {
                continue;
            }
            final DirectInvite d = live(p);
            if (d != null && d.to().same(who)) {
                // An invite to me: which game, who from (their shown name), until when, its format; nothing else (no deck).
                final JsonObject j = new JsonObject();
                j.addProperty("game", g.id());
                j.addProperty("from", p.creator.name());
                j.addProperty("expires", d.expires());
                addFormat(j, g);
                invites.add(j);
            } else if (p.listed && d == null) {
                // Open games: listed, nobody has joined or is invited, still running. Who started it and when, its format; nothing else.
                final JsonObject j = new JsonObject();
                j.addProperty("id", g.id());
                j.addProperty("host", p.creator.name());
                j.addProperty("created", g.created());
                addFormat(j, g);
                open.add(j);
            }
        }
        res.add("matches", arr);
        res.add("open", open);
        res.add("invites", invites);
        res.add("online", online(who));
        res.add("people", people(who));
        res.addProperty("draining", draining || restartAt != 0);
        res.addProperty("guests", o.guests); // whether "Allow guests" is offered
        if (uploadConfigurable() && who.userOrNull() != null) {
            final JsonObject up = new JsonObject();
            up.addProperty("on", uploadEffective(who.userOrNull()));
            res.add("upload", up);
        }
        return res;
    }

    /** Whether this server offers the "send my games to train the AI" toggle at all. */
    private boolean uploadConfigurable() {
        return o.uploadUrl != null && !"off".equals(o.uploadMode);
    }

    /** Whether anyone may upload: offered, and the saved choices are known (an unreadable file must not mean "default"). */
    private boolean uploadKnown() {
        return uploadConfigurable() && !uploadPrefs.unreadable();
    }

    /** This user's effective choice right now: their own pick if they've made one, else the channel's default. */
    private boolean uploadEffective(final String user) {
        if (!uploadKnown()) {
            return false;
        }
        final Boolean pref = uploadPrefs.get(user);
        return pref != null ? pref : "on".equals(o.uploadMode);
    }

    /** {@code PUT /api/upload} {@code {on}}: the user's own choice, persisted (hidden/refused if the channel never offers it). */
    private void upload(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who) {
        final String user = who.userOrNull();
        if (!uploadConfigurable() || user == null) {
            sendError(ctx, req, HttpResponseStatus.FORBIDDEN, "This server doesn't offer that.");
            return;
        }
        final String type = req.headers().get(HttpHeaderNames.CONTENT_TYPE);
        if (type == null || !type.toLowerCase().startsWith("application/json")) {
            sendError(ctx, req, HttpResponseStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.");
            return;
        }
        final boolean on;
        try {
            on = JsonParser.parseString(req.content().toString(StandardCharsets.UTF_8)).getAsJsonObject().get("on").getAsBoolean();
        } catch (final RuntimeException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Send {\"on\": true|false}.");
            return;
        }
        final boolean saved = uploadPrefs.set(user, on);
        if ((!on && !host.withdrawUpload(user)) || !saved) {
            sendError(ctx, req, HttpResponseStatus.INTERNAL_SERVER_ERROR, "Couldn't save that. Try again.");
            return;
        }
        sendJson(ctx, req, HttpResponseStatus.OK, matches(who, who.admin(), origin(req)));
    }

    // ---------------------------------------------------------------- admin API

    /** Whether the proxy's group list (joined with --groups-separator) names {@code group} exactly. */
    boolean inGroup(final String list, final String group) {
        for (final String g : list.split(java.util.regex.Pattern.quote(o.groupsSeparator))) {
            if (g.trim().equals(group)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether the proxy's groups say this request comes from an admin: exactly one non-empty groups header whose
     * --groups-separator-separated names include {@code --admin-group} exactly (none configured: nobody).
     */
    private boolean headerAdmin(final FullHttpRequest req) {
        if (o.adminGroup == null || o.groupsHeader == null) {
            return false;
        }
        final List<String> groups = req.headers().getAll(o.groupsHeader);
        return groups.size() == 1 && inGroup(groups.get(0), o.adminGroup);
    }

    /** {@code GET /api/me}: the sign-in mode, who I am, whether I'm an admin, and how I sign out (if I can). */
    private JsonObject me(final Principal who) {
        final JsonObject me = new JsonObject();
        me.addProperty("auth", o.mode());
        me.addProperty("login", who.id());
        me.addProperty("name", who.name());
        me.addProperty("admin", who.admin());
        if (o.sessions()) {
            me.addProperty("signOut", "/auth/logout");
        } else if (o.logoutUrl != null) {
            me.addProperty("logoutUrl", o.logoutUrl);
        }
        return me;
    }

    /**
     * {@code GET /api/admin/matches} (every game), {@code DELETE /api/admin/matches/<id>} (end any game),
     * {@code POST /api/admin/update} (warn every open game, end them all after the countdown, drain). Admins only.
     */
    private void adminApi(final ChannelHandlerContext ctx, final FullHttpRequest req, final String path, final Principal who) {
        if (!who.admin()) {
            BridgeLog.warn("Refused " + req.method() + " " + path + " to non-admin " + who.id());
            sendError(ctx, req, HttpResponseStatus.FORBIDDEN, "Admins only.");
            return;
        }
        final HttpMethod m = req.method();
        if (path.equals("/api/admin/matches") && m == HttpMethod.GET) {
            sendJson(ctx, req, HttpResponseStatus.OK, allMatches());
        } else if (path.startsWith("/api/admin/matches/") && m == HttpMethod.DELETE) {
            final GameHost.Game g = host.status(path.substring("/api/admin/matches/".length()));
            if (g == null || g.status() == GameHost.Status.STOPPING) {
                sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such game.");
                return;
            }
            host.end(g.id(), "ended by admin " + who.id());
            sendJson(ctx, req, HttpResponseStatus.OK, allMatches());
        } else if (path.equals("/api/admin/update") && m == HttpMethod.POST) {
            final String type = req.headers().get(HttpHeaderNames.CONTENT_TYPE);
            if (type == null || !type.toLowerCase().startsWith("application/json")) {
                sendError(ctx, req, HttpResponseStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.");
                return;
            }
            updateNow(who.id());
            sendJson(ctx, req, HttpResponseStatus.OK, allMatches());
        } else {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
        }
    }

    /**
     * The Admin sheet: every user's games, and the server.
     * {@code {matches: [game…], draining, restartIn?, server: {build, builtAt?, started, games, maxMatches, maxPerUser,
     * online, guests}}}; each game {@code {id, owner, created, status, connected, mode, ai?, format?, error?,
     * progress?: {label, pct}, players: [{seat, name, guest?, connected}], waiting?, guests?, table?: {turn, active,
     * seats: [{life, deck?, key?}…]}, lastSeen?}}. Unlike a player's own list, an admin sees both decks of a game
     * between two people. {@code lastSeen} only while nobody has the game open.
     */
    private JsonObject allMatches() {
        final JsonObject res = new JsonObject();
        final JsonArray arr = new JsonArray();
        final List<GameHost.Game> games = host.list();
        for (final GameHost.Game g : games) {
            arr.add(adminJson(g));
        }
        res.add("matches", arr);
        res.addProperty("draining", draining || restartAt != 0);
        final long at = restartAt;
        if (at != 0) {
            res.addProperty("restartIn", Math.max(0, (at - System.currentTimeMillis() + 999) / 1000));
        }
        final JsonObject server = new JsonObject();
        server.addProperty("build", build[0]);
        addIf(server, "builtAt", build[1]);
        server.addProperty("started", started);
        server.addProperty("games", games.stream().filter(g -> g.status() != GameHost.Status.STOPPING).count());
        server.addProperty("maxMatches", maxMatches);
        server.addProperty("maxPerUser", o.maxPerUser);
        server.addProperty("online", onlineCount());
        server.addProperty("guests", o.guests);
        res.add("server", server);
        return res;
    }

    /** One game on the Admin sheet ({@link #allMatches}). */
    private JsonObject adminJson(final GameHost.Game g) {
        final JsonObject j = new JsonObject();
        j.addProperty("id", g.id());
        j.addProperty("owner", g.owner());
        j.addProperty("created", g.created());
        j.addProperty("status", g.status().name().toLowerCase());
        final boolean connected = host.connected(g.id());
        j.addProperty("connected", connected);
        final PvpGame pg = pvp.get(g.id());
        j.addProperty("mode", pg == null ? "ai" : "pvp");
        addIf(j, "ai", pg == null ? aiByGame.get(g.id()) : null);
        addFormat(j, g);
        addIf(j, "error", g.error());
        if (g.progress() != null) {
            final JsonObject p = new JsonObject();
            p.addProperty("label", g.progress().label());
            p.addProperty("pct", g.progress().pct());
            j.add("progress", p);
        }
        final JsonArray players = new JsonArray();
        for (final Member m : members(g)) {
            final JsonObject pl = new JsonObject();
            pl.addProperty("seat", m.seat());
            pl.addProperty("name", m.who().name());
            if (m.who().kind() == Kind.GUEST) {
                pl.addProperty("guest", true);
            }
            pl.addProperty("connected", host.connected(g.id(), m.seat()));
            players.add(pl);
        }
        j.add("players", players);
        if (pg != null) {
            if (pg.joiner == null) {
                j.addProperty("waiting", true);
            }
            if (pg.guests) {
                j.addProperty("guests", true);
            }
        }
        final GameHost.Table t = g.table();
        if (t != null) {
            final JsonObject tj = new JsonObject();
            tj.addProperty("turn", t.turn());
            tj.addProperty("active", t.active());
            final JsonArray seats = new JsonArray();
            for (final GameHost.Table.Seat st : t.seats()) {
                final JsonObject sj = new JsonObject();
                sj.addProperty("life", st.life());
                addIf(sj, "deck", st.deck());
                addIf(sj, "key", st.key());
                seats.add(sj);
            }
            tj.add("seats", seats);
            j.add("table", tj);
        }
        final long seen = connected ? 0 : host.lastSeen(g.id());
        if (seen > 0) {
            j.addProperty("lastSeen", seen);
        }
        return j;
    }

    /** How many signed-in users are online right now (never a guest). */
    private int onlineCount() {
        final long now = o.clock.getAsLong();
        synchronized (presence) {
            return (int) presence.values().stream().filter(s -> isOnline(s, now)).count();
        }
    }

    /**
     * An admin's "update now": no new games from now on; every open game is told it ends in
     * {@link Options#updateCountdownMs} (a countdown banner); then every game is ended and the router drains and
     * exits. A second call while counting down changes nothing.
     */
    void updateNow(final String by) {
        synchronized (capLock) {
            if (restartAt != 0) {
                return;
            }
            restartAt = System.currentTimeMillis() + o.updateCountdownMs;
        }
        BridgeLog.info("update now (admin " + by + "): games end in " + o.updateCountdownMs / 1000 + " s");
        host.announce(() -> {
            final long secs = Math.max(0, (restartAt - System.currentTimeMillis() + 999) / 1000);
            final JsonObject n = new JsonObject();
            n.addProperty("t", "notice");
            n.addProperty("kind", "restart");
            n.addProperty("seconds", secs);
            n.addProperty("message", "Server restarting in " + secs + " s. Your game is saved and picks up after the update "
                    + "(a game with a guest ends).");
            return n.toString();
        });
        drainTimer.schedule(() -> {
            try {
                for (final GameHost.Game g : host.list()) {
                    if (keptOverRestart(g)) {
                        continue; // saved by the restart, resumed after it
                    }
                    try {
                        host.end(g.id(), "server update (admin " + by + ")");
                    } catch (final RuntimeException e) {
                        BridgeLog.warn("update now: ending game " + g.id() + " failed: " + e);
                    }
                }
            } finally {
                drain(); // whatever happened above, or the router refuses new games forever
            }
        }, o.updateCountdownMs, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    /** The game's format on a lobby row ("brawl", "standard"); none for Constructed, so those rows stay as they were. */
    private static void addFormat(final JsonObject j, final GameHost.Game g) {
        if (g.format() != null) {
            j.addProperty("format", g.format());
        }
    }

    /**
     * The game card's table as {@code seat} sees it: {@code {turn, mine, life: [mine, theirs], deck?, key?,
     * oppDeck?, oppKey?}}, {@code mine} = it is my turn. A pvp opponent's deck stays theirs (life and turn are on the
     * table anyway). Null with no table, or not a two-seat one.
     */
    static JsonObject tableJson(final GameHost.Table t, final int seat, final boolean pvp) {
        if (t == null || t.seats().size() != 2 || seat < 0 || seat > 1) {
            return null;
        }
        final GameHost.Table.Seat me = t.seats().get(seat);
        final GameHost.Table.Seat them = t.seats().get(1 - seat);
        final JsonObject j = new JsonObject();
        j.addProperty("turn", t.turn());
        j.addProperty("mine", t.active() == seat);
        final JsonArray life = new JsonArray();
        life.add(me.life());
        life.add(them.life());
        j.add("life", life);
        addIf(j, "deck", me.deck());
        addIf(j, "key", me.key());
        if (!pvp) {
            addIf(j, "oppDeck", them.deck());
            addIf(j, "oppKey", them.key());
        }
        return j;
    }

    private static void addIf(final JsonObject j, final String k, final String v) {
        if (v != null) {
            j.addProperty(k, v);
        }
    }

    /**
     * A game as its member at {@code seat} sees it in the lobby: status and boot progress, its mode, both players' names,
     * and for a pvp game's creator whether it is listed and, while nobody has joined, its live invite link.
     */
    private JsonObject toJson(final GameHost.Game g, final int seat, final String origin) {
        final JsonObject j = new JsonObject();
        j.addProperty("id", g.id());
        j.addProperty("status", g.status().name().toLowerCase());
        j.addProperty("created", g.created());
        if (g.error() != null) {
            j.addProperty("error", g.error());
        }
        if (g.progress() != null) {
            final JsonObject p = new JsonObject();
            p.addProperty("stage", g.progress().stage());
            p.addProperty("label", g.progress().label());
            p.addProperty("pct", g.progress().pct());
            p.addProperty("elapsed", Math.max(0, (System.currentTimeMillis() - g.created()) / 1000));
            j.add("progress", p);
        }
        final PvpGame pg = pvp.get(g.id());
        j.addProperty("mode", pg == null ? "ai" : "pvp");
        addIf(j, "ai", pg == null ? aiByGame.get(g.id()) : null);
        addFormat(j, g);
        j.addProperty("seat", seat);
        final JsonArray players = new JsonArray();
        for (final Member m : members(g)) {
            final JsonObject pl = new JsonObject();
            pl.addProperty("seat", m.seat());
            pl.addProperty("name", m.who().name());
            players.add(pl);
        }
        j.add("players", players);
        final JsonObject table = tableJson(g.table(), seat, pg != null);
        if (table != null) {
            j.add("table", table);
        }
        if (pg != null) {
            if (pg.joiner == null) {
                j.addProperty("waiting", true);
            }
            if (seat == 0) {
                j.addProperty("listed", pg.listed);
                synchronized (capLock) {
                    if (pg.joiner == null && pg.code != null && pg.codeExpires > System.currentTimeMillis()) {
                        final JsonObject inv = new JsonObject();
                        inv.addProperty("url", origin + (pg.guests ? "/g/join/" : "/join/") + pg.code);
                        inv.addProperty("expires", pg.codeExpires);
                        inv.addProperty("guests", pg.guests);
                        j.add("invite", inv);
                    }
                }
                final DirectInvite d = live(pg);
                if (pg.joiner == null && d != null) {
                    final JsonObject inv = new JsonObject();
                    inv.addProperty("name", d.to().name());
                    inv.addProperty("expires", d.expires());
                    j.add("invited", inv);
                }
            }
        }
        return j;
    }

    /** Who sits at game {@code g}: a pvp game's one or two players, else its owner alone (a game against the AI). */
    List<Member> members(final GameHost.Game g) {
        final PvpGame p = pvp.get(g.id());
        return p != null ? p.members() : List.of(new Member(Principal.user(g.owner()), 0));
    }

    /** The seat {@code who} holds at game {@code g}, or -1. Every "is this yours" check in the router is this one. */
    int seat(final GameHost.Game g, final Principal who) {
        for (final Member m : members(g)) {
            if (m.who().same(who)) {
                return m.seat();
            }
        }
        return -1;
    }

    /** Games {@code who} is a member of, crashed and closing ones too (capLock): the per-user cap counts these. */
    private int memberships(final Principal who) {
        int n = 0;
        for (final GameHost.Game x : host.list()) {
            if (seat(x, who) >= 0) {
                n++;
            }
        }
        return n;
    }

    /**
     * POST /api/matches {mode?, deck?, oppDeck?, ai?, listed?}: both caps are checked and the game reserved under one lock.
     * {@code mode: "pvp"} starts a game for two people (deck required; oppDeck and ai are ignored) with an invite link.
     */
    private void create(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who) {
        final String type = req.headers().get(HttpHeaderNames.CONTENT_TYPE);
        if (type == null || !type.toLowerCase().startsWith("application/json")) {
            sendError(ctx, req, HttpResponseStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.");
            return;
        }
        final String deck;
        final String oppDeck;
        final String ai;
        final boolean pvpMode;
        final boolean listed;
        final boolean guests;
        final String inviteKey;
        final String format;
        try {
            final String text = req.content().toString(StandardCharsets.UTF_8);
            final JsonObject body = text.isBlank() ? new JsonObject() : JsonParser.parseString(text).getAsJsonObject();
            format = forge.bridge.Formats.parse(optional(body, "format"));
            final String mode = optional(body, "mode");
            if (mode != null && !mode.equals("ai") && !mode.equals("pvp")) {
                throw new IllegalArgumentException("The mode is ai or pvp.");
            }
            pvpMode = "pvp".equals(mode);
            deck = deckName(body, "deck");
            if (pvpMode) {
                oppDeck = null;
                ai = null;
                listed = !Boolean.FALSE.equals(optionalBool(body, "listed"));
                // off unless asked for, and only where this server serves guests at all (else ignored)
                guests = o.guests && Boolean.TRUE.equals(optionalBool(body, "guests"));
                inviteKey = optional(body, "invite"); // an "Online now" handle: seat 1 is held for that user
                if (inviteKey == null && body.has("invite") && !body.get("invite").isJsonNull()) {
                    throw new IllegalArgumentException("They're not online any more."); // blank: never a listed game
                }
                if (deck == null) {
                    throw new IllegalArgumentException("Pick a deck.");
                }
            } else {
                oppDeck = deckName(body, "oppDeck");
                ai = optional(body, "ai");
                listed = false;
                guests = false;
                inviteKey = null;
                if (ai != null && !AIS.contains(ai)) {
                    throw new IllegalArgumentException("The AI is Neural or Default.");
                }
            }
        } catch (final RuntimeException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e instanceof IllegalArgumentException ? e.getMessage() : "Bad request.");
            return;
        }
        // Only that the deck exists: the router has no card database, so a deck illegal in the format is refused by the
        // game itself when its seat readies (match.start: Formats.problem, said to the player); the start screen greys it out.
        if (pvpMode && !hasDeck(who, deck, format)) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Unknown deck.");
            return;
        }
        final Principal to = inviteKey == null ? null : onlineUser(inviteKey);
        if (inviteKey != null && to == null) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "They're not online any more.");
            return;
        }
        if (to != null && to.same(who)) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "You can't invite yourself.");
            return;
        }
        final GameHost.Game g;
        synchronized (capLock) {
            if (draining || restartAt != 0) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "Server is updating, new games are paused.");
                return;
            }
            // Per user: every game they are in, crashed and closing ones too (crashed ones go after a grace period).
            // In total: every process that may still hold memory, so a closing game counts until it has exited.
            final int mine = memberships(who);
            final int live = live();
            if (mine >= o.maxPerUser) {
                sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS,
                        "You already have " + mine + " games open (the limit is " + o.maxPerUser + "). End one to start another.");
                return;
            }
            if (live >= maxMatches) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE,
                        "The server is full (" + live + " games running). Try again when a game ends.");
                return;
            }
            if (pvpMode && !mintAllowed(who)) {
                sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS, "That's a lot of invite links. Try again in a few minutes.");
                return;
            }
            if (pvpMode) {
                // Never an upload URL: nothing of a game between two people is captured.
                g = host.createPvp(who.id(), deck, format);
                final PvpGame p = new PvpGame(g.id(), who, listed, guests);
                if (to != null) { // before it is visible, so it never shows in anyone's open list meanwhile
                    p.direct = new DirectInvite(to, o.clock.getAsLong() + o.inviteMs);
                }
                pvp.put(g.id(), p);
                mint(p, who); // a direct invite rides on the create's one mint: the same 10 per 10 min
            } else {
                final String user = who.userOrNull();
                g = host.create(who.id(), deck, oppDeck, ai, user != null && uploadEffective(user) ? o.uploadUrl : null, format);
                if (ai != null) {
                    aiByGame.put(g.id(), ai);
                }
            }
        }
        BridgeLog.info("game " + g.id() + " created for " + who.id() + (pvpMode ? " (vs a person" + (listed ? ", listed" : "") + (guests ? ", guests allowed" : "")
                + (to != null ? ", inviting " + to.id() : "") + ")" : ""));
        sendJson(ctx, req, HttpResponseStatus.CREATED, toJson(g, 0, origin(req)));
    }

    /** Games that may hold memory (capLock): every one but the crashed and paused (no process). */
    private int live() {
        int live = 0;
        for (final GameHost.Game x : host.list()) {
            if (x.status() != GameHost.Status.CRASHED && x.status() != GameHost.Status.PAUSED) {
                live++;
            }
        }
        return live;
    }

    /** POST /api/matches/{id}/resume: a member starts a paused game again from its save (the server cap applies). */
    private void resume(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who, final String id) {
        final GameHost.Game g = host.status(id);
        if (g == null || g.status() == GameHost.Status.STOPPING) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such game.");
            return;
        }
        final int seat = seat(g, who);
        if (seat < 0) {
            sendError(ctx, req, HttpResponseStatus.FORBIDDEN, "That isn't your game.");
            return;
        }
        final GameHost.Game r;
        synchronized (capLock) {
            if (draining || restartAt != 0) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "Server is updating. Your game picks up after the update.");
                return;
            }
            final int live = live();
            if (g.status() == GameHost.Status.PAUSED && live >= maxMatches) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE,
                        "The server is full (" + live + " games running). Try again when a game ends.");
                return;
            }
            r = host.resume(id);
        }
        if (r != null) {
            BridgeLog.info("game " + id + " resumed by " + who.id());
        }
        // Not paused (any more): someone resumed it first, so it is starting or running. Either way, here it is.
        final GameHost.Game now = r != null ? r : host.status(id);
        if (now == null) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such game.");
            return;
        }
        sendJson(ctx, req, HttpResponseStatus.OK, toJson(now, seat, origin(req)));
    }

    /** Whether {@code who} has a deck by this name (as the game would list it). */
    private boolean hasDeck(final Principal who, final String deck, final String format) {
        for (final String d : host.decks(who.userOrNull(), format)) {
            if (d.equalsIgnoreCase(deck)) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- two people

    /** Whether {@code who} may make another invite link now (capLock): {@link Options#mintLimit} per window. */
    private boolean mintAllowed(final Principal who) {
        final java.util.ArrayDeque<Long> times = mints.computeIfAbsent(who.kind() + ":" + who.id(), k -> new java.util.ArrayDeque<>());
        final long now = System.currentTimeMillis();
        while (!times.isEmpty() && now - times.peekFirst() >= o.mintWindowMs) {
            times.pollFirst();
        }
        return times.size() < o.mintLimit;
    }

    /**
     * A fresh invite for {@code p} (capLock): 128 random bits, single use, working for {@link Options#inviteMs}; the old
     * code stops working. Logs only its first 4 characters.
     */
    private void mint(final PvpGame p, final Principal who) {
        if (p.code != null) {
            invites.remove(p.code);
        }
        p.code = ChildProcessHost.randomHex(16);
        p.codeExpires = System.currentTimeMillis() + o.inviteMs;
        invites.put(p.code, p.id);
        mints.computeIfAbsent(who.kind() + ":" + who.id(), k -> new java.util.ArrayDeque<>()).addLast(System.currentTimeMillis());
        BridgeLog.info("game " + p.id + " invite " + p.code.substring(0, 4) + "… made" + (p.guests ? " (guests allowed)" : ""));
    }

    /**
     * {@code POST /api/matches/<id>/invite {guests?}}: seat 0 of a pvp game nobody has joined gets a new link; the old one
     * dies. {@code guests} absent keeps the game's choice; it is ignored (false) on a server without --guests.
     */
    private void invite(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who, final String id) {
        final Boolean guests;
        try {
            final String text = req.content().toString(StandardCharsets.UTF_8);
            guests = optionalBool(text.isBlank() ? new JsonObject() : JsonParser.parseString(text).getAsJsonObject(), "guests");
        } catch (final RuntimeException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e instanceof IllegalArgumentException ? e.getMessage() : "Bad request.");
            return;
        }
        final GameHost.Game g = host.status(id);
        if (g == null || g.status() == GameHost.Status.STOPPING) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such game.");
            return;
        }
        if (seat(g, who) != 0) {
            sendError(ctx, req, HttpResponseStatus.FORBIDDEN, "Only the player who started this game can do that.");
            return;
        }
        final PvpGame p = pvp.get(id);
        if (p == null) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Only a game against another player has an invite link.");
            return;
        }
        synchronized (capLock) {
            if (p.joiner != null) {
                sendError(ctx, req, HttpResponseStatus.CONFLICT, "Someone already joined.");
                return;
            }
            if (!mintAllowed(who)) {
                sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS, "That's a lot of invite links. Try again in a few minutes.");
                return;
            }
            if (guests != null) {
                p.guests = o.guests && guests;
            }
            mint(p, who);
        }
        sendJson(ctx, req, HttpResponseStatus.OK, toJson(g, 0, origin(req)));
    }

    /**
     * {@code POST /api/join {code? | id?, deck}}: take seat 1 of a pvp game nobody has joined, by its invite code (listed
     * or not) or, for a listed game, by its id. The code is used up; only the chosen deck is handed to the game.
     */
    private void join(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who) {
        final String type = req.headers().get(HttpHeaderNames.CONTENT_TYPE);
        if (type == null || !type.toLowerCase().startsWith("application/json")) {
            sendError(ctx, req, HttpResponseStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.");
            return;
        }
        final String code;
        final String id;
        final String deck;
        try {
            final JsonObject body = JsonParser.parseString(req.content().toString(StandardCharsets.UTF_8)).getAsJsonObject();
            code = optional(body, "code");
            id = optional(body, "id");
            deck = deckName(body, "deck");
            if ((code == null) == (id == null)) {
                throw new IllegalArgumentException("Send an invite code or a game id.");
            }
            if (deck == null) {
                throw new IllegalArgumentException("Pick a deck.");
            }
        } catch (final RuntimeException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e instanceof IllegalArgumentException ? e.getMessage() : "Bad request.");
            return;
        }
        final String gone = code != null ? "That invite has expired or was already used." : "That game isn't open any more.";
        final GameHost.Game g;
        synchronized (capLock) {
            if (draining || restartAt != 0) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "Server is updating, new games are paused.");
                return;
            }
            PvpGame p;
            if (code != null) {
                final String gid = invites.get(code);
                p = gid == null ? null : pvp.get(gid);
                if (p != null && (!code.equals(p.code) || p.codeExpires <= System.currentTimeMillis())) {
                    p = null;
                }
            } else {
                p = pvp.get(id);
                final DirectInvite d = p == null ? null : live(p);
                // By id: a game held for someone (a live direct invite) only by them; else an unlisted game by its link only.
                if (p != null && (d != null ? !d.to().same(who) : !p.listed)) {
                    p = null;
                }
            }
            final GameHost.Game found = p == null ? null : host.status(p.id);
            if (found == null || p.closed || found.status() == GameHost.Status.STOPPING || found.status() == GameHost.Status.CRASHED) {
                sendError(ctx, req, HttpResponseStatus.NOT_FOUND, gone);
                return;
            }
            if (p.creator.same(who)) {
                sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "You can't join your own game.");
                return;
            }
            if (p.joiner != null) {
                sendError(ctx, req, HttpResponseStatus.CONFLICT, "Someone already joined.");
                return;
            }
            final int mine = memberships(who);
            if (mine >= o.maxPerUser) {
                sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS,
                        "You already have " + mine + " games open (the limit is " + o.maxPerUser + "). End one to join another.");
                return;
            }
            if (!host.seatDeck(p.id, who.userOrNull(), deck)) {
                sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Unknown deck.");
                return;
            }
            p.joiner = who;
            if (p.code != null) {
                invites.remove(p.code);
                p.code = null;
            }
            host.remember(p.id, pvpFacts(p)); // who sits where, kept with the game over a restart
            g = found;
        }
        BridgeLog.info("game " + g.id() + ": " + who.id() + " joined " + (code != null ? "with invite " + code.substring(0, Math.min(4, code.length())) + "…" : "from the open list"));
        sendJson(ctx, req, HttpResponseStatus.OK, toJson(g, 1, origin(req)));
    }

    /**
     * {@code POST /api/matches/<id>/decline}: the user a game's direct invite is for turns it down. The invite dies; the
     * game goes on waiting (its link still works). Anyone else, or no live invite: 404, the same answer either way.
     */
    private void decline(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who, final String id) {
        final PvpGame p = pvp.get(id);
        synchronized (capLock) {
            final DirectInvite d = p == null ? null : live(p);
            if (d == null || !d.to().same(who) || p.joiner != null) {
                sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "That invite has expired or was already used.");
                return;
            }
            p.direct = null;
        }
        BridgeLog.info("game " + id + ": " + who.id() + " declined the invite");
        sendJson(ctx, req, HttpResponseStatus.OK, matches(who, who.admin(), origin(req)));
    }

    /** {@code p}'s direct invite while it lasts, else null. */
    private DirectInvite live(final PvpGame p) {
        final DirectInvite d = p.direct;
        return d != null && d.expires() > o.clock.getAsLong() ? d : null;
    }

    /**
     * {@code DELETE /api/matches/<id>} by a member. Against the AI, or a pvp game nobody has joined: the game ends. A pvp
     * game with both players: that seat concedes (the other wins) and the game ends as usual; if no match is in
     * progress there (still choosing decks, already over) the game ends.
     */
    private void leave(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who, final GameHost.Game g) {
        final PvpGame p = pvp.get(g.id());
        final boolean cancel;
        synchronized (capLock) {
            cancel = p == null || p.joiner == null;
            if (p != null && cancel) {
                p.closed = true;
            }
        }
        if (cancel) {
            host.end(g.id(), p == null ? "ended by its owner" : "cancelled by its owner");
            sendJson(ctx, req, HttpResponseStatus.OK, matches(who, who.admin(), origin(req)));
            return;
        }
        final int seat = seat(g, who);
        final String origin = origin(req);
        final boolean admin = who.admin();
        host.concede(g.id(), seat).whenComplete((conceded, e) -> ctx.executor().execute(() -> {
            if (conceded == null || !conceded) {
                host.end(g.id(), "left by seat " + seat + " (" + who.id() + ")");
            } else {
                BridgeLog.info("game " + g.id() + ": seat " + seat + " (" + who.id() + ") conceded");
            }
            sendJson(ctx, req, HttpResponseStatus.OK, matches(who, admin, origin));
        }));
    }

    /**
     * Every {@link Options#waitingTickMs}: end pvp games nobody joined within {@link Options#waitingMs}, drop expired
     * codes, and forget games the host no longer has.
     */
    void reapWaiting() {
        final long now = System.currentTimeMillis();
        aiByGame.keySet().removeIf(id -> host.status(id) == null);
        for (final PvpGame p : List.copyOf(pvp.values())) {
            final GameHost.Game g = host.status(p.id);
            synchronized (capLock) {
                if (p.code != null && (g == null || p.codeExpires <= now)) {
                    invites.remove(p.code);
                    p.code = null;
                }
                if (p.direct != null && live(p) == null) {
                    p.direct = null;
                }
                if (g == null) {
                    pvp.remove(p.id);
                    continue;
                }
                if (p.joiner != null || now - p.created < o.waitingMs || g.status() == GameHost.Status.STOPPING) {
                    continue;
                }
                p.closed = true;
            }
            host.end(p.id, "nobody joined in " + o.waitingMs / 60_000 + " min");
        }
        // Guest tokens past their 4 h, or whose game is gone, are forgotten (guestSeat refuses them anyway).
        final long t = o.clock.getAsLong();
        guestSeats.values().removeIf(s -> s.expires() <= t || host.status(s.game()) == null);
        synchronized (capLock) { // and addresses with no guest join in the window
            guestJoins.values().removeIf(d -> d.isEmpty() || t - d.peekLast() >= o.guestJoinWindowMs);
        }
        synchronized (presence) { // and users gone quiet
            forgetQuiet(t);
        }
    }

    // ---------------------------------------------------------------- who is online ("Online now")

    /**
     * {@code who} made a request, and opened (+1) or closed (-1) {@code sockets} game sockets: online from now. Signed-in
     * USERS only (identify() and their game sockets; never a guest, never /g/). At most {@link Options#onlineMax} users
     * are tracked: when full, quiet ones are forgotten first, else a new one simply isn't listed.
     */
    private Principal seen(final Principal who, final int sockets) {
        if (who.kind() != Kind.USER) {
            return who;
        }
        final long now = o.clock.getAsLong();
        synchronized (presence) {
            Seen s = presence.get(who.id());
            if (s == null) {
                if (presence.size() >= o.onlineMax) {
                    forgetQuiet(now);
                }
                if (presence.size() >= o.onlineMax) {
                    return who;
                }
                s = new Seen();
                presence.put(who.id(), s);
                presenceByKey.put(s.key, s);
            }
            s.who = who;
            s.last = now;
            s.sockets = Math.max(0, s.sockets + sockets);
            lastSeen.put(who.id(), now);
        }
        return who;
    }

    private boolean isOnline(final Seen s, final long now) {
        return s.sockets > 0 || now - s.last < o.onlineMs;
    }

    /** Forget users neither seen within {@link Options#onlineMs} nor at a table (holding {@code presence}). */
    private void forgetQuiet(final long now) {
        presence.values().removeIf(s -> !isOnline(s, now));
        presenceByKey.values().removeIf(s -> !isOnline(s, now));
    }

    /** "Online now" for {@code who}: everyone else online, by shown name, each with their handle; never a login. */
    private JsonArray online(final Principal who) {
        final long now = o.clock.getAsLong();
        final List<Seen> others = new java.util.ArrayList<>();
        synchronized (presence) {
            for (final Seen s : presence.values()) {
                if (isOnline(s, now) && !s.who.same(who)) {
                    others.add(s);
                }
            }
            others.sort(java.util.Comparator.comparing(s -> s.who.name(), String.CASE_INSENSITIVE_ORDER));
            final JsonArray arr = new JsonArray();
            for (final Seen s : others) {
                final JsonObject j = new JsonObject();
                j.addProperty("key", s.key);
                j.addProperty("name", s.who.name());
                arr.add(j);
            }
            return arr;
        }
    }

    /** People listed for {@code who} at most ("Online now" first, then recent opponents who are away). */
    static final int PEOPLE_MAX = 24;
    /** Opponents from this long ago are still listed while away. */
    static final long PEOPLE_RECENT_MS = 30L * 24 * 60 * 60_000;

    /**
     * {@code people} for {@code who}: everyone else online ({@code state} "playing" while they hold a seat in a game in
     * play, else "online"; {@code key} is their invite handle, as in {@code online}), then the people {@code who} played in
     * the last 30 days who aren't ("away", {@code seen}: when they were last around; their {@code key} is opaque and
     * invites nobody). Each with {@code who}'s {@code record} ({@code {w, l}}) and {@code last} game against them, if any.
     * Never a login; a guest asking gets the online part only.
     */
    private JsonArray people(final Principal who) {
        final long now = o.clock.getAsLong();
        final String me = who.userOrNull();
        final java.util.Map<String, Results.Opp> opps = me == null ? java.util.Map.of() : results.opponents(me, now - PEOPLE_RECENT_MS);
        final java.util.Set<String> playing = playingUsers();
        final JsonArray arr = new JsonArray();
        final java.util.Set<String> listed = new java.util.HashSet<>();
        final java.util.Map<String, Long> seenAt = new java.util.HashMap<>();
        synchronized (presence) {
            final List<Seen> others = new java.util.ArrayList<>();
            for (final Seen s : presence.values()) {
                if (isOnline(s, now) && !s.who.same(who)) {
                    others.add(s);
                }
            }
            others.sort(java.util.Comparator.comparing(s -> s.who.name(), String.CASE_INSENSITIVE_ORDER));
            for (final Seen s : others) {
                if (arr.size() >= PEOPLE_MAX) {
                    break;
                }
                final JsonObject j = new JsonObject();
                j.addProperty("key", s.key);
                j.addProperty("name", s.who.name());
                j.addProperty("state", playing.contains(s.who.id()) ? "playing" : "online");
                addRecord(j, opps.get(s.who.id()));
                arr.add(j);
                listed.add(s.who.id());
            }
            for (final String u : opps.keySet()) {
                final Long t = lastSeen.get(u);
                if (t != null) {
                    seenAt.put(u, t);
                }
            }
        }
        final List<Results.Opp> away = new java.util.ArrayList<>();
        for (final Results.Opp op : opps.values()) {
            if (!listed.contains(op.user())) {
                away.add(op);
            }
        }
        away.sort(java.util.Comparator.comparingLong((Results.Opp op) -> op.stat().last()).reversed());
        for (final Results.Opp op : away) {
            if (arr.size() >= PEOPLE_MAX) {
                break;
            }
            final JsonObject j = new JsonObject();
            j.addProperty("key", awayKey(op.user()));
            j.addProperty("name", op.name());
            j.addProperty("state", "away");
            j.addProperty("seen", Math.max(seenAt.getOrDefault(op.user(), 0L), op.stat().last()));
            addRecord(j, op);
            arr.add(j);
        }
        return arr;
    }

    private static void addRecord(final JsonObject j, final Results.Opp op) {
        if (op != null) {
            j.add("record", record(op.stat()));
            j.addProperty("last", op.stat().last());
        }
    }

    private static JsonObject record(final Results.Stat st) {
        final JsonObject r = new JsonObject();
        r.addProperty("w", st.w());
        r.addProperty("l", st.l());
        return r;
    }

    /** An away person's handle: stable while this router runs, never their login, and no invite target. */
    private String awayKey(final String user) {
        try {
            final byte[] h = java.security.MessageDigest.getInstance("SHA-256").digest((token + ":" + user).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return "away-" + java.util.HexFormat.of().formatHex(h, 0, 8);
        } catch (final java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The logins holding a seat in a game in play (its owner, and whoever joined a game between two people). */
    private java.util.Set<String> playingUsers() {
        final java.util.Set<String> out = new java.util.HashSet<>();
        for (final GameHost.Game g : host.list()) {
            if (g.status() != GameHost.Status.PLAYING) {
                continue;
            }
            final PvpGame p = pvp.get(g.id());
            if (p == null) {
                out.add(g.owner());
            } else {
                for (final Member m : p.members()) {
                    if (m.who().userOrNull() != null) {
                        out.add(m.who().id());
                    }
                }
            }
        }
        return out;
    }

    /**
     * A game ended in one of the host's games: record it with who sat where (seat 0 the owner; seat 1 the AI, or whoever
     * joined). A guest is recorded as nobody, by no name.
     */
    void finished(final GameHost.Finished f) {
        final GameHost.Game g = host.status(f.game());
        if (g == null || f.seats().isEmpty()) {
            return;
        }
        final PvpGame p = pvp.get(f.game());
        final List<Results.Seat> seats = new java.util.ArrayList<>();
        for (int i = 0; i < f.seats().size(); i++) {
            final GameHost.Finished.FinishedSeat fs = f.seats().get(i);
            final Principal at = p != null ? (i == 0 ? p.creator : i == 1 ? p.joiner : null) : i == 0 ? Principal.user(g.owner()) : null;
            final String user = at == null ? null : at.userOrNull();
            seats.add(new Results.Seat(user, user == null ? null : at.name(), fs.deck(), fs.r(), fs.conceded()));
        }
        results.add(new Results.Result(f.game() + ":" + f.n(), o.clock.getAsLong(), p != null ? "pvp" : "ai", g.format(), List.copyOf(seats)));
    }

    /** The user an "Online now" handle stands for while they are online, else null. */
    private Principal onlineUser(final String key) {
        synchronized (presence) {
            final Seen s = presenceByKey.get(key);
            return s != null && isOnline(s, o.clock.getAsLong()) ? s.who : null;
        }
    }

    private static String optional(final JsonObject body, final String key) {
        final JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) {
            return null;
        }
        final String s = e.getAsString().trim();
        return s.isEmpty() ? null : s;
    }

    /** A true/false field, or null when absent; anything else is a 400. */
    private static Boolean optionalBool(final JsonObject body, final String key) {
        final JsonElement e = body.get(key);
        if (e == null || e.isJsonNull()) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
            throw new IllegalArgumentException(key + " is true or false.");
        }
        return e.getAsBoolean();
    }

    /** A deck is chosen by name from the deck folders, never by path. */
    private static String deckName(final JsonObject body, final String key) {
        final String s = optional(body, key);
        if (s != null && (s.length() > 200 || s.contains("/") || s.contains("\\") || s.startsWith(".") || s.startsWith("-")
                || s.chars().anyMatch(Character::isISOControl))) {
            throw new IllegalArgumentException("Bad deck name.");
        }
        return s;
    }

    // ---------------------------------------------------------------- guests (plans/forge-pvp.md "Guests")

    /** The guest's cookie. Its path is the one game it was made for, {@code /g/<id>/}, so the browser sends it nowhere else. */
    static final String GUEST_COOKIE = "ftg";

    /** What a guest token is good for: seat 1 of game {@code game} as {@code who}, until {@code expires} ({@link Options#clock}). */
    record GuestSeat(String game, Principal who, long expires) { }

    /**
     * /g/…: everything a guest's browser loads, the one prefix the proxy lets through without a login. Without --guests,
     * all of it is a plain 404. No proxy user header is read anywhere under here: the join page, its static files and the
     * guest API need no identity, and a game's /g/&lt;id&gt;/ accepts only that game's guest cookie.
     */
    private void guest(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String path) throws IOException {
        if (!o.guests) {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
            return;
        }
        final String rest = path.startsWith("/g/") ? path.substring(3) : "";
        final int slash = rest.indexOf('/');
        final String head = slash < 0 ? rest : rest.substring(0, slash);
        if (rest.equals("api/decks")) {
            guestDecks(ctx, req, q);
        } else if (rest.equals("api/join")) {
            guestJoin(ctx, req);
        } else if (rest.startsWith(GUEST_ART_CROP)) {
            guestArtCrop(ctx, req, q, rest.substring(GUEST_ART_CROP.length()));
        } else if (JOIN_PATH.matcher("/" + rest).matches()) {
            // Like /join/<code>: the same page whatever the code; only POST /g/api/join says whether it works.
            webFile(ctx, req, "lobby.html", "/g/");
        } else if (rest.equals("bye")) {
            sendPage(ctx, req, HttpResponseStatus.OK, "Thanks for playing", "The game is over. You can close this tab.", false);
        } else if (head.matches("[0-9a-f]{1,32}")) {
            guestGame(ctx, req, q, head, rest.substring(head.length()));
        } else if (!rest.startsWith("api/") && (rest.startsWith("assets/") || PUBLIC_FILES.contains(rest) && !rest.equals("lobby.html"))) {
            webFile(ctx, req, rest, null); // the join page's own bundle and icons: static, the same for everyone
        } else {
            sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "Page not found", "Nothing lives at this address.", false);
        }
    }

    /** /g/&lt;id&gt;/…: the table for the guest at seat 1 of game {@code id}, as /m/&lt;id&gt;/… is for its members. */
    private void guestGame(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String id, final String sub) {
        if (sub.isEmpty()) {
            redirect(ctx, "/g/" + id + "/");
            return;
        }
        if (sub.equals("/status") || sub.startsWith("/seat/")) {
            sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
            return;
        }
        if (!validSub(sub)) {
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad path");
            return;
        }
        final GuestSeat seat = guestSeat(req, id);
        if (seat == null) {
            // no cookie, someone else's, expired, or the game is over: all the same answer
            sendPage(ctx, req, HttpResponseStatus.FORBIDDEN, "Not your game", "This table is only open to the guest who joined it, while the game is on.", false);
            return;
        }
        if (sub.startsWith(FONTS)) {
            fontFile(ctx, req, sub.substring(FONTS.length()));
            return;
        }
        if (sub.equals("/ws") && !sameOrigin(req)) {
            BridgeLog.warn("Refused guest WebSocket upgrade from origin " + req.headers().get(HttpHeaderNames.ORIGIN));
            sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
            return;
        }
        final String query = withoutToken(q.rawQuery());
        host.attach(id, ctx, req, sub + (query.isEmpty() ? "" : "?" + query), 1, seat.who().name());
    }

    /**
     * The guest seat a request for game {@code id} carries, or null: a {@value #GUEST_COOKIE} cookie whose token is live,
     * was made for this very game, and whose guest still holds seat 1 of it while the game runs. The token is looked up
     * by its hash, so the map never holds one.
     */
    GuestSeat guestSeat(final FullHttpRequest req, final String id) {
        final long now = o.clock.getAsLong();
        for (final String header : req.headers().getAll(HttpHeaderNames.COOKIE)) {
            for (final String part : header.split(";")) {
                final String c = part.trim();
                if (!c.startsWith(GUEST_COOKIE + "=")) {
                    continue;
                }
                final GuestSeat s = guestSeats.get(sha256(c.substring(GUEST_COOKIE.length() + 1)));
                if (s == null || !s.game().equals(id) || s.expires() <= now) {
                    continue;
                }
                final PvpGame p = pvp.get(id);
                final GameHost.Game g = host.status(id);
                if (p == null || g == null || g.status() == GameHost.Status.STOPPING || !s.who().same(p.joiner)) {
                    continue;
                }
                return s;
            }
        }
        return null;
    }

    /** The pvp game a live, unexpired invite code that allows guests opens, or null (capLock). */
    private PvpGame guestCode(final String code) {
        final String gid = code == null ? null : invites.get(code);
        final PvpGame p = gid == null ? null : pvp.get(gid);
        if (p == null || !p.guests || !code.equals(p.code) || p.codeExpires <= System.currentTimeMillis() || p.closed || p.joiner != null) {
            return null;
        }
        return p;
    }

    /** {@code GET /g/api/decks?code=}: the shared decks (a guest has no others), for a live guest code only; else 404. */
    private void guestDecks(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q) {
        if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
            sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
            return;
        }
        final List<String> code = q.parameters().get("code");
        final PvpGame live;
        synchronized (capLock) {
            live = code != null && code.size() == 1 ? guestCode(code.get(0)) : null;
        }
        final GameHost.Game game = live == null ? null : host.status(live.id);
        if (live == null) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "That invite has expired or was already used.");
            return;
        }
        sendJson(ctx, req, HttpResponseStatus.OK, decksJson(null, game == null ? null : game.format()));
    }

    /** {@code GET /g/api/art/crop/<card name>?code=} ({@link #guestArtCrop}), relative to /g/. */
    static final String GUEST_ART_CROP = "api/art/crop/";

    /**
     * {@code GET /g/api/art/crop/<card name>?code=}: the join page's deck art, as {@link #artCrop} gives the lobby's, for
     * a live guest code only; else the same 404 as {@link #guestDecks}. Crops only (no full scans), and the name only keys
     * the curated map, so a code buys no more than the lobby's own art. No per-address limit (a gallery loads a crop per
     * deck, past {@link Options#guestJoinLimit}): the bound is the code's life, the curated map's size and
     * {@link CachedCrops}' 4 fetch threads with a bounded queue (a burst past it is refused, not queued); cached crops
     * cost a file read.
     */
    private void guestArtCrop(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String raw) {
        if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
            sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
            return;
        }
        final List<String> code = q.parameters().get("code");
        final PvpGame live;
        synchronized (capLock) {
            live = code != null && code.size() == 1 ? guestCode(code.get(0)) : null;
        }
        if (live == null) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "That invite has expired or was already used.");
            return;
        }
        artCrop(ctx, req, raw, false);
    }

    /**
     * {@code {decks: [name…], details: {name: {cards, colors, key?, commander?}}}}: the decks {@code user} (null: shared
     * only) can play in {@code format}, and what the lobby's gallery shows of each the host could read.
     */
    /** A deck name as a slug: lower case, runs of anything but letters and digits as one '-'. */
    static String deckSlug(final String name) {
        return name.toLowerCase(java.util.Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", "-").replaceAll("^-|-$", "");
    }

    private JsonObject decksJson(final String user, final String format) {
        final JsonObject res = new JsonObject();
        final JsonArray arr = new JsonArray();
        host.decks(user, format).forEach(arr::add);
        res.add("decks", arr);
        final JsonObject details = new JsonObject();
        host.deckSummaries(user, format).forEach((name, d) -> details.add(name, d.toJson()));
        // My record with each deck. Games record a deck's own name ([metadata] Name=, "Mono Red Madness"), the list its
        // file's ("mono-red-madness"): matched as is, else as the same slug.
        final Map<String, String> bySlug = new HashMap<>();
        details.keySet().forEach(n -> bySlug.putIfAbsent(deckSlug(n), n));
        results.decks(user).forEach((recorded, st) -> {
            final String name = details.has(recorded) ? recorded : bySlug.get(deckSlug(recorded));
            if (name != null && !details.getAsJsonObject(name).has("record")) {
                final JsonObject d = details.getAsJsonObject(name);
                d.add("record", record(st));
                d.addProperty("last", st.last());
            }
        });
        res.add("details", details);
        if (!forge.bridge.Formats.isBrawl(format) && !host.standardChecked()) {
            res.addProperty("standardChecked", false); // no details carry "standard": the lobby can't tell
        }
        return res;
    }

    /**
     * {@code GET /api/decks/cards?name=<deck>[&format=]}: {@code {sections: [{name, cards: [{n, name, type?, cmc?, cost?}…]}…]}},
     * the deck's cards by section in file order (type, mana value and cost from {@link GameHost#cardInfo}, when known), for a deck the user's games could load ({@link GameHost#deckCards}: the same
     * folders and the same file lookup); 404 for any other name, 400 for a bad format.
     */
    private void deckCards(final ChannelHandlerContext ctx, final FullHttpRequest req, final Principal who, final QueryStringDecoder q) {
        final List<String> f = q.parameters().get("format");
        final List<String> n = q.parameters().get("name");
        final String format;
        try {
            format = forge.bridge.Formats.parse(f == null || f.isEmpty() ? null : f.get(0));
        } catch (final IllegalArgumentException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e.getMessage());
            return;
        }
        final String name = n == null || n.size() != 1 ? null : n.get(0);
        final java.util.Map<String, java.util.Map<String, Integer>> cards = name == null || name.length() > 200
                || !host.decks(who.userOrNull(), format).contains(name) ? null : host.deckCards(who.userOrNull(), format, name);
        if (cards == null) {
            sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "No such deck.");
            return;
        }
        final JsonArray sections = new JsonArray();
        cards.forEach((section, list) -> {
            final JsonObject s = new JsonObject();
            s.addProperty("name", section);
            final JsonArray a = new JsonArray();
            list.forEach((card, count) -> {
                final JsonObject c = new JsonObject();
                c.addProperty("n", count);
                c.addProperty("name", card);
                final CardScripts.Info info = host.cardInfo(card);
                if (info != null) {
                    c.addProperty("type", info.type());
                    c.addProperty("cmc", info.cmc());
                    c.addProperty("cost", info.cost());
                }
                a.add(c);
            });
            s.add("cards", a);
            sections.add(s);
        });
        final JsonObject res = new JsonObject();
        res.add("sections", sections);
        sendJson(ctx, req, HttpResponseStatus.OK, res);
    }

    /**
     * {@code GET /api/art/crop/<card name>}: the curated art crop in the shared cache, with its artist
     * ({@link BridgeServer#ARTIST_HEADER}), fetched there first when a game hasn't yet; else 204. The name only looks a
     * crop up in the curated map ({@link CachedCrops}); no path is ever made of it.
     */
    private void artCrop(final ChannelHandlerContext ctx, final FullHttpRequest req, final String raw, final boolean full) {
        final String name;
        try {
            name = QueryStringDecoder.decodeComponent(raw);
        } catch (final IllegalArgumentException e) {
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad name");
            return;
        }
        if (!validKey(name) || name.length() > 200) {
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad name");
            return;
        }
        if (crops == null) {
            noArt(ctx, req);
            return;
        }
        crops.findOrFetch(name, full).whenComplete((c, e) -> ctx.executor().execute(() -> sendCrop(ctx, req, e == null ? c : null)));
    }

    private void sendCrop(final ChannelHandlerContext ctx, final FullHttpRequest req, final CachedCrops.Crop c) {
        final byte[] body;
        try {
            body = c == null ? null : java.nio.file.Files.readAllBytes(c.file());
        } catch (final IOException e) {
            noArt(ctx, req);
            return;
        }
        if (body == null) {
            noArt(ctx, req);
            return;
        }
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK,
                req.method() == HttpMethod.HEAD ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, BridgeServer.imageMime(body, c.file().getFileName().toString()));
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "private, max-age=86400");
        res.headers().set("X-Content-Type-Options", "nosniff");
        if (c.artist() != null && !c.artist().isEmpty()) {
            // as the game sends it: header values must be ASCII
            res.headers().set(BridgeServer.ARTIST_HEADER, java.net.URLEncoder.encode(c.artist(), StandardCharsets.UTF_8).replace("+", "%20"));
        }
        finish(ctx, req, res);
    }

    /**
     * {@link #NEURAL_AVATAR}: the picture, else the art crop of the model's {@code avatar_card} (cached, or fetched like
     * {@link #artCrop} does, when the games show curated art), or 404 when there is none (the lobby then draws no picture).
     */
    private void neuralAvatar(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        final byte[] body = forge.bridge.NeuralStatus.avatar();
        if (body == null) {
            final String card = forge.bridge.NeuralStatus.avatarCard();
            if (card == null || crops == null) {
                sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
                return;
            }
            crops.findOrFetch(forge.bridge.NeuralStatus.avatarCardName(card)).whenComplete((c, e) -> ctx.executor().execute(() -> {
                if (e != null || c == null) {
                    sendText(ctx, HttpResponseStatus.NOT_FOUND, "not found");
                } else {
                    sendCrop(ctx, req, c);
                }
            }));
            return;
        }
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK,
                req.method() == HttpMethod.HEAD ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, forge.bridge.NeuralStatus.avatarType(body));
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, BridgeServer.AVATAR_CACHE);
        res.headers().set("X-Content-Type-Options", "nosniff");
        finish(ctx, req, res);
    }

    /** 204: no art (yet); the client draws without. Not cached, so it shows once a game has fetched the crop. */
    private static void noArt(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.NO_CONTENT, Unpooled.EMPTY_BUFFER);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        finish(ctx, req, res);
    }

    /**
     * {@code POST /g/api/join {code, name, deck}}: take seat 1 of the game a guest code opens, with a shared deck, as
     * "{name} (guest)". The code is used up, and the answer sets the guest's cookie: a fresh 256-bit token for this one game.
     * Limits: {@link Options#guestJoinLimit} tries per client address per window (every try counts, good or not), and
     * {@link Options#maxGuestGames} games with a guest on the server.
     */
    private void guestJoin(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        if (req.method() != HttpMethod.POST) {
            sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "POST only");
            return;
        }
        if (!sameOrigin(req)) {
            sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
            return;
        }
        final String type = req.headers().get(HttpHeaderNames.CONTENT_TYPE);
        if (type == null || !type.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) {
            sendError(ctx, req, HttpResponseStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.");
            return;
        }
        final String code;
        final String deck;
        final String name;
        try {
            final JsonObject body = JsonParser.parseString(req.content().toString(StandardCharsets.UTF_8)).getAsJsonObject();
            code = optional(body, "code");
            deck = deckName(body, "deck");
            name = guestName(optional(body, "name"));
            if (code == null) {
                throw new IllegalArgumentException("Open the link you were sent.");
            }
            if (name == null) {
                throw new IllegalArgumentException("Type a name.");
            }
            if (deck == null) {
                throw new IllegalArgumentException("Pick a deck.");
            }
        } catch (final RuntimeException e) {
            sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, e instanceof IllegalArgumentException ? e.getMessage() : "Bad request.");
            return;
        }
        final String ip = clientIp(ctx, req);
        final String token = ChildProcessHost.randomHex(32);
        final GameHost.Game g;
        final Principal who;
        synchronized (capLock) {
            if (draining || restartAt != 0) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "Server is updating, new games are paused.");
                return;
            }
            final long now = o.clock.getAsLong();
            // The only state a client without a login can make: bounded. Full? Forget quiet addresses first, then refuse new ones.
            if (!guestJoins.containsKey(ip) && guestJoins.size() >= o.guestJoinAddresses) {
                guestJoins.values().removeIf(d -> d.isEmpty() || now - d.peekLast() >= o.guestJoinWindowMs);
                if (guestJoins.size() >= o.guestJoinAddresses) {
                    sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS, "Too many guests are joining right now. Try again in a few minutes.");
                    return;
                }
            }
            final java.util.ArrayDeque<Long> tries = guestJoins.computeIfAbsent(ip, k -> new java.util.ArrayDeque<>());
            while (!tries.isEmpty() && now - tries.peekFirst() >= o.guestJoinWindowMs) {
                tries.pollFirst();
            }
            if (tries.size() >= o.guestJoinLimit) {
                sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS, "Too many guest joins from here. Try again in a few minutes.");
                return;
            }
            tries.addLast(now);
            final PvpGame p = guestCode(code);
            final GameHost.Game found = p == null ? null : host.status(p.id);
            if (found == null || found.status() == GameHost.Status.STOPPING || found.status() == GameHost.Status.CRASHED) {
                sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "That invite has expired or was already used.");
                return;
            }
            if (guestGames() >= o.maxGuestGames) {
                sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE,
                        "The server already has " + o.maxGuestGames + " games with guests. Try again when one ends, or sign in.");
                return;
            }
            if (!host.seatDeck(p.id, null, deck)) { // shared decks only: a guest has no folder
                sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Unknown deck.");
                return;
            }
            who = Principal.guest(name);
            guestSeats.put(sha256(token), new GuestSeat(p.id, who, now + o.guestMs));
            p.joiner = who;
            invites.remove(p.code);
            p.code = null;
            g = found;
        }
        BridgeLog.info("game " + g.id() + ": guest " + who.id().substring(0, 10) + "… (\"" + who.name() + "\") joined with invite " + code.substring(0, 4) + "…");
        // Secure holds on http://localhost and 127.0.0.1 too (browsers count loopback as secure), so tests need no exception.
        final String cookie = GUEST_COOKIE + "=" + token + "; Path=/g/" + g.id() + "/; Max-Age=" + o.guestMs / 1000 + "; HttpOnly; Secure; SameSite=Strict";
        sendJson(ctx, req, HttpResponseStatus.OK, toJson(g, 1, origin(req)), cookie);
    }

    /** Games with a guest at seat 1 that may still hold a process (capLock). */
    private int guestGames() {
        int n = 0;
        for (final PvpGame p : pvp.values()) {
            final Principal j = p.joiner;
            final GameHost.Game g = j != null && j.kind() == Kind.GUEST ? host.status(p.id) : null;
            if (g != null && g.status() != GameHost.Status.CRASHED) {
                n++;
            }
        }
        return n;
    }

    /**
     * Who a guest join counts against ({@link #addressKey}): the one {@code --real-ip-header} value when configured
     * (missing or odd: the proxy's own address, so all such tries share one budget), else the socket's peer. No other
     * header is trusted.
     */
    String clientIp(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        if (o.realIpHeader != null) {
            final List<String> v = req.headers().getAll(o.realIpHeader);
            if (v.size() == 1 && !v.get(0).isBlank() && v.get(0).length() <= 64) {
                return addressKey(v.get(0).trim());
            }
        }
        final java.net.SocketAddress peer = ctx.channel().remoteAddress();
        return addressKey(peer instanceof InetSocketAddress isa && isa.getAddress() != null ? isa.getAddress().getHostAddress() : String.valueOf(peer));
    }

    /**
     * The limit's key for a client address: an IPv6 address counts by its /64 (one subscriber's block, so rotating
     * addresses inside it buys nothing), an IPv4-mapped one as its IPv4 address, anything else as written. Only an
     * address literal is ever parsed (never a name lookup).
     */
    static String addressKey(final String ip) {
        final String s = ip.startsWith("[") && ip.endsWith("]") ? ip.substring(1, ip.length() - 1) : ip;
        if (s.indexOf(':') >= 0 && s.matches("[0-9A-Fa-f:.]{2,45}")) {
            try {
                final byte[] b = InetAddress.getByName(s).getAddress(); // a literal with ':' is parsed, never resolved
                return b.length == 16 ? "v6:" + java.util.HexFormat.of().formatHex(b, 0, 8) : InetAddress.getByAddress(b).getHostAddress();
            } catch (final UnknownHostException e) {
                // not an address after all: counted as written
            }
        }
        return s;
    }

    /**
     * A guest's typed name made safe to show: control, format (bidi, zero-width), unassigned and private-use characters
     * removed, runs of spaces made one, trimmed, at most 24 characters. Null when nothing is left.
     */
    static String guestName(final String raw) {
        if (raw == null) {
            return null;
        }
        final String s = raw.replaceAll("[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}]", "").replaceAll("\\p{Zs}+", " ").trim();
        final String cut = s.substring(0, s.offsetByCodePoints(0, Math.min(24, s.codePointCount(0, s.length())))).trim();
        return cut.isEmpty() ? null : cut;
    }

    private static String sha256(final String s) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (final java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------------------------------------------------------- identity

    /**
     * Who is asking, or null after answering 400/401/403. With the proxy header, the USER it names (exactly one,
     * non-empty; same for the groups header under --require-group). Without it, the USER "local" when the token was
     * given (or when {@code needToken} is false: static files). A USER's {@code name} is the first word of the
     * {@code --name-header} (read only here, so never under /g/), else the login. Never a GUEST: a guest's cookie is only ever read on its
     * own game's /g/&lt;id&gt;/ paths ({@link #guestSeat}), and ignored here. Every USER it names counts as online ({@link #seen}).
     */
    Principal identify(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final boolean needToken) {
        if (sessions != null) {
            return sessionUser(ctx, req);
        }
        if (o.trustHeader == null) {
            if (!needToken || hasToken(req, q)) {
                return seen(new Principal(Kind.USER, "local", "local", true), 0);
            }
            sendText(ctx, HttpResponseStatus.UNAUTHORIZED, "token required");
            return null;
        }
        final List<String> users = req.headers().getAll(o.trustHeader);
        if (users.isEmpty()) {
            sendText(ctx, HttpResponseStatus.UNAUTHORIZED, "not signed in");
            return null;
        }
        if (users.size() > 1 || users.get(0).isBlank()) {
            BridgeLog.warn("Rejected a request with " + users.size() + " " + o.trustHeader + " header(s)" + (users.size() == 1 ? " (empty)" : ""));
            sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad " + o.trustHeader + " header");
            return null;
        }
        if (o.requireGroup != null) {
            final List<String> groups = o.groupsHeader == null ? List.of() : req.headers().getAll(o.groupsHeader);
            if (groups.size() > 1) {
                sendText(ctx, HttpResponseStatus.BAD_REQUEST, "bad " + o.groupsHeader + " header");
                return null;
            }
            if (groups.isEmpty() || !inGroup(groups.get(0), o.requireGroup)) {
                sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forge Table is limited to the " + o.requireGroup + " group");
                return null;
            }
        }
        final String user = users.get(0).trim();
        String name = null;
        if (o.nameHeader != null) {
            final List<String> names = req.headers().getAll(o.nameHeader);
            name = names.size() == 1 ? firstName(names.get(0)) : null; // missing, repeated or empty: the login
        }
        return seen(new Principal(Kind.USER, user, name != null ? name : user, headerAdmin(req)), 0);
    }

    /**
     * Native sign-in: the USER whose live session the cookie names (admin by their account, or by a group the directory
     * reported at sign-in), else null after sending a page load to the sign-in page and anything else a 401.
     */
    private Principal sessionUser(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        UserStore.Session s;
        try {
            s = sessions.find(sessions.cookie(req.headers().getAll(HttpHeaderNames.COOKIE)));
        } catch (final java.sql.SQLException e) {
            BridgeLog.warn("session lookup failed: " + e.getMessage());
            sendText(ctx, HttpResponseStatus.SERVICE_UNAVAILABLE, "sign-in is unavailable; try again");
            return null;
        }
        if (s == null) {
            final boolean page = (req.method() == HttpMethod.GET || req.method() == HttpMethod.HEAD)
                    && req.headers().get(HttpHeaderNames.ACCEPT, "").contains("text/html")
                    && !"websocket".equalsIgnoreCase(req.headers().get(HttpHeaderNames.UPGRADE, ""));
            if (page) {
                final String next = AuthRoutes.safeNext(req.uri());
                redirect(ctx, "/auth/login" + (next.equals("/") ? "" : "?next=" + java.net.URLEncoder.encode(next, StandardCharsets.UTF_8)));
            } else {
                sendText(ctx, HttpResponseStatus.UNAUTHORIZED, "not signed in");
            }
            return null;
        }
        final UserStore.User u = s.user();
        return seen(new Principal(Kind.USER, u.login(), u.shownName(), u.admin() || s.groupAdmin()), 0);
    }

    /**
     * The name others see from the proxy's full-name header: its first word, cleaned like a guest's name ({@link #guestName}),
     * or null when nothing is left. The header's bytes are read as UTF-8 where they are (Netty hands them over as Latin-1).
     */
    static String firstName(final String header) {
        String v = header;
        if (header.chars().allMatch(c -> c <= 0xFF)) {
            try {
                v = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(header.getBytes(StandardCharsets.ISO_8859_1))).toString();
            } catch (final java.nio.charset.CharacterCodingException e) {
                // not UTF-8: taken as it came
            }
        }
        final String clean = guestName(v);
        return clean == null ? null : clean.split(" ", 2)[0];
    }

    private boolean hasToken(final FullHttpRequest req, final QueryStringDecoder q) {
        if (tokenEquals(req.headers().get(TOKEN_HEADER))) {
            return true;
        }
        final List<String> t = q.parameters().get("t");
        if (t != null && !t.isEmpty() && tokenEquals(t.get(0))) {
            return true;
        }
        for (final String cookie : req.headers().getAll(HttpHeaderNames.COOKIE)) {
            for (final String part : cookie.split(";")) {
                final String p = part.trim();
                if (p.startsWith("ft=") && tokenEquals(p.substring(3))) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean tokenEquals(final String s) {
        return s != null && MessageDigest.isEqual(s.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    /** No Origin (not a browser), or an Origin whose host:port is the one the browser asked for. */
    boolean sameOrigin(final FullHttpRequest req) {
        final String origin = req.headers().get(HttpHeaderNames.ORIGIN);
        if (origin == null) {
            return true;
        }
        final String dev = System.getProperty("forge.bridge.devOrigin");
        if (dev != null && dev.equals(origin)) {
            return true;
        }
        final String authority;
        try {
            authority = URI.create(origin).getRawAuthority();
        } catch (final IllegalArgumentException e) {
            return false;
        }
        if (authority == null) {
            return false;
        }
        final String forwarded = o.multiUser() ? req.headers().get("X-Forwarded-Host") : null;
        return authority.equalsIgnoreCase(req.headers().get(HttpHeaderNames.HOST)) || forwarded != null && authority.equalsIgnoreCase(forwarded)
                || sessions != null && o.publicUrl != null && origin.equalsIgnoreCase(o.publicUrl);
    }

    /**
     * Native sign-in's check on anything that changes state (and game sockets): {@link #sameOrigin} with an Origin, and
     * without one only a browser saying {@code Sec-Fetch-Site: same-origin}. A cookie rides along on every request, so
     * "no Origin, not a browser" isn't good enough here.
     */
    boolean strictSameOrigin(final FullHttpRequest req) {
        if (req.headers().contains(HttpHeaderNames.ORIGIN)) {
            return sameOrigin(req);
        }
        return "same-origin".equals(req.headers().get("Sec-Fetch-Site"));
    }

    // ---------------------------------------------------------------- responses

    private static String error(final String message) {
        final JsonObject e = new JsonObject();
        e.addProperty("reason", message);
        return e.toString();
    }

    static void sendError(final ChannelHandlerContext ctx, final FullHttpRequest req, final HttpResponseStatus status, final String message) {
        final JsonObject e = new JsonObject();
        e.addProperty("error", message);
        sendJson(ctx, req, status, e);
    }

    static void sendJson(final ChannelHandlerContext ctx, final FullHttpRequest req, final HttpResponseStatus status, final JsonElement json) {
        sendJson(ctx, req, status, json, null);
    }

    static void sendJson(final ChannelHandlerContext ctx, final FullHttpRequest req, final HttpResponseStatus status, final JsonElement json,
            final String setCookie) {
        final byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(body));
        if (setCookie != null) {
            res.headers().set(HttpHeaderNames.SET_COOKIE, setCookie);
        }
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json");
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        finish(ctx, req, res);
    }

    private static void finish(final ChannelHandlerContext ctx, final FullHttpRequest req, final FullHttpResponse res) {
        if (HttpUtil.isKeepAlive(req)) {
            res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.KEEP_ALIVE);
            ctx.writeAndFlush(res);
        } else {
            ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
        }
    }

    /**
     * An error a person sees (a browser asking for a page, e.g. an old game link): a page in the table's look with a
     * way back to the lobby. Anything else (scripts, the WebSocket, images) gets {@link #sendText}.
     */
    static void sendPage(final ChannelHandlerContext ctx, final FullHttpRequest req, final HttpResponseStatus status, final String title, final String text) {
        sendPage(ctx, req, status, title, text, true);
    }

    /** {@link #sendPage}, without the way back to the lobby when {@code lobbyLink} is false (a guest has no lobby). */
    static void sendPage(final ChannelHandlerContext ctx, final FullHttpRequest req, final HttpResponseStatus status, final String title, final String text,
            final boolean lobbyLink) {
        final String accept = req.headers().get(HttpHeaderNames.ACCEPT, "");
        if (!accept.contains("text/html")) {
            sendText(ctx, status, text);
            return;
        }
        final byte[] body = ERROR_PAGE.replace("@CODE@", String.valueOf(status.code())).replace("@TITLE@", title).replace("@TEXT@", text)
                .replace("@LINK@", lobbyLink ? "<a href=\"/\">Back to the lobby</a>" : "").getBytes(StandardCharsets.UTF_8);
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status,
                req.method() == HttpMethod.HEAD ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/html; charset=utf-8");
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        res.headers().set("X-Content-Type-Options", "nosniff");
        res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE);
        ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
    }

    // ponytail: constants only go into it (no escaping needed); a template file if it ever takes user text.
    private static final String ERROR_PAGE = """
            <!doctype html>
            <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <title>@TITLE@ · Forge Table</title><link rel="icon" href="/favicon.svg">
            <style>
            html,body{margin:0;height:100%;background:radial-gradient(ellipse at 50% 40%,#1b1f26,#0d0f13 70%);color:#e8eaee;
            font-family:'Inter Variable','Inter',system-ui,sans-serif}
            main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;
            box-sizing:border-box;text-align:center}
            .card{width:120px;height:168px;border-radius:9px;border:2px solid #b08d57;transform:rotate(-6deg);
            background:repeating-linear-gradient(45deg,#1d2129 0 8px,#181b22 8px 16px);box-shadow:0 12px 30px rgba(0,0,0,.55);
            display:flex;align-items:center;justify-content:center;font:700 40px 'Barlow Condensed','Arial Narrow',sans-serif;
            color:#b08d57;letter-spacing:.04em;margin-bottom:8px}
            h1{margin:0;font-size:26px;font-weight:700}
            p{margin:0;max-width:34ch;color:#a9afba;line-height:1.5}
            a{margin-top:8px;padding:11px 22px;border-radius:8px;background:#ff7a33;color:#14171c;font-weight:700;text-decoration:none}
            a:hover{background:#ff9257}
            </style></head>
            <body><main><div class="card">@CODE@</div><h1>@TITLE@</h1><p>@TEXT@</p>@LINK@</main></body></html>
            """;

    static void sendText(final ChannelHandlerContext ctx, final HttpResponseStatus status, final String text) {
        final byte[] body = text.getBytes(StandardCharsets.UTF_8);
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=utf-8");
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE); // said, since the connection does close
        ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
    }
}

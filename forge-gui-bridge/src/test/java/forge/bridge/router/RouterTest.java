package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.HttpResponseStatus;

/**
 * The router's own rules against a stub {@link GameHost} (no JVMs): binding, identity from the proxy header,
 * the local token, ownership, origin checks and the caps.
 */
public class RouterTest {

    /** Games that are "running" as soon as they're created; attach answers with what it was given. */
    static final class StubHost implements GameHost {
        final Map<String, Game> games = new ConcurrentHashMap<>();
        final AtomicInteger seq = new AtomicInteger();
        /** The upload URL the router passed to the last {@link #create}, or null (never asked, or asked not to). */
        volatile String lastUploadUrl;

        @Override
        public Game create(final String owner, final String deck, final String oppDeck, final String ai) {
            return create(owner, deck, oppDeck, ai, null);
        }

        @Override
        public Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl) {
            lastUploadUrl = neuralUploadUrl;
            final Game g = new Game(Integer.toHexString(0x100 + seq.incrementAndGet()), owner, Status.READY, System.nanoTime(), null);
            games.put(g.id(), g);
            return g;
        }

        @Override
        public Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl,
                final String format) {
            return withFormat(create(owner, deck, oppDeck, ai, neuralUploadUrl), format);
        }

        @Override
        public Game createPvp(final String owner, final String deck, final String format) {
            return withFormat(createPvp(owner, deck), format);
        }

        private Game withFormat(final Game g, final String format) {
            if (format == null) {
                return g;
            }
            final Game f = new Game(g.id(), g.owner(), g.status(), g.created(), g.error(), g.progress(), format);
            games.put(f.id(), f);
            return f;
        }

        @Override
        public void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path) {
            Router.sendText(ctx, HttpResponseStatus.OK, "attached " + id + " " + path);
        }

        @Override
        public List<Game> list() {
            final List<Game> l = new ArrayList<>(games.values());
            l.sort(Comparator.comparingLong(Game::created));
            return l;
        }

        @Override
        public Game status(final String id) { return games.get(id); }

        @Override
        public void end(final String id) { games.remove(id); }

        @Override
        public void close() { games.clear(); }

        // Two people: a game "runs" at once; decks are by user; concessions are recorded.
        final java.util.Set<String> pvpIds = ConcurrentHashMap.newKeySet();
        /** Game id → "user:deck" handed to seat 1. */
        final Map<String, String> seated = new ConcurrentHashMap<>();
        final List<String> concessions = java.util.Collections.synchronizedList(new ArrayList<>());
        volatile boolean concedes = true;
        volatile int lastSeat = -1;
        volatile String lastName;
        /** Leave a /ws request unanswered and its connection open (a browser at the table). */
        volatile boolean holdSockets;

        @Override
        public Game createPvp(final String owner, final String deck) {
            final Game g = create(owner, deck, null, null, null);
            pvpIds.add(g.id());
            return g;
        }

        @Override
        public List<String> decks(final String user) {
            final List<String> d = new ArrayList<>(List.of("shared-deck"));
            if ("alice".equals(user)) {
                d.add("burn");
            } else if (user != null) {
                d.add(user + "-deck");
            }
            return d;
        }

        /** The shared deck can be read; a user's own can't (so it is listed without details). */
        @Override
        public Map<String, DeckSummary> deckSummaries(final String user, final String format) {
            return Map.of("shared-deck", DeckSummary.parse(List.of("[Main]", "4 Lightning Bolt|M10|1", "16 Mountain")));
        }

        /** Only the shared deck can be read (as in deckSummaries). */
        @Override
        public Map<String, Map<String, Integer>> deckCards(final String user, final String format, final String name) {
            return "shared-deck".equals(name) ? DeckSummary.sections(List.of("[metadata]", "Name=x", "[Main]", "4 Lightning Bolt|M10|1",
                    "16 Mountain", "[Sideboard]", "2 Shock")) : null;
        }

        /** Two cards the scripts know. */
        @Override
        public CardScripts.Info cardInfo(final String name) {
            return switch (name) {
                case "Lightning Bolt" -> new CardScripts.Info("Instant", 1, "{R}");
                case "Mountain" -> new CardScripts.Info("Land", 0, "");
                default -> null;
            };
        }

        @Override
        public boolean seatDeck(final String id, final String user, final String name) {
            if (!pvpIds.contains(id) || !decks(user).contains(name)) {
                return false;
            }
            seated.put(id, user + ":" + name);
            return true;
        }

        @Override
        public java.util.concurrent.CompletableFuture<Boolean> concede(final String id, final int seat) {
            concessions.add(id + ":" + seat);
            return java.util.concurrent.CompletableFuture.completedFuture(concedes);
        }

        @Override
        public void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path, final int seat,
                final String name) {
            lastSeat = seat;
            lastName = name;
            if (holdSockets && path.equals("/ws")) {
                return; // like an open game socket: no answer, the connection stays up until the client closes it
            }
            attach(id, ctx, req, path);
        }
    }

    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;

    private Router start(final Router.Options o) throws Exception {
        router = new Router(o, new StubHost());
        router.start();
        return router;
    }

    private static Router.Options proxied() {
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        return o;
    }

    @AfterMethod(alwaysRun = true)
    public void stop() {
        if (router != null) {
            router.stop();
            router = null;
        }
    }

    private HttpRequest.Builder req(final String path, final String... headers) {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        return b;
    }

    private HttpResponse<String> get(final String path, final String... headers) throws Exception {
        return http.send(req(path, headers).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> create(final String user, final String body) throws Exception {
        return http.send(req("/api/matches", "X-authentik-username", user, "Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> delete(final String user, final String id) throws Exception {
        return http.send(req("/api/matches/" + id, "X-authentik-username", user).DELETE().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> putUpload(final String user, final boolean on) throws Exception {
        return http.send(req("/api/upload", "X-authentik-username", user, "Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString("{\"on\":" + on + "}")).build(), HttpResponse.BodyHandlers.ofString());
    }

    private static boolean uploadOn(final HttpResponse<String> list) {
        return JsonParser.parseString(list.body()).getAsJsonObject().getAsJsonObject("upload").get("on").getAsBoolean();
    }

    private static String id(final HttpResponse<String> created) {
        return JsonParser.parseString(created.body()).getAsJsonObject().get("id").getAsString();
    }

    @Test
    public void bindRules() {
        // Wildcards never; another address only behind the proxy header.
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("0.0.0.0", true));
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("::", true));
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("0.0.0.0", false));
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("172.17.0.1", false));
        assertEquals(Router.checkBind("172.17.0.1", true).getHostAddress(), "172.17.0.1");
        assertEquals(Router.checkBind("10.0.0.5", true).getHostAddress(), "10.0.0.5");
        assertEquals(Router.checkBind("192.168.1.20", true).getHostAddress(), "192.168.1.20");
        assertTrue(Router.checkBind("fd00::1", true) != null);
        // With the proxy header, still no public address (the port is the identity boundary).
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("8.8.8.8", true));
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("2001:4860:4860::8888", true));
        expectThrows(IllegalArgumentException.class, () -> Router.checkBind("169.254.1.1", true));
        assertTrue(Router.checkBind("127.0.0.1", false).isLoopbackAddress());
        assertTrue(Router.checkBind("::1", false).isLoopbackAddress());
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--router", "--require-group", "g"}));
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--router", "--state", "x"}));
    }

    @Test
    public void ramCapIsDerived() {
        assertTrue(Router.ramCap(0, 1) > 1);
        assertEquals(Router.ramCap(Long.MAX_VALUE / 4, 1536), 1);
        final Router.Options o = proxied();
        o.maxMatches = 0;
        o.reserveMb = 0;
        o.gameMb = 1024;
        assertEquals(new Router(o, new StubHost()).maxMatches(), Router.ramCap(0, 1024));
    }

    @Test
    public void proxyHeaderIsStrict() throws Exception {
        start(proxied());
        assertEquals(get("/api/matches").statusCode(), 401);
        assertEquals(get("/assets/main.js").statusCode(), 401);
        assertEquals(get("/api/matches", "X-authentik-username", " ").statusCode(), 400);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-username", "bob").statusCode(), 400);
        final HttpResponse<String> ok = get("/api/matches", "X-authentik-username", "alice");
        assertEquals(ok.statusCode(), 200);
        assertEquals(JsonParser.parseString(ok.body()).getAsJsonObject().get("user").getAsString(), "alice");
        // The local token means nothing here.
        assertEquals(get("/api/matches", Router.TOKEN_HEADER, router.token()).statusCode(), 401);
    }

    /** Link-preview bots are never signed in: the lobby page (its og: tags filled in) and its image and icons only. */
    @Test
    public void previewFilesNeedNoLogin() throws Exception {
        final java.nio.file.Path web = java.nio.file.Files.createTempDirectory("ft-web");
        java.nio.file.Files.writeString(web.resolve("lobby.html"), "<meta property=\"og:image\" content=\"__FT_ORIGIN__/og.png\" /><meta name=\"description\" content=\"__FT_TAGLINE__\" />");
        java.nio.file.Files.writeString(web.resolve("og.png"), "png");
        java.nio.file.Files.writeString(web.resolve("secret.js"), "js");
        final Router.Options o = proxied();
        o.requireGroup = "forge";
        o.groupsHeader = "X-authentik-groups";
        o.webDir = web.toString();
        start(o);
        final HttpResponse<String> page = get("/");
        assertEquals(page.statusCode(), 200);
        assertTrue(page.body().matches(".*content=\"http://127\\.0\\.0\\.1:[0-9]+/og\\.png\".*"), page.body());
        assertTrue(page.body().contains("content=\"" + Router.TAGLINE + "\""), page.body());
        assertEquals(get("/og.png").statusCode(), 200);
        assertEquals(get("/secret.js").statusCode(), 401);
        // A signed-in request is checked as usual (here: not in the group).
        assertEquals(get("/", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/og.png", "X-authentik-username", "alice", "X-authentik-username", "bob").statusCode(), 400);
    }

    @Test
    public void originIsStrict() {
        final java.util.function.BiFunction<String, String, String> of = (host, publicUrl) -> {
            final FullHttpRequest r = new io.netty.handler.codec.http.DefaultFullHttpRequest(io.netty.handler.codec.http.HttpVersion.HTTP_1_1,
                    io.netty.handler.codec.http.HttpMethod.GET, "/");
            if (host != null) {
                r.headers().set("Host", host);
            }
            return Router.origin(r, publicUrl);
        };
        assertEquals(of.apply("table.example.org", null), "https://table.example.org");
        assertEquals(of.apply("TABLE.example.org", null), "https://table.example.org");
        assertEquals(of.apply("localhost:8080", null), "http://localhost:8080");
        assertEquals(of.apply("evil\"><script>", null), "http://localhost");
        assertEquals(of.apply(null, null), "http://localhost");
        assertEquals(of.apply(null, "https://table.example.org"), "https://table.example.org");
        assertEquals(of.apply("evil\"><script>", "https://table.example.org"), "https://table.example.org");
        assertEquals(of.apply("other.example.org", "https://table.example.org"), "https://other.example.org");
        assertEquals(of.apply("localhost.evil.com", null), "https://localhost.evil.com");
        assertEquals(of.apply("127.0.0.1:9", null), "http://127.0.0.1:9");
        assertEquals(Router.parse(new String[] {"--public-url", "HTTPS://Table.example.org/"}).publicUrl, "https://table.example.org");
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--public-url", "https://x.org/\"><b>"}));
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--public-url", "ftp://x.org"}));
    }

    @Test
    public void settingsComeFromFlagsThenEnvThenConfigFile() throws Exception {
        final Path file = java.nio.file.Files.createTempFile("ft", ".env");
        try {
            java.nio.file.Files.writeString(file, "# EnvironmentFile style\nFT_MAX_MATCHES=7\nFT_PORT=8790\nFT_GROUPS_SEPARATOR=\"|\"\n"
                    + "FT_TRUST_PROXY_HEADER=X-User\nFT_GUESTS=true\nFT_REAL_IP_HEADER=X-Real-IP\nFT_DECKS=decks\nFT_EXTRA_ARGS=--nope\n");
            final Router.Options o = Router.parseArgs(Router.withDefaults(
                    new String[] {"--router", "--config", file.toString(), "--port", "1234"},
                    Map.of("FT_MAX_MATCHES", "3", "FT_ADMIN_GROUP", " ", "FT_GROUPS_HEADER", "X-Groups")));
            assertEquals(o.port, 1234); // flag beats file
            assertEquals(o.maxMatches, 3); // env beats file
            assertEquals(o.groupsHeader, "X-Groups");
            assertEquals(o.groupsSeparator, "|"); // file, EnvironmentFile quotes dropped
            assertEquals(o.trustHeader, "X-User");
            assertTrue(o.guests);
            assertEquals(o.adminGroup, null); // blank env is no value
            assertEquals(o.child.childArgs, List.of("--decks", "decks")); // child flags pass through once
        } finally {
            java.nio.file.Files.delete(file);
        }
        // FT_CONFIG names the file too; a switch only turns on for a yes-ish value; defaults are neutral
        final Router.Options d = Router.parseArgs(Router.withDefaults(new String[] {"--router"}, Map.of("FT_GUESTS", "0")));
        assertFalse(d.guests);
        assertEquals(d.groupsHeader, null);
        assertEquals(d.groupsSeparator, ",");
        assertEquals(d.publicUrl, null);
        assertEquals(Router.envName("--mtgai-upload-url"), "FT_MTGAI_UPLOAD_URL");
        expectThrows(IllegalArgumentException.class, () -> Router.withDefaults(new String[] {"--config", "/nonexistent/ft.env"}, Map.of()));
        expectThrows(IllegalArgumentException.class, () -> Router.withDefaults(new String[0], Map.of("FT_CONFIG", "/nonexistent/ft.env")));
    }

    @Test
    public void aFlagValueThatLooksLikeAFlagDoesNotHideTheEnvSetting() throws Exception {
        // --name-header's VALUE is "--require-group": FT_REQUIRE_GROUP must still apply (else the group gate silently drops)
        final Router.Options o = Router.parseArgs(Router.withDefaults(
                new String[] {"--trust-proxy-header", "X-User", "--name-header", "--require-group"},
                Map.of("FT_REQUIRE_GROUP", "forge", "FT_GROUPS_HEADER", "X-Groups")));
        assertEquals(o.requireGroup, "forge");
        assertEquals(o.nameHeader, "--require-group");
        // single-quoted EnvironmentFile values lose their quotes too
        final Path file = java.nio.file.Files.createTempFile("ft", ".env");
        try {
            java.nio.file.Files.writeString(file, "FT_GROUPS_SEPARATOR='|'\n");
            assertEquals(Router.parseArgs(Router.withDefaults(new String[] {"--config", file.toString()}, Map.of())).groupsSeparator, "|");
        } finally {
            java.nio.file.Files.delete(file);
        }
        // an explicitly empty --require-group is refused, not read as "no gate"
        expectThrows(IllegalArgumentException.class, () -> Router.parseArgs(new String[] {"--trust-proxy-header", "X-User",
                "--groups-header", "X-Groups", "--require-group", " "}));
    }

    @Test
    public void groupGate() throws Exception {
        final Router.Options o = proxied();
        o.requireGroup = "forge";
        o.groupsHeader = "X-authentik-groups"; // Authentik's header and separator, as prod sets them
        o.groupsSeparator = "|";
        start(o);
        assertEquals(get("/api/matches", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-groups", "users|admins").statusCode(), 403);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-groups", "").statusCode(), 403);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-groups", "forge", "X-authentik-groups", "x").statusCode(), 400);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-groups", "users|forge").statusCode(), 200);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-Forwarded-Groups", "forge").statusCode(), 403);
    }

    @Test
    public void groupGateWithCommaSeparator() throws Exception {
        final Router.Options o = proxied();
        o.requireGroup = "forge";
        o.groupsHeader = "X-Forwarded-Groups";
        start(o);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-Forwarded-Groups", "users, forge").statusCode(), 200);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-Forwarded-Groups", "users|forge").statusCode(), 403);
        assertEquals(get("/api/matches", "X-authentik-username", "alice", "X-authentik-groups", "forge").statusCode(), 403);
    }

    @Test
    public void groupFlagsNeedTheGroupsHeader() {
        expectThrows(IllegalArgumentException.class, () -> Router.parseArgs(new String[] {"--trust-proxy-header", "X-User", "--require-group", "g"}));
        expectThrows(IllegalArgumentException.class, () -> Router.parseArgs(new String[] {"--trust-proxy-header", "X-User", "--admin-group", "g"}));
        expectThrows(IllegalArgumentException.class, () -> Router.parseArgs(new String[] {"--trust-proxy-header", "X-User", "--admin-group", "g",
                "--groups-header", " "}));
        assertEquals(Router.parseArgs(new String[] {"--trust-proxy-header", "X-User", "--admin-group", "g", "--groups-header", "X-G"}).groupsHeader, "X-G");
    }

    @Test
    public void localModeNeedsTheToken() throws Exception {
        final Router.Options o = new Router.Options();
        o.maxMatches = 10;
        start(o);
        assertEquals(get("/api/matches").statusCode(), 401);
        assertEquals(get("/api/matches", Router.TOKEN_HEADER, "nope").statusCode(), 401);
        assertEquals(get("/api/matches", Router.TOKEN_HEADER, router.token()).statusCode(), 200);
        assertEquals(get("/api/matches?t=" + router.token()).statusCode(), 200);
        final HttpResponse<String> made = http.send(req("/api/matches", Router.TOKEN_HEADER, router.token(), "Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(made.statusCode(), 201);
        final String id = id(made);
        // Static game files are open (as in the plain sidecar); images and the socket need the token.
        assertEquals(get("/m/" + id + "/").statusCode(), 200);
        assertEquals(get("/m/" + id + "/img/card/x").statusCode(), 401);
        assertEquals(get("/m/" + id + "/img/card/x", "Cookie", "ft=" + router.token()).body(), "attached " + id + " /img/card/x");
        assertEquals(get("/m/" + id + "/img/avatar/neural", "Cookie", "ft=" + router.token()).body(), "attached " + id + " /img/avatar/neural");
        // The router's token is not passed on to the game, however it is spelled.
        assertEquals(get("/m/" + id + "/img/card/x?t=" + router.token() + "&v=2").body(), "attached " + id + " /img/card/x?v=2");
        assertEquals(get("/m/" + id + "/img/card/x?%74=" + router.token() + "&v=2").body(), "attached " + id + " /img/card/x?v=2");
        assertEquals(get("/m/" + id + "/img/card/x?v=2;t=" + router.token()).body(), "attached " + id + " /img/card/x?v=2");
        assertEquals(Router.withoutToken("t=a;%74=b&v=1&%zz=c&t"), "v=1");
        assertEquals(get("/m/" + id + "/status", Router.TOKEN_HEADER, router.token()).statusCode(), 404);
    }

    @Test
    public void usersOnlySeeTheirOwnGames() throws Exception {
        start(proxied());
        final String a = id(create("alice", "{\"deck\":\"mono-red-madness\",\"ai\":\"Neural\"}"));
        final String b = id(create("bob", "{}"));
        // By id, not by substring: a stub id ("102") can turn up in another game's created time.
        final JsonObject alice = JsonParser.parseString(get("/api/matches", "X-authentik-username", "alice").body()).getAsJsonObject();
        assertTrue(find(alice, a) != null);
        assertTrue(find(alice, b) == null);
        // The AI asked for rides on the game card; none asked, none said.
        assertEquals(find(alice, a).get("ai").getAsString(), "Neural");
        final JsonObject bob = JsonParser.parseString(get("/api/matches", "X-authentik-username", "bob").body()).getAsJsonObject();
        assertTrue(find(bob, b).get("ai") == null);

        assertEquals(get("/m/" + a + "/img/card/x?y=1", "X-authentik-username", "alice").body(), "attached " + a + " /img/card/x?y=1");
        assertEquals(get("/m/" + b + "/img/card/x", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/m/" + b + "/ws", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/m/" + b + "/", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/m/" + b + "/").statusCode(), 401);
        assertEquals(get("/m/ffff/", "X-authentik-username", "alice").statusCode(), 404);
        // An old game link in a browser gets a page with the way back; a script still gets plain text.
        final HttpResponse<String> gone = get("/m/ffff/", "X-authentik-username", "alice", "Accept", "text/html,*/*");
        assertEquals(gone.statusCode(), 404);
        assertTrue(gone.body().contains("This game is over") && gone.body().contains("href=\"/\""));
        assertTrue(gone.headers().firstValue("content-type").orElse("").startsWith("text/html"));
        assertFalse(get("/m/ffff/", "X-authentik-username", "alice").body().contains("<html"));
        assertEquals(get("/m/" + a, "X-authentik-username", "alice").headers().firstValue("location").orElse(""), "/m/" + a + "/");

        assertEquals(delete("alice", b).statusCode(), 403);
        assertEquals(delete("bob", b).statusCode(), 200);
        assertEquals(delete("bob", b).statusCode(), 404);
    }

    /** The router routes the raw path and the game decodes it, so encoded tricks stop at the router. */
    @Test
    public void encodedPathsAreChecked() throws Exception {
        start(proxied());
        final String a = id(create("alice", "{}"));
        final String m = "/m/" + a;
        assertEquals(get(m + "/%2e%2e/x", "X-authentik-username", "alice").statusCode(), 400);
        assertEquals(get(m + "/assets/%2fetc", "X-authentik-username", "alice").statusCode(), 400);
        assertEquals(get(m + "/img/card/..%2F..%2Fx", "X-authentik-username", "alice").statusCode(), 400);
        assertEquals(get(m + "/img/card/x%00y", "X-authentik-username", "alice").statusCode(), 400);
        assertEquals(get(m + "/img/card/c%3AFire%20%2F%2F%20Ice%7CMH2", "X-authentik-username", "alice").body(),
                "attached " + a + " /img/card/c%3AFire%20%2F%2F%20Ice%7CMH2");
        // art crops are routed the same way: an encoded key passes, a traversal does not
        assertEquals(get(m + "/img/crop/c%3AFire%20%2F%2F%20Ice%7CMH2", "X-authentik-username", "alice").body(),
                "attached " + a + " /img/crop/c%3AFire%20%2F%2F%20Ice%7CMH2");
        assertEquals(get(m + "/img/crop/..%2F..%2Fx", "X-authentik-username", "alice").statusCode(), 400);
    }

    /** An HTTP connection that sends nothing is closed. */
    @Test
    public void idleConnectionsAreClosed() throws Exception {
        final Router.Options o = proxied();
        o.readTimeoutSec = 1;
        start(o);
        try (java.net.Socket sock = new java.net.Socket("127.0.0.1", router.port())) {
            sock.setSoTimeout(5000);
            final long t0 = System.currentTimeMillis();
            assertEquals(sock.getInputStream().read(), -1, "the router should hang up");
            assertTrue(System.currentTimeMillis() - t0 < 4000);
        }
    }

    @Test
    public void createValidatesItsInput() throws Exception {
        start(proxied());
        assertEquals(create("alice", "{\"deck\":\"--router\"}").statusCode(), 400);
        assertEquals(create("alice", "{\"oppDeck\":\"-x\"}").statusCode(), 400);
        assertEquals(create("alice", "{\"ai\":\"Reckless\"}").statusCode(), 400);
        assertEquals(create("alice", "{\"deck\":\"../../etc/x\"}").statusCode(), 400);
        assertEquals(create("alice", "{\"oppDeck\":\"/abs.dck\"}").statusCode(), 400);
        assertEquals(create("alice", "[1]").statusCode(), 400);
        assertEquals(create("alice", "{\"format\":\"x\"}").statusCode(), 400);
        assertEquals(create("alice", "{\"mode\":\"pvp\",\"format\":\"commander\"}").statusCode(), 400);
        assertEquals(get("/api/decks?format=x", "X-authentik-username", "alice").statusCode(), 400);
        assertEquals(get("/api/decks?format=brawl", "X-authentik-username", "alice").statusCode(), 200);
        assertEquals(http.send(req("/api/matches", "X-authentik-username", "alice", "Content-Type", "text/plain")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 415);
    }

    @Test
    public void foreignOriginsAreRefused() throws Exception {
        start(proxied());
        final String origin = "http://127.0.0.1:" + router.port();
        assertEquals(http.send(req("/api/matches", "X-authentik-username", "alice", "Content-Type", "application/json", "Origin", "https://evil.example")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 403);
        assertEquals(http.send(req("/api/matches", "X-authentik-username", "alice", "Content-Type", "application/json", "Origin", origin)
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 201);
        // Behind the proxy the browser's host arrives as X-Forwarded-Host.
        assertEquals(http.send(req("/api/matches", "X-authentik-username", "alice", "Content-Type", "application/json",
                "Origin", "https://forge.example", "X-Forwarded-Host", "forge.example")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 201);
        final String id = JsonParser.parseString(get("/api/matches", "X-authentik-username", "alice").body()).getAsJsonObject()
                .getAsJsonArray("matches").get(0).getAsJsonObject().get("id").getAsString();
        assertEquals(get("/m/" + id + "/ws", "X-authentik-username", "alice", "Origin", "https://evil.example").statusCode(), 403);
    }

    @Test
    public void perUserCap() throws Exception {
        final Router.Options o = proxied();
        o.maxPerUser = 2;
        start(o);
        assertEquals(create("alice", "{}").statusCode(), 201);
        assertEquals(create("alice", "{}").statusCode(), 201);
        final HttpResponse<String> third = create("alice", "{}");
        assertEquals(third.statusCode(), 429);
        assertTrue(JsonParser.parseString(third.body()).getAsJsonObject().get("error").getAsString().contains("limit is 2"));
        assertEquals(create("bob", "{}").statusCode(), 201);
    }

    /** At the router: crashed and closing games still count for their owner; closing ones also in total. */
    @Test
    public void crashedAndClosingGamesCount() throws Exception {
        final Router.Options o = proxied();
        o.maxPerUser = 2;
        o.maxMatches = 3;
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        final String a = id(create("alice", "{}"));
        stub.games.computeIfPresent(a, (k, g) -> new GameHost.Game(g.id(), g.owner(), GameHost.Status.CRASHED, g.created(), "boom"));
        final String b = id(create("alice", "{}"));
        assertEquals(create("alice", "{}").statusCode(), 429, "the crashed game still counts for alice");
        stub.games.computeIfPresent(b, (k, g) -> new GameHost.Game(g.id(), g.owner(), GameHost.Status.STOPPING, g.created(), null));
        assertEquals(create("alice", "{}").statusCode(), 429, "so does the closing one");
        id(create("bob", "{}"));
        id(create("carol", "{}"));
        // Live: b (closing), bob, carol = 3; the crashed one holds no memory.
        assertEquals(create("dave", "{}").statusCode(), 503);
        // A closing game is no longer reachable.
        assertEquals(get("/m/" + b + "/", "X-authentik-username", "alice").statusCode(), 404);
        assertEquals(delete("alice", b).statusCode(), 404);
    }

    /** Many users racing for the last slots: exactly the cap gets in. */
    @Test
    public void totalCapHoldsUnderConcurrentCreates() throws Exception {
        final Router.Options o = proxied();
        o.maxMatches = 5;
        start(o);
        final ExecutorService pool = Executors.newFixedThreadPool(16);
        final CountDownLatch go = new CountDownLatch(1);
        final List<Future<Integer>> codes = new ArrayList<>();
        for (int i = 0; i < 32; i++) {
            final String user = "user" + i;
            codes.add(pool.submit(() -> {
                go.await();
                return create(user, "{}").statusCode();
            }));
        }
        go.countDown();
        int created = 0;
        int full = 0;
        for (final Future<Integer> f : codes) {
            final int c = f.get();
            if (c == 201) {
                created++;
            } else if (c == 503) {
                full++;
            }
        }
        pool.shutdown();
        assertEquals(created, 5);
        assertEquals(full, 27);
        final JsonObject list = JsonParser.parseString(get("/api/matches", "X-authentik-username", "user0").body()).getAsJsonObject();
        assertEquals(list.get("maxMatches").getAsInt(), 5);
    }

    // ---------------------------------------------------------------- operations

    @Test
    public void healthIsLocalOnlyAndCountsOnly() throws Exception {
        start(proxied());
        id(create("alice", "{}"));
        final HttpResponse<String> ok = get("/healthz");
        assertEquals(ok.statusCode(), 200);
        final JsonObject h = JsonParser.parseString(ok.body()).getAsJsonObject();
        assertTrue(h.get("ok").getAsBoolean());
        assertEquals(h.get("active").getAsInt(), 1);
        assertEquals(h.get("starting").getAsInt(), 0);
        assertEquals(h.get("stopping").getAsInt(), 0);
        assertFalse(h.get("draining").getAsBoolean());
        assertEquals(h.get("cap").getAsInt(), 10);
        assertTrue(h.has("build"));
        assertFalse(ok.body().contains("alice"), "no user names");
        // Through a proxy, with the user header, or from a browser: refused, as is any other peer.
        assertEquals(get("/healthz", "X-authentik-username", "alice").statusCode(), 403);
        assertEquals(get("/healthz", "X-Forwarded-For", "10.0.0.9").statusCode(), 403);
        assertEquals(get("/healthz", "Origin", "http://127.0.0.1:" + router.port()).statusCode(), 403);
        assertEquals(http.send(req("/admin/drain", "X-authentik-username", "alice").POST(HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.ofString()).statusCode(), 403);
        assertFalse(router.draining());
        assertEquals(get("/admin/drain").statusCode(), 404, "drain is a POST");
    }

    /** --admin-port: a loopback listener for scripts that answers health and drain, and nothing else. */
    @Test
    public void adminListenerServesOnlyOperations() throws Exception {
        final Router.Options o = proxied();
        o.adminPort = 0;
        start(o);
        assertEquals(router.adminPort(), 0, "no admin listener unless asked");
        router.stop();
        final java.net.ServerSocket free = new java.net.ServerSocket(0);
        o.adminPort = free.getLocalPort();
        free.close();
        start(o);
        final String admin = "http://127.0.0.1:" + router.adminPort();
        assertEquals(http.send(HttpRequest.newBuilder(URI.create(admin + "/healthz")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 200);
        assertEquals(http.send(HttpRequest.newBuilder(URI.create(admin + "/api/matches")).header("X-authentik-username", "alice").build(),
                HttpResponse.BodyHandlers.ofString()).statusCode(), 404, "no identity can be claimed on the admin port");
        assertEquals(http.send(HttpRequest.newBuilder(URI.create(admin + "/")).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 404);
    }

    /** Drain: no new games; saved games pause over the restart, so the router stops without waiting for them. */
    @Test
    public void drainRefusesNewGamesAndDoesNotWaitForSavedOnes() throws Exception {
        final Router.Options o = proxied();
        o.drainTickMs = 1_000; // the checks below run before the first drain tick
        start(o);
        final CountDownLatch drained = new CountDownLatch(1);
        router.onDrained(drained::countDown);
        id(create("alice", "{}"));
        final HttpResponse<String> d = http.send(req("/admin/drain").POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(d.statusCode(), 200);
        assertTrue(JsonParser.parseString(d.body()).getAsJsonObject().get("draining").getAsBoolean());
        final HttpResponse<String> refused = create("bob", "{}");
        assertEquals(refused.statusCode(), 503);
        assertTrue(refused.body().contains("Server is updating"));
        assertTrue(JsonParser.parseString(get("/api/matches", "X-authentik-username", "alice").body()).getAsJsonObject().get("draining").getAsBoolean());
        // A game against the AI is saved over the restart (it pauses and resumes): nothing to wait for.
        assertTrue(drained.await(5, java.util.concurrent.TimeUnit.SECONDS), "router never finished draining");
    }

    @Test
    public void drainTimesOutAndEndsTheRest() throws Exception {
        final Router.Options o = proxied();
        o.drainTickMs = 50;
        o.drainTimeoutMs = 300;
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        final CountDownLatch drained = new CountDownLatch(1);
        router.onDrained(drained::countDown);
        id(create("alice", "{}"));
        router.drain();
        assertTrue(drained.await(5, java.util.concurrent.TimeUnit.SECONDS), "drain never timed out");
        assertTrue(stub.games.isEmpty(), "the remaining games were ended");
    }

    /** "off": no toggle, no upload, whatever a user asks. */
    /** No Neural AI plugin, nothing to upload: upload is off (and the toggle hidden), not a crash loop. */
    @Test
    public void uploadNeedsThePlugin() {
        final String[] on = {"--router", "--mtgai-upload", "optin", "--mtgai-upload-url", "https://intake.example/"};
        final Router.Options without = Router.uploadNeedsPlugin(Router.parseArgs(on), false);
        assertEquals(without.uploadMode, "off");
        assertEquals(without.uploadUrl, null);
        final Router.Options with = Router.uploadNeedsPlugin(Router.parseArgs(on), true);
        assertEquals(with.uploadMode, "optin");
        assertEquals(with.uploadUrl, "https://intake.example/");
    }

    @Test
    public void uploadOffHidesTheToggle() throws Exception {
        final Router.Options o = proxied();
        o.uploadUrl = "https://intake.example/";
        o.uploadMode = "off";
        o.dataDir = Path.of("target", "router-test", "upload-off-" + System.nanoTime());
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        assertFalse(JsonParser.parseString(get("/api/matches", "X-authentik-username", "alice").body()).getAsJsonObject().has("upload"));
        assertEquals(putUpload("alice", true).statusCode(), 403);
        create("alice", "{}");
        assertEquals(stub.lastUploadUrl, null);
    }

    /** "on": a game uploads by default; a user may turn it off, and the choice survives their next game. */
    @Test
    public void uploadOnDefaultsOnAndRemembersOptOut() throws Exception {
        final Router.Options o = proxied();
        o.uploadUrl = "https://intake.example/";
        o.uploadMode = "on";
        o.dataDir = Path.of("target", "router-test", "upload-on-" + System.nanoTime());
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        assertTrue(uploadOn(get("/api/matches", "X-authentik-username", "alice")), "on by default");
        create("alice", "{}");
        assertEquals(stub.lastUploadUrl, "https://intake.example/");
        assertFalse(uploadOn(putUpload("alice", false)));
        create("alice", "{}");
        assertEquals(stub.lastUploadUrl, null, "opted out");
        assertTrue(uploadOn(get("/api/matches", "X-authentik-username", "bob")), "a different user keeps the channel default");
    }

    /** "optin": off by default; a user who opts in gets it on the next game they start. */
    @Test
    public void uploadOptinDefaultsOff() throws Exception {
        final Router.Options o = proxied();
        o.uploadUrl = "https://intake.example/";
        o.uploadMode = "optin";
        o.dataDir = Path.of("target", "router-test", "upload-optin-" + System.nanoTime());
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        assertFalse(uploadOn(get("/api/matches", "X-authentik-username", "alice")), "off by default");
        create("alice", "{}");
        assertEquals(stub.lastUploadUrl, null);
        assertTrue(uploadOn(putUpload("alice", true)));
        create("alice", "{}");
        assertEquals(stub.lastUploadUrl, "https://intake.example/");
    }

    // ---------------------------------------------------------------- two people

    private HttpResponse<String> post(final String user, final String path, final String body) throws Exception {
        return http.send(req(path, "X-authentik-username", user, "Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private static JsonObject json(final HttpResponse<String> r) {
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    private static String code(final JsonObject game) {
        final String url = game.getAsJsonObject("invite").get("url").getAsString();
        return url.substring(url.lastIndexOf('/') + 1);
    }

    private JsonObject listFor(final String user) throws Exception {
        return json(get("/api/matches", "X-authentik-username", user));
    }

    private static JsonObject find(final JsonObject list, final String id) {
        for (final com.google.gson.JsonElement e : list.getAsJsonArray("matches")) {
            if (e.getAsJsonObject().get("id").getAsString().equals(id)) {
                return e.getAsJsonObject();
            }
        }
        return null;
    }

    /**
     * A pvp game: the creator gets a single-use invite link; the open list shows only id, host and age; joining by code
     * (listed or not) or by a listed id seats the joiner with only their chosen deck; a used, unknown or own code is refused.
     */
    @Test
    public void pvpInviteJoinAndOpenList() throws Exception {
        final StubHost stub = new StubHost();
        router = new Router(proxied(), stub);
        router.start();
        final HttpResponse<String> made = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}");
        assertEquals(made.statusCode(), 201, made.body());
        final JsonObject g = json(made);
        final String id = g.get("id").getAsString();
        assertEquals(g.get("mode").getAsString(), "pvp");
        assertEquals(g.get("seat").getAsInt(), 0);
        assertTrue(g.get("waiting").getAsBoolean());
        assertTrue(g.get("listed").getAsBoolean(), "listed by default");
        final String code = code(g);
        assertTrue(code.matches("[0-9a-f]{32}"), code);
        assertTrue(g.getAsJsonObject("invite").get("url").getAsString().startsWith("http://127.0.0.1:" + router.port() + "/join/"));
        final long ttl = g.getAsJsonObject("invite").get("expires").getAsLong() - System.currentTimeMillis();
        assertTrue(ttl > 14 * 60_000 && ttl <= 15 * 60_000, "expires in 15 min: " + ttl);

        // Bob's open list: the game, its host and age; nothing else about it (no deck, no code, no ids of people).
        final JsonObject bobs = listFor("bob");
        assertEquals(bobs.getAsJsonArray("matches").size(), 0);
        final JsonObject open = bobs.getAsJsonArray("open").get(0).getAsJsonObject();
        assertEquals(open.keySet(), java.util.Set.of("id", "host", "created"));
        assertEquals(open.get("host").getAsString(), "alice");
        assertFalse(bobs.toString().contains("burn") || bobs.toString().contains(code), bobs.toString());
        assertEquals(listFor("alice").getAsJsonArray("open").size(), 0, "your own game isn't in your open list");

        assertEquals(post("alice", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"burn\"}").statusCode(), 400, "own game");
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"burn\"}").statusCode(), 400, "alice's deck isn't bob's");
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"../x\"}").statusCode(), 400);
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code + "\",\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}").statusCode(), 400);
        final HttpResponse<String> unknown = post("bob", "/api/join", "{\"code\":\"" + "0".repeat(32) + "\",\"deck\":\"bob-deck\"}");
        assertEquals(unknown.statusCode(), 404);
        assertEquals(json(unknown).get("error").getAsString(), "That invite has expired or was already used.");

        final HttpResponse<String> joined = post("bob", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"bob-deck\"}");
        assertEquals(joined.statusCode(), 200, joined.body());
        final JsonObject jb = json(joined);
        assertEquals(jb.get("seat").getAsInt(), 1);
        assertFalse(jb.has("invite") || jb.has("listed") || jb.has("waiting"), jb.toString());
        assertEquals(jb.getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"alice\"},{\"seat\":1,\"name\":\"bob\"}]");
        assertEquals(stub.seated.get(id), "bob:bob-deck", "only the joiner's chosen deck reaches the game");
        assertFalse(jb.toString().contains("burn"), "the creator's deck stays hidden");
        final HttpResponse<String> reused = post("carol", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"carol-deck\"}");
        assertEquals(reused.statusCode(), 404, "a code is single use");
        assertEquals(post("carol", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"carol-deck\"}").statusCode(), 409, "someone already joined");
        final JsonObject alices = find(listFor("alice"), id);
        assertFalse(alices.has("invite") || alices.has("waiting"), alices.toString());
        assertEquals(listFor("carol").getAsJsonArray("open").size(), 0, "a joined game isn't open");
        assertTrue(find(listFor("bob"), id) != null, "the game is in both players' lists");

        // By id from the open list; an unlisted game only by its link.
        final String listed = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"shared-deck\"}")).get("id").getAsString();
        final JsonObject hidden = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"listed\":false}"));
        assertFalse(hidden.get("listed").getAsBoolean());
        // By id, not by substring: a stub id can turn up in another game's created time.
        final String hiddenId = hidden.get("id").getAsString();
        final JsonObject carols = listFor("carol");
        assertTrue(find(carols, hiddenId) == null, "unlisted games aren't carol's");
        for (final com.google.gson.JsonElement e : carols.getAsJsonArray("open")) {
            assertFalse(e.getAsJsonObject().get("id").getAsString().equals(hiddenId), "unlisted games aren't open");
        }
        assertEquals(post("carol", "/api/join", "{\"id\":\"" + hidden.get("id").getAsString() + "\",\"deck\":\"carol-deck\"}").statusCode(), 404);
        assertEquals(post("carol", "/api/join", "{\"code\":\"" + code(hidden) + "\",\"deck\":\"shared-deck\"}").statusCode(), 200);
        assertEquals(post("dave", "/api/join", "{\"id\":\"" + listed + "\",\"deck\":\"dave-deck\"}").statusCode(), 200);
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"faeries\"}").statusCode(), 400, "creator's deck must be theirs");
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\"}").statusCode(), 400, "pvp needs a deck");
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"chess\"}").statusCode(), 400);
    }

    /** An expired invite is refused like a used one, and the creator can make a new link (seat 0 only). */
    @Test
    public void pvpInviteExpiresAndIsRemade() throws Exception {
        final Router.Options o = proxied();
        o.inviteMs = 300;
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        final JsonObject g = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        final String id = g.get("id").getAsString();
        final String old = code(g);
        Thread.sleep(400);
        assertFalse(find(listFor("alice"), id).has("invite"), "an expired link isn't shown");
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + old + "\",\"deck\":\"bob-deck\"}").statusCode(), 404, "expired");
        assertEquals(post("bob", "/api/matches/" + id + "/invite", "{}").statusCode(), 403, "not a member");
        o.inviteMs = 60_000;
        final HttpResponse<String> again = post("alice", "/api/matches/" + id + "/invite", "{}");
        assertEquals(again.statusCode(), 200, again.body());
        final String fresh = code(json(again));
        assertFalse(fresh.equals(old));
        final String older = fresh;
        final String newest = code(json(post("alice", "/api/matches/" + id + "/invite", "{}")));
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + older + "\",\"deck\":\"bob-deck\"}").statusCode(), 404, "a re-mint kills the old link");
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + newest + "\",\"deck\":\"bob-deck\"}").statusCode(), 200);
        assertEquals(post("bob", "/api/matches/" + id + "/invite", "{}").statusCode(), 403, "seat 1 can't make links");
        assertEquals(post("alice", "/api/matches/" + id + "/invite", "{}").statusCode(), 409, "nobody to invite any more");
        final String ai = id(create("alice", "{}"));
        assertEquals(post("alice", "/api/matches/" + ai + "/invite", "{}").statusCode(), 400, "a game against the AI has no invite");
    }

    /** Invite links per person are rate-limited (creates count). */
    @Test
    public void pvpInvitesAreRateLimited() throws Exception {
        final Router.Options o = proxied();
        o.mintLimit = 3;
        router = new Router(o, new StubHost());
        router.start();
        final String id = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}")).get("id").getAsString();
        assertEquals(post("alice", "/api/matches/" + id + "/invite", "{}").statusCode(), 200);
        assertEquals(post("alice", "/api/matches/" + id + "/invite", "{}").statusCode(), 200);
        assertEquals(post("alice", "/api/matches/" + id + "/invite", "{}").statusCode(), 429);
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}").statusCode(), 429);
        assertEquals(post("bob", "/api/matches/" + id + "/invite", "{}").statusCode(), 403);
    }

    /**
     * Membership is checked everywhere ownership was: page, socket, images and DELETE are 403 for anyone else; each member
     * reaches the game as their own seat, with their name; leaving a game being played concedes for that seat.
     */
    @Test
    public void pvpMembersOnlyAndSeatStamp() throws Exception {
        final StubHost stub = new StubHost();
        router = new Router(proxied(), stub);
        router.start();
        final JsonObject g = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        final String id = g.get("id").getAsString();
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"bob-deck\"}").statusCode(), 200);
        for (final String sub : new String[] {"/", "/ws", "/img/card/x"}) {
            assertEquals(get("/m/" + id + sub, "X-authentik-username", "carol").statusCode(), 403, sub);
        }
        assertEquals(get("/m/" + id + "/seat/concede", "X-authentik-username", "alice").statusCode(), 404, "the child's concede stays internal");
        assertEquals(delete("carol", id).statusCode(), 403);
        assertEquals(get("/m/" + id + "/img/card/x", "X-authentik-username", "bob").body(), "attached " + id + " /img/card/x");
        assertEquals(stub.lastSeat, 1);
        assertEquals(stub.lastName, "bob");
        get("/m/" + id + "/img/card/x", "X-authentik-username", "alice");
        assertEquals(stub.lastSeat, 0);
        assertEquals(stub.lastName, "alice");
        // A game against the AI: its owner is seat 0.
        final String ai = id(create("carol", "{}"));
        get("/m/" + ai + "/img/card/x", "X-authentik-username", "carol");
        assertEquals(stub.lastSeat, 0);

        // Leaving a game being played: that seat concedes, the game goes on to its end.
        assertEquals(delete("bob", id).statusCode(), 200);
        assertEquals(stub.concessions, List.of(id + ":1"));
        assertTrue(stub.games.containsKey(id), "conceding doesn't end the game at once");
        // No match in progress there (still choosing decks, or over): the game ends.
        stub.concedes = false;
        assertEquals(delete("alice", id).statusCode(), 200);
        assertFalse(stub.games.containsKey(id));
        // Cancelling a game nobody joined ends it.
        final String waiting = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}")).get("id").getAsString();
        assertEquals(delete("alice", waiting).statusCode(), 200);
        assertFalse(stub.games.containsKey(waiting));
        assertEquals(stub.concessions.size(), 2, "only games with two players are conceded");
    }

    /** The per-user cap counts every game you are in, joined ones too. */
    @Test
    public void pvpCapCountsMemberships() throws Exception {
        final Router.Options o = proxied();
        o.maxPerUser = 2;
        router = new Router(o, new StubHost());
        router.start();
        id(create("bob", "{}"));
        final JsonObject g = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        final JsonObject g2 = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"bob-deck\"}").statusCode(), 200);
        assertEquals(create("bob", "{}").statusCode(), 429, "the joined game counts");
        final HttpResponse<String> third = post("bob", "/api/join", "{\"code\":\"" + code(g2) + "\",\"deck\":\"bob-deck\"}");
        assertEquals(third.statusCode(), 429, third.body());
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}").statusCode(), 429);
    }

    /** A pvp game nobody joined is ended after the waiting time; a joined one is not. */
    @Test
    public void pvpWaitingGamesAreReaped() throws Exception {
        final Router.Options o = proxied();
        o.waitingMs = 200;
        o.waitingTickMs = 60_000;
        final StubHost stub = new StubHost();
        router = new Router(o, stub);
        router.start();
        final String lonely = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}")).get("id").getAsString();
        final JsonObject g = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"bob-deck\"}").statusCode(), 200);
        final String ai = id(create("alice", "{}"));
        Thread.sleep(300);
        router.reapWaiting();
        assertFalse(stub.games.containsKey(lonely), "nobody joined: ended");
        assertTrue(stub.games.containsKey(g.get("id").getAsString()));
        assertTrue(stub.games.containsKey(ai));
        router.reapWaiting(); // the ended one is forgotten, not ended twice
        assertTrue(stub.games.containsKey(g.get("id").getAsString()));
    }

    /** GET /api/decks: the shared decks and your own, never another user's. */
    @Test
    public void decksAreYourOwn() throws Exception {
        start(proxied());
        final JsonObject alice = json(get("/api/decks", "X-authentik-username", "alice"));
        assertEquals(alice.getAsJsonArray("decks").toString(), "[\"shared-deck\",\"burn\"]");
        assertEquals(alice.getAsJsonObject("details").toString(),
                "{\"shared-deck\":{\"cards\":20,\"colors\":\"R\",\"key\":\"Lightning Bolt\"}}", "an unreadable deck has no details");
        assertFalse(alice.get("neuralLabel").getAsString().isBlank());
        assertEquals(alice.has("neural"), !forge.bridge.NeuralStatus.pluginInstalled());
        final String bobs = get("/api/decks", "X-authentik-username", "bob").body();
        assertFalse(bobs.contains("burn"), bobs);
        assertTrue(bobs.contains("bob-deck"));
        assertEquals(get("/api/decks").statusCode(), 401);
        assertFalse(alice.get("standardChecked").getAsBoolean(), "a host that can't judge Standard says so");
        assertFalse(json(get("/api/decks?format=brawl", "X-authentik-username", "alice")).has("standardChecked"), "not Brawl's business");
    }

    /** GET /api/decks/cards: a deck's cards by section, for a deck you can play only. */
    @Test
    public void deckCardsAreYourOwn() throws Exception {
        start(proxied());
        final String u = "X-authentik-username";
        final HttpResponse<String> ok = get("/api/decks/cards?name=shared-deck", u, "alice");
        assertEquals(ok.statusCode(), 200, ok.body());
        assertEquals(ok.body(), "{\"sections\":[{\"name\":\"Main\",\"cards\":[{\"n\":4,\"name\":\"Lightning Bolt\",\"type\":\"Instant\",\"cmc\":1,\"cost\":\"{R}\"},"
                + "{\"n\":16,\"name\":\"Mountain\",\"type\":\"Land\",\"cmc\":0,\"cost\":\"\"}]},"
                + "{\"name\":\"Sideboard\",\"cards\":[{\"n\":2,\"name\":\"Shock\"}]}]}", "a card the scripts don't know has no type");
        assertEquals(get("/api/decks/cards?name=burn", u, "bob").statusCode(), 404, "another user's deck");
        assertEquals(get("/api/decks/cards?name=burn", u, "alice").statusCode(), 404, "listed but unreadable");
        assertEquals(get("/api/decks/cards?name=nope", u, "alice").statusCode(), 404);
        assertEquals(get("/api/decks/cards", u, "alice").statusCode(), 404, "no name");
        assertEquals(get("/api/decks/cards?name=shared-deck&format=x", u, "alice").statusCode(), 400);
        assertEquals(get("/api/decks/cards?name=shared-deck").statusCode(), 401);
    }

    /** /join/<code> is the lobby page whatever the code: GET says nothing about codes. */
    @Test
    public void joinLinkServesTheLobby() throws Exception {
        final java.nio.file.Path web = java.nio.file.Files.createTempDirectory("ft-web");
        java.nio.file.Files.writeString(web.resolve("lobby.html"), "<head><p>lobby</p>");
        final Router.Options o = proxied();
        o.webDir = web.toString();
        start(o);
        // the lobby's relative ./assets/ URLs must resolve from / at /join/<code>; / itself needs no base
        assertEquals(get("/", "X-authentik-username", "bob").body(), "<head><p>lobby</p>");
        final String code = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}")).getAsJsonObject("invite").get("url").getAsString();
        final HttpResponse<String> real = get(code.substring(code.indexOf("/join/")), "X-authentik-username", "bob");
        final HttpResponse<String> fake = get("/join/" + "f".repeat(32), "X-authentik-username", "bob");
        assertEquals(real.statusCode(), 200);
        assertEquals(real.body(), "<head><base href=\"/\"><p>lobby</p>");
        assertEquals(fake.statusCode(), 200);
        assertEquals(fake.body(), real.body());
        assertEquals(get("/join/a/b", "X-authentik-username", "bob").statusCode(), 404);
    }

    /** A JPEG's first bytes, so the crop is typed by its content. */
    private static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2, 3};

    private HttpResponse<byte[]> getBytes(final String path, final String... headers) throws Exception {
        return http.send(req(path, headers).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    /**
     * GET /api/art/crop/&lt;name&gt;: a curated crop a game already cached is served with its artist; one the map names
     * but nobody fetched is fetched from the CDN into the same cache first; anything else is 204. The name only keys the
     * curated map: no file outside the art cache is ever served or written.
     */
    @Test
    public void lobbyArtCropsComeFromTheCacheOrTheCdn() throws Exception {
        final Router.Options o = proxied();
        final List<String> fetched = java.util.Collections.synchronizedList(new ArrayList<>());
        o.cropDownload = (url, dest) -> {
            fetched.add(url);
            if (!url.contains("/fetchable.jpg")) {
                return false;
            }
            try {
                java.nio.file.Files.createDirectories(dest.getParent());
                java.nio.file.Files.write(dest, JPEG);
                return true;
            } catch (final java.io.IOException e) {
                return false;
            }
        };
        o.dataDir = java.nio.file.Files.createTempDirectory("ft-router-art");
        final Path table = java.nio.file.Files.createDirectories(o.dataDir.resolve("cache").resolve("table"));
        final Path crop = table.resolve("art/art_crop/front/a/b/bolt.jpg");
        java.nio.file.Files.createDirectories(crop.getParent());
        java.nio.file.Files.write(crop, JPEG);
        final Path scan = table.resolve("art/normal/front/a/b/bolt.jpg");
        java.nio.file.Files.createDirectories(scan.getParent());
        java.nio.file.Files.write(scan, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 9});
        final Path outside = java.nio.file.Files.write(o.dataDir.resolve("secret.jpg"), JPEG);
        java.nio.file.Files.write(table.resolve("secret.jpg"), JPEG);
        java.nio.file.Files.createSymbolicLink(table.resolve("art/art_crop/front/a/b/link.jpg"), outside);
        java.nio.file.Files.createDirectories(table.resolve("art/art_crop/front/e"));
        java.nio.file.Files.createSymbolicLink(table.resolve("art/art_crop/front/e/x"), o.dataDir);
        java.nio.file.Files.createSymbolicLink(table.resolve("art/normal/front/a/b/link.jpg"), outside);
        java.nio.file.Files.createDirectories(table.resolve("art/normal/front/e"));
        java.nio.file.Files.createSymbolicLink(table.resolve("art/normal/front/e/x"), o.dataDir);
        final Path map = forge.bridge.art.CardArtIndex.builtFile(table);
        java.nio.file.Files.writeString(map, "{\"Lightning Bolt\":\"https://cards.scryfall.io/normal/front/a/b/bolt.jpg?1\","
                + "\"Opt\":\"https://cards.scryfall.io/normal/front/c/d/opt.jpg\","
                + "\"Evil\":\"https://cards.scryfall.io/normal/../../secret.jpg\","
                + "\"Linked\":\"https://cards.scryfall.io/normal/front/a/b/link.jpg\","
                + "\"Bad URI\":\"https://cards.scryfall.io/normal/front/a b/bolt.jpg\","
                + "\"Linked Dir\":\"https://cards.scryfall.io/normal/front/e/x/secret.jpg\","
                + "\"Fetchable\":\"https://cards.scryfall.io/normal/front/f/g/fetchable.jpg\","
                + "\"Elsewhere\":\"https://evil.example/normal/front/h/i/elsewhere.jpg\"}");
        java.nio.file.Files.writeString(forge.bridge.art.CardArtIndex.builtArtistsFile(table), "{\"Lightning Bolt\":\"Jérôme Moeller\"}");
        start(o);
        final String u = "X-authentik-username";

        final HttpResponse<byte[]> ok = getBytes("/api/art/crop/Lightning%20Bolt", u, "alice");
        assertEquals(ok.statusCode(), 200);
        assertEquals(ok.body(), JPEG);
        assertEquals(ok.headers().firstValue("content-type").orElse(""), "image/jpeg");
        assertEquals(ok.headers().firstValue("cache-control").orElse(""), "private, max-age=86400");
        assertEquals(ok.headers().firstValue("x-card-artist").orElse(""), "J%C3%A9r%C3%B4me%20Moeller");
        assertEquals(get("/api/art/crop/Lightning%20Bolt%20%2F%2F%20Thunder", u, "alice").statusCode(), 200, "a split card's front");
        assertEquals(get("/api/art/crop/Lightning%20Bolt").statusCode(), 401, "signed-in users only");

        assertEquals(get("/api/art/crop/Opt", u, "alice").statusCode(), 204, "in the map, the fetch failed");
        assertEquals(get("/api/art/crop/Opt", u, "alice").statusCode(), 204, "a failed fetch isn't retried at once");
        assertEquals(fetched, List.of("https://cards.scryfall.io/art_crop/front/c/d/opt.jpg"));
        final HttpResponse<byte[]> got = getBytes("/api/art/crop/Fetchable", u, "alice");
        assertEquals(got.statusCode(), 200, "in the map, fetched on the spot");
        assertEquals(got.body(), JPEG);
        assertTrue(java.nio.file.Files.isRegularFile(table.resolve("art/art_crop/front/f/g/fetchable.jpg")), "where a game would put it");
        assertEquals(get("/api/art/crop/Elsewhere", u, "alice").statusCode(), 204, "only Scryfall's CDN");
        assertEquals(get("/api/art/crop/Nope", u, "alice").statusCode(), 204, "not in the map");
        assertEquals(get("/api/art/crop/Evil", u, "alice").statusCode(), 204, "a map URL with .. never leaves the art cache");
        assertEquals(get("/api/art/crop/Linked", u, "alice").statusCode(), 204, "a link out of the art cache");
        for (final String bad : new String[] {"..%2Fsecret.jpg", "..%2F..%2Fsecret.jpg", "a%5Cb", "%00", "x%0Ay", ""}) {
            assertEquals(get("/api/art/crop/" + bad, u, "alice").statusCode(), 400, bad);
        }
        final HttpResponse<byte[]> head = http.send(req("/api/art/crop/Lightning%20Bolt", u, "alice")
                .method("HEAD", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(head.statusCode(), 200);
        assertEquals(head.body().length, 0, "HEAD: no body");
        assertEquals(head.headers().firstValue("content-type").orElse(""), "image/jpeg");
        assertEquals(get("/api/art/crop/Bad%20URI", u, "alice").statusCode(), 204, "a map URL that is not a URI");
        assertEquals(get("/api/art/crop/Linked%20Dir", u, "alice").statusCode(), 204, "a linked folder out of the art cache");
        assertFalse(fetched.stream().anyMatch(f -> f.contains("link.jpg") || f.contains("/e/x/") || f.contains("evil.example")),
                "never fetched over a link, or off the CDN: " + fetched);
        assertFalse(java.nio.file.Files.exists(o.dataDir.resolve("secret.jpg").resolveSibling("fetchable.jpg")));

        // the whole card: the map's own scan, cached or fetched the same way
        final HttpResponse<byte[]> card = getBytes("/api/art/card/Lightning%20Bolt", u, "alice");
        assertEquals(card.statusCode(), 200);
        assertEquals(card.body()[4], 9, "the scan, not the crop");
        assertEquals(card.headers().firstValue("x-card-artist").orElse(""), "J%C3%A9r%C3%B4me%20Moeller");
        assertEquals(getBytes("/api/art/card/Fetchable", u, "alice").statusCode(), 200, "fetched on the spot");
        assertTrue(fetched.contains("https://cards.scryfall.io/normal/front/f/g/fetchable.jpg"), fetched.toString());
        assertTrue(java.nio.file.Files.isRegularFile(table.resolve("art/normal/front/f/g/fetchable.jpg")), "where a game would put it");
        for (final String none : new String[] {"Evil", "Elsewhere", "Nope", "Linked", "Linked%20Dir", "Bad%20URI"}) {
            assertEquals(get("/api/art/card/" + none, u, "alice").statusCode(), 204, none);
        }
        for (final String bad : new String[] {"..%2Fsecret.jpg", "..%2F..%2Fsecret.jpg", "a%5Cb", "%00", "x%0Ay", ""}) {
            assertEquals(get("/api/art/card/" + bad, u, "alice").statusCode(), 400, bad);
        }
        assertEquals(get("/api/art/card/Lightning%20Bolt").statusCode(), 401);
        final HttpResponse<byte[]> cardHead = http.send(req("/api/art/card/Lightning%20Bolt", u, "alice")
                .method("HEAD", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(cardHead.statusCode(), 200);
        assertEquals(cardHead.body().length, 0, "HEAD: no body");
        assertFalse(fetched.stream().anyMatch(f -> f.contains("link.jpg") || f.contains("/e/x/") || f.contains("evil.example")),
                "the card route never fetched over a link, or off the CDN: " + fetched);

        // a game rebuilt the map: re-read
        java.nio.file.Files.createDirectories(table.resolve("art/art_crop/front/c/d"));
        java.nio.file.Files.write(table.resolve("art/art_crop/front/c/d/opt.jpg"), JPEG);
        java.nio.file.Files.writeString(map, "{\"Opt\":\"https://cards.scryfall.io/normal/front/c/d/opt.jpg\"}");
        java.nio.file.Files.setLastModifiedTime(map, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 60_000));
        final HttpResponse<String> opt = get("/api/art/crop/Opt", u, "alice");
        assertEquals(opt.statusCode(), 200);
        assertEquals(opt.headers().firstValue("x-card-artist").orElse(null), null, "no artist known");
        assertEquals(get("/api/art/crop/Lightning%20Bolt", u, "alice").statusCode(), 204, "dropped from the new map");

        // no map at all: 204
        java.nio.file.Files.delete(map);
        assertEquals(get("/api/art/crop/Opt", u, "alice").statusCode(), 204);
    }

    /** The games' art mode decides: curated by default, none when off (or --test-prefs), the operator's map when given. */
    @Test
    public void lobbyArtFollowsTheGamesArtMode() {
        final Router.Options o = proxied();
        assertTrue(Router.cachedCrops(o) != null);
        o.child.childArgs.addAll(List.of("--card-art", "off"));
        assertEquals(Router.cachedCrops(o), null);
        o.child.childArgs.clear();
        o.child.childArgs.add("--test-prefs");
        assertEquals(Router.cachedCrops(o), null);
        o.child.childArgs.addAll(List.of("--card-art", "curated", "--card-image-map", "map.json"));
        assertTrue(Router.cachedCrops(o) != null);
    }

    /** --fonts serves the Framed face's allowlisted font names from its folder, typed and cacheable; anything else is a 404. */
    @Test
    public void fontsServesOnlyItsAllowlist() throws Exception {
        final java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("ft-fonts");
        java.nio.file.Files.write(dir.resolve("beleren.ttf"), new byte[] {0, 1, 0, 0});
        java.nio.file.Files.write(dir.resolve("mplantin.woff"), new byte[] {'w', 'O', 'F', 'F'});
        java.nio.file.Files.writeString(dir.resolve("notes.txt"), "secret");
        java.nio.file.Files.writeString(dir.getParent().resolve("ft-fonts-outside.ttf"), "outside");
        // flag > FT_FONTS; blank means none; a missing folder is refused
        assertEquals(Router.parseArgs(Router.withDefaults(new String[0], Map.of("FT_FONTS", dir.toString()))).fontsDir, dir);
        assertEquals(Router.parseArgs(Router.withDefaults(new String[] {"--fonts", dir.toString()}, Map.of("FT_FONTS", "/elsewhere"))).fontsDir, dir);
        assertEquals(Router.parseArgs(Router.withDefaults(new String[0], Map.of("FT_FONTS", " "))).fontsDir, null);
        expectThrows(IllegalArgumentException.class, () -> Router.parseArgs(new String[] {"--fonts", "/nonexistent/ft-fonts"}));

        final Router.Options o = proxied();
        o.fontsDir = dir;
        start(o);
        final HttpResponse<byte[]> ttf = getBytes("/fonts/beleren.ttf", "X-authentik-username", "alice");
        assertEquals(ttf.statusCode(), 200);
        assertEquals(ttf.headers().firstValue("Content-Type").orElse(""), "font/ttf");
        assertTrue(ttf.headers().firstValue("Cache-Control").orElse("").contains("max-age="));
        assertEquals(ttf.body(), new byte[] {0, 1, 0, 0});
        assertEquals(get("/fonts/mplantin.woff", "X-authentik-username", "alice").headers().firstValue("Content-Type").orElse(""), "font/woff");
        // behind the proxy, a login as for the bundle; under a game's base, any signed-in user
        assertEquals(get("/fonts/beleren.ttf").statusCode(), 401);
        final String id = id(create("alice", "{}"));
        assertEquals(get("/m/" + id + "/fonts/beleren.ttf", "X-authentik-username", "bob").statusCode(), 200);
        // allowlisted but absent; not allowlisted; traversal; no listing
        assertEquals(get("/fonts/beleren.woff2", "X-authentik-username", "alice").statusCode(), 404);
        assertEquals(get("/fonts/notes.txt", "X-authentik-username", "alice").statusCode(), 404);
        assertEquals(get("/fonts/..%2Fft-fonts-outside.ttf", "X-authentik-username", "alice").statusCode(), 404);
        assertEquals(get("/fonts/../ft-fonts-outside.ttf", "X-authentik-username", "alice").statusCode(), 404);
        assertFalse(get("/m/" + id + "/fonts/../../ft-fonts-outside.ttf", "X-authentik-username", "alice").statusCode() == 200);
        assertEquals(get("/fonts/", "X-authentik-username", "alice").statusCode(), 404);
        router.stop();

        // no --fonts: every name is a 404 (the client falls back to its bundled fonts)
        start(proxied());
        assertEquals(get("/fonts/beleren.ttf", "X-authentik-username", "alice").statusCode(), 404);
    }

    @Test
    public void deckRecordsMatchAFilesNameByItsSlug() {
        assertEquals(Router.deckSlug("Mono Red Madness"), "mono-red-madness");
        assertEquals(Router.deckSlug("  Izzet  Phoenix (v2)! "), "izzet-phoenix-v2");
        assertEquals(Router.deckSlug("mono-red-madness"), "mono-red-madness");
    }

    /** GET /api/neural/avatar: the Neural AI's picture for signed-in users, advertised in /api/decks; 404 when there is none. */
    @Test
    public void neuralAvatar() throws Exception {
        start(proxied());
        final String u = "X-authentik-username";
        assertEquals(get("/api/neural/avatar", u, "alice").statusCode(), 404);
        assertFalse(json(get("/api/decks", u, "alice")).has("neuralAvatar"));
        final byte[] webp = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'E', 'B', 'P', 'V', 'P', '8', ' '};
        final Path file = java.nio.file.Files.write(java.nio.file.Files.createTempFile("avatar", ".png"), webp);
        System.setProperty("forge.table.neuralAvatar", file.toString());
        try {
            assertEquals(get("/api/neural/avatar").statusCode(), 401, "signed-in users only");
            final HttpResponse<byte[]> r = getBytes("/api/neural/avatar", u, "alice");
            assertEquals(r.statusCode(), 200);
            assertEquals(r.body(), webp);
            assertEquals(r.headers().firstValue("content-type").orElse(""), "image/webp", "typed by its bytes, not its name");
            assertEquals(r.headers().firstValue("x-content-type-options").orElse(""), "nosniff");
            assertEquals(r.headers().firstValue("cache-control").orElse(""), "private, max-age=3600");
            assertTrue(json(get("/api/decks", u, "alice")).get("neuralAvatar").getAsBoolean());
        } finally {
            System.clearProperty("forge.table.neuralAvatar");
        }
    }

    /**
     * GET /api/neural/avatar from the model's {@code avatar_card}: the card's art crop (cached, or fetched from the CDN
     * on the first ask), advertised in /api/decks; a file beats it, card art off or a failed fetch is 404.
     */
    @Test
    public void neuralAvatarFromACard() throws Exception {
        final String u = "X-authentik-username";
        final java.nio.file.Path model = java.nio.file.Files.createTempDirectory("ft-neural-model");
        java.nio.file.Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Lyra Dawnbringer|DOM\"}");
        final Router.Options o = proxied();
        final List<String> fetched = java.util.Collections.synchronizedList(new ArrayList<>());
        o.cropDownload = (url, dest) -> {
            fetched.add(url);
            try {
                java.nio.file.Files.createDirectories(dest.getParent());
                java.nio.file.Files.write(dest, JPEG);
                return true;
            } catch (final java.io.IOException e) {
                return false;
            }
        };
        o.dataDir = java.nio.file.Files.createTempDirectory("ft-router-avatar");
        final Path table = java.nio.file.Files.createDirectories(o.dataDir.resolve("cache").resolve("table"));
        java.nio.file.Files.writeString(forge.bridge.art.CardArtIndex.builtFile(table),
                "{\"Lyra Dawnbringer\":\"https://cards.scryfall.io/normal/front/l/y/lyra.jpg?1\"}");
        System.setProperty("mtgai.neural.dir", model.toString());
        try {
            start(o);
            assertTrue(json(get("/api/decks", u, "alice")).get("neuralAvatar").getAsBoolean(), "set before the crop is fetched");
            assertEquals(get("/api/neural/avatar").statusCode(), 401, "signed-in users only");
            final HttpResponse<byte[]> r = getBytes("/api/neural/avatar", u, "alice");
            assertEquals(r.statusCode(), 200);
            assertEquals(r.body(), JPEG);
            assertEquals(r.headers().firstValue("content-type").orElse(""), "image/jpeg");
            assertEquals(fetched, List.of("https://cards.scryfall.io/art_crop/front/l/y/lyra.jpg?1"), "the name alone keys the map");
            assertEquals(getBytes("/api/neural/avatar", u, "alice").statusCode(), 200);
            assertEquals(fetched.size(), 1, "the second ask is a cache hit");
            // A picture file wins.
            final byte[] webp = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'E', 'B', 'P', 'V', 'P', '8', ' '};
            java.nio.file.Files.write(model.resolve("avatar.webp"), webp);
            assertEquals(getBytes("/api/neural/avatar", u, "alice").body(), webp);
            java.nio.file.Files.delete(model.resolve("avatar.webp"));
            // No card in the map, or one that can't be fetched: none.
            java.nio.file.Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Nope\"}");
            assertEquals(get("/api/neural/avatar", u, "alice").statusCode(), 404);
            router.stop();
            // Card art off: none, and not advertised.
            o.child.childArgs.addAll(List.of("--card-art", "off"));
            java.nio.file.Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Lyra Dawnbringer\"}");
            start(o);
            assertEquals(get("/api/neural/avatar", u, "alice").statusCode(), 404);
            assertFalse(json(get("/api/decks", u, "alice")).has("neuralAvatar"));
            assertEquals(fetched.size(), 1, "nothing fetched with card art off");
        } finally {
            System.clearProperty("mtgai.neural.dir");
        }
    }
}

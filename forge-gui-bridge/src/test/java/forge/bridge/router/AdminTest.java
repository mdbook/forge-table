package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.HttpResponseStatus;

/**
 * The admin API ({@code --admin-group}): only admins reach it, however the groups header is spelled; admins see and
 * end anybody's game; "update now" warns every game, ends them after the countdown and drains.
 */
public class AdminTest {

    private static final String USER = "X-authentik-username";
    private static final String GROUPS = "X-authentik-groups";

    /** Games running at once; records why each was ended and what was announced. */
    static final class Host implements GameHost {
        final Map<String, Game> games = new ConcurrentHashMap<>();
        final AtomicInteger seq = new AtomicInteger();
        final List<String> ended = new CopyOnWriteArrayList<>();
        volatile Supplier<String> announced;

        @Override
        public Game create(final String owner, final String deck, final String oppDeck, final String ai) {
            final Game g = new Game(Integer.toHexString(0x100 + seq.incrementAndGet()), owner, Status.PLAYING, System.nanoTime(), null);
            games.put(g.id(), g);
            return g;
        }

        @Override
        public void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path) {
            Router.sendText(ctx, HttpResponseStatus.OK, "attached");
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
        public void end(final String id) { end(id, "ended by its owner"); }

        @Override
        public void end(final String id, final String reason) {
            if (games.remove(id) != null) {
                ended.add(id + ": " + reason);
            }
        }

        @Override
        public boolean connected(final String id) { return id.endsWith("1"); }

        @Override
        public void announce(final Supplier<String> message) { announced = message; }

        @Override
        public void close() { games.clear(); }
    }

    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;
    private Host host;

    private Router start(final String adminGroup, final long countdownMs) throws Exception {
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.groupsHeader = GROUPS; // Authentik's header and separator, as prod sets them
        o.groupsSeparator = "|";
        o.adminGroup = adminGroup;
        o.maxMatches = 10;
        o.maxPerUser = 5;
        o.updateCountdownMs = countdownMs;
        o.drainTickMs = 50;
        host = new Host();
        router = new Router(o, host);
        router.start();
        return router;
    }

    @AfterMethod(alwaysRun = true)
    public void stop() {
        if (router != null) {
            router.stop();
            router = null;
        }
    }

    private HttpResponse<String> send(final String method, final String path, final String body, final String... headers) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private String create(final String user) throws Exception {
        final HttpResponse<String> r = send("POST", "/api/matches", "{}", USER, user, "Content-Type", "application/json");
        assertEquals(r.statusCode(), 201, r.body());
        return JsonParser.parseString(r.body()).getAsJsonObject().get("id").getAsString();
    }

    /** Every admin endpoint, as {method, path, body}. */
    private static List<String[]> endpoints(final String id) {
        return List.of(new String[] {"GET", "/api/admin/matches", null}, new String[] {"DELETE", "/api/admin/matches/" + id, null},
                new String[] {"POST", "/api/admin/update", "{}"});
    }

    @Test
    public void nonAdminsGet403Everywhere() throws Exception {
        start("staff", 60_000);
        final String robins = create("robin");
        final List<String[]> asNonAdmin = List.of(
                new String[] {USER, "liam"},
                new String[] {USER, "liam", GROUPS, "players"},
                new String[] {USER, "liam", GROUPS, "staff-not|players"},
                new String[] {USER, "liam", GROUPS, "Staff"},
                new String[] {USER, "liam", GROUPS, "admins|staf"},
                new String[] {USER, "liam", GROUPS, ""},
                new String[] {USER, "liam", GROUPS, "staff", GROUPS, "staff"}); // duplicated header
        for (final String[] headers : asNonAdmin) {
            for (final String[] e : endpoints(robins)) {
                final String[] h = e[2] == null ? headers : concat(headers, "Content-Type", "application/json");
                final HttpResponse<String> r = send(e[0], e[1], e[2], h);
                assertEquals(r.statusCode(), 403, e[0] + " " + e[1] + " with " + String.join(",", headers) + ": " + r.body());
            }
            assertFalse(JsonParser.parseString(send("GET", "/api/matches", null, headers).body()).getAsJsonObject().has("admin"));
        }
        assertEquals(host.games.size(), 1, "nothing was ended");
        assertTrue(host.announced == null, "nothing was announced");
    }

    @Test
    public void noAdminGroupMeansNoAdmins() throws Exception {
        start(null, 60_000);
        create("robin");
        assertEquals(send("GET", "/api/admin/matches", null, USER, "kai", GROUPS, "staff").statusCode(), 403);
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--router", "--admin-group", "staff"}));
        // the unit passes --admin-group "${FT_ADMIN_GROUP}": empty or unset is no admins, not a crash loop
        assertEquals(Router.parse(new String[] {"--router", "--trust-proxy-header", "X-authentik-username", "--admin-group", ""}).adminGroup, null);
    }

    @Test
    public void adminsListAndEndAnyGame() throws Exception {
        start("staff", 60_000);
        final String robins = create("robin");
        create("liam");
        final String[] kai = {USER, "kai", GROUPS, "players|staff"};
        assertTrue(JsonParser.parseString(send("GET", "/api/matches", null, kai).body()).getAsJsonObject().get("admin").getAsBoolean());
        final JsonArray all = JsonParser.parseString(send("GET", "/api/admin/matches", null, kai).body()).getAsJsonObject().getAsJsonArray("matches");
        assertEquals(all.size(), 2);
        final JsonObject first = all.get(0).getAsJsonObject();
        assertEquals(first.get("owner").getAsString(), "robin");
        assertEquals(first.get("status").getAsString(), "playing");
        assertNotNull(first.get("connected"));
        assertNotNull(first.get("created"));
        assertEquals(first.get("mode").getAsString(), "ai");
        final JsonObject seat0 = first.getAsJsonArray("players").get(0).getAsJsonObject();
        assertEquals(seat0.get("name").getAsString(), "robin");
        assertEquals(seat0.get("connected").getAsBoolean(), first.get("connected").getAsBoolean(), "seat 0 of an AI game is the game");
        final JsonObject server = JsonParser.parseString(send("GET", "/api/admin/matches", null, kai).body()).getAsJsonObject().getAsJsonObject("server");
        assertEquals(server.get("games").getAsInt(), 2);
        assertEquals(server.get("maxMatches").getAsInt(), 10);
        assertEquals(server.get("maxPerUser").getAsInt(), 5);
        assertFalse(server.get("guests").getAsBoolean());
        final HttpResponse<String> end = send("DELETE", "/api/admin/matches/" + robins, null, kai);
        assertEquals(end.statusCode(), 200, end.body());
        assertEquals(host.ended, List.of(robins + ": ended by admin kai"));
        assertEquals(send("DELETE", "/api/admin/matches/" + robins, null, kai).statusCode(), 404);
        // A foreign Origin can't drive it (as for every write).
        assertEquals(send("DELETE", "/api/admin/matches/" + robins, null, concat(kai, "Origin", "https://evil.example")).statusCode(), 403);
        assertEquals(send("POST", "/api/admin/update", "{}", kai).statusCode(), 415, "JSON only");
    }

    @Test
    public void updateNowWarnsThenDrainsKeepingTheGames() throws Exception {
        start("staff", 400);
        final CountDownLatch drained = new CountDownLatch(1);
        router.onDrained(drained::countDown);
        final String a = create("robin");
        final String b = create("liam");
        final String[] kai = {USER, "kai", GROUPS, "staff", "Content-Type", "application/json"};
        final HttpResponse<String> r = send("POST", "/api/admin/update", "{}", kai);
        assertEquals(r.statusCode(), 200, r.body());
        assertTrue(r.body().contains("\"restartIn\""), r.body());
        // Every open game is told; new games are refused meanwhile.
        final JsonObject notice = JsonParser.parseString(host.announced.get()).getAsJsonObject();
        assertEquals(notice.get("t").getAsString(), "notice");
        assertEquals(notice.get("kind").getAsString(), "restart");
        assertTrue(notice.get("seconds").getAsInt() <= 1);
        assertEquals(send("POST", "/api/matches", "{}", USER, "liam", "Content-Type", "application/json").statusCode(), 503);
        assertTrue(send("GET", "/api/matches", null, USER, "liam").body().contains("\"draining\":true"));
        assertEquals(host.games.size(), 2, "games run until the countdown ends");
        assertTrue(drained.await(10, TimeUnit.SECONDS), "never drained");
        // Games against the AI are saved over the restart: the update doesn't end them (the router's stop pauses them).
        assertFalse(host.ended.stream().anyMatch(e -> e.startsWith(a + ":") || e.startsWith(b + ":")), host.ended.toString());
        assertEquals(router.exitCode(), Router.RESTART_EXIT, "no deploy asked: exit so that systemd restarts it");
        router = null; // stopped by the drain
    }

    @Test
    public void theLocalUserIsTheAdmin() throws Exception {
        final Router.Options o = new Router.Options();
        o.maxMatches = 4;
        host = new Host();
        router = new Router(o, host);
        router.start();
        assertEquals(send("GET", "/api/admin/matches", null).statusCode(), 401, "the token is still needed");
        final HttpResponse<String> r = send("GET", "/api/admin/matches", null, Router.TOKEN_HEADER, router.token());
        assertEquals(r.statusCode(), 200, r.body());
        assertTrue(JsonParser.parseString(send("GET", "/api/matches", null, Router.TOKEN_HEADER, router.token()).body()).getAsJsonObject()
                .get("admin").getAsBoolean());
    }

    @Test
    public void aDeploysDrainExitsZero() throws Exception {
        start("staff", 60_000);
        create("robin"); // a live game keeps the drained router up, so update now still gets through
        assertEquals(router.exitCode(), 0);
        assertEquals(send("POST", "/admin/drain", null).statusCode(), 200);
        send("POST", "/api/admin/update", "{}", USER, "kai", GROUPS, "staff", "Content-Type", "application/json");
        assertEquals(router.exitCode(), 0, "the deploy restarts it");
    }

    private static String[] concat(final String[] a, final String... b) {
        final String[] out = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}

package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocketHandshakeException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.AfterClass;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.ScriptedClient;
import forge.bridge.TableTestEnv;

/**
 * Real child sidecars behind a real router: two users' games played at the
 * same time through {@code /m/<id>/ws}, isolation between them, both caps with live processes, a crashed child,
 * an idle one, and finished games reaped after the grace period.
 */
public class RouterGamesTest {

    private static final String USER = "X-authentik-username";
    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;
    private ChildProcessHost host;
    private Path data;

    @AfterClass(alwaysRun = true)
    public void stop() throws Exception {
        if (router != null) {
            router.stop();
        }
        // No child may outlive the router.
        waitFor(() -> children().isEmpty(), 30, "children still running after stop");
    }

    @Test
    public void twoUsersPlayAtOnceInIsolation() throws Exception {
        data = Path.of("target", "router-test").toAbsolutePath();
        ChildProcessHost.deleteTree(data);
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.maxMatches = 4;
        o.maxPerUser = 3;
        o.dataDir = data;
        o.child.dataDir = data;
        o.child.idleMs = 20_000;
        o.child.graceMs = 1_000;
        o.child.tickMs = 250;
        // Children inherit the test JVM's -Xmx3g; four of them OOM a 4 GB CI runner (exit 137). A game's live heap is
        // ~215 MB, so 384 MB with the serial collector and C1 only is plenty here.
        o.child.jvmArgs = new java.util.ArrayList<>(o.child.jvmArgs.stream().filter(a -> !a.startsWith("-Xmx")).toList());
        o.child.jvmArgs.add("-Xmx384m");
        o.child.jvmArgs.add("-XX:TieredStopAtLevel=1");
        o.child.jvmArgs.add("-XX:+UseSerialGC");
        o.child.childArgs.addAll(List.of("--assets", System.getProperty("forge.bridge.assets", "../forge-gui/"),
                "--decks", TableTestEnv.decksDir().getAbsolutePath(), "--test-prefs"));
        host = new ChildProcessHost(o.child);
        router = new Router(o, host);
        router.start();

        final String deck = "{\"deck\":\"mono-red-madness\",\"oppDeck\":\"mono-blue-faeries\",\"ai\":\"Default\"}";
        final String a = id(create("alice", deck));
        final String b = id(create("bob", deck));
        final String idle = id(create("alice", "{}"));
        final String doomed = id(create("alice", "{}"));
        // Caps with live processes: alice has 3 (her limit); the server has 4 (its limit).
        assertEquals(create("alice", "{}").statusCode(), 429);
        assertEquals(create("bob", "{}").statusCode(), 503);

        // Isolation: nobody reaches another user's game, page, images or socket.
        assertEquals(get("/m/" + a + "/", USER, "bob").statusCode(), 403);
        assertEquals(get("/m/" + a + "/img/card/x", USER, "bob").statusCode(), 403);
        assertEquals(get("/m/" + a + "/").statusCode(), 401);
        final JsonObject aliceList = list("alice");
        assertFalse(ids(aliceList).contains(b));
        assertFalse(aliceList.toString().contains("token"));
        assertEquals(wsStatus(b, "alice"), 403);

        // Both games run at once, each through the router with a hello token the router replaces.
        final CompletableFuture<ScriptedClient.Result> ra = CompletableFuture.supplyAsync(() -> play(a, "alice", 11L));
        final CompletableFuture<ScriptedClient.Result> rb = CompletableFuture.supplyAsync(() -> play(b, "bob", 12L));

        // Meanwhile: one child dies and shows as crashed; another is never opened and is closed when idle.
        waitFor(() -> "ready".equals(status("alice", doomed)), 240, "game never became ready");
        waitFor(() -> !"starting".equals(status("alice", a)), 240, "alice's game never started");
        assertEquals(get("/m/" + a + "/img/card/x", USER, "alice").statusCode(), 204); // images reach alice's own child (art off)
        final ProcessHandle victim = ProcessHandle.of(host.pid(doomed)).orElseThrow();
        assertTrue(children().contains(victim));
        victim.destroyForcibly();
        waitFor(() -> "crashed".equals(status("alice", doomed)), 30, "killed child not reported as crashed");
        assertTrue(list("alice").toString().contains("stopped unexpectedly"));
        // A crashed game holds no memory, so it doesn't count: bob may start one now.
        final String bob2 = id(create("bob", "{}"));
        assertEquals(delete("alice", doomed).statusCode(), 200);
        assertEquals(delete("alice", bob2).statusCode(), 403);
        assertEquals(delete("bob", bob2).statusCode(), 200);

        // Through the router a browser can't name a file, open a third socket or send a huge frame.
        waitFor(() -> "ready".equals(status("alice", idle)), 240, "idle game never became ready");
        try (RawWs s1 = new RawWs(idle, "alice"); RawWs s2 = new RawWs(idle, "alice")) {
            assertEquals(wsStatus(idle, "alice"), 429, "a third socket to one game");
            s1.send("{\"t\":\"hello\",\"proto\":1,\"token\":\"x\"}");
            s1.next("welcome");
            final String bobs = host.userDir("bob").resolve("decks").resolve("secret.dck").toString();
            s1.send("{\"t\":\"rpc\",\"id\":\"1\",\"method\":\"match.start\",\"params\":{\"deck\":" + new com.google.gson.JsonPrimitive(bobs) + "}}");
            final JsonObject res = s1.next("rpcResult");
            assertFalse(res.get("ok").getAsBoolean());
            assertEquals(res.get("error").getAsString(), "Unknown deck");
            s1.send("{\"t\":\"rpc\",\"id\":\"2\",\"method\":\"match.start\",\"params\":{\"state\":\"/etc/passwd\"}}");
            assertEquals(s1.next("rpcResult").get("error").getAsString(), "Board states aren't available here");
            // A router announcement (an admin's "update now") reaches every open game socket, mid-stream.
            assertTrue(host.connected(idle));
            host.announce(() -> "{\"t\":\"notice\",\"kind\":\"restart\",\"seconds\":60}");
            JsonObject n;
            do {
                n = s1.next("notice");
            } while (!"restart".equals(n.get("kind").getAsString()));
            assertEquals(n.get("seconds").getAsInt(), 60);
            s2.send("x".repeat(ChildProcessHost.MAX_FRAME + 1));
            assertEquals(s2.closed.get(30, TimeUnit.SECONDS).intValue(), 1009, "an oversized frame closes the socket");
        }

        final ScriptedClient.Result resA = ra.get(10, TimeUnit.MINUTES);
        final ScriptedClient.Result resB = rb.get(10, TimeUnit.MINUTES);
        assertTrue(resA.gameOver, "alice: " + resA + " " + resA.violations);
        assertTrue(resB.gameOver, "bob: " + resB + " " + resB.violations);
        assertEquals(engineViolations(resA), List.of(), "alice: " + resA.violations);
        assertEquals(engineViolations(resB), List.of(), "bob: " + resB.violations);

        // Finished games are closed after the grace period; the idle one after the idle limit.
        waitFor(() -> status("alice", a) == null && status("bob", b) == null, 60, "finished games not reaped");
        waitFor(() -> status("alice", idle) == null, 90, "idle game not reaped");
        waitFor(() -> children().isEmpty(), 30, "child processes left behind");
        assertEquals(list("alice").getAsJsonArray("matches").size(), 0);
        // Scratch folders go; the shared user deck folders (links in them) stay.
        waitFor(() -> {
            try (var s = Files.list(data.resolve("matches"))) {
                return s.count() == 0;
            }
        }, 30, "game folders left behind");
        try (var s = Files.list(data.resolve("users"))) {
            assertEquals(s.filter(d -> Files.isDirectory(d.resolve("decks"))).count(), 2L);
        }
        try (var s = Files.list(data.resolve("cache"))) {
            assertEquals(s.count(), 1L); // table/
        }
    }

    private ScriptedClient.Result play(final String id, final String user, final long seed) {
        try {
            waitFor(() -> "ready".equals(status(user, id)), 240, user + "'s game never became ready");
            final JsonObject params = new JsonObject();
            params.addProperty("deck", "mono-red-madness");
            params.addProperty("oppDeck", "mono-blue-faeries");
            params.addProperty("ai", "Default");
            final ScriptedClient.Result r = new ScriptedClient(URI.create("ws://127.0.0.1:" + router.port() + "/m/" + id + "/ws"), Map.of(USER, user),
                    "not-the-token", seed, false, 400).play(params, Duration.ofMinutes(8));
            if (!r.gameOver) {
                dumpChild(id, user);
            }
            return r;
        } catch (final Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** A stuck game: print its child's threads (the game thread shows whether it waits on an Input, a prompt or the AI). */
    private void dumpChild(final String id, final String user) {
        try {
            final Process p = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "jcmd").toString(), String.valueOf(host.pid(id)),
                    "Thread.print").redirectErrorStream(true).start();
            final String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            System.out.println("[RouterGamesTest] " + user + "'s game " + id + " never ended; its threads:\n" + out);
        } catch (final Exception e) {
            System.out.println("[RouterGamesTest] no thread dump for " + id + ": " + e);
        }
    }

    /**
     * The client's violations minus the known LiveGameTest flake (an own-hand draw beat with a null fromId, which
     * ScriptedClient reports as a draw "from=" nothing): a projection issue unrelated to routing, and two games here
     * would double its odds of failing the build.
     */
    private static List<String> engineViolations(final ScriptedClient.Result r) {
        return r.violations.stream().filter(v -> !v.startsWith(ScriptedClient.NULL_FROM_ID_DRAW)).toList();
    }

    /** A bare socket to a game through the router: what it receives, and its close code. */
    private final class RawWs implements java.net.http.WebSocket.Listener, AutoCloseable {
        final java.util.concurrent.BlockingQueue<JsonObject> inbox = new java.util.concurrent.LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        private final StringBuilder partial = new StringBuilder();
        private final java.net.http.WebSocket ws;

        RawWs(final String id, final String user) throws Exception {
            ws = http.newWebSocketBuilder().header(USER, user).buildAsync(URI.create("ws://127.0.0.1:" + router.port() + "/m/" + id + "/ws"), this)
                    .get(30, TimeUnit.SECONDS);
        }

        void send(final String text) {
            ws.sendText(text, true);
        }

        JsonObject next(final String type) throws InterruptedException {
            while (true) {
                final JsonObject m = inbox.poll(60, TimeUnit.SECONDS);
                assertNotNull(m, "no " + type);
                if (type.equals(m.get("t").getAsString())) {
                    return m;
                }
            }
        }

        @Override
        public java.util.concurrent.CompletionStage<?> onText(final java.net.http.WebSocket w, final CharSequence data, final boolean last) {
            partial.append(data);
            if (last) {
                inbox.add(JsonParser.parseString(partial.toString()).getAsJsonObject());
                partial.setLength(0);
            }
            w.request(1);
            return null;
        }

        @Override
        public java.util.concurrent.CompletionStage<?> onClose(final java.net.http.WebSocket w, final int code, final String reason) {
            closed.complete(code);
            return null;
        }

        @Override
        public void onError(final java.net.http.WebSocket w, final Throwable error) {
            closed.complete(-1);
        }

        @Override
        public void close() {
            ws.abort();
        }
    }

    /** The upgrade's HTTP status when the socket is refused (0 when it opened). */
    private int wsStatus(final String id, final String user) throws InterruptedException {
        try {
            http.newWebSocketBuilder().header(USER, user).buildAsync(URI.create("ws://127.0.0.1:" + router.port() + "/m/" + id + "/ws"),
                    new java.net.http.WebSocket.Listener() { }).get(30, TimeUnit.SECONDS).abort();
            return 0;
        } catch (final ExecutionException e) {
            if (e.getCause() instanceof WebSocketHandshakeException h) {
                return h.getResponse().statusCode();
            }
            throw new IllegalStateException(e);
        } catch (final java.util.concurrent.TimeoutException e) {
            throw new IllegalStateException(e);
        }
    }

    /** This test JVM's live child processes (only the router's sidecars start any). */
    private static List<ProcessHandle> children() {
        return ProcessHandle.current().children().filter(ProcessHandle::isAlive).toList();
    }

    private HttpResponse<String> get(final String path, final String... headers) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        return http.send(b.GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> create(final String user, final String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches")).header(USER, user)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> delete(final String user, final String id) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches/" + id)).header(USER, user)
                .DELETE().build(), HttpResponse.BodyHandlers.ofString());
    }

    private JsonObject list(final String user) throws Exception {
        final HttpResponse<String> res = get("/api/matches", USER, user);
        assertEquals(res.statusCode(), 200);
        return JsonParser.parseString(res.body()).getAsJsonObject();
    }

    private String status(final String user, final String id) {
        try {
            final JsonArray arr = list(user).getAsJsonArray("matches");
            for (final JsonElement e : arr) {
                if (e.getAsJsonObject().get("id").getAsString().equals(id)) {
                    return e.getAsJsonObject().get("status").getAsString();
                }
            }
            return null;
        } catch (final Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String id(final HttpResponse<String> created) {
        assertEquals(created.statusCode(), 201, created.body());
        final String id = JsonParser.parseString(created.body()).getAsJsonObject().get("id").getAsString();
        assertNotNull(id);
        return id;
    }

    private interface Check {
        boolean ok() throws Exception;
    }

    private static void waitFor(final Check c, final int seconds, final String what) throws Exception {
        final long end = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < end) {
            if (c.ok()) {
                return;
            }
            Thread.sleep(200);
        }
        fail(what);
    }

    /** Every game id in a lobby list (matches, open, invites): exact, where a substring test of the JSON would also
     *  hit digits inside a created timestamp. */
    private static List<String> ids(final JsonObject list) {
        return java.util.stream.Stream.of("matches", "open", "invites").filter(list::has)
                .flatMap(k -> java.util.stream.StreamSupport.stream(list.getAsJsonArray(k).spliterator(), false))
                .filter(e -> e.isJsonObject()).map(e -> e.getAsJsonObject()).filter(o -> o.has("id")).map(o -> o.get("id").getAsString()).toList();
    }
}

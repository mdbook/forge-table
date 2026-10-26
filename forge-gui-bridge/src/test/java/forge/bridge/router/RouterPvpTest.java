package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.AfterClass;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import forge.bridge.ScriptedClient;
import forge.bridge.TableTestEnv;

/**
 * A game between two people end to end: a real router and one real child. Alice starts it, Bob joins by the invite
 * code with a shared deck (only that deck reaches the game's seat-1 folder), both play through {@code /m/<id>/ws} to
 * the end. Bob's browser claims Alice's seat and name in its hello; the router's stamp wins.
 */
public class RouterPvpTest {

    private static final String USER = "X-authentik-username";
    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;

    @AfterClass(alwaysRun = true)
    public void stop() throws Exception {
        if (router != null) {
            router.stop();
        }
        final long end = System.currentTimeMillis() + 30_000;
        while (ProcessHandle.current().children().anyMatch(ProcessHandle::isAlive) && System.currentTimeMillis() < end) {
            Thread.sleep(100);
        }
    }

    @Test
    public void twoPeoplePlayThroughTheRouter() throws Exception {
        final Path data = Path.of("target", "router-pvp-test").toAbsolutePath();
        ChildProcessHost.deleteTree(data);
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.maxMatches = 2;
        o.dataDir = data;
        o.child.dataDir = data;
        o.child.tickMs = 250;
        o.child.jvmArgs = new java.util.ArrayList<>(o.child.jvmArgs.stream().filter(a -> !a.startsWith("-Xmx")).toList());
        o.child.jvmArgs.add("-Xmx384m");
        o.child.jvmArgs.add("-XX:TieredStopAtLevel=1");
        o.child.jvmArgs.add("-XX:+UseSerialGC");
        o.child.childArgs.addAll(List.of("--assets", System.getProperty("forge.bridge.assets", "../forge-gui/"),
                "--decks", TableTestEnv.decksDir().getAbsolutePath(), "--test-prefs"));
        router = new Router(o, new ChildProcessHost(o.child));
        router.start();

        final HttpResponse<String> made = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"mono-red-madness\"}");
        assertEquals(made.statusCode(), 201, made.body());
        final JsonObject g = JsonParser.parseString(made.body()).getAsJsonObject();
        final String id = g.get("id").getAsString();
        final String url = g.getAsJsonObject("invite").get("url").getAsString();
        final String code = url.substring(url.lastIndexOf('/') + 1);
        final HttpResponse<String> joined = post("bob", "/api/join", "{\"code\":\"" + code + "\",\"deck\":\"mono-blue-faeries\"}");
        assertEquals(joined.statusCode(), 200, joined.body());
        try (java.util.stream.Stream<Path> s = Files.list(data.resolve("matches").resolve(id).resolve("seat1").resolve("decks"))) {
            assertEquals(s.map(p -> p.getFileName().toString()).toList(), List.of("mono-blue-faeries.dck"));
        }
        final long until = System.currentTimeMillis() + 240_000;
        while (!"ready".equals(status(id)) && System.currentTimeMillis() < until) {
            Thread.sleep(250);
        }
        assertEquals(status(id), "ready", "the game never became ready");

        final ScriptedClient a = client(id, "alice", 31L);
        final ScriptedClient b = client(id, "bob", 32L).helloExtra("seat", new JsonPrimitive(0)).helloExtra("name", new JsonPrimitive("alice"));
        final CompletableFuture<ScriptedClient.Result> fa = CompletableFuture.supplyAsync(() -> play(a, "mono-red-madness"));
        final CompletableFuture<ScriptedClient.Result> fb = CompletableFuture.supplyAsync(() -> play(b, "mono-blue-faeries"));
        final ScriptedClient.Result ra = fa.get(10, TimeUnit.MINUTES);
        final ScriptedClient.Result rb = fb.get(10, TimeUnit.MINUTES);
        System.out.println("[RouterPvpTest] alice " + ra + "\n[RouterPvpTest] bob " + rb);
        assertTrue(ra.violations.stream().allMatch(v -> v.startsWith(ScriptedClient.NULL_FROM_ID_DRAW)), "alice: " + ra.violations);
        assertTrue(rb.violations.stream().allMatch(v -> v.startsWith(ScriptedClient.NULL_FROM_ID_DRAW)), "bob: " + rb.violations);
        assertTrue(ra.gameOver && rb.gameOver);
        assertNotEquals(ra.won, rb.won);
        assertNotEquals(a.viewer(), b.viewer(), "bob's forged seat 0 was honoured");
        final Set<String> names = new HashSet<>();
        b.players().values().forEach(p -> names.add(p.get("name").getAsString()));
        assertEquals(names, Set.of("alice", "bob"), "bob's forged name was honoured");
        assertEquals(b.players().get(b.viewer()).get("name").getAsString(), "bob");

        // The game's result reached the router's store from the child's /status: alice's record against bob is one game.
        final long seen = System.currentTimeMillis() + 30_000;
        JsonObject bobForAlice = null;
        while (System.currentTimeMillis() < seen) {
            final JsonObject list = JsonParser.parseString(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches"))
                    .header(USER, "alice").GET().build(), HttpResponse.BodyHandlers.ofString()).body()).getAsJsonObject();
            for (final com.google.gson.JsonElement e : list.getAsJsonArray("people")) {
                final JsonObject p = e.getAsJsonObject();
                if (p.get("name").getAsString().equals("bob") && p.has("record")) {
                    bobForAlice = p;
                }
            }
            if (bobForAlice != null) {
                break;
            }
            Thread.sleep(250);
        }
        assertTrue(bobForAlice != null, "no record of the game against bob");
        final JsonObject rec = bobForAlice.getAsJsonObject("record");
        assertEquals(rec.get("w").getAsInt() + rec.get("l").getAsInt(), 1);
        assertEquals(rec.get("w").getAsInt() == 1, ra.won, "alice's record says what her game over said");
        final List<String> lines = Files.readAllLines(data.resolve("results.jsonl"));
        assertEquals(lines.size(), 1, lines.toString());
        assertTrue(lines.get(0).contains("\"mode\":\"pvp\"") && lines.get(0).contains("Madness") && lines.get(0).contains("Faeries"), lines.get(0));
    }

    private ScriptedClient client(final String id, final String user, final long seed) {
        return new ScriptedClient(URI.create("ws://127.0.0.1:" + router.port() + "/m/" + id + "/ws"), Map.of(USER, user), "not-the-token", seed,
                false, 150);
    }

    private static ScriptedClient.Result play(final ScriptedClient c, final String deck) {
        final JsonObject params = new JsonObject();
        params.addProperty("deck", deck);
        try {
            return c.play(params, Duration.ofMinutes(8));
        } catch (final Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResponse<String> post(final String user, final String path, final String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path)).header(USER, user)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private String status(final String id) {
        try {
            final JsonObject list = JsonParser.parseString(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches"))
                    .header(USER, "alice").GET().build(), HttpResponse.BodyHandlers.ofString()).body()).getAsJsonObject();
            for (final var e : list.getAsJsonArray("matches")) {
                if (e.getAsJsonObject().get("id").getAsString().equals(id)) {
                    return e.getAsJsonObject().get("status").getAsString();
                }
            }
        } catch (final Exception e) {
            fail("list failed: " + e);
        }
        return null;
    }
}

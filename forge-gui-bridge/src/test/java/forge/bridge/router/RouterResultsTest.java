package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Finished games reach the results store with who sat where, and come back as the lobby's records: {@code people}
 * (online / playing / away, each with my W-L and last game against them) and a deck's {@code record} and {@code last}.
 */
public class RouterResultsTest {
    private static final String USER = "X-authentik-username";
    private final HttpClient http = HttpClient.newHttpClient();
    private final AtomicLong clock = new AtomicLong(1_000_000_000L);
    private Router router;
    private RouterTest.StubHost stub;
    private Path data;

    @AfterMethod(alwaysRun = true)
    public void stop() {
        if (router != null) {
            router.stop();
            router = null;
        }
    }

    private void start() throws Exception {
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.maxMatches = 50;
        o.maxPerUser = 10;
        o.clock = clock::get;
        data = Files.createTempDirectory("ft-router-results");
        o.dataDir = data;
        stub = new RouterTest.StubHost();
        router = new Router(o, stub);
        router.start();
    }

    private HttpResponse<String> send(final String method, final String user, final String path, final String body) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path)).header(USER, user)
                .header("Content-Type", "application/json");
        return http.send(b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private JsonObject get(final String user, final String path) throws Exception {
        final HttpResponse<String> r = send("GET", user, path, null);
        assertEquals(r.statusCode(), 200, r.body());
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    private static JsonObject person(final JsonObject list, final String name) {
        for (final JsonElement e : list.getAsJsonArray("people")) {
            if (e.getAsJsonObject().get("name").getAsString().equals(name)) {
                return e.getAsJsonObject();
            }
        }
        return null;
    }

    private void playing(final String id) {
        final GameHost.Game g = stub.games.get(id);
        stub.games.put(id, new GameHost.Game(g.id(), g.owner(), GameHost.Status.PLAYING, g.created(), null, null, g.format()));
    }

    private static GameHost.Finished.FinishedSeat seat(final String deck, final String r) {
        return new GameHost.Finished.FinishedSeat(deck, r, false);
    }

    @Test
    public void aGameBetweenTwoPeopleBecomesTheirRecord() throws Exception {
        start();
        get("bob", "/api/matches"); // bob is online
        final HttpResponse<String> made = send("POST", "alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"listed\":true}");
        assertEquals(made.statusCode(), 201, made.body());
        final String id = JsonParser.parseString(made.body()).getAsJsonObject().get("id").getAsString();
        final HttpResponse<String> joined = send("POST", "bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}");
        assertEquals(joined.statusCode(), 200, joined.body());

        // Before any game: bob is just online, no record; the list never shows anyone their own login.
        JsonObject bob = person(get("alice", "/api/matches"), "bob");
        assertEquals(bob.get("state").getAsString(), "online");
        assertFalse(bob.has("record"));
        assertEquals(get("alice", "/api/matches").getAsJsonArray("online").get(0).getAsJsonObject().get("key").getAsString(), bob.get("key").getAsString(),
                "people's key is the invite handle online[] has");

        playing(id);
        router.finished(new GameHost.Finished(id, 1, List.of(seat("burn", "won"), seat("bob-deck", "lost"))));
        router.finished(new GameHost.Finished(id, 1, List.of(seat("burn", "won"), seat("bob-deck", "lost")))); // reported again
        clock.addAndGet(1_000);
        router.finished(new GameHost.Finished(id, 2, List.of(seat("burn", "lost"), seat("bob-deck", "won")))); // the rematch
        clock.addAndGet(1_000);
        router.finished(new GameHost.Finished(id, 3, List.of(seat("burn", "won"), seat("bob-deck", "lost"))));

        bob = person(get("alice", "/api/matches"), "bob");
        assertEquals(bob.get("state").getAsString(), "playing", "bob holds a seat in a game in play");
        assertEquals(bob.getAsJsonObject("record").get("w").getAsInt(), 2);
        assertEquals(bob.getAsJsonObject("record").get("l").getAsInt(), 1);
        assertEquals(bob.get("last").getAsLong(), clock.get());
        final JsonObject alice = person(get("bob", "/api/matches"), "alice");
        assertEquals(alice.get("state").getAsString(), "playing");
        assertEquals(alice.getAsJsonObject("record").get("w").getAsInt(), 1, "bob sees his own side");
        assertEquals(alice.getAsJsonObject("record").get("l").getAsInt(), 2);
        assertEquals(Files.readAllLines(data.resolve("results.jsonl")).size(), 3, "3 games, the repeat counted once");

        // Both go quiet and the game is gone: bob is "away" for alice, with when he was last around; no invite handle.
        stub.games.remove(id);
        clock.addAndGet(2 * 60_000L);
        get("alice", "/api/matches"); // alice is back, bob isn't
        bob = person(get("alice", "/api/matches"), "bob");
        assertEquals(bob.get("state").getAsString(), "away");
        assertTrue(bob.get("seen").getAsLong() >= bob.get("last").getAsLong());
        assertTrue(bob.get("key").getAsString().startsWith("away-"));
        assertFalse(bob.get("key").getAsString().contains("bob"));
        assertEquals(bob.getAsJsonObject("record").get("w").getAsInt(), 2);
        final HttpResponse<String> invited = send("POST", "alice", "/api/matches",
                "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"" + bob.get("key").getAsString() + "\"}");
        assertNotEquals(invited.statusCode(), 201, "an away handle invites nobody");

        // A restart reads the store back.
        stop();
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.clock = clock::get;
        o.dataDir = data;
        router = new Router(o, new RouterTest.StubHost());
        router.start();
        bob = person(get("alice", "/api/matches"), "bob");
        assertEquals(bob.get("state").getAsString(), "away");
        assertEquals(bob.getAsJsonObject("record").get("l").getAsInt(), 1);

        // Past 30 days he drops off the list.
        clock.addAndGet(31L * 24 * 60 * 60_000);
        assertEquals(person(get("alice", "/api/matches"), "bob"), null);
    }

    @Test
    public void aDeckCarriesItsRecordAndAnAiIsNobody() throws Exception {
        start();
        final HttpResponse<String> made = send("POST", "alice", "/api/matches", "{\"deck\":\"shared-deck\"}");
        assertEquals(made.statusCode(), 201, made.body());
        final String id = JsonParser.parseString(made.body()).getAsJsonObject().get("id").getAsString();
        router.finished(new GameHost.Finished(id, 1, List.of(seat("shared-deck", "won"), seat("AI deck", "lost"))));
        clock.addAndGet(500);
        router.finished(new GameHost.Finished(id, 2, List.of(seat("shared-deck", "draw"), seat("AI deck", "draw"))));

        final JsonObject d = get("alice", "/api/decks").getAsJsonObject("details").getAsJsonObject("shared-deck");
        assertEquals(d.getAsJsonObject("record").get("w").getAsInt(), 1);
        assertEquals(d.getAsJsonObject("record").get("l").getAsInt(), 0);
        assertEquals(d.get("last").getAsLong(), clock.get());
        assertFalse(get("bob", "/api/decks").getAsJsonObject("details").getAsJsonObject("shared-deck").has("record"), "only my own games");
        final JsonArray people = get("alice", "/api/matches").getAsJsonArray("people");
        assertEquals(people.size(), 1, "bob, online; an AI is nobody: " + people);
        assertFalse(people.get(0).getAsJsonObject().has("record"), "alice never played bob");
        final String line = Files.readAllLines(data.resolve("results.jsonl")).get(0);
        assertTrue(line.contains("\"mode\":\"ai\"") && line.contains("\"user\":\"alice\""), line);
        assertEquals(JsonParser.parseString(line).getAsJsonObject().getAsJsonArray("seats").get(1).getAsJsonObject().keySet(), java.util.Set.of("deck", "r"));
    }
}

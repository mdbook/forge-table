package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * "Online now" and direct invites against the stub host: who the lobby lists as online (signed-in users seen in
 * the last minute or at a table, never yourself, never a guest, by name and an opaque handle), a pvp game made for one of
 * them, which only they can take by id, their invite card, declining, expiry, the rate limit and the race with a link.
 */
public class RouterInviteTest {

    private static final String USER = "X-authentik-username";
    private static final String NAME = "X-authentik-name";
    private final HttpClient http = HttpClient.newHttpClient();
    private final AtomicLong clock = new AtomicLong(1_000_000_000L);
    private Router router;
    private RouterTest.StubHost stub;

    @AfterMethod(alwaysRun = true)
    public void stop() {
        if (router != null) {
            router.stop();
            router = null;
        }
    }

    private Router.Options options() {
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.maxMatches = 50;
        o.maxPerUser = 10;
        o.mintLimit = 100;
        o.clock = clock::get;
        return o;
    }

    private void start(final Router.Options o) throws Exception {
        stub = new RouterTest.StubHost();
        router = new Router(o, stub);
        router.start();
    }

    private HttpResponse<String> send(final String method, final String path, final String body, final String... headers) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        final HttpRequest.BodyPublisher p = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body);
        return http.send(b.method(method, p).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(final String user, final String path, final String body) throws Exception {
        return send("POST", path, body, USER, user, "Content-Type", "application/json");
    }

    private JsonObject list(final String user) throws Exception {
        final HttpResponse<String> r = send("GET", "/api/matches", null, USER, user);
        assertEquals(r.statusCode(), 200, r.body());
        return json(r);
    }

    private static JsonObject json(final HttpResponse<String> r) {
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    /** The names in {@code user}'s "Online now". */
    private List<String> onlineNames(final String user) throws Exception {
        final List<String> names = new ArrayList<>();
        for (final JsonElement e : list(user).getAsJsonArray("online")) {
            names.add(e.getAsJsonObject().get("name").getAsString());
        }
        return names;
    }

    /** {@code viewer}'s handle for the online user shown as {@code name}. */
    private String keyOf(final String viewer, final String name) throws Exception {
        for (final JsonElement e : list(viewer).getAsJsonArray("online")) {
            if (e.getAsJsonObject().get("name").getAsString().equals(name)) {
                return e.getAsJsonObject().get("key").getAsString();
            }
        }
        throw new AssertionError(name + " isn't online for " + viewer);
    }

    /** alice makes a pvp game inviting the online user shown as {@code name}: the game JSON. */
    private JsonObject invite(final String name, final boolean listed) throws Exception {
        final HttpResponse<String> made = post("alice", "/api/matches",
                "{\"mode\":\"pvp\",\"deck\":\"burn\",\"listed\":" + listed + ",\"invite\":\"" + keyOf("alice", name) + "\"}");
        assertEquals(made.statusCode(), 201, made.body());
        return json(made);
    }

    private static String code(final JsonObject game) {
        final String url = game.getAsJsonObject("invite").get("url").getAsString();
        return url.substring(url.lastIndexOf('/') + 1);
    }

    private static boolean hasId(final JsonArray arr, final String field, final String id) {
        for (final JsonElement e : arr) {
            if (e.getAsJsonObject().get(field).getAsString().equals(id)) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- presence

    /**
     * A request makes you online for a minute: others see your shown name (the first name, never the login) and a random
     * handle; you never see yourself; quiet for a minute and you're gone. Not signed in: no list at all.
     */
    @Test
    public void presenceAppearsExpiresAndNeverShowsLogins() throws Exception {
        final Router.Options o = options();
        o.nameHeader = NAME;
        start(o);
        final String[] alice = {USER, "alice", NAME, "Alice Liddell"}; // every request of hers carries her full name
        send("GET", "/api/matches", null, alice);
        final JsonObject bobs = list("bob");
        assertEquals(bobs.getAsJsonArray("online").size(), 1, bobs.toString());
        final JsonObject a = bobs.getAsJsonArray("online").get(0).getAsJsonObject();
        assertEquals(a.keySet(), java.util.Set.of("key", "name"));
        assertEquals(a.get("name").getAsString(), "Alice");
        assertTrue(a.get("key").getAsString().matches("[0-9a-f]{32}"), a.toString());
        assertFalse(bobs.getAsJsonArray("online").toString().contains("alice"), "no login in the online list");
        final JsonArray alices = json(send("GET", "/api/matches", null, alice)).getAsJsonArray("online");
        assertEquals(alices.size(), 1, "never yourself");
        assertEquals(alices.get(0).getAsJsonObject().get("name").getAsString(), "bob", "bob (no name header) shows by login");
        assertEquals(keyOf("bob", "Alice"), a.get("key").getAsString(), "the handle is stable while alice stays online");

        clock.addAndGet(59_000);
        assertEquals(onlineNames("bob"), List.of("Alice"), "still within the minute");
        clock.addAndGet(2_000);
        assertEquals(onlineNames("bob"), List.of(), "quiet for a minute: gone");
        router.reapWaiting(); // and forgotten
        send("GET", "/", null, alice); // any signed-in request counts
        final String again = keyOf("bob", "Alice");
        assertFalse(again.equals(a.get("key").getAsString()), "back after being forgotten: a fresh handle");
        clock.addAndGet(61_000);
        router.reapWaiting();
        assertEquals(onlineNames("bob"), List.of(), "reaped");
        assertEquals(send("GET", "/api/matches", null).statusCode(), 401, "not signed in: no list");
    }

    /** A guest never shows as online (nor anything under /g/ makes anyone online), and doesn't see the list. */
    @Test
    public void guestsAreNeverOnline() throws Exception {
        final Router.Options o = options();
        o.guests = true;
        o.realIpHeader = "X-Real-IP";
        start(o);
        final JsonObject g = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}"));
        final String id = g.get("id").getAsString();
        final HttpResponse<String> joined = send("POST", "/g/api/join", "{\"code\":\"" + code(g) + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}",
                "Content-Type", "application/json", "X-Real-IP", "10.9.9.9");
        assertEquals(joined.statusCode(), 200, joined.body());
        final String set = joined.headers().firstValue("set-cookie").orElseThrow();
        final String cookie = set.substring(0, set.indexOf(';'));
        assertEquals(send("GET", "/g/" + id + "/", null, "Cookie", cookie).statusCode(), 200);
        send("GET", "/g/" + id + "/img/card/x", null, "Cookie", cookie);
        send("GET", "/g/join/" + "a".repeat(32), null, USER, "mallory"); // a user header under /g/ identifies nobody
        assertEquals(onlineNames("bob"), List.of("alice"), "only the signed-in creator");
        assertEquals(send("GET", "/api/matches", null, "Cookie", cookie).statusCode(), 401, "a guest gets no list");
    }

    /** At a table (a game socket open) you stay online however long it lasts; after it closes, for another minute. */
    @Test
    public void anOpenTableKeepsYouOnline() throws Exception {
        start(options());
        stub.holdSockets = true;
        final String id = json(post("carol", "/api/matches", "{}")).get("id").getAsString();
        try (Socket s = new Socket("127.0.0.1", router.port())) {
            final OutputStream out = s.getOutputStream();
            out.write(("GET /m/" + id + "/ws HTTP/1.1\r\nHost: 127.0.0.1\r\n" + USER + ": carol\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            final long until = System.currentTimeMillis() + 5_000;
            while (stub.lastSeat != 0 && System.currentTimeMillis() < until) {
                Thread.sleep(20);
            }
            assertEquals(stub.lastSeat, 0, "the socket reached the game");
            clock.addAndGet(10 * 60_000L);
            router.reapWaiting();
            assertEquals(onlineNames("bob"), List.of("carol"), "ten quiet minutes at the table: still online");
        }
        final long until = System.currentTimeMillis() + 5_000;
        boolean released = false;
        while (!released && System.currentTimeMillis() < until) {
            clock.addAndGet(61_000);
            released = onlineNames("bob").isEmpty();
            Thread.sleep(50);
        }
        assertTrue(released, "the socket closed: offline a minute later");
    }

    /** Only a real WebSocket upgrade counts as at the table: plain GETs of /ws on a kept-alive connection pin nobody online. */
    @Test
    public void plainGetsOfTheSocketPathDontPinYouOnline() throws Exception {
        start(options());
        stub.holdSockets = true;
        final String id = json(post("carol", "/api/matches", "{}")).get("id").getAsString();
        try (Socket s = new Socket("127.0.0.1", router.port())) {
            final OutputStream out = s.getOutputStream();
            for (int i = 0; i < 2; i++) {
                out.write(("GET /m/" + id + "/ws HTTP/1.1\r\nHost: 127.0.0.1\r\n" + USER + ": carol\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            }
            out.flush();
            final long until = System.currentTimeMillis() + 5_000;
            while (stub.lastSeat != 0 && System.currentTimeMillis() < until) {
                Thread.sleep(20);
            }
            assertEquals(stub.lastSeat, 0, "the request reached the game");
            clock.addAndGet(61_000);
            router.reapWaiting();
            assertEquals(onlineNames("bob"), List.of(), "no upgrade, no table: offline a minute later though the connection is up");
        }
    }

    // ---------------------------------------------------------------- direct invites

    /**
     * alice invites bob from "Online now": bob (only bob) gets the card {game, from, expires}; the game isn't open to anyone
     * else, nor joinable by id except by bob; alice's row says who she invited; bob accepts by id with his own deck.
     */
    @Test
    public void onlyTheInviteeSeesAndTakesTheSeat() throws Exception {
        start(options());
        list("bob");
        list("carol");
        final JsonObject g = invite("bob", true);
        final String id = g.get("id").getAsString();
        assertEquals(g.getAsJsonObject("invited").get("name").getAsString(), "bob");
        assertTrue(g.getAsJsonObject("invited").get("expires").getAsLong() == clock.get() + 15 * 60_000L);
        assertTrue(g.has("invite"), "the link is made as usual");

        final JsonArray cards = list("bob").getAsJsonArray("invites");
        assertEquals(cards.size(), 1);
        final JsonObject card = cards.get(0).getAsJsonObject();
        assertEquals(card.keySet(), java.util.Set.of("game", "from", "expires"));
        assertEquals(card.get("game").getAsString(), id);
        assertEquals(card.get("from").getAsString(), "alice");
        assertFalse(card.toString().contains("burn"), "nothing about the deck");

        final JsonObject carols = list("carol");
        assertEquals(carols.getAsJsonArray("invites").size(), 0, "carol has no card");
        assertFalse(hasId(carols.getAsJsonArray("open"), "id", id), "a game held for bob isn't open to carol, though listed");
        assertFalse(hasId(list("bob").getAsJsonArray("open"), "id", id), "nor in bob's open list (it is his card)");
        assertEquals(list("alice").getAsJsonArray("invites").size(), 0);
        final HttpResponse<String> carolById = post("carol", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"carol-deck\"}");
        assertEquals(carolById.statusCode(), 404, "only bob takes it by id");
        assertEquals(json(carolById).get("error").getAsString(), "That game isn't open any more.");

        assertEquals(post("bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"burn\"}").statusCode(), 400, "alice's deck isn't bob's");
        final HttpResponse<String> accepted = post("bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}");
        assertEquals(accepted.statusCode(), 200, accepted.body());
        assertEquals(json(accepted).get("seat").getAsInt(), 1);
        assertEquals(stub.seated.get(id), "bob:bob-deck");
        assertEquals(list("bob").getAsJsonArray("invites").size(), 0, "the card is gone once he is in");
        final JsonObject alices = list("alice").getAsJsonArray("matches").get(0).getAsJsonObject();
        assertFalse(alices.has("invited") || alices.has("waiting") || alices.has("invite"), alices.toString());
        assertEquals(post("carol", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"carol-deck\"}").statusCode(), 404, "the link died with the join");
    }

    /** A Brawl game says so on the invite card and the open-games row, so the joiner picks a Brawl deck; Constructed rows don't change. */
    @Test
    public void brawlRowsSayBrawl() throws Exception {
        start(options());
        list("bob");
        list("carol");
        final HttpResponse<String> held = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"format\":\"brawl\",\"invite\":\""
                + keyOf("alice", "bob") + "\"}");
        assertEquals(held.statusCode(), 201, held.body());
        assertEquals(json(held).get("format").getAsString(), "brawl");
        final JsonObject card = list("bob").getAsJsonArray("invites").get(0).getAsJsonObject();
        assertEquals(card.keySet(), java.util.Set.of("game", "from", "expires", "format"));
        assertEquals(card.get("format").getAsString(), "brawl");

        final HttpResponse<String> listed = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"format\":\"brawl\"}");
        final HttpResponse<String> plain = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}");
        final JsonObject brawlRow = row(list("carol").getAsJsonArray("open"), json(listed).get("id").getAsString());
        assertEquals(brawlRow.keySet(), java.util.Set.of("id", "host", "created", "format"));
        assertEquals(brawlRow.get("format").getAsString(), "brawl");
        assertEquals(row(list("carol").getAsJsonArray("open"), json(plain).get("id").getAsString()).keySet(), java.util.Set.of("id", "host", "created"));
    }

    private static JsonObject row(final JsonArray arr, final String id) {
        for (final JsonElement e : arr) {
            if (e.getAsJsonObject().get("id").getAsString().equals(id)) {
                return e.getAsJsonObject();
            }
        }
        throw new AssertionError(id + " isn't in " + arr);
    }

    /** Someone with the link still gets in while bob's card is out; then bob's accept is "already joined". */
    @Test
    public void theLinkStillWorksWhileAnInviteIsOut() throws Exception {
        start(options());
        list("bob");
        final JsonObject g = invite("bob", false);
        final String id = g.get("id").getAsString();
        assertEquals(post("carol", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"carol-deck\"}").statusCode(), 200);
        assertEquals(list("bob").getAsJsonArray("invites").size(), 0);
        assertEquals(post("bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}").statusCode(), 409);
        assertEquals(post("bob", "/api/matches/" + id + "/decline", "{}").statusCode(), 404, "nothing left to decline");
    }

    /** bob declines: the card dies, alice's game goes on waiting with its link (and, listed, in the open list); nobody else can decline. */
    @Test
    public void declineKillsTheInviteOnly() throws Exception {
        start(options());
        list("bob");
        final JsonObject g = invite("bob", true);
        final String id = g.get("id").getAsString();
        assertEquals(post("carol", "/api/matches/" + id + "/decline", "{}").statusCode(), 404, "not carol's to decline");
        assertEquals(post("alice", "/api/matches/" + id + "/decline", "{}").statusCode(), 404, "nor alice's");
        assertEquals(post("bob", "/api/matches/" + "f".repeat(16) + "/decline", "{}").statusCode(), 404);
        assertEquals(send("POST", "/api/matches/" + id + "/decline", "{}", USER, "bob", "Origin", "https://evil.example").statusCode(), 403);
        assertEquals(list("bob").getAsJsonArray("invites").size(), 1, "still out");
        final HttpResponse<String> declined = post("bob", "/api/matches/" + id + "/decline", "{}");
        assertEquals(declined.statusCode(), 200, declined.body());
        assertEquals(json(declined).getAsJsonArray("invites").size(), 0, "the answer is bob's fresh list");
        assertEquals(post("bob", "/api/matches/" + id + "/decline", "{}").statusCode(), 404, "once");
        final JsonObject alices = list("alice").getAsJsonArray("matches").get(0).getAsJsonObject();
        assertFalse(alices.has("invited"), alices.toString());
        assertTrue(alices.has("waiting") && alices.has("invite"), "still waiting, link still live: " + alices);
        assertTrue(hasId(list("carol").getAsJsonArray("open"), "id", id), "listed: open again");
        assertEquals(post("carol", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"carol-deck\"}").statusCode(), 200, "the link works");
    }

    /** After 15 minutes the card is gone and an unlisted game is closed to bob by id; the link (remade) still works. */
    @Test
    public void invitesExpire() throws Exception {
        start(options());
        list("bob");
        final JsonObject g = invite("bob", false);
        final String id = g.get("id").getAsString();
        clock.addAndGet(15 * 60_000L);
        assertEquals(list("bob").getAsJsonArray("invites").size(), 0, "expired");
        final JsonObject alices = list("alice").getAsJsonArray("matches").get(0).getAsJsonObject();
        assertFalse(alices.has("invited"), alices.toString());
        assertEquals(post("bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}").statusCode(), 404);
        assertEquals(post("bob", "/api/matches/" + id + "/decline", "{}").statusCode(), 404);
        router.reapWaiting();
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"bob-deck\"}").statusCode(), 200, "the link is separate");
    }

    /** A handle that is unknown or gone quiet is a 400; so is your own; an AI game ignores the field. */
    @Test
    public void staleUnknownAndOwnHandlesAreRefused() throws Exception {
        start(options());
        list("bob");
        final String bobKey = keyOf("alice", "bob");
        final String aliceKey = keyOf("bob", "alice");
        final HttpResponse<String> self = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"" + aliceKey + "\"}");
        assertEquals(self.statusCode(), 400);
        assertEquals(json(self).get("error").getAsString(), "You can't invite yourself.");
        final HttpResponse<String> unknown = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"" + "0".repeat(32) + "\"}");
        assertEquals(unknown.statusCode(), 400);
        assertEquals(json(unknown).get("error").getAsString(), "They're not online any more.");
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"bob\"}").statusCode(), 400, "a login is no handle");
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":{}}").statusCode(), 400);
        assertEquals(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\" \"}").statusCode(), 400, "blank: no silent listed game");
        clock.addAndGet(61_000);
        final HttpResponse<String> stale = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"" + bobKey + "\"}");
        assertEquals(stale.statusCode(), 400);
        assertEquals(json(stale).get("error").getAsString(), "They're not online any more.");
        assertEquals(stub.games.size(), 0, "no game was made by any of these");
        assertEquals(post("alice", "/api/matches", "{\"invite\":\"" + bobKey + "\"}").statusCode(), 201, "against the AI the field means nothing");
    }

    /** Direct invites come out of the same link budget (a create is one mint, with or without an invite). */
    @Test
    public void invitesAreRateLimited() throws Exception {
        final Router.Options o = options();
        o.mintLimit = 2;
        start(o);
        list("bob");
        invite("bob", true);
        invite("bob", true);
        final HttpResponse<String> third = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"invite\":\"" + keyOf("alice", "bob") + "\"}");
        assertEquals(third.statusCode(), 429, third.body());
        assertEquals(list("bob").getAsJsonArray("invites").size(), 2);
    }

    /** bob accepting by id and carol joining by the link at the same moment: exactly one gets the seat, every time. */
    @Test
    public void theInviteeAndALinkRaceForOneSeat() throws Exception {
        start(options());
        final ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            for (int i = 0; i < 20; i++) {
                list("bob");
                final JsonObject g = invite("bob", false);
                final String id = g.get("id").getAsString();
                final CountDownLatch go = new CountDownLatch(1);
                final Future<HttpResponse<String>> bob = pool.submit(() -> {
                    go.await();
                    return post("bob", "/api/join", "{\"id\":\"" + id + "\",\"deck\":\"bob-deck\"}");
                });
                final Future<HttpResponse<String>> carol = pool.submit(() -> {
                    go.await();
                    return post("carol", "/api/join", "{\"code\":\"" + code(g) + "\",\"deck\":\"carol-deck\"}");
                });
                go.countDown();
                final int bs = bob.get().statusCode();
                final int cs = carol.get().statusCode();
                assertTrue((bs == 200) != (cs == 200), "exactly one wins: bob " + bs + ", carol " + cs);
                assertTrue(bs == 200 || bs == 409, "bob loses with taken: " + bs);
                assertTrue(cs == 200 || cs == 404 || cs == 409, "carol loses with gone or taken: " + cs);
                assertEquals(stub.seated.get(id), bs == 200 ? "bob:bob-deck" : "carol:carol-deck");
                stub.end(id); // room under the per-user cap for the next round
            }
        } finally {
            pool.shutdownNow();
        }
    }
}

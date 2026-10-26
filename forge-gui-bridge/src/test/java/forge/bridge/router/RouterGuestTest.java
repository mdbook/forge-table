package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Guests (plans/forge-pvp.md "Guests") against the stub host: /g/* exists only with --guests; a guest cookie opens its
 * own game's /g/&lt;id&gt;/ and nothing else; codes, caps, expiry and the guest's seat and name.
 */
public class RouterGuestTest {

    private static final String USER = "X-authentik-username";
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

    private Router.Options options(final boolean guests) {
        final Router.Options o = new Router.Options();
        o.trustHeader = USER;
        o.maxMatches = 20;
        o.maxPerUser = 10;
        o.guests = guests;
        o.clock = clock::get;
        return o;
    }

    private void start(final Router.Options o) throws Exception {
        stub = new RouterTest.StubHost();
        router = new Router(o, stub);
        router.start();
    }

    private HttpRequest.Builder req(final String path, final String... headers) {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        return b;
    }

    private HttpResponse<String> send(final String method, final String path, final String body, final String... headers) throws Exception {
        final HttpRequest.BodyPublisher p = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body);
        return http.send(req(path, headers).method(method, p).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(final String path, final String... headers) throws Exception {
        return send("GET", path, null, headers);
    }

    private HttpResponse<String> post(final String user, final String path, final String body) throws Exception {
        return send("POST", path, body, USER, user, "Content-Type", "application/json");
    }

    private HttpResponse<String> guestJoin(final String body, final String... headers) throws Exception {
        final List<String> h = new ArrayList<>(List.of("Content-Type", "application/json"));
        h.addAll(List.of(headers));
        return send("POST", "/g/api/join", body, h.toArray(new String[0]));
    }

    private static JsonObject json(final HttpResponse<String> r) {
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    private static String code(final JsonObject game) {
        final String url = game.getAsJsonObject("invite").get("url").getAsString();
        return url.substring(url.lastIndexOf('/') + 1);
    }

    /** A pvp game of alice's whose link allows guests: {id, code}. */
    private String[] guestGame() throws Exception {
        final HttpResponse<String> made = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}");
        assertEquals(made.statusCode(), 201, made.body());
        final JsonObject g = json(made);
        assertTrue(g.getAsJsonObject("invite").get("url").getAsString().contains("/g/join/"), g.toString());
        return new String[] {g.get("id").getAsString(), code(g)};
    }

    /** Gus joins as a guest with code {@code code}: the cookie header value ("ftg=…"). */
    private String joinAsGus(final String code) throws Exception {
        final HttpResponse<String> r = guestJoin("{\"code\":\"" + code + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}");
        assertEquals(r.statusCode(), 200, r.body());
        final String set = r.headers().firstValue("set-cookie").orElseThrow();
        return set.substring(0, set.indexOf(';'));
    }

    // ---------------------------------------------------------------- the flag

    /** Without --guests every /g/ path is a plain 404 and "Allow guests" is ignored; --guests needs the proxy header. */
    @Test
    public void withoutTheFlagEveryGuestPathIsA404() throws Exception {
        start(options(false));
        final HttpResponse<String> made = post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}");
        final JsonObject g = json(made);
        assertTrue(g.getAsJsonObject("invite").get("url").getAsString().contains("/join/") && !g.toString().contains("/g/join/"), g.toString());
        assertFalse(g.getAsJsonObject("invite").get("guests").getAsBoolean(), "ignored without --guests");
        assertFalse(json(get("/api/matches", USER, "alice")).get("guests").getAsBoolean(), "the lobby hides the toggle");
        final String id = g.get("id").getAsString();
        final String code = code(g);
        for (final String p : new String[] {"/g", "/g/", "/g/join/" + code, "/g/api/decks?code=" + code, "/g/api/art/crop/Opt?code=" + code, "/g/" + id + "/", "/g/" + id + "/ws",
                "/g/assets/x.js", "/g/favicon.svg", "/g/bye"}) {
            final HttpResponse<String> r = get(p, USER, "alice");
            assertEquals(r.statusCode(), 404, p);
            assertEquals(r.body(), "not found", p);
        }
        assertEquals(guestJoin("{\"code\":\"" + code + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}").statusCode(), 404);
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--guests"}));
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--trust-proxy-header", USER, "--guests"}));
        assertTrue(Router.parse(new String[] {"--trust-proxy-header", USER, "--guests", "--real-ip-header", "X-Real-IP"}).guests);
    }

    // ---------------------------------------------------------------- THE gate

    /**
     * A guest cookie opens its own game's /g/&lt;id&gt;/ (page, socket, images) as seat 1 named "{name} (guest)", and nothing
     * else: everywhere else it is ignored and the answer is the one for nobody signed in (401, or the public page the
     * same as without it); another game's /g/ path is 403.
     */
    @Test
    public void aGuestCookieWorksOnlyOnItsOwnGame() throws Exception {
        final Router.Options o = options(true);
        o.adminGroup = "admins";
        o.groupsHeader = "X-authentik-groups";
        start(o);
        final String[] g1 = guestGame();
        final String id = g1[0];
        final String cookie = joinAsGus(g1[1]);
        // another pvp game (bob joined) and an AI game
        final JsonObject other = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}"));
        final String id2 = other.get("id").getAsString();
        final String code2 = code(other);
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code2 + "\",\"deck\":\"bob-deck\"}").statusCode(), 200, "a guest link works for a signed-in user too");
        final String ai = json(post("alice", "/api/matches", "{}")).get("id").getAsString();

        // its own game: every kind of request, as seat 1 with the guest's name
        for (final String sub : new String[] {"/", "/ws", "/img/card/x", "/assets/main.js"}) {
            final HttpResponse<String> r = get("/g/" + id + sub, "Cookie", cookie);
            assertEquals(r.statusCode(), 200, sub);
            assertEquals(r.body(), "attached " + id + " " + sub);
            assertEquals(stub.lastSeat, 1);
            assertEquals(stub.lastName, "Gus (guest)");
        }
        assertEquals(get("/g/" + id + "/seat/concede", "Cookie", cookie).statusCode(), 404, "the child's concede stays internal");
        assertEquals(get("/g/" + id + "/ws", "Cookie", cookie, "Origin", "https://evil.example").statusCode(), 403, "same origin for the socket");

        // everywhere else the cookie is nobody
        final String[][] api = {
            {"GET", "/api/matches", null}, {"POST", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"shared-deck\"}"},
            {"POST", "/api/join", "{\"code\":\"" + code2 + "\",\"deck\":\"shared-deck\"}"}, {"POST", "/api/join", "{\"id\":\"" + id2 + "\",\"deck\":\"shared-deck\"}"},
            {"POST", "/api/matches/" + id + "/invite", "{}"}, {"DELETE", "/api/matches/" + id, null}, {"DELETE", "/api/matches/" + ai, null},
            {"GET", "/api/decks", null}, {"PUT", "/api/upload", "{\"on\":true}"}, {"GET", "/api/admin/matches", null},
            {"DELETE", "/api/admin/matches/" + id, null}, {"POST", "/api/admin/update", "{}"},
        };
        for (final String[] a : api) {
            final HttpResponse<String> r = send(a[0], a[1], a[2], "Cookie", cookie, "Content-Type", "application/json");
            assertEquals(r.statusCode(), 401, a[0] + " " + a[1]);
        }
        for (final String game : new String[] {id, id2, ai}) {
            for (final String sub : new String[] {"/", "/ws", "/img/card/x"}) {
                assertEquals(get("/m/" + game + sub, "Cookie", cookie).statusCode(), 401, "/m/" + game + sub);
            }
        }
        for (final String game : new String[] {id2, ai, "abcdef12"}) {
            for (final String sub : new String[] {"/", "/ws", "/img/card/x"}) {
                assertEquals(get("/g/" + game + sub, "Cookie", cookie).statusCode(), 403, "/g/" + game + sub);
            }
        }
        // the public pages are the same with the cookie as without it (no data on them)
        for (final String p : new String[] {"/", "/join/" + code2, "/favicon.svg"}) {
            final HttpResponse<String> with = get(p, "Cookie", cookie);
            final HttpResponse<String> without = get(p);
            assertEquals(with.statusCode(), without.statusCode(), p);
            assertEquals(with.body(), without.body(), p);
        }
        assertTrue(stub.games.containsKey(id) && stub.games.containsKey(ai), "nothing was ended by the guest");
        assertTrue(stub.concessions.isEmpty());

        // a signed-in user (even the creator) never gets in at /g/<id>/: the header is ignored there
        assertEquals(get("/g/" + id + "/", USER, "alice").statusCode(), 403);
        assertEquals(get("/g/" + id + "/", USER, "alice", "X-authentik-groups", "admins").statusCode(), 403);
    }

    /** No cookie, a wrong one, another game's, an expired one (4 h) or one for a game that ended: all 403 on /g/&lt;id&gt;/. */
    @Test
    public void guestTokensAreBoundAndExpire() throws Exception {
        start(options(true));
        final String[] g = guestGame();
        final String id = g[0];
        final HttpResponse<String> r = guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}");
        final String set = r.headers().firstValue("set-cookie").orElseThrow();
        assertTrue(set.matches("ftg=[0-9a-f]{64}; Path=/g/" + id + "/; Max-Age=14400; HttpOnly; Secure; SameSite=Strict"), set);
        final String cookie = set.substring(0, set.indexOf(';'));
        final JsonObject joined = json(r);
        assertEquals(joined.get("seat").getAsInt(), 1);
        assertEquals(joined.getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"alice\"},{\"seat\":1,\"name\":\"Gus (guest)\"}]");
        assertFalse(r.body().contains("guest-"), "the guest's id is never shown");

        assertEquals(get("/g/" + id + "/").statusCode(), 403, "no cookie");
        assertEquals(get("/g/" + id + "/", "Cookie", "ftg=" + "0".repeat(64)).statusCode(), 403, "wrong token");
        assertEquals(get("/g/" + id + "/", "Cookie", "ft=x; " + cookie + "; other=1").statusCode(), 200, "among other cookies");
        final HttpResponse<String> page = get("/g/" + id + "/", "Accept", "text/html");
        assertEquals(page.statusCode(), 403);
        assertFalse(page.body().contains("href=\"/\""), "a guest's error page has no way to the lobby");

        // what alice's lobby shows: the guest's name
        final JsonObject alices = json(get("/api/matches", USER, "alice")).getAsJsonArray("matches").get(0).getAsJsonObject();
        assertTrue(alices.toString().contains("Gus (guest)"), alices.toString());

        clock.addAndGet(4 * 60 * 60_000L - 1);
        assertEquals(get("/g/" + id + "/", "Cookie", cookie).statusCode(), 200, "still within 4 h");
        clock.addAndGet(1);
        assertEquals(get("/g/" + id + "/", "Cookie", cookie).statusCode(), 403, "4 h at most");

        // the token dies with its game
        clock.set(1_000_000_000L);
        final String[] g2 = guestGame();
        final String c2 = joinAsGus(g2[1]);
        assertEquals(get("/g/" + g2[0] + "/", "Cookie", c2).statusCode(), 200);
        stub.end(g2[0]);
        assertEquals(get("/g/" + g2[0] + "/", "Cookie", c2).statusCode(), 403, "the game ended");
        router.reapWaiting();
        assertEquals(get("/g/" + g2[0] + "/", "Cookie", c2).statusCode(), 403);
    }

    // ---------------------------------------------------------------- codes and the join page

    /**
     * Only a live code made with guests on works under /g/api/ (the same 404 for unknown, used, expired and guests-off);
     * a guest gets the shared decks only; a new link keeps the choice; the join page says nothing about the code.
     */
    @Test
    public void guestCodesAndDecks() throws Exception {
        final Router.Options o = options(true);
        final Path web = Files.createTempDirectory("ft-web");
        Files.writeString(web.resolve("lobby.html"), "<head><p>lobby</p>");
        Files.writeString(web.resolve("index.html"), "<p>table</p>");
        Files.createDirectories(web.resolve("assets"));
        Files.writeString(web.resolve("assets").resolve("lobby-x.js"), "js");
        Files.writeString(web.resolve("favicon.svg"), "<svg/>");
        o.webDir = web.toString();
        start(o);
        final String gone = "That invite has expired or was already used.";

        // guests off (the default): refused under /g/, fine for a signed-in user
        final JsonObject off = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        assertFalse(off.getAsJsonObject("invite").get("guests").getAsBoolean(), "off by default");
        final String offCode = code(off);
        assertTrue(json(get("/api/matches", USER, "alice")).get("guests").getAsBoolean(), "the lobby offers the toggle");
        assertEquals(get("/g/api/decks?code=" + offCode).statusCode(), 404);
        final HttpResponse<String> offJoin = guestJoin("{\"code\":\"" + offCode + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}");
        assertEquals(offJoin.statusCode(), 404);
        assertEquals(json(offJoin).get("error").getAsString(), gone);
        assertTrue(offJoin.headers().firstValue("set-cookie").isEmpty());

        // on: the shared decks only, never the creator's own
        final String[] g = guestGame();
        final HttpResponse<String> decks = get("/g/api/decks?code=" + g[1]);
        assertEquals(decks.statusCode(), 200, decks.body());
        assertEquals(json(decks).getAsJsonArray("decks").toString(), "[\"shared-deck\"]");
        assertEquals(json(decks).getAsJsonObject("details").getAsJsonObject("shared-deck").get("key").getAsString(), "Lightning Bolt");
        assertFalse(json(decks).has("neuralLabel"), "the lobby's, not a guest's");
        assertEquals(get("/g/api/decks?code=" + "0".repeat(32)).statusCode(), 404);
        assertEquals(get("/g/api/decks").statusCode(), 404);
        final HttpResponse<String> theirs = guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"burn\"}");
        assertEquals(theirs.statusCode(), 400, "alice's import isn't a guest's");
        assertEquals(json(theirs).get("error").getAsString(), "Unknown deck.");
        assertEquals(guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"../x\"}").statusCode(), 400);
        assertEquals(guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\" \\u0000 \",\"deck\":\"shared-deck\"}").statusCode(), 400, "no name");
        assertEquals(guestJoin("{\"id\":\"" + g[0] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}").statusCode(), 400, "never by id (no open list)");
        assertEquals(guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}", "Origin", "https://evil.example").statusCode(), 403);
        assertEquals(send("POST", "/g/api/join", "{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}", "Content-Type", "text/plain").statusCode(), 415);
        assertEquals(get("/g/api/join").statusCode(), 405);
        assertEquals(get("/g/api/matches").statusCode(), 404, "no other guest API");
        joinAsGus(g[1]);
        assertEquals(stub.seated.get(g[0]), "null:shared-deck", "seat 1 got a shared deck, as nobody's");
        final HttpResponse<String> reused = guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Hal\",\"deck\":\"shared-deck\"}");
        assertEquals(reused.statusCode(), 404, "single use");
        assertEquals(json(reused).get("error").getAsString(), gone);
        assertEquals(get("/g/api/decks?code=" + g[1]).statusCode(), 404, "a used code lists nothing");
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + g[1] + "\",\"deck\":\"bob-deck\"}").statusCode(), 404, "used for everyone");

        // the open list never shows a guest's game, nor anyone's guests
        final JsonObject listed = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}"));
        final JsonObject bobs = json(get("/api/matches", USER, "bob"));
        assertFalse(bobs.toString().contains("Gus") || ids(bobs).contains(g[0]), bobs.toString());
        assertTrue(ids(bobs).contains(listed.get("id").getAsString()), "a waiting game is listed as usual");

        // a new link keeps the choice unless asked otherwise
        final String lid = listed.get("id").getAsString();
        final JsonObject again = json(post("alice", "/api/matches/" + lid + "/invite", "{}"));
        assertTrue(again.getAsJsonObject("invite").get("guests").getAsBoolean());
        assertEquals(get("/g/api/decks?code=" + code(listed)).statusCode(), 404, "the old code died");
        final JsonObject offAgain = json(post("alice", "/api/matches/" + lid + "/invite", "{\"guests\":false}"));
        assertFalse(offAgain.getAsJsonObject("invite").get("guests").getAsBoolean());
        assertFalse(offAgain.getAsJsonObject("invite").get("url").getAsString().contains("/g/"));
        assertEquals(get("/g/api/decks?code=" + code(offAgain)).statusCode(), 404);
        assertEquals(post("alice", "/api/matches/" + lid + "/invite", "{\"guests\":\"yes\"}").statusCode(), 400);

        // the join page: the lobby page from /g/, whatever the code; its bundle and icons; nothing else
        final HttpResponse<String> page = get("/g/join/" + code(offAgain));
        assertEquals(page.statusCode(), 200);
        assertEquals(page.body(), "<head><base href=\"/g/\"><p>lobby</p>");
        assertEquals(get("/g/join/" + "f".repeat(32)).body(), page.body());
        assertEquals(get("/g/assets/lobby-x.js").body(), "js");
        assertEquals(get("/g/favicon.svg").body(), "<svg/>");
        assertEquals(get("/g/lobby.html").statusCode(), 404);
        assertEquals(get("/g/index.html").statusCode(), 404);
        assertEquals(get("/g/assets/../index.html").statusCode(), 400);
        assertEquals(get("/g/bye", "Accept", "text/html").statusCode(), 200);
        assertEquals(send("POST", "/g/join/" + code(offAgain), "{}").statusCode(), 405);
    }

    /**
     * GET /g/api/art/crop/&lt;name&gt;?code=: the join page's deck art, for a live guest code only (the same 404 as the deck
     * list for unknown, used, guests-off and missing codes); the lobby route's name guards; crops, never full scans.
     */
    @Test
    public void guestArtCropsNeedALiveCode() throws Exception {
        final Router.Options o = options(true);
        o.cropDownload = (url, dest) -> false;
        o.dataDir = Files.createTempDirectory("ft-guest-art");
        final Path table = Files.createDirectories(o.dataDir.resolve("cache").resolve("table"));
        final Path crop = table.resolve("art/art_crop/front/a/b/bolt.jpg");
        Files.createDirectories(crop.getParent());
        final byte[] jpeg = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2, 3};
        Files.write(crop, jpeg);
        Files.writeString(forge.bridge.art.CardArtIndex.builtFile(table), "{\"Lightning Bolt\":\"https://cards.scryfall.io/normal/front/a/b/bolt.jpg\"}");
        start(o);
        final String[] g = guestGame();
        final String bolt = "/g/api/art/crop/Lightning%20Bolt?code=";

        final HttpResponse<byte[]> ok = http.send(req(bolt + g[1]).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(ok.statusCode(), 200);
        assertEquals(ok.body(), jpeg);
        assertEquals(ok.headers().firstValue("content-type").orElse(""), "image/jpeg");
        assertEquals(send("HEAD", bolt + g[1], null).statusCode(), 200);
        assertEquals(get("/g/api/art/crop/Nope?code=" + g[1]).statusCode(), 204, "not in the map");
        for (final String bad : new String[] {"..%2Fsecret.jpg", "a%5Cb", "%00", "x%0Ay", ""}) {
            assertEquals(get("/g/api/art/crop/" + bad + "?code=" + g[1]).statusCode(), 400, bad);
        }
        assertEquals(send("POST", bolt + g[1], "{}").statusCode(), 405);
        assertEquals(get("/g/api/art/card/Lightning%20Bolt?code=" + g[1]).statusCode(), 404, "no full scans for guests");

        assertEquals(get("/g/api/art/crop/Lightning%20Bolt").statusCode(), 404, "no code");
        assertEquals(get(bolt + "0".repeat(32)).statusCode(), 404, "unknown code");
        assertEquals(get(bolt + g[1] + "&code=" + g[1]).statusCode(), 404, "one code only");
        final String offCode = code(json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}")));
        assertEquals(get(bolt + offCode).statusCode(), 404, "a link without guests");
        final String[] closed = guestGame();
        assertEquals(send("DELETE", "/api/matches/" + closed[0], null, USER, "alice").statusCode(), 200);
        assertEquals(get(bolt + closed[1]).statusCode(), 404, "a closed game's code");
        joinAsGus(g[1]);
        assertEquals(get(bolt + g[1]).statusCode(), 404, "a used code");
    }

    /**
     * The Admin sheet: each game's mode, players (a guest marked as one, each seat's own connected), a waiting game and
     * whether its link allows guests, both seats' table (decks too, even a pvp game's), and the server strip.
     */
    @Test
    public void theAdminSheetShowsEveryGameAndTheServer() throws Exception {
        final Router.Options o = options(true);
        o.adminGroup = "admins";
        o.groupsHeader = "X-authentik-groups";
        start(o);
        final String[] g = guestGame();
        final JsonObject made = json(post("alice", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        final String friend = made.get("id").getAsString();
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + code(made) + "\",\"deck\":\"bob-deck\"}").statusCode(), 200);
        final String ai = json(post("alice", "/api/matches", "{}")).get("id").getAsString();
        final GameHost.Game f = stub.games.get(friend);
        stub.games.put(friend, new GameHost.Game(f.id(), f.owner(), GameHost.Status.PLAYING, f.created(), null, null, null,
                new GameHost.Table(4, 1, List.of(new GameHost.Table.Seat(17, "Burn", "Lightning Bolt"), new GameHost.Table.Seat(12, "Bob Deck", null)))));

        JsonObject res = adminList();
        JsonObject guest = byId(res, g[0]);
        assertEquals(guest.get("mode").getAsString(), "pvp");
        assertTrue(guest.get("waiting").getAsBoolean());
        assertTrue(guest.get("guests").getAsBoolean());
        assertEquals(guest.getAsJsonArray("players").size(), 1);
        assertEquals(guest.getAsJsonArray("players").get(0).getAsJsonObject().get("name").getAsString(), "alice");
        assertFalse(guest.getAsJsonArray("players").get(0).getAsJsonObject().get("connected").getAsBoolean());

        final JsonObject fr = byId(res, friend);
        assertFalse(fr.has("waiting"));
        assertFalse(fr.has("guests"), "a link without guests");
        assertEquals(fr.getAsJsonArray("players").get(1).getAsJsonObject().get("name").getAsString(), "bob");
        assertFalse(fr.getAsJsonArray("players").get(1).getAsJsonObject().has("guest"));
        final JsonObject table = fr.getAsJsonObject("table");
        assertEquals(table.get("turn").getAsInt(), 4);
        assertEquals(table.get("active").getAsInt(), 1);
        assertEquals(table.getAsJsonArray("seats").get(0).getAsJsonObject().get("key").getAsString(), "Lightning Bolt");
        assertEquals(table.getAsJsonArray("seats").get(1).getAsJsonObject().get("deck").getAsString(), "Bob Deck", "an admin sees both decks");
        assertEquals(table.getAsJsonArray("seats").get(1).getAsJsonObject().get("life").getAsInt(), 12);

        final JsonObject a = byId(res, ai);
        assertEquals(a.get("mode").getAsString(), "ai");
        assertEquals(a.getAsJsonArray("players").size(), 1);
        assertFalse(a.has("table"));

        final JsonObject server = res.getAsJsonObject("server");
        assertEquals(server.get("games").getAsInt(), 3);
        assertEquals(server.get("maxMatches").getAsInt(), 20);
        assertEquals(server.get("maxPerUser").getAsInt(), 10);
        assertTrue(server.get("guests").getAsBoolean());
        assertTrue(server.get("online").getAsInt() >= 2, server.toString());
        assertTrue(server.get("started").getAsLong() > 0);
        assertFalse(server.get("build").getAsString().isBlank());

        joinAsGus(g[1]);
        guest = byId(adminList(), g[0]);
        assertFalse(guest.has("waiting"));
        final JsonObject gus = guest.getAsJsonArray("players").get(1).getAsJsonObject();
        assertEquals(gus.get("name").getAsString(), "Gus (guest)");
        assertTrue(gus.get("guest").getAsBoolean());
        assertEquals(gus.get("seat").getAsInt(), 1);
    }

    private JsonObject adminList() throws Exception {
        final HttpResponse<String> r = get("/api/admin/matches", USER, "kai", "X-authentik-groups", "admins");
        assertEquals(r.statusCode(), 200, r.body());
        return json(r);
    }

    private static JsonObject byId(final JsonObject list, final String id) {
        for (final var e : list.getAsJsonArray("matches")) {
            if (e.getAsJsonObject().get("id").getAsString().equals(id)) {
                return e.getAsJsonObject();
            }
        }
        throw new AssertionError("no game " + id + " in " + list);
    }

    /** An expired guest code is refused like a used one. */
    @Test
    public void expiredGuestCodesAreRefused() throws Exception {
        final Router.Options o = options(true);
        o.inviteMs = 300;
        start(o);
        final String[] g = guestGame();
        Thread.sleep(400);
        assertEquals(get("/g/api/decks?code=" + g[1]).statusCode(), 404);
        assertEquals(get("/g/api/art/crop/Lightning%20Bolt?code=" + g[1]).statusCode(), 404);
        assertEquals(guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}").statusCode(), 404);
    }

    // ---------------------------------------------------------------- caps

    /** At most 5 guest joins per address per 10 min (every try counts), and the address is the socket's unless configured. */
    @Test
    public void guestJoinsArePerAddressLimited() throws Exception {
        start(options(true));
        final String bad = "{\"code\":\"" + "0".repeat(32) + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}";
        for (int i = 0; i < 5; i++) {
            assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0." + i).statusCode(), 404, "try " + i);
        }
        final String[] g = guestGame();
        final String good = "{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}";
        final HttpResponse<String> sixth = guestJoin(good, "X-Real-IP", "10.0.0.99");
        assertEquals(sixth.statusCode(), 429, "an unconfigured X-Real-IP is not trusted: all five came from 127.0.0.1");
        clock.addAndGet(10 * 60_000L);
        assertEquals(guestJoin(good).statusCode(), 200, "the window moved on");
        stop();

        final Router.Options o = options(true);
        o.realIpHeader = "X-Real-IP";
        start(o);
        for (int i = 0; i < 5; i++) {
            assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0.1").statusCode(), 404);
        }
        assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0.1").statusCode(), 429);
        assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0.2").statusCode(), 404, "another address has its own budget");
        final String[] g2 = guestGame();
        assertEquals(guestJoin("{\"code\":\"" + g2[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}", "X-Real-IP", "10.0.0.1").statusCode(), 429);
    }

    /**
     * The join limit's address map is bounded (a new address is refused once it is full, after quiet ones are forgotten),
     * and an IPv6 client counts by its /64.
     */
    @Test
    public void addressMapIsBoundedAndIpv6CountsBy64() throws Exception {
        final Router.Options o = options(true);
        o.realIpHeader = "X-Real-IP";
        o.guestJoinAddresses = 3;
        start(o);
        final String bad = "{\"code\":\"" + "0".repeat(32) + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}";
        for (final String ip : new String[] {"10.0.0.1", "10.0.0.2", "10.0.0.3"}) {
            assertEquals(guestJoin(bad, "X-Real-IP", ip).statusCode(), 404, ip);
        }
        final HttpResponse<String> full = guestJoin(bad, "X-Real-IP", "10.0.0.4");
        assertEquals(full.statusCode(), 429, "a new address once the map is full");
        assertTrue(json(full).get("error").getAsString().contains("Too many guests"), full.body());
        assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0.1").statusCode(), 404, "a known address still counts as usual");
        clock.addAndGet(10 * 60_000L);
        assertEquals(guestJoin(bad, "X-Real-IP", "10.0.0.4").statusCode(), 404, "quiet addresses are forgotten to make room");

        // IPv6: one /64 is one budget, however the address is written
        clock.addAndGet(10 * 60_000L);
        for (int i = 1; i <= 5; i++) {
            assertEquals(guestJoin(bad, "X-Real-IP", "2001:db8:0:7::" + Integer.toHexString(i)).statusCode(), 404);
        }
        assertEquals(guestJoin(bad, "X-Real-IP", "2001:0db8:0000:0007:ffff::9").statusCode(), 429, "same /64");
        assertEquals(guestJoin(bad, "X-Real-IP", "2001:db8:0:8::1").statusCode(), 404, "the next /64 is another budget");
        assertEquals(Router.addressKey("2001:db8:0:7::1"), Router.addressKey("[2001:db8:0:7:abcd::2]"));
        assertEquals(Router.addressKey("::ffff:192.0.2.7"), "192.0.2.7");
        assertEquals(Router.addressKey("192.0.2.7"), "192.0.2.7");
        assertEquals(Router.addressKey("not-an-address"), "not-an-address");
        assertEquals(Router.addressKey("::zz"), "::zz", "never a lookup, only literals");
    }

    /** Path tricks under a guest's table never reach another game or a game's internal endpoints. */
    @Test
    public void pathTricksUnderAGuestTable() throws Exception {
        start(options(true));
        final String[] g = guestGame();
        final String id = g[0];
        final String cookie = joinAsGus(g[1]);
        final String other = json(post("alice", "/api/matches", "{}")).get("id").getAsString();
        final Object[][] cases = {
            {"/g/" + id + "/../" + other + "/", 400},
            {"/g/" + id + "/%2e%2e/" + other + "/", 400},
            {"/g/" + id + "/%2E%2E/x", 400},
            {"/g/" + id + "/assets/%2fx", 400},
            {"/g/" + id + "/img/card/..%2F..%2Fx", 400},
            {"/g//" + id + "/", 404},
            {"/g/" + id + "//status", 400},
            {"/g/" + id + "/./status", 400},
            {"/g/" + id + "/seat/concede", 404},
            {"/g/" + id + "/status", 404},
            {"/g/ABCDEF12/", 404}, // upper-case hex is never a game id (ids are lower-case)
            {"/g/" + id + "%2F", 404},
            {"/g/" + other + "/", 403},
        };
        for (final Object[] c : cases) {
            final HttpResponse<String> r = get((String) c[0], "Cookie", cookie);
            assertEquals(r.statusCode(), (int) (Integer) c[1], (String) c[0] + " -> " + r.body());
            assertFalse(r.body().startsWith("attached"), (String) c[0]);
        }
        assertEquals(get("/g/" + id + "/assets/x.js", "Cookie", cookie).body(), "attached " + id + " /assets/x.js", "the control still works");
    }

    /** A guest and a signed-in user racing for the same seat with the same code: exactly one gets it, every time. */
    @Test
    public void aGuestAndAUserRaceForOneSeat() throws Exception {
        final Router.Options o = options(true);
        o.mintLimit = 100;
        start(o);
        final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            for (int i = 0; i < 20; i++) {
                final String[] g = guestGame();
                final java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
                final java.util.concurrent.Future<HttpResponse<String>> guest = pool.submit(() -> {
                    go.await();
                    return guestJoin("{\"code\":\"" + g[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}", "X-Real-IP", "10.1.0." + g[0].length());
                });
                final java.util.concurrent.Future<HttpResponse<String>> user = pool.submit(() -> {
                    go.await();
                    return post("bob", "/api/join", "{\"code\":\"" + g[1] + "\",\"deck\":\"bob-deck\"}");
                });
                go.countDown();
                final int gs = guest.get().statusCode();
                final int us = user.get().statusCode();
                assertTrue((gs == 200) != (us == 200), "exactly one wins: guest " + gs + ", user " + us);
                assertTrue(gs == 200 || gs == 404, "the guest loses with the gone answer: " + gs);
                assertTrue(us == 200 || us == 404 || us == 409, "the user loses with gone or taken: " + us);
                final JsonObject alices = json(get("/api/matches", USER, "alice"));
                for (final com.google.gson.JsonElement e : alices.getAsJsonArray("matches")) {
                    if (e.getAsJsonObject().get("id").getAsString().equals(g[0])) {
                        final String players = e.getAsJsonObject().getAsJsonArray("players").toString();
                        assertTrue(players.contains(gs == 200 ? "Gus (guest)" : "bob") && !players.contains(gs == 200 ? "bob" : "Gus"), players);
                    }
                }
                stub.end(g[0]); // room for the next round (2 guest games at most)
                clock.addAndGet(10 * 60_000L); // and a fresh join budget
            }
        } finally {
            pool.shutdownNow();
        }
    }

    /** At most 2 games with a guest at once on the server; one ending makes room. */
    @Test
    public void atMostTwoGuestGames() throws Exception {
        start(options(true));
        final String[] a = guestGame();
        joinAsGus(a[1]);
        joinAsGus(guestGame()[1]);
        final String[] third = guestGame();
        final HttpResponse<String> full = guestJoin("{\"code\":\"" + third[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}");
        assertEquals(full.statusCode(), 503);
        assertTrue(json(full).get("error").getAsString().contains("2 games with guests"), full.body());
        assertEquals(post("bob", "/api/join", "{\"code\":\"" + third[1] + "\",\"deck\":\"bob-deck\"}").statusCode(), 200, "signed-in players aren't capped by it");
        final String[] fourth = guestGame();
        stub.end(a[0]);
        assertEquals(guestJoin("{\"code\":\"" + fourth[1] + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}").statusCode(), 200, "room again");
    }

    // ---------------------------------------------------------------- first names (--name-header)

    private static final String NAME = "X-authentik-name";

    private HttpResponse<String> postAs(final String user, final String name, final String path, final String body) throws Exception {
        return name == null ? post(user, path, body) : send("POST", path, body, USER, user, NAME, name, "Content-Type", "application/json");
    }

    /**
     * With --name-header, others see a user's first name (the header's first word, cleaned), never the login: in the open
     * list, players[] and the hello stamp; the login when the header is missing or empty. A guest sees only that name.
     */
    @Test
    public void othersSeeFirstNamesNotLogins() throws Exception {
        final Router.Options o = options(true);
        o.nameHeader = NAME;
        start(o);
        final JsonObject g = json(postAs("alice", "Alice  Liddell", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\",\"guests\":true}"));
        final String id = g.get("id").getAsString();
        assertEquals(g.getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"Alice\"}]");
        final JsonObject bobs = json(get("/api/matches", USER, "bob", NAME, "Bob Builder"));
        assertEquals(bobs.getAsJsonArray("open").get(0).getAsJsonObject().get("host").getAsString(), "Alice", "the open list shows the first name");
        assertFalse(bobs.getAsJsonArray("open").toString().contains("alice"), "and never the login");
        assertEquals(bobs.get("user").getAsString(), "bob", "your own login is still yours to see");

        // a guest joins (any name header sent along is ignored under /g/): the creator is "Alice", never "alice"
        final HttpResponse<String> joined = guestJoin("{\"code\":\"" + code(g) + "\",\"name\":\"Gus\",\"deck\":\"shared-deck\"}", NAME, "Mallory Evil",
                USER, "mallory");
        assertEquals(joined.statusCode(), 200, joined.body());
        assertEquals(json(joined).getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"Alice\"},{\"seat\":1,\"name\":\"Gus (guest)\"}]");
        assertFalse(joined.body().contains("alice") || joined.body().contains("Mallory"), joined.body());
        final String set = joined.headers().firstValue("set-cookie").orElseThrow();
        get("/g/" + id + "/img/card/x", "Cookie", set.substring(0, set.indexOf(';')), NAME, "Mallory");
        assertEquals(stub.lastName, "Gus (guest)", "the guest's stamp ignores any name header");
        get("/m/" + id + "/img/card/x", USER, "alice", NAME, "Alice Liddell");
        assertEquals(stub.lastName, "Alice", "the hello stamp carries the first name");

        // a user pvp game: both first names; the fallback is the login
        final JsonObject g2 = json(postAs("alice", "Alice Liddell", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        final JsonObject j2 = json(postAs("bob", "  Bob   Builder ", "/api/join", "{\"code\":\"" + code(g2) + "\",\"deck\":\"bob-deck\"}"));
        assertEquals(j2.getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"Alice\"},{\"seat\":1,\"name\":\"Bob\"}]");
        final JsonObject g3 = json(postAs("carol", null, "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"shared-deck\"}"));
        assertEquals(g3.getAsJsonArray("players").get(0).getAsJsonObject().get("name").getAsString(), "carol", "no header: the login");
        final JsonObject g4 = json(postAs("dave", "   ", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"shared-deck\"}"));
        assertEquals(g4.getAsJsonArray("players").get(0).getAsJsonObject().get("name").getAsString(), "dave", "an empty header: the login");
        // the login stays the identity: alice is still the owner of her game whatever her name header says
        assertEquals(get("/m/" + g2.get("id").getAsString() + "/img/card/x", USER, "alice", NAME, "Someone Else").statusCode(), 200);
        assertEquals(stub.lastSeat, 0);
    }

    /** Without --name-header the name header is never read: everyone is shown by login, as before. */
    @Test
    public void theNameHeaderIsIgnoredWithoutTheFlag() throws Exception {
        start(options(true));
        final JsonObject g = json(postAs("alice", "Alice Liddell", "/api/matches", "{\"mode\":\"pvp\",\"deck\":\"burn\"}"));
        assertEquals(g.getAsJsonArray("players").toString(), "[{\"seat\":0,\"name\":\"alice\"}]");
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--name-header", NAME}));
        assertEquals(Router.parse(new String[] {"--trust-proxy-header", USER, "--name-header", NAME}).nameHeader, NAME);
    }

    @Test
    public void firstNameIsTheFirstWordCleaned() {
        assertEquals(Router.firstName("Alice Liddell"), "Alice");
        assertEquals(Router.firstName("  Alice\tLiddell "), "AliceLiddell", "a tab is a control character: removed, not a space");
        assertEquals(Router.firstName("\u202eEve\u200b Q"), "Eve", "bidi and zero-width characters go");
        assertEquals(Router.firstName(new String("\u202eEve Q".getBytes(java.nio.charset.StandardCharsets.UTF_8), java.nio.charset.StandardCharsets.ISO_8859_1)), "Eve",
                "also when they arrive as raw UTF-8 bytes");
        assertEquals(Router.firstName("Bartholomew-Maximilian-Theodore Smith"), "Bartholomew-Maximilian-T", "24 characters at most");
        assertEquals(Router.firstName(new String("Zoë Quinn".getBytes(java.nio.charset.StandardCharsets.UTF_8), java.nio.charset.StandardCharsets.ISO_8859_1)), "Zoë",
                "UTF-8 bytes as Netty hands them over");
        assertNull(Router.firstName("   "));
        assertNull(Router.firstName("\u0000"));
    }

    // ---------------------------------------------------------------- names and the hello

    /**
     * A game with a guest can't be kept over a restart (the guest's seat lives in this run only), so a drain waits for
     * it; a signed-in user's game against the AI is saved and isn't waited for.
     */
    @Test
    public void aDrainWaitsForAGameWithAGuest() throws Exception {
        final Router.Options o = options(true);
        o.drainTickMs = 50;
        start(o);
        final java.util.concurrent.CountDownLatch drained = new java.util.concurrent.CountDownLatch(1);
        router.onDrained(drained::countDown);
        assertEquals(post("alice", "/api/matches", "{}").statusCode(), 201);
        final String[] g = guestGame();
        joinAsGus(g[1]);
        assertEquals(send("POST", "/admin/drain", null).statusCode(), 200);
        Thread.sleep(300);
        assertEquals(drained.getCount(), 1L, "the game with a guest is still running");
        stub.games.remove(g[0]); // the game ends (leaving a pvp game concedes it; the game itself goes on to its end)
        assertTrue(drained.await(5, java.util.concurrent.TimeUnit.SECONDS), "never drained once the guest's game ended");
        router = null; // stopped by the drain
    }

    @Test
    public void guestNamesAreCleaned() {
        assertEquals(Router.guestName("  Gus  "), "Gus");
        assertEquals(Router.guestName("G\u0000u\u001bs\n"), "Gus");
        assertEquals(Router.guestName("‮Gus​"), "Gus", "bidi and zero-width characters go");
        assertEquals(Router.guestName("Gus   the\tGreat"), "Gus theGreat");
        assertEquals(Router.guestName("a".repeat(30)), "a".repeat(24));
        assertEquals(Router.guestName("😀".repeat(30)), "😀".repeat(24), "24 characters, never half of one");
        assertEquals(Router.guestName("a".repeat(23) + " b"), "a".repeat(23), "trimmed after the cut");
        assertNull(Router.guestName("   "));
        assertNull(Router.guestName("\u0000​"));
        assertNull(Router.guestName(null));
    }

    @Test
    public void theHelloStampsTheGuestsSeatAndName() {
        final JsonObject h = JsonParser.parseString(ChildProcessHost.rewriteHello("{\"t\":\"hello\",\"seat\":0,\"name\":\"alice\",\"token\":\"x\"}", "tok", 1,
                "Gus (guest)")).getAsJsonObject();
        assertEquals(h.get("seat").getAsInt(), 1);
        assertEquals(h.get("name").getAsString(), "Gus (guest)");
        assertEquals(h.get("token").getAsString(), "tok");
    }

    /** Every game id in a lobby list (matches, open, invites): exact, where a substring test of the JSON would also
     *  hit digits inside a created timestamp. */
    private static List<String> ids(final JsonObject list) {
        return java.util.stream.Stream.of("matches", "open", "invites").filter(list::has)
                .flatMap(k -> java.util.stream.StreamSupport.stream(list.getAsJsonArray(k).spliterator(), false))
                .filter(e -> e.isJsonObject()).map(e -> e.getAsJsonObject()).filter(o -> o.has("id")).map(o -> o.get("id").getAsString()).toList();
    }
}

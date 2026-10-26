package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertNotNull;
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
import java.util.Map;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.auth.Pbkdf2Hasher;
import forge.bridge.auth.UserStore;

/**
 * --auth users on a real router: signed-out pages go to the sign-in page, sign in and out, the cookie's attributes,
 * CSRF on every POST, the try limit, a turned-off account, session fixation, admins; and token and header modes as
 * they were, with /api/me added.
 */
public class NativeSignInTest {
    private static final String PW = "correct horse battery";
    private static final String COOKIE = "__Host-ft_session";

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    private Router router;
    private AdminTest.Host host;
    private Path data;

    private Router start() throws Exception {
        final Router.Options o = new Router.Options();
        o.auth.add("users");
        o.maxMatches = 10;
        o.maxPerUser = 5;
        data = Files.createTempDirectory("ft-signin");
        o.dataDir = data;
        final Path web = Files.createDirectories(data.resolve("web"));
        Files.writeString(web.resolve("login.html"), "<head></head><meta property=\"og:url\" content=\"__FT_ORIGIN__/\">sign in");
        Files.writeString(web.resolve("lobby.html"), "lobby");
        Files.writeString(web.resolve("og.png"), "png");
        Files.createDirectories(web.resolve("assets"));
        Files.writeString(web.resolve("assets/login.js"), "js");
        Files.writeString(web.resolve("other.html"), "other");
        o.webDir = web.toString();
        try (UserStore s = store()) {
            s.add("alice", "Alice", Pbkdf2Hasher.hash(PW), false, 0);
            s.add("ana", null, Pbkdf2Hasher.hash(PW), true, 0);
        }
        return start(o);
    }

    private Router start(final Router.Options o) throws Exception {
        host = new AdminTest.Host();
        router = new Router(o, host);
        router.start();
        return router;
    }

    private UserStore store() throws Exception {
        return new UserStore(data.resolve("forge-table.db"));
    }

    @AfterMethod(alwaysRun = true)
    public void stop() {
        if (router != null) {
            router.stop();
            router = null;
        }
    }

    private String origin() {
        return "http://127.0.0.1:" + router.port();
    }

    private HttpResponse<String> send(final String method, final String path, final String body, final String... headers) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(origin() + path));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> login(final String user, final String pw, final String... headers) throws Exception {
        final List<String> h = new ArrayList<>(List.of("Content-Type", "application/json"));
        h.addAll(List.of(headers));
        if (!h.contains("Origin")) {
            h.addAll(List.of("Origin", origin()));
        }
        final JsonObject body = new JsonObject();
        body.addProperty("login", user);
        body.addProperty("password", pw);
        return send("POST", "/auth/login", body.toString(), h.toArray(new String[0]));
    }

    /** {@code __Host-ft_session=<id>} from a sign-in's Set-Cookie. */
    private static String cookie(final HttpResponse<String> r) {
        final String set = r.headers().firstValue("Set-Cookie").orElseThrow();
        return set.substring(0, set.indexOf(';'));
    }

    private String signIn(final String user) throws Exception {
        final HttpResponse<String> r = login(user, PW);
        assertEquals(r.statusCode(), 200, r.body());
        return cookie(r);
    }

    private static JsonObject json(final HttpResponse<String> r) {
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    @Test
    public void signedOutPagesGoToTheSignInPage() throws Exception {
        start();
        final String html = "text/html,application/xhtml+xml";
        HttpResponse<String> r = send("GET", "/", null, "Accept", html);
        assertEquals(r.statusCode(), 302);
        assertEquals(r.headers().firstValue("Location").orElse(""), "/auth/login");
        r = send("GET", "/join/abc123", null, "Accept", html);
        assertEquals(r.headers().firstValue("Location").orElse(""), "/auth/login?next=%2Fjoin%2Fabc123");
        r = send("GET", "/m/abc/", null, "Accept", html);
        assertEquals(r.headers().firstValue("Location").orElse(""), "/auth/login?next=%2Fm%2Fabc%2F");
        assertEquals(send("GET", "/api/matches", null).statusCode(), 401);
        assertEquals(send("GET", "/api/me", null).statusCode(), 401);
        assertEquals(send("GET", "/other.html", null).statusCode(), 401, "only the bundle's open set is open");

        r = send("GET", "/auth/login", null);
        assertEquals(r.statusCode(), 200);
        assertTrue(r.body().contains("<base href=\"/\">"), r.body());
        assertTrue(r.body().contains("content=\"" + origin() + "/\""), "link previews of invite links: " + r.body());
        assertEquals(send("GET", "/assets/login.js", null).statusCode(), 200, "the sign-in page's bundle");
        assertEquals(send("GET", "/og.png", null).statusCode(), 200);
        assertEquals(json(send("GET", "/auth/methods", null)).get("password").getAsBoolean(), true);
        assertEquals(send("GET", "/auth/nothing", null).statusCode(), 404);
        assertEquals(send("PUT", "/auth/login", "{}", "Origin", origin()).statusCode(), 405);
    }

    @Test
    public void signInUseAndSignOut() throws Exception {
        start();
        final HttpResponse<String> wrong = login("alice", "not her password");
        final HttpResponse<String> nobody = login("nobody", PW);
        assertEquals(wrong.statusCode(), 401);
        assertEquals(nobody.statusCode(), 401);
        assertEquals(wrong.body(), nobody.body(), "the same answer for a wrong password and a wrong login");
        assertFalse(wrong.headers().firstValue("Set-Cookie").isPresent());

        final HttpResponse<String> ok = login("  Alice ", PW);
        assertEquals(ok.statusCode(), 200, ok.body());
        assertEquals(json(ok).get("next").getAsString(), "/");
        final String set = ok.headers().firstValue("Set-Cookie").orElseThrow();
        assertTrue(set.startsWith(COOKIE + "="), set);
        for (final String attr : new String[] {"HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"}) {
            assertTrue(set.contains("; " + attr), attr + " in " + set);
        }
        final String alice = cookie(ok);

        final JsonObject me = json(send("GET", "/api/me", null, "Cookie", alice));
        assertEquals(me.get("auth").getAsString(), "users");
        assertEquals(me.get("login").getAsString(), "alice");
        assertEquals(me.get("name").getAsString(), "Alice");
        assertFalse(me.get("admin").getAsBoolean());
        assertEquals(me.get("signOut").getAsString(), "/auth/logout");
        assertEquals(send("POST", "/api/matches", "{}", "Cookie", alice, "Origin", origin(), "Content-Type", "application/json").statusCode(), 201);
        assertEquals(host.games.values().iterator().next().owner(), "alice", "her folders are keyed by her login");
        assertEquals(send("GET", "/api/admin/matches", null, "Cookie", alice).statusCode(), 403);
        assertEquals(send("GET", "/", null, "Cookie", alice, "Accept", "text/html").statusCode(), 200);
        assertEquals(send("GET", "/auth/login?next=/join/x", null, "Cookie", alice).headers().firstValue("Location").orElse(""), "/join/x",
                "already signed in: straight on");

        final String ana = signIn("ana");
        assertTrue(json(send("GET", "/api/me", null, "Cookie", ana)).get("admin").getAsBoolean());
        assertEquals(send("GET", "/api/admin/matches", null, "Cookie", ana).statusCode(), 200);

        final HttpResponse<String> out = send("POST", "/auth/logout", null, "Cookie", alice, "Origin", origin());
        assertEquals(out.statusCode(), 200);
        assertTrue(out.headers().firstValue("Set-Cookie").orElse("").contains("Max-Age=0"));
        assertEquals(send("GET", "/api/me", null, "Cookie", alice).statusCode(), 401, "signed out means the session is gone, not just the cookie");
        assertEquals(send("GET", "/api/me", null, "Cookie", ana).statusCode(), 200, "other sessions untouched");
    }

    @Test
    public void everyPostChecksTheOrigin() throws Exception {
        start();
        assertEquals(login("alice", PW, "Origin", "https://evil.example").statusCode(), 403, "login CSRF");
        final JsonObject body = new JsonObject();
        body.addProperty("login", "alice");
        body.addProperty("password", PW);
        assertEquals(send("POST", "/auth/login", body.toString(), "Content-Type", "application/json").statusCode(), 403, "no Origin, no Sec-Fetch-Site");
        assertEquals(send("POST", "/auth/login", body.toString(), "Content-Type", "application/json", "Sec-Fetch-Site", "same-origin").statusCode(), 200);
        assertEquals(send("POST", "/auth/login", body.toString(), "Content-Type", "application/json", "Sec-Fetch-Site", "cross-site").statusCode(), 403);

        final String alice = signIn("alice");
        assertEquals(send("POST", "/api/matches", "{}", "Cookie", alice, "Content-Type", "application/json").statusCode(), 403);
        assertEquals(send("POST", "/api/matches", "{}", "Cookie", alice, "Origin", "https://evil.example", "Content-Type", "application/json").statusCode(), 403);
        assertEquals(send("POST", "/auth/logout", null, "Cookie", alice, "Origin", "https://evil.example").statusCode(), 403);
        assertEquals(send("GET", "/api/me", null, "Cookie", alice).statusCode(), 200, "a cross-site logout did nothing");
        assertTrue(host.games.isEmpty());

        final String id = json(send("POST", "/api/matches", "{}", "Cookie", alice, "Origin", origin(), "Content-Type", "application/json")).get("id").getAsString();
        assertEquals(send("GET", "/m/" + id + "/ws", null, "Cookie", alice, "Origin", origin()).body(), "attached");
        assertEquals(send("GET", "/m/" + id + "/ws", null, "Cookie", alice, "Origin", "https://evil.example").statusCode(), 403);
        assertEquals(send("GET", "/m/" + id + "/ws", null, "Cookie", alice).statusCode(), 403, "a socket without Origin isn't a browser on this page");
        assertEquals(send("GET", "/m/" + id + "/ws", null, "Cookie", signIn("ana"), "Origin", origin()).statusCode(), 403, "not ana's game");
    }

    @Test
    public void wrongGuessesWaitAndTurnedOffAccountsAreOut() throws Exception {
        start();
        for (int i = 0; i < 5; i++) {
            assertEquals(login("alice", "guess number " + i).statusCode(), 401);
        }
        assertEquals(login("alice", PW).statusCode(), 429, "even the right password waits now");
        assertEquals(login("ana", PW).statusCode(), 200, "other logins don't");

        final String ana = signIn("ana");
        try (UserStore s = store()) {
            s.setDisabled(s.user("ana").id(), true);
        }
        assertEquals(send("GET", "/api/me", null, "Cookie", ana).statusCode(), 401, "out on the next request");
        final HttpResponse<String> off = login("ana", PW);
        assertEquals(off.statusCode(), 403);
        assertTrue(off.body().contains("turned off"), off.body());
    }

    @Test
    public void guessesFiredAtOnceStillWait() throws Exception {
        start();
        final List<java.util.concurrent.CompletableFuture<HttpResponse<String>>> burst = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            final JsonObject body = new JsonObject();
            body.addProperty("login", "alice");
            body.addProperty("password", "guess number " + i);
            burst.add(http.sendAsync(HttpRequest.newBuilder(URI.create(origin() + "/auth/login"))
                    .header("Content-Type", "application/json").header("Origin", origin())
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(), HttpResponse.BodyHandlers.ofString()));
        }
        int checked = 0;
        for (final var f : burst) {
            final int status = f.get().statusCode();
            assertTrue(status == 401 || status == 429, "status " + status);
            checked += status == 401 ? 1 : 0;
        }
        assertTrue(checked <= 5, checked + " guesses were checked, the limit is 5");
        assertEquals(login("alice", PW).statusCode(), 429, "the right password waits too");
    }

    @Test
    public void everySignInGetsANewSession() throws Exception {
        start();
        final String first = signIn("alice");
        final HttpResponse<String> again = login("alice", PW, "Cookie", first);
        final String second = cookie(again);
        assertNotEquals(second, first);
        assertEquals(send("GET", "/api/me", null, "Cookie", first).statusCode(), 401, "the cookie it came with is dead");
        assertEquals(send("GET", "/api/me", null, "Cookie", second).statusCode(), 200);
        assertEquals(send("GET", "/api/me", null, "Cookie", first + "; " + second).statusCode(), 401, "two session cookies: neither");
        assertEquals(send("GET", "/api/me", null, "Cookie", "ft_session=" + second.substring(COOKIE.length() + 1)).statusCode(), 401,
                "only the __Host- name counts");
    }

    @Test
    public void nextStaysOnThisSite() throws Exception {
        for (final String bad : new String[] {null, "", "https://evil.example/", "//evil.example", "/\\evil.example", "\\\\evil", "/ok\r\nSet-Cookie: x",
                "/auth/login", "/auth/logout", "javascript:alert(1)", "/" + "a".repeat(600)}) {
            assertEquals(AuthRoutes.safeNext(bad), "/", String.valueOf(bad));
        }
        assertEquals(AuthRoutes.safeNext("/join/abc"), "/join/abc");
        assertEquals(AuthRoutes.safeNext("/m/abc/?x=1"), "/m/abc/?x=1");
        start();
        final JsonObject body = new JsonObject();
        body.addProperty("login", "alice");
        body.addProperty("password", PW);
        body.addProperty("next", "//evil.example/");
        assertEquals(json(send("POST", "/auth/login", body.toString(), "Origin", origin())).get("next").getAsString(), "/");
    }

    @Test
    public void settings() {
        final String ip = "--real-ip-header";
        assertTrue(Router.parse(new String[] {"--router", "--auth", "users", ip, "X-Real-IP"}).sessions());
        assertTrue(Router.parseArgs(Router.withDefaults(new String[] {"--router"}, Map.of("FT_AUTH", "users", "FT_REAL_IP_HEADER", "X-Real-IP")))
                .sessions());
        assertEquals(Router.parse(new String[] {"--router", "--auth", "users", ip, "X-Real-IP", "--session-idle-days", "2"}).sessionIdleMs,
                2 * Router.DAY_MS);
        final IllegalArgumentException noIp = expectThrows(IllegalArgumentException.class,
                () -> Router.parse(new String[] {"--router", "--auth", "users"}));
        assertTrue(noIp.getMessage().contains("--real-ip-header"), noIp.getMessage());
        expectThrows(IllegalArgumentException.class, () -> Router.parse(new String[] {"--router", "--auth", "users", ip, ""}));
        for (final String[] bad : List.of(
                new String[] {"--router", "--auth", "users,header", "--trust-proxy-header", "X-User"},
                new String[] {"--router", "--auth", "users,token"},
                new String[] {"--router", "--auth", "users", "--trust-proxy-header", "X-User"},
                new String[] {"--router", "--auth", "header"},
                new String[] {"--router", "--auth", "token", "--trust-proxy-header", "X-User"},
                new String[] {"--router", "--auth", "kerberos"},
                new String[] {"--router", "--insecure-cookies"},
                new String[] {"--router", "--auth", "users", ip, "X-Real-IP", "--session-idle-days", "0"},
                new String[] {"--router", "--auth", "users", ip, "X-Real-IP", "--session-idle-days", "40"},
                new String[] {"--router", "--auth", "users", ip, "X-Real-IP", "--session-max-days", "x"},
                new String[] {"--router", "--logout-url", "/oauth2/sign_out"},
                new String[] {"--router", "--trust-proxy-header", "X-User", "--logout-url", "javascript:alert(1)"},
                new String[] {"--router", "--trust-proxy-header", "X-User", "--logout-url", "//evil.example"},
                new String[] {"--router", "--guests", "--real-ip-header", "X-Real-IP"})) {
            expectThrows(IllegalArgumentException.class, () -> Router.parse(bad));
        }
        assertTrue(Router.parse(new String[] {"--router", "--auth", "users", "--guests", "--real-ip-header", "X-Real-IP"}).guests);
        assertTrue(Router.parse(new String[] {"--router", "--auth", "users", ip, "X-Real-IP", "--insecure-cookies"}).insecureCookies);
        assertEquals(Router.parse(new String[] {"--router", "--trust-proxy-header", "X-User", "--auth", "header", "--logout-url", "/oauth2/sign_out"}).logoutUrl,
                "/oauth2/sign_out");
        assertEquals(Router.parse(new String[] {"--router", "--trust-proxy-header", "X-User", "--logout-url", ""}).logoutUrl, null);
        assertNotNull(Router.checkBind("10.0.0.5", Router.parse(new String[] {"--router", "--auth", "users", ip, "X-Real-IP"}).multiUser()));
    }

    @Test
    public void tokenModeIsAsItWas() throws Exception {
        final Router.Options o = new Router.Options();
        o.dataDir = Files.createTempDirectory("ft-token");
        start(o);
        final JsonObject me = json(send("GET", "/api/me", null, Router.TOKEN_HEADER, router.token()));
        assertEquals(me.get("auth").getAsString(), "token");
        assertEquals(me.get("login").getAsString(), "local");
        assertTrue(me.get("admin").getAsBoolean());
        assertFalse(me.has("signOut"));
        assertEquals(send("GET", "/api/me", null).statusCode(), 401);
        assertEquals(send("GET", "/auth/login", null).statusCode(), 404);
        assertFalse(Files.exists(o.dataDir.resolve("forge-table.db")), "no database outside --auth users");
    }

    @Test
    public void headerModeIsAsItWas() throws Exception {
        final Router.Options o = new Router.Options();
        o.dataDir = Files.createTempDirectory("ft-header");
        o.trustHeader = "X-Forwarded-User";
        o.groupsHeader = "X-Forwarded-Groups";
        o.groupsSeparator = "|";
        o.adminGroup = "admins";
        o.logoutUrl = "/oauth2/sign_out";
        start(o);
        final JsonObject ana = json(send("GET", "/api/me", null, o.trustHeader, "ana", o.groupsHeader, "players|admins"));
        assertEquals(ana.get("auth").getAsString(), "header");
        assertTrue(ana.get("admin").getAsBoolean());
        assertEquals(ana.get("logoutUrl").getAsString(), "/oauth2/sign_out");
        assertFalse(json(send("GET", "/api/me", null, o.trustHeader, "liam", o.groupsHeader, "players")).get("admin").getAsBoolean());
        assertEquals(send("GET", "/auth/login", null, o.trustHeader, "ana").statusCode(), 404);
        assertFalse(Files.exists(o.dataDir.resolve("forge-table.db")));
    }
}

package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import forge.bridge.auth.OidcLogin;
import forge.bridge.auth.Pbkdf2Hasher;
import forge.bridge.auth.UserStore;

/**
 * --auth oidc on a real router against a small fake provider (discovery, authorize, token, userinfo): the whole
 * sign-in, a state that's stale, reused or from another browser, the collision rule and --link-by-login, a rename at
 * the provider, --require-group and --admin-group, claims from userinfo, signing out at the provider, and the settings.
 */
public class OidcSignInTest {
    private static final String CLIENT = "forge-table";
    private static final String SECRET = "s3cret-for-tests";
    private static final String PUBLIC = "https://ft.example";
    private static final String CALLBACK = PUBLIC + "/auth/oidc/callback";

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    private Router router;
    private Idp idp;
    private Path data;

    /**
     * The fake provider. {@link #person} is who signs in at {@code /authorize} next (claims beyond iss, aud, exp, iat and
     * nonce); {@link #userinfo} what {@code /userinfo} answers (null: the ID token claims). The token endpoint checks
     * the client's Basic credentials, the redirect URI and the PKCE verifier, and a code works once.
     */
    static final class Idp implements AutoCloseable {
        final HttpServer server;
        final String issuer;
        volatile JsonObject person = new JsonObject();
        volatile JsonObject userinfo;
        final Map<String, Grant> codes = new ConcurrentHashMap<>();
        final Map<String, JsonObject> tokens = new ConcurrentHashMap<>();
        final List<String> refusals = new ArrayList<>();

        record Grant(String nonce, String challenge, String redirect, JsonObject person) { }

        Idp() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            issuer = "http://127.0.0.1:" + server.getAddress().getPort() + "/realm";
            server.createContext("/realm/.well-known/openid-configuration", x -> {
                final JsonObject d = new JsonObject();
                d.addProperty("issuer", issuer);
                d.addProperty("authorization_endpoint", issuer + "/authorize");
                d.addProperty("token_endpoint", issuer + "/token");
                d.addProperty("userinfo_endpoint", issuer + "/userinfo");
                d.addProperty("end_session_endpoint", issuer + "/logout");
                send(x, 200, d);
            });
            server.createContext("/realm/authorize", this::authorize);
            server.createContext("/realm/token", this::token);
            server.createContext("/realm/userinfo", this::userinfo);
            server.start();
        }

        /** Signs {@link #person} in at once and sends the browser back with a code, like a provider would. */
        private void authorize(final HttpExchange x) throws IOException {
            final Map<String, String> q = query(x.getRequestURI().getRawQuery());
            if (!CLIENT.equals(q.get("client_id")) || !"code".equals(q.get("response_type")) || !"S256".equals(q.get("code_challenge_method"))
                    || q.get("nonce") == null || q.get("state") == null || !q.get("scope").contains("openid")) {
                send(x, 400, error("invalid_request"));
                return;
            }
            final String code = UUID.randomUUID().toString();
            codes.put(code, new Grant(q.get("nonce"), q.get("code_challenge"), q.get("redirect_uri"), person.deepCopy()));
            x.getResponseHeaders().set("Location", q.get("redirect_uri") + "?code=" + code + "&state=" + enc(q.get("state")) + "&iss=" + enc(issuer));
            x.sendResponseHeaders(302, -1);
            x.close();
        }

        private void token(final HttpExchange x) throws IOException {
            final Map<String, String> f = query(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            final String basic = "Basic " + Base64.getEncoder().encodeToString((CLIENT + ":" + SECRET).getBytes(StandardCharsets.UTF_8));
            final Grant g = f.get("code") == null ? null : codes.remove(f.get("code"));
            final String why = !basic.equals(x.getRequestHeaders().getFirst("Authorization")) ? "client"
                    : !"authorization_code".equals(f.get("grant_type")) ? "grant_type"
                    : g == null ? "code"
                    : !g.redirect().equals(f.get("redirect_uri")) ? "redirect_uri"
                    : !g.challenge().equals(s256(f.get("code_verifier"))) ? "code_verifier" : null;
            if (why != null) {
                refusals.add(why);
                send(x, 400, error("invalid_grant"));
                return;
            }
            final long now = System.currentTimeMillis() / 1000;
            final JsonObject t = g.person().deepCopy();
            t.addProperty("iss", issuer);
            t.addProperty("aud", CLIENT);
            t.addProperty("exp", now + 300);
            t.addProperty("iat", now);
            t.addProperty("nonce", g.nonce());
            final String access = UUID.randomUUID().toString();
            tokens.put(access, g.person());
            final JsonObject r = new JsonObject();
            r.addProperty("id_token", jwt(t));
            r.addProperty("access_token", access);
            r.addProperty("token_type", "Bearer");
            send(x, 200, r);
        }

        private void userinfo(final HttpExchange x) throws IOException {
            final String auth = x.getRequestHeaders().getFirst("Authorization");
            final JsonObject p = auth == null || !auth.startsWith("Bearer ") ? null : tokens.get(auth.substring(7));
            if (p == null) {
                send(x, 401, error("invalid_token"));
                return;
            }
            send(x, 200, userinfo == null ? p : userinfo);
        }

        @Override
        public void close() {
            server.stop(0);
        }

        private static JsonObject error(final String code) {
            final JsonObject e = new JsonObject();
            e.addProperty("error", code);
            return e;
        }

        private static void send(final HttpExchange x, final int status, final JsonObject body) throws IOException {
            final byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
            x.getResponseHeaders().set("Content-Type", "application/json");
            x.sendResponseHeaders(status, b.length);
            x.getResponseBody().write(b);
            x.close();
        }
    }

    /** Who signs in at the provider next. */
    private void person(final String sub, final String login, final String name, final String... groups) {
        final JsonObject p = new JsonObject();
        p.addProperty("sub", sub);
        if (login != null) {
            p.addProperty("preferred_username", login);
        }
        if (name != null) {
            p.addProperty("given_name", name);
        }
        final JsonArray g = new JsonArray();
        for (final String s : groups) {
            g.add(s);
        }
        p.add("groups", g);
        idp.person = p;
    }

    private Router.Options options(final String auth) throws Exception {
        idp = new Idp();
        final Router.Options o = new Router.Options();
        for (final String a : auth.split(",")) {
            o.auth.add(a);
        }
        o.maxMatches = 10;
        o.maxPerUser = 5;
        o.publicUrl = PUBLIC;
        o.oidcIssuer = idp.issuer;
        o.oidcClientId = CLIENT;
        o.oidcInsecure = true;
        data = Files.createTempDirectory("ft-oidc");
        o.dataDir = data;
        final Path secret = data.resolve("client-secret");
        Files.writeString(secret, SECRET + "\n");
        o.oidcClientSecretFile = secret;
        final Path web = Files.createDirectories(data.resolve("web"));
        Files.writeString(web.resolve("login.html"), "<head></head>sign in");
        Files.writeString(web.resolve("lobby.html"), "lobby");
        o.webDir = web.toString();
        return o;
    }

    private Router start(final Router.Options o) throws Exception {
        router = new Router(o, new AdminTest.Host());
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
        if (idp != null) {
            idp.close();
            idp = null;
        }
    }

    private String origin() {
        return "http://127.0.0.1:" + router.port();
    }

    private HttpResponse<String> send(final String method, final String url, final String body, final String... headers) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url.startsWith("/") ? origin() + url : url));
        for (int i = 0; i < headers.length; i += 2) {
            b.header(headers[i], headers[i + 1]);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String location(final HttpResponse<String> r) {
        assertEquals(r.statusCode(), 302, r.body());
        return r.headers().firstValue("Location").orElseThrow();
    }

    /** {@code name=value} of the Set-Cookie for {@code name}, or null (a clearing one counts, with an empty value). */
    private static String cookie(final HttpResponse<String> r, final String name) {
        for (final String set : r.headers().allValues("Set-Cookie")) {
            if (set.startsWith(name + "=")) {
                return set.substring(0, set.indexOf(';'));
            }
        }
        return null;
    }

    /** One started sign-in: the provider's callback query for it, and this browser's pre-login cookie. */
    private record Flow(String callbackQuery, String preLogin, String authorize) { }

    /** Starts a sign-in and goes through the provider; stops right before the browser comes back to us. */
    private Flow begin(final String next) throws Exception {
        final HttpResponse<String> s = send("GET", "/auth/oidc/start" + (next == null ? "" : "?next=" + enc(next)), null);
        final String authorize = location(s);
        assertTrue(authorize.startsWith(idp.issuer + "/authorize?"), authorize);
        assertEquals(s.headers().firstValue("Cache-Control").orElse(""), "no-store");
        final String preLogin = cookie(s, "__Host-ft_oidc");
        assertNotNull(preLogin);
        final String back = location(send("GET", authorize, null));
        assertTrue(back.startsWith(CALLBACK + "?"), back);
        return new Flow(back.substring(CALLBACK.length() + 1), preLogin, authorize);
    }

    private HttpResponse<String> callback(final String query, final String... cookies) throws Exception {
        return cookies.length == 0 ? send("GET", "/auth/oidc/callback?" + query, null)
                : send("GET", "/auth/oidc/callback?" + query, null, "Cookie", String.join("; ", cookies));
    }

    /** A whole sign-in as whoever {@link #person} is: the session cookie, or null and the sign-in page's error in {@code why}. */
    private String signIn(final String[] why) throws Exception {
        final Flow f = begin(null);
        final HttpResponse<String> r = callback(f.callbackQuery(), f.preLogin());
        final String to = location(r);
        assertEquals(cookie(r, "__Host-ft_oidc"), "__Host-ft_oidc=", "the pre-login cookie is cleared either way");
        final String session = cookie(r, "__Host-ft_session");
        if (why != null) {
            why[0] = to;
        }
        return session;
    }

    private String signIn() throws Exception {
        final String[] why = new String[1];
        final String s = signIn(why);
        assertNotNull(s, why[0]);
        return s;
    }

    private String refused() throws Exception {
        final String[] why = new String[1];
        assertNull(signIn(why), why[0]);
        return why[0];
    }

    private JsonObject me(final String session) throws Exception {
        final HttpResponse<String> r = send("GET", "/api/me", null, "Cookie", session);
        assertEquals(r.statusCode(), 200, r.body());
        return JsonParser.parseString(r.body()).getAsJsonObject();
    }

    @Test
    public void signInWithTheProvider() throws Exception {
        start(options("oidc"));
        final JsonObject methods = JsonParser.parseString(send("GET", "/auth/methods", null).body()).getAsJsonObject();
        assertFalse(methods.get("password").getAsBoolean());
        assertEquals(methods.getAsJsonObject("oidc").get("label").getAsString(), "Sign in with SSO");
        final HttpResponse<String> pw = send("POST", "/auth/login", "{\"login\":\"ana\",\"password\":\"x\"}", "Origin", origin(),
                "Content-Type", "application/json");
        assertEquals(pw.statusCode(), 404, "no password sign-in under --auth oidc alone");

        person("sub-ana", " Ana.L ", "Ana");
        final Flow f = begin("/join/abc123");
        final Map<String, String> asked = query(URI.create(f.authorize()).getRawQuery());
        assertEquals(asked.get("redirect_uri"), CALLBACK);
        assertEquals(asked.get("scope"), "openid profile email");
        final HttpResponse<String> r = callback(f.callbackQuery(), f.preLogin());
        assertEquals(location(r), "/join/abc123", "back to where they were going");
        final String session = cookie(r, "__Host-ft_session");
        assertNotNull(session);
        assertTrue(r.headers().allValues("Set-Cookie").stream().anyMatch(c -> c.startsWith("__Host-ft_session=") && c.contains("HttpOnly")
                && c.contains("Secure") && c.contains("SameSite=Lax")));
        final JsonObject me = me(session);
        assertEquals(me.get("login").getAsString(), "Ana.L", "trimmed, not case-folded: header mode's folders line up");
        assertEquals(me.get("name").getAsString(), "Ana");
        assertFalse(me.get("admin").getAsBoolean());
        assertEquals(send("GET", "/api/matches", null, "Cookie", session).statusCode(), 200);
        try (UserStore s = store()) {
            final UserStore.User u = s.user("Ana.L");
            assertNull(u.passwordHash(), "an OIDC account has no password");
            assertEquals(s.links(u.id()), List.of(new UserStore.Link("oidc:" + idp.issuer, "sub-ana")));
        }
        assertTrue(idp.refusals.isEmpty(), idp.refusals.toString());

        // the same callback again (a replay, or the back button) is stale, even with the right cookie
        assertEquals(location(callback(f.callbackQuery(), f.preLogin())), "/auth/login?error=oidc-stale");
    }

    @Test
    public void aStateWorksOnceAndOnlyInItsBrowser() throws Exception {
        start(options("oidc"));
        person("sub-ana", "ana", null);
        final Flow f = begin(null);
        assertEquals(location(callback(f.callbackQuery())), "/auth/login?error=oidc-stale", "no pre-login cookie");
        // knowing the state isn't enough to use it up: the right browser still finishes, once
        assertEquals(location(callback(f.callbackQuery(), f.preLogin())), "/");
        assertEquals(location(callback(f.callbackQuery(), f.preLogin())), "/auth/login?error=oidc-stale");

        final Flow g = begin(null);
        final Flow other = begin(null);
        assertEquals(location(callback(g.callbackQuery(), other.preLogin())), "/auth/login?error=oidc-stale", "another browser's cookie");
        assertEquals(location(callback("state=made-up&code=x", other.preLogin())), "/auth/login?error=oidc-stale");
        final String o = location(callback(other.callbackQuery(), other.preLogin()));
        assertEquals(o, "/", "the other browser's own sign-in still works");

        final Flow d = begin("/m/abc/");
        final String state = query(d.callbackQuery()).get("state");
        assertEquals(location(callback("error=access_denied&state=" + enc(state), d.preLogin())), "/auth/login?error=oidc-denied");
        // a failed try in the right browser uses the state up: it can't be finished after all
        assertEquals(location(callback(d.callbackQuery(), d.preLogin())), "/auth/login?error=oidc-stale");
        final Flow w = begin(null);
        final String q = w.callbackQuery().replaceFirst("iss=[^&]*", "iss=" + enc("https://elsewhere.example"));
        assertEquals(location(callback(q, w.preLogin())), "/auth/login?error=oidc-provider", "RFC 9207: another issuer's callback");

        final Flow t = begin(null);
        final String sealed = t.preLogin().substring(t.preLogin().indexOf('=') + 1);
        final char last = sealed.charAt(sealed.length() - 2);
        final String tampered = "__Host-ft_oidc=" + sealed.substring(0, sealed.length() - 2) + (last == 'A' ? 'B' : 'A') + sealed.charAt(sealed.length() - 1);
        assertEquals(location(callback(t.callbackQuery(), tampered)), "/auth/login?error=oidc-stale", "a changed cookie doesn't open");
    }

    @Test
    public void aFloodOfStartsBlocksNobody() throws Exception {
        start(options("oidc"));
        person("sub-ana", "ana", null);
        // anyone can start a sign-in and nothing is kept for one, so far more starts than any cap leave room for real ones
        final OidcLogin login = new OidcLogin(new OidcLogin.Config(idp.issuer, CLIENT, SECRET, "openid profile email", "preferred_username",
                List.of("given_name"), null, CALLBACK, true), System::currentTimeMillis);
        for (int i = 0; i < 50_000; i++) {
            login.start("/");
        }
        // callbacks with valid cookies fill the used states past their cap; the oldest go, nobody is refused for it
        for (int i = 0; i < 120_000; i++) {
            final OidcLogin.Start j = login.start("/");
            final String state = query(URI.create(j.location()).getRawQuery()).get("state");
            assertEquals(expectThrows(OidcLogin.Failure.class, () -> login.finish(state, null, "access_denied", null, j.cookie())).code, "denied");
        }
        final OidcLogin.Start s = login.start("/m/abc/");
        final String back = location(send("GET", s.location(), null));
        final Map<String, String> q = query(back.substring(CALLBACK.length() + 1));
        final OidcLogin.Done d = login.finish(q.get("state"), q.get("code"), null, q.get("iss"), s.cookie());
        assertEquals(d.identity().login(), "ana");
        assertEquals(d.next(), "/m/abc/");
        final OidcLogin.Start again = login.start("/");
        assertEquals(expectThrows(OidcLogin.Failure.class, () -> login.finish(query(URI.create(again.location()).getRawQuery()).get("state"),
                "x", null, null, s.cookie())).code, "stale", "one sign-in's cookie doesn't finish another");

        // the same through the router: a burst of starts, then a whole sign-in
        for (int i = 0; i < 300; i++) {
            assertEquals(send("GET", "/auth/oidc/start", null).statusCode(), 302);
        }
        signIn();
        // a next too long for the cookie once sealed (512 characters of 3 bytes each) still signs in, and goes home
        final OidcLogin.Start longNext = login.start("/" + "中".repeat(511));
        assertTrue(longNext.cookie().length() <= 2048, longNext.cookie().length() + " (MAX_COOKIE)");
        final Map<String, String> lq = query(location(send("GET", longNext.location(), null)).substring(CALLBACK.length() + 1));
        assertEquals(login.finish(lq.get("state"), lq.get("code"), null, lq.get("iss"), longNext.cookie()).next(), "/");
        // a cookie sealed by another router (or this one before a restart) doesn't open here
        final String state = query(URI.create(s.location()).getRawQuery()).get("state");
        assertEquals(location(callback("state=" + enc(state) + "&code=x", "__Host-ft_oidc=" + s.cookie())), "/auth/login?error=oidc-stale");
    }

    @Test
    public void aLoginThatIsTakenIsRefused() throws Exception {
        final Router.Options o = options("users,oidc");
        o.realIpHeader = "X-Real-IP";
        try (UserStore s = store()) {
            s.add("ana", null, Pbkdf2Hasher.hash("correct horse battery"), false, 0);
        }
        start(o);
        person("sub-1", "ana", null);
        assertEquals(refused(), "/auth/login?error=oidc-taken", "no account takeover by a matching name at the provider");
        try (UserStore s = store()) {
            assertTrue(s.links(s.user("ana").id()).isEmpty());
        }
    }

    @Test
    public void linkByLoginTakesTheAccountOnceAndRenamesKeepIt() throws Exception {
        final Router.Options o = options("users,oidc");
        o.realIpHeader = "X-Real-IP";
        o.linkByLogin = true;
        final long id;
        try (UserStore s = store()) {
            id = s.add("ana", null, Pbkdf2Hasher.hash("correct horse battery"), false, 0).id();
        }
        start(o);
        person("sub-1", "ana", "Ana");
        assertEquals(me(signIn()).get("login").getAsString(), "ana");
        try (UserStore s = store()) {
            assertEquals(s.links(id), List.of(new UserStore.Link("oidc:" + idp.issuer, "sub-1")));
        }
        person("sub-2", "ana", null);
        assertEquals(refused(), "/auth/login?error=oidc-taken", "a second subject with the same login doesn't get the account");

        // renamed at the provider: still the same account (and folder), found by its subject
        person("sub-1", "ana-lopez", "Ana L");
        final JsonObject me = me(signIn());
        assertEquals(me.get("login").getAsString(), "ana");
        assertEquals(me.get("name").getAsString(), "Ana L", "the shown name follows the provider");
        try (UserStore s = store()) {
            assertNull(s.user("ana-lopez"));
        }
    }

    @Test
    public void groupsGateAndMakeAdmins() throws Exception {
        final Router.Options o = options("oidc");
        o.requireGroup = "players";
        o.adminGroup = "ft-admins";
        start(o);
        person("sub-1", "bo", null, "others");
        assertEquals(refused(), "/auth/login?error=oidc-group");
        person("sub-1", "bo", null, "players");
        final String player = signIn();
        assertFalse(me(player).get("admin").getAsBoolean());
        assertEquals(send("GET", "/api/admin/matches", null, "Cookie", player).statusCode(), 403);
        person("sub-2", "cy", null, "players", "ft-admins");
        final String admin = signIn();
        assertTrue(me(admin).get("admin").getAsBoolean());
        assertEquals(send("GET", "/api/admin/matches", null, "Cookie", admin).statusCode(), 200);
        // admin by group lasts as long as that session: the next sign-in without the group isn't
        person("sub-2", "cy", null, "players");
        assertFalse(me(signIn()).get("admin").getAsBoolean());
    }

    @Test
    public void claimsMissingFromTheIdTokenComeFromUserinfo() throws Exception {
        start(options("oidc"));
        final JsonObject bare = new JsonObject();
        bare.addProperty("sub", "sub-9");
        idp.person = bare;
        final JsonObject info = new JsonObject();
        info.addProperty("sub", "sub-9");
        info.addProperty("preferred_username", "dee");
        info.addProperty("name", "Dee Dee");
        idp.userinfo = info;
        final JsonObject me = me(signIn());
        assertEquals(me.get("login").getAsString(), "dee");
        assertEquals(me.get("name").getAsString(), "Dee Dee");

        info.addProperty("sub", "someone-else");
        assertEquals(refused(), "/auth/login?error=oidc-provider", "userinfo for another subject is refused");
        idp.userinfo = null;
        assertEquals(refused(), "/auth/login?error=oidc-provider", "no login claim anywhere");
    }

    @Test
    public void signingOutAtTheProvider() throws Exception {
        final Router.Options o = options("users,oidc");
        o.realIpHeader = "X-Real-IP";
        o.oidcLogout = "provider";
        try (UserStore s = store()) {
            s.add("ana", null, Pbkdf2Hasher.hash("correct horse battery"), false, 0);
        }
        start(o);
        person("sub-1", "bo", null);
        final String session = signIn();
        HttpResponse<String> r = send("POST", "/auth/logout", "{}", "Cookie", session, "Origin", origin());
        assertEquals(r.statusCode(), 200);
        final JsonObject out = JsonParser.parseString(r.body()).getAsJsonObject();
        assertEquals(out.get("endSession").getAsString(),
                idp.issuer + "/logout?client_id=" + CLIENT + "&post_logout_redirect_uri=" + enc(PUBLIC + "/auth/login"));
        assertEquals(send("GET", "/api/me", null, "Cookie", session).statusCode(), 401, "signed out here too");

        // a local account has nothing to sign out of at the provider
        r = send("POST", "/auth/login", "{\"login\":\"ana\",\"password\":\"correct horse battery\"}", "Origin", origin(),
                "Content-Type", "application/json", "X-Real-IP", "10.0.0.7");
        assertEquals(r.statusCode(), 200, r.body());
        r = send("POST", "/auth/logout", "{}", "Cookie", cookie(r, "__Host-ft_session"), "Origin", origin());
        assertFalse(JsonParser.parseString(r.body()).getAsJsonObject().has("endSession"));
    }

    @Test
    public void settings() throws Exception {
        final String[] base = {"--router", "--auth", "oidc", "--oidc-issuer", "https://idp.example/realm", "--oidc-client-id", CLIENT,
                "--public-url", PUBLIC};
        final Router.Options o = Router.parse(base);
        assertTrue(o.sessions());
        assertEquals(o.oidcLoginClaim, "preferred_username");
        assertEquals(o.oidcLogout, "local");
        final Router.Options env = Router.parseArgs(Router.withDefaults(new String[] {"--router"}, Map.of("FT_AUTH", "oidc",
                "FT_OIDC_ISSUER", "https://idp.example/realm", "FT_OIDC_CLIENT_ID", CLIENT, "FT_PUBLIC_URL", PUBLIC,
                "FT_OIDC_LOGIN_CLAIM", "email", "FT_LINK_BY_LOGIN", "true", "FT_OIDC_LOGOUT", "provider")));
        assertEquals(env.oidcLoginClaim, "email");
        assertTrue(env.linkByLogin);
        assertEquals(env.oidcLogout, "provider");
        assertEquals(Router.parse(plus(base, "--require-group", "players")).requireGroup, "players", "groups come from the provider");

        for (final String[] bad : List.of(
                new String[] {"--router", "--auth", "oidc", "--oidc-issuer", "https://idp.example/realm", "--oidc-client-id", CLIENT},
                new String[] {"--router", "--auth", "oidc", "--oidc-client-id", CLIENT, "--public-url", PUBLIC},
                plus(base, "--oidc-issuer", "http://idp.example/realm"),
                plus(base, "--oidc-issuer", "https://idp.example/realm?x=1"),
                plus(base, "--oidc-scopes", "profile email"),
                plus(base, "--oidc-logout", "everywhere"),
                plus(base, "--oidc-label", ""),
                new String[] {"--router", "--trust-proxy-header", "X-User", "--oidc-issuer", "https://idp.example/realm"},
                new String[] {"--router", "--auth", "users", "--real-ip-header", "X-Real-IP", "--link-by-login"},
                new String[] {"--router", "--auth", "oidc,header", "--trust-proxy-header", "X-User"})) {
            expectThrows(IllegalArgumentException.class, () -> Router.parse(bad));
        }
        assertTrue(Router.parse(plus(base, "--oidc-issuer", "http://127.0.0.1:9/realm", "--oidc-insecure")).oidcInsecure);

        final Router.Options missing = Router.parse(plus(base, "--oidc-client-secret-file", "/nonexistent/forge-table-secret"));
        final IllegalArgumentException e = expectThrows(IllegalArgumentException.class, () -> new Router(missing, new AdminTest.Host()));
        assertTrue(e.getMessage().contains("--oidc-client-secret-file"), e.getMessage());
    }

    // ---------------------------------------------------------------- bits

    private static String[] plus(final String[] base, final String... more) {
        final List<String> l = new ArrayList<>(List.of(base));
        l.addAll(List.of(more));
        return l.toArray(new String[0]);
    }

    static Map<String, String> query(final String raw) {
        final Map<String, String> q = new HashMap<>();
        if (raw == null || raw.isEmpty()) {
            return q;
        }
        for (final String part : raw.split("&")) {
            final int eq = part.indexOf('=');
            q.put(URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8),
                    eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return q;
    }

    private static String enc(final String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    static String s256(final String verifier) {
        if (verifier == null) {
            return null;
        }
        try {
            return Base64.getUrlEncoder().withoutPadding().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (final java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String jwt(final JsonObject claims) {
        final Base64.Encoder b = Base64.getUrlEncoder().withoutPadding();
        return b.encodeToString("{\"alg\":\"RS256\"}".getBytes(StandardCharsets.UTF_8)) + "."
                + b.encodeToString(claims.toString().getBytes(StandardCharsets.UTF_8)) + ".c2ln";
    }
}

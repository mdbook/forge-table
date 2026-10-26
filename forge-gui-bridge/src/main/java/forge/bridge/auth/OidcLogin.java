package forge.bridge.auth;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;

/**
 * Sign in with an OpenID Connect provider (--auth oidc): the authorization code flow with PKCE (S256), the code
 * exchanged at the token endpoint, and the ID token's {@code iss}, {@code aud}/{@code azp}, {@code exp}, {@code iat}
 * and {@code nonce} checked. Endpoints come from the issuer's discovery document, fetched again every
 * {@link #DISCOVERY_MS}.
 * <p>
 * A sign-in under way is kept by the browser, not here: {@code state}, {@code nonce}, the PKCE verifier, where to go
 * next and when it runs out ({@link #PENDING_MS}) ride in the pre-login cookie, sealed with AES-GCM under a key made
 * at startup. Anyone can start a sign-in, so starting one stores nothing; a flood of them can't crowd out real ones.
 * A restart only fails the sign-ins that were under way. The one thing kept is each {@code state} already brought
 * back, so a callback works once.
 * <p>
 * {@code ponytail:} the ID token's signature isn't checked. OIDC Core 3.1.3.7 lets TLS stand in for it because the
 * token comes straight from the token endpoint, and nothing here ever takes a token from the browser. If that changes
 * (implicit or hybrid flow), check it against the JWKS (nimbus-jose-jwt).
 * <p>
 * No library: the JDK's HttpClient and Gson. Every call blocks, so callers run them off the event loop.
 */
public final class OidcLogin {
    /**
     * The client's settings. {@code clientSecret} null: a public client (PKCE only). {@code nameClaims}: the first one
     * present is the name others see. {@code insecure}: allow an http issuer (a local test provider).
     */
    public record Config(String issuer, String clientId, String clientSecret, String scopes, String loginClaim, List<String> nameClaims,
            String groupsClaim, String redirectUri, boolean insecure) { }

    /** Who the provider says signed in. {@code provider} is {@code oidc:<issuer>}, the key of their link. */
    public record Identity(String provider, String subject, String login, String name, List<String> groups) { }

    /** Where to send the browser, and the pre-login cookie (sealed) that the callback must bring back. */
    public record Start(String location, String cookie) { }

    /** A finished sign-in at the provider, and where the person was going. */
    public record Done(Identity identity, String next) { }

    /**
     * A sign-in that didn't work. {@code code} is what the sign-in page is told ({@code ?error=oidc-<code>}: {@code stale},
     * {@code denied}, {@code provider}); the message is for the log only.
     */
    public static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        public final String code;

        Failure(final String code, final String log) {
            super(log);
            this.code = code;
        }
    }

    /** The provider's endpoints from its discovery document. */
    record Endpoints(String issuer, String authorize, String token, String userinfo, String endSession, long fetched) { }

    /** What the pre-login cookie holds. */
    private record Pending(String state, String nonce, String verifier, String next, long expires) { }

    /** How long a started sign-in may take at the provider. */
    public static final long PENDING_MS = 10 * 60_000;
    static final long DISCOVERY_MS = 60 * 60_000;
    /** How far apart the provider's clock and ours may be, in seconds. */
    static final long SKEW_S = 120;
    /**
     * Used states remembered at once. Past this the oldest go first: a flood can then let an old callback through a
     * second time, which still needs that browser's cookie and a code the provider hasn't taken yet (codes work once).
     */
    static final int MAX_USED = 100_000;
    /** Longer cookies aren't ours: start seals a plain {@code next} instead of one that would go past this. */
    static final int MAX_COOKIE = 2048;
    private static final byte[] SEAL_AAD = "forge-table oidc pre-login 1".getBytes(StandardCharsets.US_ASCII);
    static final int MAX_BODY = 1 << 20;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Config c;
    private final HttpClient http;
    private final LongSupplier clock;
    private final SecretKey seal;
    /** state -> when it would have run out; guarded by itself. */
    private final LinkedHashMap<String, Long> used = new LinkedHashMap<>();
    private volatile Endpoints endpoints;

    public OidcLogin(final Config c, final LongSupplier clock) {
        this(c, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build(), clock);
    }

    OidcLogin(final Config c, final HttpClient http, final LongSupplier clock) {
        this.c = c;
        this.http = http;
        this.clock = clock;
        try {
            final KeyGenerator g = KeyGenerator.getInstance("AES");
            g.init(256, RANDOM);
            this.seal = g.generateKey();
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code oidc:<issuer>}: what a person's link to this provider is stored under. */
    public String provider() {
        return "oidc:" + c.issuer();
    }

    /** Fetches the discovery document once and says in the log whether it worked (at startup, so a typo shows early). */
    public void check() {
        try {
            final Endpoints e = endpoints();
            BridgeLog.info("OIDC: " + e.issuer() + " answers; redirect URI " + c.redirectUri());
        } catch (final Failure f) {
            BridgeLog.warn("OIDC: " + f.getMessage() + " (sign-in with it won't work until that's fixed)");
        }
    }

    /** Starts a sign-in: the provider's authorize URL for this browser, and its pre-login cookie value. */
    public Start start(final String next) throws Failure {
        final Endpoints e = endpoints();
        final String state = random();
        final String nonce = random();
        final String verifier = random();
        final long expires = clock.getAsLong() + PENDING_MS;
        String cookie = seal(new Pending(state, nonce, verifier, next, expires));
        if (cookie.length() > MAX_COOKIE) { // a very long next (non-ASCII, escaped) wouldn't come back: go home instead
            cookie = seal(new Pending(state, nonce, verifier, "/", expires));
        }
        final Map<String, String> q = new LinkedHashMap<>();
        q.put("response_type", "code");
        q.put("client_id", c.clientId());
        q.put("redirect_uri", c.redirectUri());
        q.put("scope", c.scopes());
        q.put("state", state);
        q.put("nonce", nonce);
        q.put("code_challenge", base64url(sha256(verifier)));
        q.put("code_challenge_method", "S256");
        return new Start(e.authorize() + (e.authorize().contains("?") ? "&" : "?") + form(q), cookie);
    }

    /**
     * The provider sent the browser back: opens the pre-login cookie and checks {@code state} against it, trades the
     * code for an ID token, checks the token and reads who it is. A {@code state} works once.
     */
    public Done finish(final String state, final String code, final String error, final String iss, final String cookie) throws Failure {
        final long now = clock.getAsLong();
        final Pending p = open(cookie);
        // only a cookie we sealed, for this state, uses the state up (junk never reaches the set); after that a
        // callback that fails can't be tried again
        if (p == null || state == null || p.expires() <= now
                || !MessageDigest.isEqual(p.state().getBytes(StandardCharsets.UTF_8), state.getBytes(StandardCharsets.UTF_8))
                || !firstUse(state, now)) {
            throw new Failure("stale", "callback with an unknown, used or expired state, or from another browser");
        }
        if (error != null) {
            throw new Failure(error.equals("access_denied") ? "denied" : "provider", "the provider said " + error.replaceAll("[^A-Za-z0-9_.-]", "?"));
        }
        final Endpoints e = endpoints();
        if (iss != null && !iss.equals(e.issuer())) { // RFC 9207: a provider that names itself must be this one
            throw new Failure("provider", "callback from issuer " + clean(iss) + ", expected " + e.issuer());
        }
        if (code == null || code.isEmpty() || code.length() > 4096) {
            throw new Failure("provider", "callback without a code");
        }
        final Map<String, String> form = new LinkedHashMap<>();
        form.put("grant_type", "authorization_code");
        form.put("code", code);
        form.put("redirect_uri", c.redirectUri());
        form.put("code_verifier", p.verifier());
        if (c.clientSecret() == null) {
            form.put("client_id", c.clientId());
        }
        final JsonObject tokens = call(HttpRequest.newBuilder(uri(e.token()))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form(form))), "token endpoint");
        final JsonObject claims = idToken(string(tokens, "id_token"), e.issuer(), p.nonce(), now);
        final String accessToken = string(tokens, "access_token");
        if (e.userinfo() != null && accessToken != null && missing(claims)) {
            final JsonObject info = call(HttpRequest.newBuilder(uri(e.userinfo())).header("Authorization", "Bearer " + accessToken).GET(),
                    "userinfo endpoint");
            if (!claims.get("sub").getAsString().equals(string(info, "sub"))) {
                throw new Failure("provider", "userinfo is for another subject"); // OIDC Core 5.3.2
            }
            for (final Map.Entry<String, JsonElement> en : info.entrySet()) {
                claims.add(en.getKey(), en.getValue());
            }
        }
        return new Done(identity(claims), p.next());
    }

    /** Whether the ID token lacks a claim we need (then the userinfo endpoint is asked). */
    private boolean missing(final JsonObject claims) {
        return string(claims, c.loginClaim()) == null || c.groupsClaim() != null && !claims.has(c.groupsClaim())
                || byEmail() && !claims.has("email_verified");
    }

    /**
     * The ID token's claims after the checks of OIDC Core 3.1.3.7 that apply to a token taken straight from the token
     * endpoint: {@code iss}, {@code aud} (and {@code azp} when there's more than one audience, or it's there at all),
     * {@code exp}, {@code iat}, {@code nonce}, and a {@code sub}.
     */
    JsonObject idToken(final String jwt, final String issuer, final String nonce, final long nowMs) throws Failure {
        if (jwt == null) {
            throw new Failure("provider", "the token endpoint sent no id_token (is the openid scope on?)");
        }
        final String[] parts = jwt.split("\\.", -1);
        if (parts.length != 3) {
            throw new Failure("provider", "the id_token isn't a signed JWT (an encrypted one isn't supported)");
        }
        final JsonObject t;
        try {
            t = JsonParser.parseString(new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (final RuntimeException ex) {
            throw new Failure("provider", "the id_token's claims don't parse");
        }
        if (!issuer.equals(string(t, "iss"))) {
            throw new Failure("provider", "id_token iss " + clean(string(t, "iss")) + ", expected " + issuer);
        }
        final List<String> aud = strings(t.get("aud"));
        final String azp = string(t, "azp");
        if (!aud.contains(c.clientId()) || (aud.size() > 1 || azp != null) && !c.clientId().equals(azp)) {
            throw new Failure("provider", "id_token is for " + clean(aud.toString()) + (azp == null ? "" : " (azp " + clean(azp) + ")") + ", not client " + c.clientId());
        }
        final long now = nowMs / 1000;
        final long exp = number(t, "exp");
        final long iat = number(t, "iat");
        if (exp + SKEW_S <= now) {
            throw new Failure("provider", "id_token expired at " + exp + " (now " + now + "; check the clocks)");
        }
        if (iat > now + SKEW_S || iat < now - PENDING_MS / 1000 - SKEW_S) {
            throw new Failure("provider", "id_token issued at " + iat + " (now " + now + "; check the clocks)");
        }
        if (!MessageDigest.isEqual(nonce.getBytes(StandardCharsets.UTF_8), String.valueOf(string(t, "nonce")).getBytes(StandardCharsets.UTF_8))) {
            throw new Failure("provider", "id_token nonce doesn't match this sign-in");
        }
        final String sub = string(t, "sub");
        if (sub == null || sub.isEmpty() || sub.length() > 255) {
            throw new Failure("provider", "id_token has no usable sub");
        }
        return t;
    }

    /** Whether the login is the email claim, which then has to come with {@code email_verified: true}. */
    private boolean byEmail() {
        return c.loginClaim().equals("email");
    }

    /** {@code true}, or the string {@code "true"} (some providers send it that way). */
    private static boolean verified(final JsonElement e) {
        return e != null && e.isJsonPrimitive() && (e.getAsJsonPrimitive().isBoolean() ? e.getAsBoolean() : "true".equals(e.getAsString()));
    }

    /** Who these claims say signed in: the login claim (trimmed, not case-folded), the first name claim present, the groups. */
    Identity identity(final JsonObject claims) throws Failure {
        final String raw = string(claims, c.loginClaim());
        final String login = raw == null ? null : raw.trim();
        if (login == null || login.isEmpty() || login.length() > 256 || login.chars().anyMatch(ch -> ch < 0x20 || ch == 0x7f)) {
            throw new Failure("provider", "no usable " + c.loginClaim() + " claim (set --oidc-login-claim to the claim that holds the username)");
        }
        if (byEmail() && !verified(claims.get("email_verified"))) {
            // anyone can type an address at a provider that lets people sign up; only a checked one names a person
            throw new Failure("provider", "email " + clean(login) + " isn't verified at the provider (email_verified isn't true)");
        }
        String name = null;
        for (final String claim : c.nameClaims()) {
            final String v = string(claims, claim);
            if (v != null && !v.isBlank()) {
                name = v.trim();
                break;
            }
        }
        final List<String> groups = c.groupsClaim() == null ? List.of() : strings(claims.get(c.groupsClaim()));
        return new Identity(provider(), claims.get("sub").getAsString(), login, name, groups);
    }

    /**
     * Where to send the browser after a local sign-out to sign out at the provider too (RP-Initiated Logout), coming
     * back to {@code then}; null when the provider has no end-session endpoint or hasn't answered yet.
     */
    public String endSession(final String then) {
        final Endpoints e = endpoints;
        if (e == null || e.endSession() == null) {
            return null;
        }
        final Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", c.clientId());
        q.put("post_logout_redirect_uri", then);
        return e.endSession() + (e.endSession().contains("?") ? "&" : "?") + form(q);
    }

    // ---------------------------------------------------------------- discovery

    /** The provider's endpoints: cached, fetched again once they're an hour old (the old ones stay if that fails). */
    Endpoints endpoints() throws Failure {
        final Endpoints e = endpoints;
        final long now = clock.getAsLong();
        if (e != null && now - e.fetched() < DISCOVERY_MS) {
            return e;
        }
        try {
            final Endpoints fresh = discover(now);
            endpoints = fresh;
            return fresh;
        } catch (final Failure f) {
            if (e == null) {
                throw f;
            }
            BridgeLog.warn("OIDC: " + f.getMessage() + "; using the endpoints from before");
            return e;
        }
    }

    private Endpoints discover(final long now) throws Failure {
        final String url = c.issuer().replaceFirst("/+$", "") + "/.well-known/openid-configuration";
        final JsonObject d = call(HttpRequest.newBuilder(uri(url)).GET(), "discovery at " + url);
        final String issuer = string(d, "issuer");
        if (!c.issuer().equals(issuer)) {
            throw new Failure("provider", "discovery at " + url + " names issuer " + clean(issuer) + "; set --oidc-issuer to exactly that");
        }
        final String authorize = endpoint(d, "authorization_endpoint", true);
        final String token = endpoint(d, "token_endpoint", true);
        return new Endpoints(issuer, authorize, token, endpoint(d, "userinfo_endpoint", false), endpoint(d, "end_session_endpoint", false), now);
    }

    private String endpoint(final JsonObject d, final String key, final boolean required) throws Failure {
        final String v = string(d, key);
        if (v == null) {
            if (required) {
                throw new Failure("provider", "discovery has no " + key);
            }
            return null;
        }
        if (!v.startsWith("https://") && !(c.insecure() && v.startsWith("http://"))) {
            throw new Failure("provider", key + " " + clean(v) + " isn't https (--oidc-insecure allows http, for a local test provider only)");
        }
        return v;
    }

    // ---------------------------------------------------------------- http

    /** One call that answers JSON; the client's credentials go along to the token endpoint. */
    private JsonObject call(final HttpRequest.Builder b, final String what) throws Failure {
        b.timeout(Duration.ofSeconds(10)).header("Accept", "application/json");
        if (what.equals("token endpoint") && c.clientSecret() != null) {
            // client_secret_basic: both parts form-encoded first (RFC 6749 2.3.1)
            final String basic = enc(c.clientId()) + ":" + enc(c.clientSecret());
            b.header("Authorization", "Basic " + Base64.getEncoder().encodeToString(basic.getBytes(StandardCharsets.UTF_8)));
        }
        final HttpResponse<InputStream> r;
        final byte[] body;
        try {
            r = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream in = r.body()) {
                body = in.readNBytes(MAX_BODY + 1);
            }
        } catch (final IOException ex) {
            throw new Failure("provider", what + " unreachable: " + ex);
        } catch (final InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new Failure("provider", what + ": interrupted");
        }
        if (body.length > MAX_BODY) {
            throw new Failure("provider", what + " answered more than " + MAX_BODY + " bytes");
        }
        final JsonObject json;
        try {
            json = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (final RuntimeException ex) {
            throw new Failure("provider", what + " answered " + r.statusCode() + " without JSON");
        }
        if (r.statusCode() != 200) {
            // the error code and description only: never the whole body, which may echo what was sent
            throw new Failure("provider", what + " answered " + r.statusCode() + " " + clean(string(json, "error"))
                    + (string(json, "error_description") == null ? "" : ": " + clean(string(json, "error_description"))));
        }
        return json;
    }

    private static URI uri(final String url) throws Failure {
        try {
            return URI.create(url);
        } catch (final IllegalArgumentException ex) {
            throw new Failure("provider", "not a URL: " + url);
        }
    }

    // ---------------------------------------------------------------- the pre-login cookie

    /** The cookie value for a sign-in under way: AES-GCM over its fields, base64url of nonce and ciphertext. */
    private String seal(final Pending p) {
        final JsonObject o = new JsonObject();
        o.addProperty("s", p.state());
        o.addProperty("n", p.nonce());
        o.addProperty("v", p.verifier());
        o.addProperty("t", p.next() == null ? "/" : p.next());
        o.addProperty("e", p.expires());
        try {
            final byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);
            final Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, seal, new GCMParameterSpec(128, iv));
            ci.updateAAD(SEAL_AAD);
            final byte[] sealed = ci.doFinal(o.toString().getBytes(StandardCharsets.UTF_8));
            final byte[] out = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(sealed, 0, out, iv.length, sealed.length);
            return base64url(out);
        } catch (final GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** What a pre-login cookie holds, or null when it isn't one this router sealed (forged, cut, from before a restart). */
    private Pending open(final String cookie) {
        if (cookie == null || cookie.length() > MAX_COOKIE) {
            return null;
        }
        try {
            final byte[] in = Base64.getUrlDecoder().decode(cookie);
            if (in.length < 12 + 16) {
                return null;
            }
            final Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, seal, new GCMParameterSpec(128, in, 0, 12));
            ci.updateAAD(SEAL_AAD);
            final JsonObject o = JsonParser.parseString(new String(ci.doFinal(in, 12, in.length - 12), StandardCharsets.UTF_8)).getAsJsonObject();
            return new Pending(o.get("s").getAsString(), o.get("n").getAsString(), o.get("v").getAsString(), o.get("t").getAsString(),
                    o.get("e").getAsLong());
        } catch (final GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    /**
     * Marks {@code state} brought back; false when it already was. Kept as long as a cookie for it could still be good;
     * the run-out ones are forgotten, and the oldest past {@link #MAX_USED}.
     */
    private boolean firstUse(final String state, final long now) {
        synchronized (used) {
            final Iterator<Long> it = used.values().iterator();
            while (it.hasNext()) {
                final long e = it.next();
                if (e > now && used.size() < MAX_USED) {
                    break;
                }
                it.remove();
            }
            return used.putIfAbsent(state, now + PENDING_MS) == null;
        }
    }

    /** Text from outside, fit for one log line: control and format characters become {@code ?}, at most 200 characters. */
    static String clean(final String s) {
        if (s == null) {
            return null;
        }
        return (s.length() > 200 ? s.substring(0, 200) + "..." : s).replaceAll("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "?");
    }

    // ---------------------------------------------------------------- bits

    private static String form(final Map<String, String> q) {
        final List<String> parts = new ArrayList<>();
        q.forEach((k, v) -> parts.add(enc(k) + "=" + enc(v)));
        return String.join("&", parts);
    }

    private static String enc(final String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String random() {
        final byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        return base64url(b);
    }

    private static String base64url(final byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static byte[] sha256(final String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.US_ASCII));
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A string member, else null (missing, null, or not a string). */
    static String string(final JsonObject o, final String key) {
        final JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null;
    }

    private static long number(final JsonObject o, final String key) throws Failure {
        final JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            throw new Failure("provider", "id_token has no " + key);
        }
        return e.getAsLong();
    }

    /** A string, or the strings of an array (anything else in it skipped); empty for anything else. */
    static List<String> strings(final JsonElement e) {
        final List<String> out = new ArrayList<>();
        if (e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
            out.add(e.getAsString());
        } else if (e != null && e.isJsonArray()) {
            for (final JsonElement x : e.getAsJsonArray()) {
                if (x.isJsonPrimitive() && x.getAsJsonPrimitive().isString()) {
                    out.add(x.getAsString());
                }
            }
        }
        return out;
    }
}

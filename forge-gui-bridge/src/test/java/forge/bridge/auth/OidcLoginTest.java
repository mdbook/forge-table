package forge.bridge.auth;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/** The ID token checks (OIDC Core 3.1.3.7) and reading who signed in, without a provider. */
public class OidcLoginTest {
    private static final String ISS = "https://idp.example/realm";
    private static final long NOW_MS = 1_800_000_000_000L;
    private static final long NOW = NOW_MS / 1000;

    private static OidcLogin client(final String groupsClaim) {
        return new OidcLogin(new OidcLogin.Config(ISS, "forge-table", "s3cret", "openid profile", "preferred_username",
                List.of("given_name", "name"), groupsClaim, "https://ft.example/auth/oidc/callback", false), () -> NOW_MS);
    }

    private static JsonObject claims() {
        final JsonObject t = new JsonObject();
        t.addProperty("iss", ISS);
        t.addProperty("aud", "forge-table");
        t.addProperty("sub", "8f2c");
        t.addProperty("exp", NOW + 300);
        t.addProperty("iat", NOW - 5);
        t.addProperty("nonce", "n-1");
        t.addProperty("preferred_username", " Ana.L ");
        t.addProperty("name", "Ana Lopez");
        return t;
    }

    static String jwt(final JsonObject claims) {
        final Base64.Encoder b = Base64.getUrlEncoder().withoutPadding();
        return b.encodeToString("{\"alg\":\"RS256\"}".getBytes(StandardCharsets.UTF_8)) + "."
                + b.encodeToString(claims.toString().getBytes(StandardCharsets.UTF_8)) + ".c2ln";
    }

    private static String refused(final JsonObject claims) {
        return expectThrows(OidcLogin.Failure.class, () -> client(null).idToken(jwt(claims), ISS, "n-1", NOW_MS)).getMessage();
    }

    @Test
    public void aGoodTokenPasses() throws Exception {
        assertEquals(client(null).idToken(jwt(claims()), ISS, "n-1", NOW_MS).get("sub").getAsString(), "8f2c");
        final JsonObject many = claims();
        final JsonArray aud = new JsonArray();
        aud.add("other");
        aud.add("forge-table");
        many.add("aud", aud);
        many.addProperty("azp", "forge-table");
        client(null).idToken(jwt(many), ISS, "n-1", NOW_MS);
    }

    @Test
    public void everyCheckRefuses() {
        JsonObject t = claims();
        t.addProperty("iss", "https://evil.example");
        assertTrue(refused(t).contains("iss"));
        t = claims();
        t.addProperty("aud", "someone-else");
        assertTrue(refused(t).contains("not client"));
        t = claims();
        final JsonArray aud = new JsonArray();
        aud.add("forge-table");
        aud.add("other");
        t.add("aud", aud);
        assertTrue(refused(t).contains("not client"), "several audiences need azp");
        t = claims();
        t.addProperty("azp", "other");
        assertTrue(refused(t).contains("not client"));
        t = claims();
        t.addProperty("exp", NOW - OidcLogin.SKEW_S - 1);
        assertTrue(refused(t).contains("expired"));
        t = claims();
        t.addProperty("iat", NOW + OidcLogin.SKEW_S + 60);
        assertTrue(refused(t).contains("issued"));
        t = claims();
        t.addProperty("iat", NOW - 3600);
        assertTrue(refused(t).contains("issued"), "a stale token isn't from this sign-in");
        t = claims();
        t.addProperty("nonce", "n-2");
        assertTrue(refused(t).contains("nonce"));
        t = claims();
        t.remove("nonce");
        assertTrue(refused(t).contains("nonce"));
        t = claims();
        t.remove("sub");
        assertTrue(refused(t).contains("sub"));
        t = claims();
        t.remove("exp");
        assertTrue(refused(t).contains("exp"));
        assertTrue(expectThrows(OidcLogin.Failure.class, () -> client(null).idToken("a.b.c.d.e", ISS, "n-1", NOW_MS)).getMessage().contains("encrypted"));
        assertTrue(expectThrows(OidcLogin.Failure.class, () -> client(null).idToken(null, ISS, "n-1", NOW_MS)).getMessage().contains("openid"));
    }

    @Test
    public void readsTheLoginNameAndGroups() throws Exception {
        final JsonObject t = claims();
        final JsonArray groups = new JsonArray();
        groups.add("players");
        groups.add("admins");
        t.add("groups", groups);
        OidcLogin.Identity id = client("groups").identity(t);
        assertEquals(id.login(), "Ana.L", "trimmed, case kept: header mode's folders line up");
        assertEquals(id.name(), "Ana Lopez", "given_name is missing, so name");
        assertEquals(id.groups(), List.of("players", "admins"));
        assertEquals(id.provider(), "oidc:" + ISS);
        t.addProperty("given_name", "Ana");
        assertEquals(client(null).identity(t).name(), "Ana");
        assertEquals(client(null).identity(t).groups(), List.of(), "groups aren't read when nothing needs them");
        t.remove("preferred_username");
        assertTrue(expectThrows(OidcLogin.Failure.class, () -> client(null).identity(t)).getMessage().contains("--oidc-login-claim"));
        t.addProperty("preferred_username", "ana\nadmin");
        expectThrows(OidcLogin.Failure.class, () -> client(null).identity(t));
    }

    @Test
    public void anEmailLoginMustBeVerified() throws Exception {
        final OidcLogin byEmail = new OidcLogin(new OidcLogin.Config(ISS, "forge-table", "s3cret", "openid email", "email",
                List.of("name"), null, "https://ft.example/auth/oidc/callback", false), () -> NOW_MS);
        final JsonObject t = claims();
        t.addProperty("email", "ana@example.com");
        assertTrue(expectThrows(OidcLogin.Failure.class, () -> byEmail.identity(t)).getMessage().contains("email_verified"), "missing");
        t.addProperty("email_verified", false);
        expectThrows(OidcLogin.Failure.class, () -> byEmail.identity(t));
        t.addProperty("email_verified", "false");
        expectThrows(OidcLogin.Failure.class, () -> byEmail.identity(t));
        t.addProperty("email_verified", true);
        assertEquals(byEmail.identity(t).login(), "ana@example.com");
        t.addProperty("email_verified", "true");
        assertEquals(byEmail.identity(t).login(), "ana@example.com", "some providers send it as a string");
        assertEquals(client(null).identity(claims()).login(), "Ana.L", "other login claims don't need it");
    }

    @Test
    public void textFromOutsideIsOneLogLine() {
        assertEquals(OidcLogin.clean("https://idp.example/\nINFO admin signed in​"), "https://idp.example/?INFO admin signed in?");
        assertEquals(OidcLogin.clean("x".repeat(300)).length(), 203);
        assertNull(OidcLogin.clean(null));
    }

    @Test
    public void noEndSessionBeforeDiscovery() {
        assertNull(client(null).endSession("https://ft.example/auth/login"));
    }
}

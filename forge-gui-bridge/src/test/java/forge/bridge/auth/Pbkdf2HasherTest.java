package forge.bridge.auth;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HexFormat;

import org.testng.annotations.Test;

/** Password hashes: the JDK's PBKDF2 against a published vector, the stored format, rehash-on-old-parameters, the length rule. */
public class Pbkdf2HasherTest {

    @Test
    public void matchesThePublishedVector() {
        // RFC 7914 section 11: PBKDF2-HMAC-SHA256, P="passwd", S="salt", c=1 (first 32 of its 64 bytes)
        assertEquals(HexFormat.of().formatHex(Pbkdf2Hasher.derive("passwd", "salt".getBytes(StandardCharsets.UTF_8), 1)),
                "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    }

    @Test
    public void hashesVerifyAndAreSalted() {
        final String a = Pbkdf2Hasher.hash("correct horse battery");
        final String b = Pbkdf2Hasher.hash("correct horse battery");
        assertTrue(a.startsWith("pbkdf2-sha256$600000$"), a);
        assertEquals(a.split("\\$").length, 4);
        assertNotEquals(a, b, "a fresh salt each time");
        assertTrue(Pbkdf2Hasher.verify("correct horse battery", a));
        assertTrue(Pbkdf2Hasher.verify("correct horse battery", b));
        assertFalse(Pbkdf2Hasher.verify("correct horse batterY", a));
        assertFalse(Pbkdf2Hasher.verify("", a));
        assertFalse(Pbkdf2Hasher.verify(null, a));
        assertFalse(Pbkdf2Hasher.outdated(a));
    }

    @Test
    public void unusableHashesNeverVerify() {
        for (final String stored : new String[] {null, "", "plain", "pbkdf2-sha256$x$y$z", "md5$1$abc$def", "pbkdf2-sha256$0$AAAA$AAAA",
                "pbkdf2-sha256$600000$!!!$AAAA"}) {
            assertFalse(Pbkdf2Hasher.verify("anything at all", stored), String.valueOf(stored));
        }
    }

    @Test
    public void oldParametersAreRedone() {
        final byte[] salt = new byte[16];
        final Base64.Encoder b64 = Base64.getEncoder().withoutPadding();
        final String old = "pbkdf2-sha256$1000$" + b64.encodeToString(salt) + "$" + b64.encodeToString(Pbkdf2Hasher.derive("an older one!", salt, 1000));
        assertTrue(Pbkdf2Hasher.verify("an older one!", old), "still signs in");
        assertTrue(Pbkdf2Hasher.outdated(old), "and gets redone with today's parameters");
    }

    @Test
    public void lengthRuleOnly() {
        assertNotNull(Pbkdf2Hasher.problem(null));
        assertNotNull(Pbkdf2Hasher.problem("short"));
        assertNotNull(Pbkdf2Hasher.problem("123456789"));
        assertNull(Pbkdf2Hasher.problem("1234567890"), "no composition rules");
        assertNull(Pbkdf2Hasher.problem("a".repeat(256)));
        assertNotNull(Pbkdf2Hasher.problem("a".repeat(257)));
    }
}

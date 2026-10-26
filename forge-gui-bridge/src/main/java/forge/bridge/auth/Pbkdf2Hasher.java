package forge.bridge.auth;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Password hashes for local accounts: PBKDF2-HMAC-SHA256 from the JDK, stored self-describing as
 * {@code pbkdf2-sha256$<iterations>$<salt>$<hash>} (base64, no padding), so the parameters can rise later and old
 * hashes are redone on the next good sign-in ({@link #outdated}).
 * <p>
 * ponytail: Argon2id needs a library (Bouncy Castle or password4j). The format names its scheme, so it can join as a
 * second one without a migration.
 */
public final class Pbkdf2Hasher {
    /** OWASP's current figure for PBKDF2-HMAC-SHA256. */
    public static final int ITERATIONS = 600_000;
    /** NIST 800-63B: at least 8 (we ask 10), long passphrases welcome, no composition rules. */
    public static final int MIN_LENGTH = 10;
    public static final int MAX_LENGTH = 256;

    private static final String SCHEME = "pbkdf2-sha256";
    private static final int SALT_BYTES = 16;
    private static final int HASH_BITS = 256;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder B64 = Base64.getEncoder().withoutPadding();
    private static final Base64.Decoder B64D = Base64.getDecoder();
    /** Checked against when the login doesn't exist, so a wrong login takes as long as a wrong password. */
    private static final String DUMMY = hash("not a real password, only spends the time");

    private Pbkdf2Hasher() { }

    /** Why {@code password} can't be used, or null when it can. */
    public static String problem(final String password) {
        if (password == null || password.codePointCount(0, password.length()) < MIN_LENGTH) {
            return "Passwords need at least " + MIN_LENGTH + " characters.";
        }
        if (password.length() > MAX_LENGTH) {
            return "Passwords can be at most " + MAX_LENGTH + " characters.";
        }
        return null;
    }

    /** A new stored hash of {@code password} with a fresh salt. */
    public static String hash(final String password) {
        final byte[] salt = new byte[SALT_BYTES];
        RANDOM.nextBytes(salt);
        return SCHEME + "$" + ITERATIONS + "$" + B64.encodeToString(salt) + "$" + B64.encodeToString(derive(password, salt, ITERATIONS));
    }

    /**
     * Whether {@code password} matches {@code stored}. A null or unreadable {@code stored} (no such user, an account with
     * no password) is false, after the same work as a real check.
     */
    public static boolean verify(final String password, final String stored) {
        final String pw = password == null ? "" : password;
        final String[] p = stored == null ? new String[0] : stored.split("\\$");
        if (p.length != 4 || !SCHEME.equals(p[0])) {
            spendTime(pw);
            return false;
        }
        try {
            final int iterations = Integer.parseInt(p[1]);
            if (iterations < 1 || iterations > 10_000_000) {
                return false;
            }
            return MessageDigest.isEqual(B64D.decode(p[3]), derive(pw, B64D.decode(p[2]), iterations));
        } catch (final IllegalArgumentException e) {
            return false;
        }
    }

    /** The work of a real check against a hash nobody has. */
    private static void spendTime(final String password) {
        if (DUMMY != null) { // null only while DUMMY itself is being made
            verify(password, DUMMY);
        }
    }

    /** Whether a hash that just verified was made with weaker parameters than today's (redo it with {@link #hash}). */
    public static boolean outdated(final String stored) {
        final String[] p = stored.split("\\$");
        return p.length != 4 || !SCHEME.equals(p[0]) || !String.valueOf(ITERATIONS).equals(p[1]);
    }

    static byte[] derive(final String password, final byte[] salt, final int iterations) {
        final PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, HASH_BITS);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (final GeneralSecurityException e) {
            throw new IllegalStateException(e);
        } finally {
            spec.clearPassword();
        }
    }
}

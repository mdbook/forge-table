package forge.bridge.auth;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.Test;

/** {@code --users}: the account commands, reading the password from stdin; and the sign-in try limit. */
public class UsersCliTest {
    private final ByteArrayOutputStream out = new ByteArrayOutputStream();
    private final ByteArrayOutputStream err = new ByteArrayOutputStream();

    private int run(final Path dir, final String stdin, final String... args) {
        out.reset();
        err.reset();
        final UsersCli cli = new UsersCli(new ByteArrayInputStream(stdin.getBytes(StandardCharsets.UTF_8)),
                new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(err, true, StandardCharsets.UTF_8), null);
        return cli.run(args, dir);
    }

    private static UserStore.User user(final Path dir, final String login) throws Exception {
        try (UserStore s = new UserStore(dir.resolve("forge-table.db"))) {
            return s.user(login);
        }
    }

    @Test
    public void accountLifecycle() throws Exception {
        final Path dir = Files.createTempDirectory("ft-cli");
        assertEquals(run(dir, "", "list"), 0);
        assertTrue(out.toString().contains("no accounts yet"));

        assertEquals(run(dir, "a long enough one\n", "add", "Ana", "--admin", "--name", "Ana Lima"), 0, err.toString());
        UserStore.User ana = user(dir, "ana");
        assertNotNull(ana, "stored lowercase");
        assertTrue(ana.admin());
        assertEquals(ana.displayName(), "Ana Lima");
        assertTrue(Pbkdf2Hasher.verify("a long enough one", ana.passwordHash()));

        assertEquals(run(dir, "another long one\n", "add", "ana"), 1, "taken");
        assertEquals(run(dir, "short\n", "add", "liam"), 1);
        assertTrue(err.toString().contains("at least"), err.toString());
        assertNull(user(dir, "liam"));
        assertEquals(run(dir, "a long enough one\n", "add", "bad login"), 2);

        assertEquals(run(dir, "", "list"), 0);
        assertTrue(out.toString().startsWith("ana\tadmin\ton\tpassword\tnever signed in\tAna Lima"), out.toString());

        assertEquals(run(dir, "brand new password\n", "reset", "ana"), 0, err.toString());
        assertTrue(Pbkdf2Hasher.verify("brand new password", user(dir, "ana").passwordHash()));

        assertEquals(run(dir, "", "disable", "ana"), 0);
        assertTrue(user(dir, "ana").disabled());
        assertEquals(run(dir, "", "enable", "ana"), 0);
        assertFalse(user(dir, "ana").disabled());
        assertEquals(run(dir, "", "admin", "ana", "off"), 0);
        assertFalse(user(dir, "ana").admin());
        assertEquals(run(dir, "", "admin", "ana", "maybe"), 2);
        assertEquals(run(dir, "", "disable", "nobody"), 1);
        assertEquals(run(dir, "", "delete", "ana"), 0);
        assertNull(user(dir, "ana"));
    }

    @Test
    public void usageErrors() throws Exception {
        final Path dir = Files.createTempDirectory("ft-cli");
        assertEquals(run(dir, ""), 2);
        assertEquals(run(dir, "", "frobnicate"), 2);
        assertEquals(run(dir, "", "add"), 2);
        assertEquals(run(dir, "", "list", "extra"), 2);
        assertEquals(run(dir, "", "disable", "x", "--admin"), 2);
        assertEquals(run(dir, "", "help"), 0);
        assertTrue(out.toString().contains("Usage"));
        assertEquals(run(dir, "", "list", "--data", "/ignored/here"), 0, "--data was already resolved by the caller");
    }

    @Test
    public void throttle() {
        final AtomicLong now = new AtomicLong(0);
        final LoginThrottle t = new LoginThrottle(now::get);
        for (int i = 0; i < LoginThrottle.LOGIN_FAILS; i++) {
            assertTrue(t.begin("ana", "1.2.3.4"), "try " + i);
            t.failed("ana", "1.2.3.4");
            t.end("ana", "1.2.3.4");
        }
        assertFalse(once(t, "ana", "5.6.7.8"), "the login waits, from anywhere");
        assertTrue(once(t, "liam", "1.2.3.4"), "other logins from that address still may");
        now.addAndGet(LoginThrottle.LOCK_MS - 1);
        assertFalse(once(t, "ana", "1.2.3.4"));
        now.addAndGet(1);
        assertTrue(once(t, "ana", "1.2.3.4"), "15 minutes later");

        // the address: 30 failures across many logins inside 10 minutes
        for (int i = 0; i < LoginThrottle.ADDRESS_FAILS; i++) {
            t.failed("user" + i, "9.9.9.9");
        }
        assertFalse(once(t, "someone-else", "9.9.9.9"));
        now.addAndGet(LoginThrottle.WINDOW_MS);
        assertTrue(once(t, "someone-else", "9.9.9.9"), "once they age out");

        // a good sign-in clears the login's count
        for (int i = 0; i < LoginThrottle.LOGIN_FAILS - 1; i++) {
            t.failed("ava", "1.1.1.1");
        }
        t.succeeded("ava");
        t.failed("ava", "1.1.1.1");
        assertTrue(once(t, "ava", "1.1.1.1"));

        // tries still being checked count: a burst can't all get past before the first failure is written down
        for (int i = 0; i < LoginThrottle.LOGIN_FAILS; i++) {
            assertTrue(t.begin("zoe", "2.2.2." + i), "in flight " + i);
        }
        assertFalse(t.begin("zoe", "3.3.3.3"), "the sixth waits while five are being checked");
        for (int i = 0; i < LoginThrottle.LOGIN_FAILS; i++) {
            t.end("zoe", "2.2.2." + i);
        }
        assertTrue(once(t, "zoe", "3.3.3.3"), "none of them failed, so the login is free again");
        for (int i = 0; i < LoginThrottle.ADDRESS_FAILS; i++) {
            assertTrue(t.begin("u" + i, "4.4.4.4"));
        }
        assertFalse(t.begin("one-more", "4.4.4.4"), "the address too");
    }

    /** One try that neither failed nor succeeded: whether it was let through. */
    private static boolean once(final LoginThrottle t, final String login, final String address) {
        final boolean ok = t.begin(login, address);
        if (ok) {
            t.end(login, address);
        }
        return ok;
    }
}

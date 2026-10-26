package forge.bridge.auth;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.Test;

/** The SQLite store and the session rules on top of it: schema, accounts, hashed session ids, expiry, cookies. */
public class UserStoreTest {
    private static final long DAY = 24 * 60 * 60_000L;

    private static Path db() throws Exception {
        return Files.createTempDirectory("ft-users").resolve("forge-table.db");
    }

    @Test
    public void createsTheSchemaOnceAndKeepsData() throws Exception {
        final Path file = db();
        try (UserStore s = new UserStore(file)) {
            s.add("ana", "Ana", "h", true, 1);
            if (file.getFileSystem().supportedFileAttributeViews().contains("posix")) {
                for (final Path p : List.of(file, Path.of(file + "-wal"))) {
                    assertEquals(PosixFilePermissions.toString(Files.getPosixFilePermissions(p)), "rw-------", p.toString());
                }
            }
        }
        try (UserStore s = new UserStore(file)) {
            final UserStore.User u = s.user("ana");
            assertNotNull(u);
            assertTrue(u.admin());
            assertEquals(u.shownName(), "Ana");
        }
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + file); var st = c.createStatement(); var r = st.executeQuery("PRAGMA user_version")) {
            assertTrue(r.next());
            assertEquals(r.getInt(1), UserStore.SCHEMA);
        }
    }

    @Test
    public void refusesANewerSchema() throws Exception {
        final Path file = db();
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + file); var st = c.createStatement()) {
            st.execute("PRAGMA user_version = 99");
        }
        final SQLException e = expectThrows(SQLException.class, () -> new UserStore(file));
        assertTrue(e.getMessage().contains("newer"), e.getMessage());
    }

    @Test
    public void localLogins() {
        assertEquals(UserStore.localLogin("  Ana "), "ana");
        assertEquals(UserStore.localLogin("a.b_c-9"), "a.b_c-9");
        assertNull(UserStore.localLogin(""));
        assertNull(UserStore.localLogin("has space"));
        assertNull(UserStore.localLogin("x".repeat(33)));
        assertNull(UserStore.localLogin("ünï"));
        assertNull(UserStore.localLogin("*)(uid=*"));
        assertNull(UserStore.localLogin(null));
    }

    @Test
    public void accounts() throws Exception {
        try (UserStore s = new UserStore(db())) {
            final UserStore.User a = s.add("alice", null, "h1", false, 5);
            s.add("bob", null, null, false, 6);
            expectThrows(SQLException.class, () -> s.add("alice", null, "h2", false, 7));
            assertEquals(a.shownName(), "alice");
            assertEquals(s.users().stream().map(UserStore.User::login).toList(), List.of("alice", "bob"));
            assertTrue(s.setAdmin(a.id(), true));
            assertTrue(s.user("alice").admin());
            assertTrue(s.delete(a.id()));
            assertNull(s.user("alice"));
            assertFalse(s.delete(a.id()));
        }
    }

    @Test
    public void sessionsAreStoredHashed() throws Exception {
        final Path file = db();
        try (UserStore s = new UserStore(file)) {
            final UserStore.User a = s.add("alice", null, "h", false, 0);
            final String id = s.newSession(a.id(), 10, 10 + DAY, "Firefox", false);
            assertTrue(id.matches("[A-Za-z0-9_-]{43}"), id);
            final UserStore.Session found = s.session(id);
            assertNotNull(found);
            assertEquals(found.user().login(), "alice");
            assertEquals(found.idHash(), UserStore.hash(id));
            assertNotEquals(found.idHash(), id);
            assertNull(s.session(id + "x"));
            assertNull(s.session(""));
            assertNull(s.session(null));
        }
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + file); var st = c.createStatement();
                var r = st.executeQuery("SELECT group_concat(id_hash) FROM sessions")) {
            assertTrue(r.next());
            assertTrue(r.getString(1).matches("[0-9a-f]{64}"), "only the hash is on disk");
        }
    }

    @Test
    public void endingSessions() throws Exception {
        try (UserStore s = new UserStore(db())) {
            final UserStore.User a = s.add("alice", null, "h", false, 0);
            final String one = s.newSession(a.id(), 0, DAY, null, false);
            final String two = s.newSession(a.id(), 0, DAY, null, false);
            final String three = s.newSession(a.id(), 0, DAY, null, false);
            s.setPasswordHash(a.id(), "h2", s.session(two).idHash()); // a change of password keeps the session it came from
            assertNull(s.session(one));
            assertNotNull(s.session(two));
            assertNull(s.session(three));
            s.setDisabled(a.id(), true);
            assertNull(s.session(two), "turning an account off ends every session");
            s.setDisabled(a.id(), false);
            final String four = s.newSession(a.id(), 0, DAY, null, false);
            s.delete(a.id());
            assertNull(s.session(four), "deleting an account takes its sessions");
        }
    }

    @Test
    public void sessionRules() throws Exception {
        final AtomicLong now = new AtomicLong(1_000_000);
        try (UserStore s = new UserStore(db())) {
            final Sessions sessions = new Sessions(s, 14 * DAY, 30 * DAY, false, now::get);
            final UserStore.User a = s.add("alice", null, "h", false, 0);
            final String id = sessions.open(a, "UA", false);
            assertTrue(s.user("alice").lastLogin() > 0, "sign-in time recorded");
            assertNotNull(sessions.find(id));

            now.addAndGet(Sessions.TOUCH_MS / 2);
            final long seen = s.session(id).lastSeen();
            sessions.find(id);
            assertEquals(s.session(id).lastSeen(), seen, "last-seen written at most once a minute");
            now.addAndGet(Sessions.TOUCH_MS);
            sessions.find(id);
            assertEquals(s.session(id).lastSeen(), now.get());

            now.addAndGet(14 * DAY + 1);
            assertNull(sessions.find(id), "14 days unused");
            assertNull(s.session(id), "and gone from the file");

            final String busy = sessions.open(a, null, false);
            for (int d = 0; d < 29; d++) {
                now.addAndGet(DAY);
                assertNotNull(sessions.find(busy), "day " + d);
            }
            now.addAndGet(DAY);
            assertNull(sessions.find(busy), "30 days after sign-in, however busy");

            final String off = sessions.open(a, null, false);
            s.setDisabled(a.id(), true);
            assertNull(sessions.find(off));
        }
    }

    @Test
    public void cookies() throws Exception {
        try (UserStore s = new UserStore(db())) {
            final Sessions secure = new Sessions(s, DAY, 30 * DAY, false, System::currentTimeMillis);
            assertEquals(secure.setCookie("abc"), "__Host-ft_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000");
            assertEquals(secure.clearCookie(), "__Host-ft_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
            assertEquals(secure.cookie(List.of("a=1; __Host-ft_session=xyz; b=2")), "xyz");
            assertEquals(secure.cookie(List.of("a=1", "__Host-ft_session=xyz")), "xyz");
            assertNull(secure.cookie(List.of("__Host-ft_session=x; __Host-ft_session=y")), "two of them: neither");
            assertNull(secure.cookie(List.of("ft_session=x")));
            assertNull(secure.cookie(List.of("__Host-ft_session=")));
            assertNull(secure.cookie(List.of()));

            final Sessions lan = new Sessions(s, DAY, 30 * DAY, true, System::currentTimeMillis);
            assertEquals(lan.setCookie("abc"), "ft_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
            assertEquals(lan.cookie(List.of("ft_session=q")), "q");
        }
    }
}

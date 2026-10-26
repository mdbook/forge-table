package forge.bridge.auth;

import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * Native sign-in's accounts and sessions in one SQLite file ({@code <data>/forge-table.db}), so a self-hoster can fix
 * things with the {@code sqlite3} CLI. Created on first use; the schema's version is {@code PRAGMA user_version}.
 * <p>
 * Sessions are stored by the SHA-256 of their id only: a copy of the file can't be replayed as live sign-ins. One
 * connection, every method synchronized (the router's traffic is a few requests a second at most).
 */
public final class UserStore implements Closeable {
    /** What {@link #user} and {@link #users} return. {@code passwordHash} is null for an account without a password. */
    public record User(long id, String login, String displayName, String passwordHash, boolean admin, boolean disabled,
            long created, long lastLogin) {
        /** The name other players see: the display name, else the login. */
        public String shownName() {
            return displayName == null || displayName.isBlank() ? login : displayName;
        }
    }

    /** A session and its user. {@code groupAdmin}: admin by a group the directory reported at sign-in. */
    public record Session(String idHash, User user, long created, long lastSeen, long expires, boolean groupAdmin) { }

    /** Local logins: lowercase letters, digits, dot, underscore, dash; 1 to 32. */
    public static final String LOCAL_LOGIN = "[a-z0-9._-]{1,32}";

    static final int SCHEMA = 1;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Connection db;

    public UserStore(final Path file) throws SQLException {
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            // it holds password hashes: owner-only from the start (SQLite gives its -wal and -shm files the same mode)
            if (!Files.exists(file) && file.getFileSystem().supportedFileAttributeViews().contains("posix")) {
                Files.createFile(file, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            }
        } catch (final java.io.IOException e) {
            throw new SQLException("Cannot create " + file + ": " + e.getMessage(), e);
        }
        db = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
        try (Statement s = db.createStatement()) {
            s.execute("PRAGMA foreign_keys = ON");
            s.execute("PRAGMA journal_mode = WAL");
            s.execute("PRAGMA busy_timeout = 5000");
        }
        migrate();
    }

    private void migrate() throws SQLException {
        final int version;
        try (Statement s = db.createStatement(); ResultSet r = s.executeQuery("PRAGMA user_version")) {
            version = r.next() ? r.getInt(1) : 0;
        }
        if (version > SCHEMA) {
            throw new SQLException("forge-table.db is schema " + version + ", newer than this Forge Table (" + SCHEMA
                    + "): run the newer version, or restore a backup");
        }
        if (version == SCHEMA) {
            return;
        }
        db.setAutoCommit(false);
        try (Statement s = db.createStatement()) {
            s.execute("""
                    CREATE TABLE users (
                      id INTEGER PRIMARY KEY,
                      login TEXT NOT NULL UNIQUE,
                      display_name TEXT,
                      password_hash TEXT,
                      admin INTEGER NOT NULL DEFAULT 0,
                      disabled INTEGER NOT NULL DEFAULT 0,
                      created INTEGER NOT NULL,
                      last_login INTEGER NOT NULL DEFAULT 0)""");
            s.execute("""
                    CREATE TABLE identities (
                      provider TEXT NOT NULL,
                      subject TEXT NOT NULL,
                      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      PRIMARY KEY (provider, subject))""");
            s.execute("""
                    CREATE TABLE sessions (
                      id_hash TEXT PRIMARY KEY,
                      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      created INTEGER NOT NULL,
                      last_seen INTEGER NOT NULL,
                      expires INTEGER NOT NULL,
                      user_agent TEXT,
                      group_admin INTEGER NOT NULL DEFAULT 0)""");
            s.execute("CREATE INDEX sessions_user ON sessions(user_id)");
            s.execute("""
                    CREATE TABLE setup_links (
                      code_hash TEXT PRIMARY KEY,
                      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      expires INTEGER NOT NULL)""");
            s.execute("PRAGMA user_version = " + SCHEMA);
            db.commit();
        } catch (final SQLException e) {
            db.rollback();
            throw e;
        } finally {
            db.setAutoCommit(true);
        }
    }

    /** A local login as stored: trimmed and lowercased; null when it isn't one ({@link #LOCAL_LOGIN}). */
    public static String localLogin(final String raw) {
        if (raw == null) {
            return null;
        }
        final String l = raw.trim().toLowerCase(Locale.ROOT);
        return l.matches(LOCAL_LOGIN) ? l : null;
    }

    // ---------------------------------------------------------------- users

    /** Adds a user; the login must be free. Returns the new user. */
    public synchronized User add(final String login, final String displayName, final String passwordHash, final boolean admin, final long now)
            throws SQLException {
        try (PreparedStatement p = db.prepareStatement(
                "INSERT INTO users (login, display_name, password_hash, admin, created) VALUES (?, ?, ?, ?, ?)")) {
            p.setString(1, login);
            p.setString(2, displayName);
            p.setString(3, passwordHash);
            p.setInt(4, admin ? 1 : 0);
            p.setLong(5, now);
            p.executeUpdate();
        }
        return user(login);
    }

    /** The user with exactly this login, or null. */
    public synchronized User user(final String login) throws SQLException {
        try (PreparedStatement p = db.prepareStatement("SELECT * FROM users WHERE login = ?")) {
            p.setString(1, login);
            try (ResultSet r = p.executeQuery()) {
                return r.next() ? user(r) : null;
            }
        }
    }

    /** Every user, by login. */
    public synchronized List<User> users() throws SQLException {
        final List<User> out = new ArrayList<>();
        try (Statement s = db.createStatement(); ResultSet r = s.executeQuery("SELECT * FROM users ORDER BY login")) {
            while (r.next()) {
                out.add(user(r));
            }
        }
        return out;
    }

    private static User user(final ResultSet r) throws SQLException {
        return new User(r.getLong("id"), r.getString("login"), r.getString("display_name"), r.getString("password_hash"),
                r.getInt("admin") != 0, r.getInt("disabled") != 0, r.getLong("created"), r.getLong("last_login"));
    }

    /** Sets a user's password hash; every session of theirs ends except {@code keepIdHash} (null: all). */
    public synchronized boolean setPasswordHash(final long userId, final String hash, final String keepIdHash) throws SQLException {
        final boolean changed = update("UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
        endSessions(userId, keepIdHash);
        return changed;
    }

    /** Redoes a hash with today's parameters after a good sign-in: no sessions end. */
    public synchronized void rehash(final long userId, final String hash) throws SQLException {
        update("UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
    }

    /** Turns a user off (their sessions end at once) or back on. */
    public synchronized boolean setDisabled(final long userId, final boolean disabled) throws SQLException {
        final boolean changed = update("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, userId);
        if (disabled) {
            endSessions(userId, null);
        }
        return changed;
    }

    public synchronized boolean setAdmin(final long userId, final boolean admin) throws SQLException {
        return update("UPDATE users SET admin = ? WHERE id = ?", admin ? 1 : 0, userId);
    }

    /** Deletes a user with their sessions, links and setup links (their folders under users/ stay). */
    public synchronized boolean delete(final long userId) throws SQLException {
        return update("DELETE FROM users WHERE id = ?", userId);
    }

    public synchronized void signedIn(final long userId, final long now) throws SQLException {
        update("UPDATE users SET last_login = ? WHERE id = ?", now, userId);
    }

    private boolean update(final String sql, final Object... args) throws SQLException {
        try (PreparedStatement p = db.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                p.setObject(i + 1, args[i]);
            }
            return p.executeUpdate() > 0;
        }
    }

    // ---------------------------------------------------------------- links to OIDC and LDAP

    /** How {@link #external} went: an account found by its link, a new one, a link made by login, or the login is taken. */
    public enum Outcome { LINKED_BEFORE, NEW, LINKED_BY_LOGIN, TAKEN }

    /** What {@link #external} found or made; {@code user} is null when {@link Outcome#TAKEN}. */
    public record External(Outcome outcome, User user) { }

    /**
     * The account for someone a directory or OIDC provider vouches for. Found by {@code (provider, subject)} first, so a
     * rename there keeps their folder; else made with {@code login} and linked. A login that already belongs to an
     * account without a link to this provider is {@link Outcome#TAKEN} (nobody gets an account by picking a matching
     * name elsewhere), unless {@code linkByLogin} and the account has no link to this provider yet. A display name
     * ({@code name} not null) is brought up to date on the way.
     */
    public synchronized External external(final String provider, final String subject, final String login, final String name,
            final boolean linkByLogin, final long now) throws SQLException {
        User u = linked(provider, subject);
        if (u != null) {
            if (name != null && !name.equals(u.displayName())) {
                update("UPDATE users SET display_name = ? WHERE id = ?", name, u.id());
                u = user(u.login());
            }
            return new External(Outcome.LINKED_BEFORE, u);
        }
        final User byLogin = user(login);
        if (byLogin == null) {
            db.setAutoCommit(false);
            try {
                final User made = add(login, name, null, false, now);
                link(made.id(), provider, subject);
                db.commit();
                return new External(Outcome.NEW, made);
            } catch (final SQLException e) {
                db.rollback();
                throw e;
            } finally {
                db.setAutoCommit(true);
            }
        }
        if (!linkByLogin || links(byLogin.id()).stream().anyMatch(l -> l.provider().equals(provider))) {
            return new External(Outcome.TAKEN, null);
        }
        link(byLogin.id(), provider, subject);
        return new External(Outcome.LINKED_BY_LOGIN, byLogin);
    }

    /** One of an account's links: which provider, and who it is there. */
    public record Link(String provider, String subject) { }

    /** The user linked to {@code subject} at {@code provider}, or null. */
    public synchronized User linked(final String provider, final String subject) throws SQLException {
        try (PreparedStatement p = db.prepareStatement("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?")) {
            p.setString(1, provider);
            p.setString(2, subject);
            try (ResultSet r = p.executeQuery()) {
                return r.next() ? user(r) : null;
            }
        }
    }

    /** Links an account to {@code subject} at {@code provider}; false when that subject is already someone's. */
    public synchronized boolean link(final long userId, final String provider, final String subject) throws SQLException {
        try (PreparedStatement p = db.prepareStatement("INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)")) {
            p.setString(1, provider);
            p.setString(2, subject);
            p.setLong(3, userId);
            return p.executeUpdate() > 0;
        }
    }

    /** Removes an account's links to {@code provider}; false when it had none. */
    public synchronized boolean unlink(final long userId, final String provider) throws SQLException {
        return update("DELETE FROM identities WHERE user_id = ? AND provider = ?", userId, provider);
    }

    /** An account's links, by provider. */
    public synchronized List<Link> links(final long userId) throws SQLException {
        final List<Link> out = new ArrayList<>();
        try (PreparedStatement p = db.prepareStatement("SELECT provider, subject FROM identities WHERE user_id = ? ORDER BY provider, subject")) {
            p.setLong(1, userId);
            try (ResultSet r = p.executeQuery()) {
                while (r.next()) {
                    out.add(new Link(r.getString(1), r.getString(2)));
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- sessions

    /**
     * A new session for {@code userId} that lasts at most until {@code expires}; returns its id (256 random bits,
     * base64url), which is only ever in the user's cookie. Expired sessions are swept on the way.
     */
    public synchronized String newSession(final long userId, final long now, final long expires, final String userAgent, final boolean groupAdmin)
            throws SQLException {
        update("DELETE FROM sessions WHERE expires <= ?", now);
        final byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        final String id = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        try (PreparedStatement p = db.prepareStatement(
                "INSERT INTO sessions (id_hash, user_id, created, last_seen, expires, user_agent, group_admin) VALUES (?, ?, ?, ?, ?, ?, ?)")) {
            p.setString(1, hash(id));
            p.setLong(2, userId);
            p.setLong(3, now);
            p.setLong(4, now);
            p.setLong(5, expires);
            p.setString(6, userAgent == null ? null : userAgent.substring(0, Math.min(200, userAgent.length())));
            p.setInt(7, groupAdmin ? 1 : 0);
            p.executeUpdate();
        }
        return id;
    }

    /** The session with this id (from a cookie) and its user, or null. Says nothing about expiry: see {@link Sessions}. */
    public synchronized Session session(final String id) throws SQLException {
        if (id == null || id.isEmpty() || id.length() > 64) {
            return null;
        }
        try (PreparedStatement p = db.prepareStatement("SELECT s.id_hash, s.created AS s_created, s.last_seen, s.expires, s.group_admin, u.*"
                + " FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?")) {
            p.setString(1, hash(id));
            try (ResultSet r = p.executeQuery()) {
                return r.next() ? new Session(r.getString("id_hash"), user(r), r.getLong("s_created"), r.getLong("last_seen"),
                        r.getLong("expires"), r.getInt("group_admin") != 0) : null;
            }
        }
    }

    public synchronized void touch(final String idHash, final long now) throws SQLException {
        update("UPDATE sessions SET last_seen = ? WHERE id_hash = ?", now, idHash);
    }

    public synchronized void endSession(final String idHash) throws SQLException {
        update("DELETE FROM sessions WHERE id_hash = ?", idHash);
    }

    /** Ends every session of {@code userId} except {@code keepIdHash} (null: all). */
    public synchronized void endSessions(final long userId, final String keepIdHash) throws SQLException {
        if (keepIdHash == null) {
            update("DELETE FROM sessions WHERE user_id = ?", userId);
        } else {
            update("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?", userId, keepIdHash);
        }
    }

    /** SHA-256 of a session id or link code, hex: what the file keeps instead of the secret itself. */
    public static String hash(final String secret) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8)));
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public synchronized void close() {
        try {
            db.close();
        } catch (final SQLException e) {
            // closing anyway
        }
    }
}

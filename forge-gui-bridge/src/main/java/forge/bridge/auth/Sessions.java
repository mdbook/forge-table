package forge.bridge.auth;

import java.sql.SQLException;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * Sign-in sessions over a {@link UserStore}: the cookie, idle and absolute expiry, and when last-seen is written.
 * The cookie is {@code __Host-ft_session} ({@code HttpOnly; Secure; SameSite=Lax; Path=/}); Lax rather than Strict so
 * an invite link opened from a chat app arrives signed in. {@code insecureCookies} (plain-http LAN setups) drops
 * {@code Secure} and with it the {@code __Host-} prefix, which requires it.
 */
public final class Sessions {
    /** Last-seen is written at most this often per session. */
    static final long TOUCH_MS = 60_000;

    private final UserStore store;
    private final long idleMs;
    private final long maxMs;
    private final boolean insecureCookies;
    private final LongSupplier clock;

    public Sessions(final UserStore store, final long idleMs, final long maxMs, final boolean insecureCookies, final LongSupplier clock) {
        this.store = store;
        this.idleMs = idleMs;
        this.maxMs = maxMs;
        this.insecureCookies = insecureCookies;
        this.clock = clock;
    }

    public String cookieName() {
        return insecureCookies ? "ft_session" : "__Host-ft_session";
    }

    /** A new session for {@code user}; returns the id to put in {@link #setCookie}. */
    public String open(final UserStore.User user, final String userAgent, final boolean groupAdmin) throws SQLException {
        final long now = clock.getAsLong();
        store.signedIn(user.id(), now);
        return store.newSession(user.id(), now, now + maxMs, userAgent, groupAdmin);
    }

    /**
     * The live session with this id, or null: none, expired (idle or absolute), or its user is turned off. A dead one is
     * deleted on the way.
     */
    public UserStore.Session find(final String id) throws SQLException {
        final UserStore.Session s = store.session(id);
        if (s == null) {
            return null;
        }
        final long now = clock.getAsLong();
        if (s.expires() <= now || now - s.lastSeen() > idleMs || s.user().disabled()) {
            store.endSession(s.idHash());
            return null;
        }
        if (now - s.lastSeen() >= TOUCH_MS) {
            store.touch(s.idHash(), now);
        }
        return s;
    }

    /** The {@code Set-Cookie} value for a new session id. */
    public String setCookie(final String id) {
        return cookieName() + "=" + id + attributes() + "; Max-Age=" + maxMs / 1000;
    }

    /** The {@code Set-Cookie} value that removes the session cookie. */
    public String clearCookie() {
        return cookieName() + "=" + attributes() + "; Max-Age=0";
    }

    private String attributes() {
        return "; Path=/; HttpOnly; SameSite=Lax" + (insecureCookies ? "" : "; Secure");
    }

    /** The pre-login cookie of an OIDC sign-in under way: it ties the provider's callback to the browser that started it. */
    public String preLoginName() {
        return insecureCookies ? "ft_oidc" : "__Host-ft_oidc";
    }

    /** The {@code Set-Cookie} value for a pre-login cookie, good for {@code maxAgeMs}. */
    public String setPreLogin(final String value, final long maxAgeMs) {
        return preLoginName() + "=" + value + attributes() + "; Max-Age=" + maxAgeMs / 1000;
    }

    /** The {@code Set-Cookie} value that removes the pre-login cookie. */
    public String clearPreLogin() {
        return preLoginName() + "=" + attributes() + "; Max-Age=0";
    }

    /** The pre-login cookie's value among {@code Cookie} headers, or null (as {@link #cookie}). */
    public String preLogin(final List<String> cookieHeaders) {
        return cookie(preLoginName(), cookieHeaders);
    }

    /** The session id among {@code Cookie} headers, or null (none, or more than one: a planted duplicate is refused). */
    public String cookie(final List<String> cookieHeaders) {
        return cookie(cookieName(), cookieHeaders);
    }

    private static String cookie(final String name, final List<String> cookieHeaders) {
        final String prefix = name + "=";
        String found = null;
        for (final String header : cookieHeaders) {
            for (final String part : header.split(";")) {
                final String p = part.trim();
                if (p.startsWith(prefix)) {
                    if (found != null) {
                        return null;
                    }
                    found = p.substring(prefix.length());
                }
            }
        }
        return found == null || found.isEmpty() ? null : found;
    }
}

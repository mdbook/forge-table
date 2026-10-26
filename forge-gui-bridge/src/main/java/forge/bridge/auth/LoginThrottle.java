package forge.bridge.auth;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Slows down password guessing, in memory: a login with {@link #LOGIN_FAILS} failures inside {@link #WINDOW_MS} waits
 * {@link #LOCK_MS}; a client address with {@link #ADDRESS_FAILS} failures inside the window waits until the oldest ages
 * out. A try in flight counts as a failure until it {@linkplain #end ends}, so a burst of parallel tries can't all get past
 * the check before the first failure is written down. The failure maps are bounded (the least recently touched entry goes
 * first); the in-flight ones only hold tries still being checked.
 */
public final class LoginThrottle {
    static final int LOGIN_FAILS = 5;
    static final int ADDRESS_FAILS = 30;
    static final long WINDOW_MS = 10 * 60_000L;
    static final long LOCK_MS = 15 * 60_000L;
    private static final int MAX_KEYS = 10_000;

    private final LongSupplier clock;
    private final Map<String, ArrayDeque<Long>> byLogin = bounded();
    private final Map<String, Long> lockedUntil = bounded();
    private final Map<String, ArrayDeque<Long>> byAddress = bounded();

    public LoginThrottle(final LongSupplier clock) {
        this.clock = clock;
    }

    private static <V> Map<String, V> bounded() {
        return new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(final Map.Entry<String, V> e) {
                return size() > MAX_KEYS;
            }
        };
    }

    private final Map<String, Integer> pendingLogin = new HashMap<>();
    private final Map<String, Integer> pendingAddress = new HashMap<>();

    /**
     * Whether a try for {@code login} from {@code address} may go ahead; if so it's in flight until {@link #end}, which
     * the caller must reach whatever the outcome.
     */
    public synchronized boolean begin(final String login, final String address) {
        final long now = clock.getAsLong();
        final Long until = lockedUntil.get(login);
        if (until != null && until > now) {
            return false;
        }
        if (recent(byLogin, login, now) + pendingLogin.getOrDefault(login, 0) >= LOGIN_FAILS
                || recent(byAddress, address, now) + pendingAddress.getOrDefault(address, 0) >= ADDRESS_FAILS) {
            return false;
        }
        pendingLogin.merge(login, 1, Integer::sum);
        pendingAddress.merge(address, 1, Integer::sum);
        return true;
    }

    /** A try from {@link #begin} is done (after {@link #failed} or {@link #succeeded}, if either). */
    public synchronized void end(final String login, final String address) {
        pendingLogin.computeIfPresent(login, (k, n) -> n > 1 ? n - 1 : null);
        pendingAddress.computeIfPresent(address, (k, n) -> n > 1 ? n - 1 : null);
    }

    public synchronized void failed(final String login, final String address) {
        final long now = clock.getAsLong();
        byAddress.computeIfAbsent(address, k -> new ArrayDeque<>()).addLast(now);
        byLogin.computeIfAbsent(login, k -> new ArrayDeque<>()).addLast(now);
        if (recent(byLogin, login, now) >= LOGIN_FAILS) {
            lockedUntil.put(login, now + LOCK_MS);
            byLogin.remove(login);
        }
    }

    /** A good sign-in clears the login's count (not the address's: one good password doesn't vouch for the rest). */
    public synchronized void succeeded(final String login) {
        byLogin.remove(login);
        lockedUntil.remove(login);
    }

    private static int recent(final Map<String, ArrayDeque<Long>> m, final String key, final long now) {
        final ArrayDeque<Long> d = m.get(key);
        if (d == null) {
            return 0;
        }
        while (!d.isEmpty() && d.peekFirst() <= now - WINDOW_MS) {
            d.removeFirst();
        }
        if (d.isEmpty()) {
            m.remove(key);
            return 0;
        }
        return d.size();
    }
}

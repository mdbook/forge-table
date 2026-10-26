package forge.bridge.match;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * Holds the primary game thread to the client's animation timeline.
 *
 * <p>Every beat has a cost: the wall time the client says its choreography takes at the current speed.
 * {@link #admit} runs on the primary game thread after a beat is sent and blocks, in 50 ms slices, while
 * the client is more than {@code budgetMs} behind. Pacing is off when no client is attached, at Instant
 * speed, while the client is hidden, while any prompt is outstanding, and for 4 s-stalled clients (the
 * circuit breaker re-arms only once acks advance again).
 */
public final class Pacer {

    public static final long DEFAULT_BUDGET_MS = 900;
    static final long SLICE_MS = 50;
    static final long STALL_MS = 4000;

    /** Default 1x costs (ms) used until the client declares its own. */
    private static final Map<String, Integer> DEFAULT_COSTS = Map.ofEntries(
            Map.entry("draw", 420), Map.entry("toStack", 300), Map.entry("cast", 0), Map.entry("activate", 0),
            Map.entry("etb", 360), Map.entry("token", 240), Map.entry("resolve", 120), Map.entry("fizzle", 300),
            Map.entry("tap", 180), Map.entry("untap", 120), Map.entry("dies", 650), Map.entry("discard", 360),
            Map.entry("mill", 360), Map.entry("exile", 400), Map.entry("bounce", 360), Map.entry("attack", 240),
            Map.entry("block", 240), Map.entry("damage", 300), Map.entry("life", 400), Map.entry("turn", 700),
            Map.entry("phase", 160), Map.entry("counters", 160), Map.entry("attach", 300), Map.entry("shuffle", 400));

    private final Object lock = new Object();
    private final Map<String, Integer> costs = new HashMap<>(DEFAULT_COSTS);
    private double speed = 1.0;      // 0 means Instant
    private boolean attached;
    private boolean hidden;
    private long budgetMs = DEFAULT_BUDGET_MS;

    /** Cumulative wall cost sent, and (seq, cumulative cost) per sent beat for ack accounting. */
    private long sentCost;
    private long ackedCost;
    private final Deque<long[]> ledger = new ArrayDeque<>();
    private long lastAckProgressAt = System.currentTimeMillis();
    private boolean tripped;

    private volatile BooleanSupplier promptOutstanding = () -> false;

    public void setPromptOutstanding(final BooleanSupplier supplier) {
        this.promptOutstanding = supplier;
    }

    /** Client attached or detached. Detaching releases any wait. */
    public void setAttached(final boolean attached) {
        synchronized (lock) {
            this.attached = attached;
            if (!attached) {
                ackedCost = sentCost;
                ledger.clear();
            }
            lock.notifyAll();
        }
    }

    /** @param speed motion speed multiplier; {@code 0} (or less) means Instant, which disables pacing. */
    public void configure(final double speed, final Map<String, Integer> clientCosts) {
        synchronized (lock) {
            this.speed = speed;
            if (clientCosts != null) {
                costs.putAll(clientCosts);
            }
            lock.notifyAll();
        }
    }

    public void setSpeed(final double speed) {
        configure(speed, null);
    }

    public void setBudgetMs(final long budgetMs) {
        synchronized (lock) {
            this.budgetMs = budgetMs;
        }
    }

    /** Record a sent beat (called under the outbox lock, in seq order). */
    public void beatSent(final long seq, final String kind) {
        synchronized (lock) {
            sentCost += wallCost(kind);
            ledger.addLast(new long[] { seq, sentCost });
        }
    }

    /** Client ack: it has played every beat up to {@code playedSeq}. */
    public void ack(final long playedSeq, final boolean hidden) {
        synchronized (lock) {
            this.hidden = hidden;
            long newAcked = ackedCost;
            while (!ledger.isEmpty() && ledger.peekFirst()[0] <= playedSeq) {
                newAcked = ledger.pollFirst()[1];
            }
            if (newAcked > ackedCost) {
                ackedCost = newAcked;
                lastAckProgressAt = System.currentTimeMillis();
                tripped = false;
            }
            lock.notifyAll();
        }
    }

    /** Skip/collapse on the client: everything sent counts as played. */
    public void skipAll() {
        synchronized (lock) {
            ackedCost = sentCost;
            ledger.clear();
            lastAckProgressAt = System.currentTimeMillis();
            tripped = false;
            lock.notifyAll();
        }
    }

    private long wallCost(final String kind) {
        if (speed <= 0) {
            return 0;
        }
        final Integer c = costs.get(kind);
        return c == null ? 0 : Math.round(c / speed);
    }

    /** Block the primary game thread while the client is too far behind. */
    public void admit(final String kind) {
        synchronized (lock) {
            final long waitStart = System.currentTimeMillis();
            while (true) {
                if (!pacingActive() || sentCost - ackedCost <= budgetMs) {
                    return;
                }
                final long now = System.currentTimeMillis();
                if (now - Math.max(lastAckProgressAt, waitStart) > STALL_MS) {
                    tripped = true; // circuit breaker: stay unpaced until acks advance again
                    return;
                }
                try {
                    lock.wait(SLICE_MS);
                } catch (final InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private boolean pacingActive() {
        return attached && speed > 0 && !hidden && !tripped && !promptOutstanding.getAsBoolean();
    }

    /** Current lead of the engine over the client, in wall ms (for diagnostics and tests). */
    public long leadMs() {
        synchronized (lock) {
            return sentCost - ackedCost;
        }
    }

    public boolean isTripped() {
        synchronized (lock) {
            return tripped;
        }
    }
}

package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

/** Pacer arithmetic, gating conditions and circuit breaker, without an engine. */
public class PacerTest {

    private static Pacer pacer(final double speed) {
        final Pacer p = new Pacer();
        p.configure(speed, Map.of("draw", 400, "tap", 200));
        p.setAttached(true);
        return p;
    }

    @Test
    public void costsScaleWithSpeedAndAcksDrainThem() {
        final Pacer p = pacer(2.0);
        p.beatSent(1, "draw");
        p.beatSent(2, "tap");
        p.beatSent(3, "unknownKind");
        assertEquals(p.leadMs(), 300); // (400 + 200) / 2
        p.ack(1, false);
        assertEquals(p.leadMs(), 100);
        p.ack(3, false);
        assertEquals(p.leadMs(), 0);
    }

    @Test
    public void admitReturnsImmediatelyWithinBudget() {
        final Pacer p = pacer(1.0);
        p.beatSent(1, "draw");
        final long t0 = System.nanoTime();
        p.admit("draw");
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 40);
    }

    @Test
    public void admitBlocksUntilAckedThenReleases() throws Exception {
        final Pacer p = pacer(1.0);
        p.setBudgetMs(300);
        for (int i = 1; i <= 3; i++) {
            p.beatSent(i, "draw"); // 1200 ms ahead
        }
        final Thread acker = new Thread(() -> {
            try {
                Thread.sleep(200);
            } catch (final InterruptedException ignored) {
                return;
            }
            p.ack(3, false);
        });
        acker.start();
        final long t0 = System.currentTimeMillis();
        p.admit("draw");
        final long waited = System.currentTimeMillis() - t0;
        assertTrue(waited >= 150 && waited < 2000, "waited " + waited);
        assertFalse(p.isTripped());
    }

    @Test
    public void unpacedWhenInstantHiddenDetachedOrPrompting() {
        final Pacer instant = pacer(0);
        instant.beatSent(1, "draw");
        assertEquals(instant.leadMs(), 0);

        final Pacer hidden = pacer(1.0);
        hidden.setBudgetMs(0);
        hidden.beatSent(1, "draw");
        hidden.ack(0, true);
        assertFastAdmit(hidden);

        final Pacer prompting = pacer(1.0);
        prompting.setBudgetMs(0);
        prompting.setPromptOutstanding(() -> true);
        prompting.beatSent(1, "draw");
        assertFastAdmit(prompting);

        final Pacer detached = pacer(1.0);
        detached.setBudgetMs(0);
        detached.beatSent(1, "draw");
        detached.setAttached(false);
        assertFastAdmit(detached);
    }

    @Test
    public void circuitBreakerTripsOnStallAndRearmsOnAck() {
        final Pacer p = pacer(1.0);
        p.setBudgetMs(0);
        p.beatSent(1, "draw");
        final long t0 = System.currentTimeMillis();
        p.admit("draw"); // nobody acks: trips after STALL_MS
        assertTrue(System.currentTimeMillis() - t0 >= Pacer.STALL_MS - 100);
        assertTrue(p.isTripped());
        p.beatSent(2, "draw");
        assertFastAdmit(p); // stays unpaced while tripped
        p.ack(1, false);
        assertFalse(p.isTripped());
    }

    private static void assertFastAdmit(final Pacer p) {
        final long t0 = System.nanoTime();
        p.admit("draw");
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 40, "admit should not wait");
    }
}

package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import org.testng.annotations.Test;

import forge.bridge.router.GameHost.Status;

/** When the reaper ends a game, and the reason it logs: never while a browser has the game open. */
public class ReaperTest {

    private static final long MIN = 60_000;
    private static final long GRACE = 15 * MIN;
    private static final long IDLE = 30 * MIN;
    private static final long NOW = 1_000 * MIN;

    private static String reap(final Status s, final int clients, final long overAgo, final long seenAgo) {
        return ChildProcessHost.reapReason(s, clients, NOW - overAgo, NOW - overAgo, NOW - seenAgo, NOW, GRACE, IDLE);
    }

    @Test
    public void graceIsFifteenMinutesByDefault() {
        assertEquals(new ChildProcessHost.Config().graceMs, GRACE);
    }

    @Test
    public void anOpenGameIsNeverReaped() {
        // The production bug: "over" from the game before a rematch, the player still at the table.
        assertNull(reap(Status.OVER, 1, 60 * MIN, 60 * MIN));
        assertNull(reap(Status.PLAYING, 1, 0, 120 * MIN));
        assertNull(reap(Status.READY, 2, 0, 120 * MIN));
    }

    @Test
    public void finishedGamesGoAfterTheGraceWithNobodyConnected() {
        assertNull(reap(Status.OVER, 0, 20 * MIN, 5 * MIN), "the browser left only 5 min ago");
        assertNull(reap(Status.OVER, 0, 5 * MIN, 20 * MIN), "the match ended only 5 min ago");
        final String why = reap(Status.OVER, 0, 20 * MIN, 16 * MIN);
        assertEquals(why, "finished, nobody connected for 16 min");
    }

    @Test
    public void idleAndCrashedGamesSayWhy() {
        assertNull(reap(Status.PLAYING, 0, 0, 29 * MIN));
        assertEquals(reap(Status.PLAYING, 0, 0, 31 * MIN), "idle, nobody connected for 31 min");
        assertEquals(reap(Status.READY, 0, 0, 30 * MIN), "idle, nobody connected for 30 min");
        assertNull(reap(Status.CRASHED, 0, 14 * MIN, 0));
        assertTrue(reap(Status.CRASHED, 0, 15 * MIN, 0).startsWith("crashed"));
        assertNull(reap(Status.STARTING, 0, 99 * MIN, 99 * MIN), "a booting game has its own timeout");
        assertNull(reap(Status.STOPPING, 0, 99 * MIN, 99 * MIN));
    }
}

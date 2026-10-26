package forge.game;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CyclicBarrier;

import org.testng.AssertJUnit;
import org.testng.annotations.Test;

import forge.ai.simulation.SimulationTest;
import forge.game.player.Player;

/**
 * A concede from another thread races the game thread's own state-based check (forge-table p2618: both ran
 * Game.onPlayerLost, the game thread died on a ConcurrentModificationException and the game never ended).
 */
public class ConcurrentConcedeTest extends SimulationTest {

    @Test
    public void gameOverCheckWaitsForTheGameMonitor() throws Exception {
        final Game game = initAndCreateGame();
        game.getPlayers().get(0).concede();
        final Thread other = new Thread(() -> game.getAction().checkGameOverCondition());
        synchronized (game) {
            other.start();
            for (int i = 0; i < 200 && other.getState() != Thread.State.BLOCKED; i++) {
                Thread.sleep(5);
            }
            AssertJUnit.assertEquals(Thread.State.BLOCKED, other.getState());
            AssertJUnit.assertFalse(game.isGameOver());
        }
        other.join(5000);
        AssertJUnit.assertTrue(game.isGameOver());
    }

    @Test
    public void simultaneousChecksEndTheGameOnce() throws Exception {
        for (int rep = 0; rep < 50; rep++) {
            final Game game = initAndCreateGame();
            final Player loser = game.getPlayers().get(0);
            loser.concede();
            final CyclicBarrier start = new CyclicBarrier(2);
            final List<Throwable> errors = new CopyOnWriteArrayList<>();
            final Runnable check = () -> {
                try {
                    start.await();
                    game.getAction().checkGameOverCondition();
                } catch (final Throwable t) {
                    errors.add(t);
                }
            };
            final Thread a = new Thread(check);
            final Thread b = new Thread(check);
            a.start();
            b.start();
            a.join(5000);
            b.join(5000);
            AssertJUnit.assertEquals("rep " + rep + ": " + errors, 0, errors.size());
            AssertJUnit.assertTrue(game.isGameOver());
            AssertJUnit.assertTrue(loser.hasLost());
        }
    }
}

package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Save and resume ({@link Checkpointer}): a game saves its board at priority; a new sidecar started with
 * {@code --resume} deals that board, and its own first checkpoint is the same board again (a fixed point, so a
 * game survives any number of restarts). The checkpoint goes when the game ends.
 */
public class CheckpointTest {

    @Test
    public void aResumedGameIsTheGameThatWasSaved() throws Exception {
        final Path dirA = Files.createTempDirectory("checkpoint-a");
        final Path dirB = Files.createTempDirectory("checkpoint-b");
        final Path a = dirA.resolve("checkpoint.json");
        final Path b = dirB.resolve("checkpoint.json");

        final BridgeApp.Options oa = TableTestEnv.options();
        oa.checkpoint = a.toString();
        final String saved;
        try (AutoPassTest.Game g = new AutoPassTest.Game(Main.boot(oa), AutoPassTest.Game.defaultParams("resume-board.txt"), false)) {
            g.awaitPriority();
            g.sidecar().app.flushCheckpoint();
            final JsonObject c = Checkpointer.read(a);
            saved = c.get("state").getAsString();
            assertEquals(c.get("deck").getAsString(), "mono-red-madness");
            assertEquals(c.get("ai").getAsString(), "Default");
            for (final String kept : new String[] {"turn=5", "activephase=MAIN1", "p0life=13", "p1life=17", "Mountain|Tapped",
                    "Counters:P1P1=2", "AttachedTo:", "FaceDown", "SummonSick", "p0graveyard=Fireblast", "p0exile=Counterspell",
                    "p1library=Island;Island;Island;Island;Island;Island;Island;Island;Island;Accumulated Knowledge"}) {
                assertTrue(printings(saved).contains(kept), kept + " not in the checkpoint:\n" + saved);
            }
            // a restart: the next sidecar gets this game's files
            Files.copy(a, b);
            Files.copy(Checkpointer.deckFile(a, 0), Checkpointer.deckFile(b, 0));
            Files.copy(Checkpointer.deckFile(a, 1), Checkpointer.deckFile(b, 1));
        }
        awaitGone(a);
        assertFalse(Files.exists(a), "the game ended: its checkpoint stays behind");

        final BridgeApp.Options ob = TableTestEnv.options();
        ob.checkpoint = b.toString();
        ob.resume = true;
        ob.deck = null; // nothing from the command line: all of it comes from the checkpoint
        ob.oppDeck = null;
        try (AutoPassTest.Game g = new AutoPassTest.Game(Main.boot(ob), null, false)) {
            g.awaitPriority();
            g.sidecar().app.flushCheckpoint();
            final JsonObject c = Checkpointer.read(b);
            assertEquals(ids(c.get("state").getAsString()), ids(saved));
            assertEquals(c.get("oppDeck").getAsString(), "mono-blue-faeries");
        }
    }

    /**
     * The beginning of combat is a step Checkpointer saves at, and a game resumed there has no Combat yet (it is made
     * as the step begins, and the resume skips that): the step after it must still find one, not throw.
     */
    @Test
    public void aGameResumedAtTheStartOfCombatGoesOn() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("resume-combat-begin.txt", false)) {
            // No stop of mine at the beginning of combat or the empty steps after it: the first one is the second main phase.
            g.awaitPriority();
            assertEquals(g.phase(), "MAIN2");
        }
    }

    /** A checkpoint that can't be resumed is moved aside (so the game isn't paused with it again) and the start screen shows. */
    @Test
    public void anUnreadableCheckpointIsMovedAside() throws Exception {
        final Path cp = Files.createTempDirectory("checkpoint-bad").resolve("checkpoint.json");
        Files.writeString(cp, "{\"v\":1,\"sta", java.nio.charset.StandardCharsets.UTF_8);
        final BridgeApp.Options o = TableTestEnv.options();
        o.checkpoint = cp.toString();
        o.resume = true;
        final Main.Running r = Main.boot(o);
        try {
            assertFalse(Files.exists(cp));
            assertTrue(Files.isRegularFile(cp.resolveSibling("checkpoint.json.bad")));
            assertEquals(r.app.match(), null, "nothing dealt: the start screen");
        } finally {
            r.stop();
        }
    }

    /** Conceding queued the removal on the checkpoint thread. */
    private static void awaitGone(final Path a) throws InterruptedException {
        for (int i = 0; i < 50 && Files.exists(a); i++) {
            Thread.sleep(100);
        }
    }

    /** Without the printing of each card ({@code |Set:TRK|Art:1}). */
    private static String printings(final String state) {
        return state.replaceAll("\\|Set:[^|;]*|\\|Art:\\d+", "");
    }

    /** Card ids are the dealing game's own: compare boards without them. */
    private static String ids(final String state) {
        return state.replaceAll("(Id|AttachedTo|ExiledWith):\\d+", "$1:#");
    }
}

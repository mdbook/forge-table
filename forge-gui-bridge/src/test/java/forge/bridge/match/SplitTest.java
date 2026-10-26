package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;

import org.testng.annotations.Test;

/** The damage assignment and amount split rules the sidecar enforces on a reply (Swing's dialogs' rules). */
public class SplitTest {
    private static final int[] TWO_BEARS_AND_PLAYER = {2, 2, 20};

    @Test
    public void everyPointMustBeAssigned() {
        assertNotNull(BridgeGuiGame.combatError(new int[] {2, 2, 1}, TWO_BEARS_AND_PLAYER, 6, "lethalFirst", true));
        assertNull(BridgeGuiGame.combatError(new int[] {2, 2, 2}, TWO_BEARS_AND_PLAYER, 6, "lethalFirst", true));
        assertNotNull(BridgeGuiGame.combatError(new int[] {-1, 5, 2}, TWO_BEARS_AND_PLAYER, 6, "free", true));
    }

    @Test
    public void trampleNeedsLethalOnEveryBlockerFirst() {
        assertNotNull(BridgeGuiGame.combatError(new int[] {1, 2, 3}, TWO_BEARS_AND_PLAYER, 6, "lethalFirst", true));
        // Blockers themselves can be assigned in any order.
        assertNull(BridgeGuiGame.combatError(new int[] {0, 6, 0}, TWO_BEARS_AND_PLAYER, 6, "lethalFirst", true));
        assertNull(BridgeGuiGame.combatError(new int[] {1, 5, 0}, TWO_BEARS_AND_PLAYER, 6, "lethalFirst", true));
    }

    @Test
    public void legacyOrderNeedsLethalOnEachEarlierTarget() {
        assertNotNull(BridgeGuiGame.combatError(new int[] {1, 5}, new int[] {2, 2}, 6, "inOrder", false));
        assertNull(BridgeGuiGame.combatError(new int[] {2, 4}, new int[] {2, 2}, 6, "inOrder", false));
        assertNull(BridgeGuiGame.combatError(new int[] {6, 0}, new int[] {2, 2}, 6, "inOrder", false));
    }

    @Test
    public void divideAsYouChooseIsFree() {
        assertNull(BridgeGuiGame.combatError(new int[] {0, 0, 6}, TWO_BEARS_AND_PLAYER, 6, "free", true));
    }

    @Test
    public void autoIsLethalInOrderThenTheRestToTheLast() {
        assertEquals(BridgeGuiGame.autoCombat(TWO_BEARS_AND_PLAYER, 6), new int[] {2, 2, 2});
        assertEquals(BridgeGuiGame.autoCombat(TWO_BEARS_AND_PLAYER, 3), new int[] {2, 1, 0});
        assertEquals(BridgeGuiGame.autoCombat(new int[] {1, 1}, 5), new int[] {1, 4});
    }

    @Test
    public void splitRespectsBoundsAndTotal() {
        final int[] min = {1, 1};
        final int[] max = {3, 3};
        assertNull(BridgeGuiGame.splitError(new int[] {1, 2}, min, max, 3));
        assertNotNull(BridgeGuiGame.splitError(new int[] {0, 3}, min, max, 3));
        assertNotNull(BridgeGuiGame.splitError(new int[] {1, 1}, min, max, 3));
        assertNotNull(BridgeGuiGame.splitError(new int[] {4, 0}, new int[] {0, 0}, max, 4));
    }

    @Test
    public void autoSplitGivesTheMinimumThenFillsInOrder() {
        assertEquals(BridgeGuiGame.autoSplit(new int[] {1, 1, 1}, new int[] {5, 5, 5}, 5), new int[] {3, 1, 1});
        assertEquals(BridgeGuiGame.autoSplit(new int[] {0, 0, 0}, new int[] {1, 1, 1}, 2), new int[] {1, 1, 0});
    }
}

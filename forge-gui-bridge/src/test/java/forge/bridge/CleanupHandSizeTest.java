package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.util.List;
import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

import forge.deck.Deck;
import forge.game.player.RegisteredPlayer;

/**
 * Regression (ticket 1521): cleanup asked to "discard 6 cards to bring your hand down to the maximum of 0 cards". A game
 * from a board state (a fixture, or a saved game resumed after a restart) registers its players with no opening hand,
 * and Forge used that same zero as each player's maximum hand size. The maximum must stay the rules' 7.
 */
public class CleanupHandSizeTest {

    @Test
    public void cleanupDiscardsDownToSevenInABoardGame() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("cleanup-hand-size.txt", false)) {
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer);
            assertEquals(g.phase(), "MAIN2");
            g.yieldEndOfTurn();
            final JsonObject discard = g.await(m -> "prompt".equals(m.get("t").getAsString()) && m.has("message")
                    && m.get("message").getAsString().contains("discard"));
            final String message = discard.get("message").getAsString();
            assertTrue(message.contains("maximum of 7 cards"), "wrong maximum hand size: " + message);
            assertTrue(message.contains("Select 1 card(s)"), "wrong discard count: " + message);
        }
    }

    @Test
    public void noOpeningHandKeepsEachPlayersRealHandSize() {
        final RegisteredPlayer usual = new RegisteredPlayer(new Deck("a"));
        final RegisteredPlayer bigger = new RegisteredPlayer(new Deck("b"));
        bigger.setStartingHand(8);
        final Map<RegisteredPlayer, Integer> sizes = BridgeApp.withoutOpeningHands(List.of(usual, bigger));
        assertEquals(usual.getStartingHand(), 0, "a board game deals no opening hand");
        assertEquals(bigger.getStartingHand(), 0, "a board game deals no opening hand");
        assertEquals(sizes.get(usual).intValue(), 7);
        assertEquals(sizes.get(bigger).intValue(), 8);
    }
}

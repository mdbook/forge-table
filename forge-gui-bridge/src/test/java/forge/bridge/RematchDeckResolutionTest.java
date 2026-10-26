package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import org.testng.annotations.Test;

/**
 * Rematch: a seat whose deck choice was "Random deck" re-rolls on Rematch, a seat with a
 * fixed deck keeps it, and a pool bigger than one never repeats the deck just played. No sidecar needed:
 * {@link BridgeApp#reroll} is pure over a deck-name pool, and {@link BridgeApp#legalDeckNames(List, String)} without
 * a format is plain filesystem listing.
 */
public class RematchDeckResolutionTest {

    @Test
    public void emptyPoolKeepsThePreviousDeck() {
        // Nothing to draw from (every deck removed since): a random seat still gets something to play.
        assertEquals(BridgeApp.reroll(List.of(), "Whatever", new Random()), "Whatever");
    }

    @Test
    public void onePickKeepsTheOnlyDeckEvenIfItWasJustPlayed() {
        assertEquals(BridgeApp.reroll(List.of("Solo Deck"), "Solo Deck", new Random()), "Solo Deck");
    }

    @Test
    public void previousDeckMissingFromThePoolIsNoObstacle() {
        // A deck that left the pool between games (deleted, or no longer legal): any pick in the pool is fine.
        for (int i = 0; i < 20; i++) {
            final String pick = BridgeApp.reroll(List.of("X", "Y"), "Gone", new Random());
            assertTrue(List.of("X", "Y").contains(pick), "not from the pool: " + pick);
        }
    }

    @Test
    public void neverRepeatsTheDeckJustPlayedWhenThereIsAnother() {
        final List<String> pool = List.of("A", "B", "C");
        final Random rng = new Random(7);
        String previous = "A";
        for (int i = 0; i < 200; i++) {
            final String pick = BridgeApp.reroll(pool, previous, rng);
            assertTrue(pool.contains(pick), "not from the pool: " + pick);
            assertNotEquals(pick, previous, "repeated the deck just played");
            previous = pick;
        }
    }

    @Test
    public void everyDeckInTheSmallPoolGetsDrawnEventually() {
        final List<String> pool = List.of("A", "B", "C", "D");
        final Random rng = new Random(99);
        final Set<String> seen = new HashSet<>();
        String previous = null;
        for (int i = 0; i < 400; i++) {
            previous = BridgeApp.reroll(pool, previous, rng);
            seen.add(previous);
        }
        assertEquals(seen, Set.copyOf(pool));
    }

    /** The non-format pool (Constructed): every deck name in the folders, same as the start screen's picker lists. */
    @Test
    public void nonFormatPoolIsEveryDeckNameInTheDirs() {
        final List<String> names = BridgeApp.legalDeckNames(List.of(TableTestEnv.decksDir()), null);
        assertTrue(names.contains("mono-red-madness"), names.toString());
        assertTrue(names.contains("mono-blue-faeries"), names.toString());
        assertTrue(names.size() > 1, "need more than one deck to exercise the no-repeat rule: " + names);
    }

    /** A pool of exactly two always re-rolls to the other one (the only way to honor "no immediate repeat" there). */
    @Test
    public void twoDeckPoolAlwaysSwaps() {
        final List<String> pool = List.of("Red", "Blue");
        final Random rng = new Random(3);
        String previous = "Red";
        for (int i = 0; i < 50; i++) {
            final String pick = BridgeApp.reroll(pool, previous, rng);
            assertNotEquals(pick, previous);
            previous = pick;
        }
    }
}

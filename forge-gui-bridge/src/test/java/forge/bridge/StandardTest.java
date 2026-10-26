package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import forge.deck.Deck;
import forge.deck.DeckSection;

/** Standard: a Constructed game whose decks are checked against Forge's Sanctioned/Standard.txt (sets, bans) and size. */
public class StandardTest {

    private Main.Running sidecar;

    @BeforeClass
    public void boot() throws Exception {
        sidecar = TableTestEnv.start(); // loads the card database and formats
    }

    @AfterClass(alwaysRun = true)
    public void stop() {
        if (sidecar != null) {
            sidecar.stop();
        }
    }

    /** Llanowar Elves (Foundations) {@code elves} times, {@code extra} once each, Forests to {@code size}. */
    private static Deck elves(final int elves, final int size, final String... extra) {
        final Deck d = new Deck("Test Standard");
        d.getMain().add("Llanowar Elves", elves);
        for (final String e : extra) {
            d.getMain().add(e, 1);
        }
        d.getMain().add("Forest", size - elves - extra.length);
        return d;
    }

    @Test
    public void formatNames() {
        assertEquals(Formats.parse("Standard"), Formats.STANDARD);
        assertTrue(Formats.isBrawl(Formats.BRAWL));
        assertFalse(Formats.isBrawl(Formats.STANDARD));
        assertFalse(Formats.isBrawl(null));
    }

    @Test
    public void deckRules() {
        assertNull(Formats.problem(Formats.STANDARD, elves(4, 60)));
        assertNotNull(Formats.problem(Formats.STANDARD, elves(4, 40)), "40 cards");
        assertNotNull(Formats.problem(Formats.STANDARD, elves(5, 60)), "five copies");
        final String old = Formats.problem(Formats.STANDARD, elves(4, 60, "Lightning Bolt"));
        assertNotNull(old);
        assertTrue(old.startsWith("Test Standard ") && old.contains("Lightning Bolt") && !old.contains("\n"), old);
        assertTrue(String.valueOf(Formats.problem(Formats.STANDARD, elves(4, 60, "Heartfire Hero"))).contains("Heartfire Hero"),
                "banned");
        // A Brawl deck is not a Standard deck (Forge's Constructed check alone would pass its 99), and the reverse.
        final Deck brawl = elves(1, 99);
        brawl.getOrCreate(DeckSection.Commander).add("Fynn, the Fangbearer", 1);
        assertEquals(Formats.problem(Formats.STANDARD, brawl), "Test Standard has a commander (Standard has none)");
        assertNotNull(Formats.problem(Formats.BRAWL, elves(4, 60)));
    }
}

package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertTrue;

import java.io.File;

import org.testng.annotations.Test;

import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.item.PaperCard;

/** The vendored mtg-ai Pauper decks load completely against this card database. */
public class DeckFixturesTest {

    @Test
    public void allTwelveDecksLoadWithKnownCards() throws Exception {
        final Main.Running sidecar = TableTestEnv.start(); // boots the card database
        sidecar.stop();
        final File[] files = TableTestEnv.decksDir().listFiles((d, n) -> n.endsWith(".dck"));
        assertNotNull(files);
        assertEquals(files.length, 12);
        for (final File f : files) {
            final Deck d = DeckSerializer.fromFile(f);
            assertNotNull(d, f.getName());
            int count = 0;
            for (final java.util.Map.Entry<PaperCard, Integer> e : d.getMain()) {
                assertNotNull(e.getKey().getRules(), f.getName() + ": " + e.getKey());
                count += e.getValue();
            }
            assertTrue(count >= 60, f.getName() + " has " + count + " cards");
        }
    }
}

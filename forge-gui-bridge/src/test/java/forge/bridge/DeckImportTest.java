package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.io.File;
import java.nio.file.Files;

import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.deck.io.DeckSerializer;

/** rpc decks.import: pasted lists in the common export formats, unknown lines reported, unique file names. */
public class DeckImportTest {

    @BeforeClass
    public void boot() throws Exception {
        TableTestEnv.start().stop(); // card database
    }

    private static JsonObject params(final String text, final boolean dryRun) {
        final JsonObject p = new JsonObject();
        p.addProperty("text", text);
        p.addProperty("dryRun", dryRun);
        return p;
    }

    @Test
    public void arenaStyleListWithSideboardAndUnknownLine() throws Exception {
        final String list = "Deck\n4 Lightning Bolt (M10) 146\n16 Mountain\n2 Fireblast [VIS]\n3 Not A Real Card\n\nSideboard\n2 Pyroblast\n";
        final File dir = Files.createTempDirectory("decks").toFile();
        final JsonObject res = DeckImport.run(params(list, false), dir, n -> false);
        assertEquals(res.get("main").getAsInt(), 22);
        assertEquals(res.get("side").getAsInt(), 2);
        assertEquals(res.getAsJsonArray("unknown").size(), 1);
        assertTrue(res.getAsJsonArray("unknown").get(0).getAsString().contains("Not A Real Card"));
        assertTrue(res.get("saved").getAsBoolean());
        final File saved = new File(dir, res.get("name").getAsString() + ".dck");
        assertTrue(saved.isFile(), saved.toString());
        final Deck d = DeckSerializer.fromFile(saved);
        assertEquals(d.getMain().countAll(), 22);
        assertEquals(d.get(DeckSection.Sideboard).countAll(), 2);
    }

    @Test
    public void dryRunSavesNothingAndNamesAreMadeUnique() throws Exception {
        final File dir = Files.createTempDirectory("decks").toFile();
        final JsonObject p = params("20 Island\n4 Counterspell", true);
        p.addProperty("name", "Blue: Tempo?");
        final JsonObject res = DeckImport.run(p, dir, n -> n.equalsIgnoreCase("Blue Tempo") || n.equalsIgnoreCase("Blue Tempo (2)"));
        assertEquals(res.get("name").getAsString(), "Blue Tempo (3)"); // file-name-safe and free
        assertFalse(res.get("saved").getAsBoolean());
        assertEquals(dir.listFiles().length, 0);
        assertEquals(res.get("recognized").getAsInt(), 24);
    }

    @Test
    public void nothingRecognizedIsAnError() {
        final File dir = new File(System.getProperty("java.io.tmpdir"));
        final IllegalArgumentException e = expectThrows(IllegalArgumentException.class,
                () -> DeckImport.run(params("4 Definitely Not A Card\n2 Also Fake", true), dir, n -> false));
        assertTrue(e.getMessage().contains("Definitely Not A Card"), e.getMessage());
        expectThrows(IllegalArgumentException.class, () -> DeckImport.run(new JsonObject(), dir, n -> false));
    }

    /** Names a router game (--names-only) couldn't load again are refused before anything is saved. */
    @Test
    public void namesStartingWithDotOrDashAreRefused() throws Exception {
        final File dir = Files.createTempDirectory("decks").toFile();
        for (final String name : new String[] {".hidden", "-x", "--router", "..."}) {
            final JsonObject p = params("20 Island\n4 Counterspell", false);
            p.addProperty("name", name);
            final IllegalArgumentException e = expectThrows(IllegalArgumentException.class, () -> DeckImport.run(p, dir, n -> false));
            assertTrue(e.getMessage().contains("can't start with"), name + ": " + e.getMessage());
        }
        assertEquals(dir.listFiles().length, 0);
    }

    /** The preview: every card with its type group and mana value, a typo's fix, the commander's identity. */
    @Test
    public void previewListsCardsFixesTyposAndChecksTheCommander() throws Exception {
        final File dir = Files.createTempDirectory("decks").toFile();
        final String list = "Commander\n1 Niv-Mizzet, Parun\n\nDeck\n1 Opt\n1 Lighting Bolt\n1 Spirebluff Canal\n10 Island\n";
        final JsonObject res = DeckImport.run(params(list, true), dir, n -> false);
        final JsonArray cards = res.getAsJsonArray("cards");
        JsonObject niv = null;
        JsonObject canal = null;
        for (final JsonElement e : cards) {
            final JsonObject c = e.getAsJsonObject();
            if (c.get("name").getAsString().equals("Niv-Mizzet, Parun")) {
                niv = c;
            } else if (c.get("name").getAsString().equals("Spirebluff Canal")) {
                canal = c;
            }
        }
        assertEquals(niv.get("section").getAsString(), "commander");
        assertEquals(niv.get("type").getAsString(), "Creature");
        assertEquals(niv.get("cmc").getAsInt(), 6);
        assertEquals(canal.get("type").getAsString(), "Land");
        assertEquals(canal.get("section").getAsString(), "main");
        // Keyed by the unknown line as reported (quantity and all).
        assertEquals(res.getAsJsonObject("fixes").get("1 Lighting Bolt").getAsString(), "Lightning Bolt", res.toString());
        assertEquals(res.get("identity").getAsString(), "UR");
        // 14 cards is no Brawl deck (100 with the commander): Forge says why, without the deck's name in front.
        assertTrue(res.has("brawlProblem"), res.toString());
        assertFalse(res.get("brawlProblem").getAsString().startsWith(res.get("name").getAsString()), res.toString());
    }

    @Test
    public void closestNameIsATypoOrNothing() {
        final java.util.List<String> names = java.util.List.of("Lightning Bolt", "Lightning Helix", "Opt");
        assertEquals(DeckImport.closest("lighting bolt", names), "Lightning Bolt");
        assertEquals(DeckImport.closest("Lightning Helx", names), "Lightning Helix");
        assertEquals(DeckImport.closest("Op", names), "Opt"); // one edit is always near enough
        assertEquals(DeckImport.closest("4x Lightning Bolt", names), "Lightning Bolt");
        assertEquals(DeckImport.closest("Counterspell", names), null);
        assertEquals(DeckImport.distance("kitten", "sitting", 10), 3);
        assertEquals(DeckImport.distance("kitten", "sitting", 2), 2); // capped
    }
}

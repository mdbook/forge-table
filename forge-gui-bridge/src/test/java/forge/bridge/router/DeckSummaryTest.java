package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;

import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** What the lobby's deck gallery reads out of a {@code .dck} file without a game (no files: lines in, summary out). */
public class DeckSummaryTest {

    private static DeckSummary parse(final String text) {
        return DeckSummary.parse(List.of(text.split("\n", -1)));
    }

    @Test
    public void constructedDeck() {
        final DeckSummary d = parse("[metadata]\nName=Burn\n[Main]\n4 Lightning Bolt|M10|1\n4 Goblin Guide|ZEN\n2 Lava Spike\n"
                + "10 Mountain|M10\n2 Snow-Covered Plains\n[Sideboard]\n4 Smash to Smithereens\n15 Island\n");
        assertEquals(d.cards(), 22, "Main only: the sideboard doesn't count");
        assertEquals(d.colors(), "WR", "basics in WUBRG order, snow-covered too; sideboard basics don't count");
        assertEquals(d.key(), "Lightning Bolt", "most copies, first listed on a tie");
        assertNull(d.commander());
    }

    @Test
    public void commanderIsTheKey() {
        final DeckSummary d = parse("[metadata]\nName=Vigil\n[Commander]\n1 Atraxa, Praetors' Voice|C16\n1 Thrasios, Triton Hero\n"
                + "[Main]\n30 Forest\n20 Swamp\n40 Sol Ring\n1 Wastes\n5 Snow-Covered Island\n");
        assertEquals(d.cards(), 98);
        assertEquals(d.commander(), "Atraxa, Praetors' Voice", "the first commander");
        assertEquals(d.key(), "Atraxa, Praetors' Voice", "a commander beats any count");
        assertEquals(d.colors(), "UBG");
        final JsonObject j = d.toJson();
        assertEquals(j.get("commander").getAsString(), "Atraxa, Praetors' Voice");
        assertEquals(j.get("cards").getAsInt(), 98);
    }

    @Test
    public void basicsAreNeverTheKey() {
        final DeckSummary d = parse("[Main]\n20 Island\n20 Snow-Covered Swamp\n10 Wastes\n");
        assertEquals(d.cards(), 50);
        assertEquals(d.colors(), "UB", "Wastes is a basic without a colour");
        assertNull(d.key(), "only basics: no key");
        final JsonObject j = d.toJson();
        assertFalse(j.has("key"));
        assertFalse(j.has("commander"));
        assertEquals(j.get("colors").getAsString(), "UB");
    }

    @Test
    public void sameCardOnTwoLinesAddsUp() {
        final DeckSummary d = parse("[Main]\n3 Shock|M19\n2 Opt\n1 Shock|AKH\n");
        assertEquals(d.key(), "Shock", "3 + 1 beats 2");
        assertEquals(d.cards(), 6);
        assertEquals(d.dupes(), List.of(), "no commander: not a Brawl deck, no singleton check");
    }

    /** The singleton check the Brawl drawer shows. Basics (snow too) never count; a commander does. */
    @Test
    public void dupesAreNonBasicsWithMoreThanOneCopy() {
        final DeckSummary d = parse("[Commander]\n1 Niv-Mizzet, Parun\n[Main]\n1 Niv-Mizzet, Parun\n2 Opt|M19\n1 Shock\n"
                + "20 Island\n4 Snow-Covered Mountain\n[Sideboard]\n1 Shock\n");
        assertEquals(d.dupes(), List.of("Niv-Mizzet, Parun", "Opt"), "the sideboard doesn't count");
        assertEquals(d.toJson().getAsJsonArray("dupes").size(), 2);
        assertFalse(parse("[Main]\n1 Opt\n30 Island\n").toJson().has("dupes"));
    }

    @Test
    public void junkAndMissingSections() {
        assertEquals(parse(""), new DeckSummary(0, "", null, null));
        assertEquals(parse("[metadata]\nName=Nothing\n"), new DeckSummary(0, "", null, null), "no [Main]");
        assertEquals(parse("4 Lightning Bolt\n"), new DeckSummary(0, "", null, null), "cards before any section don't count");
        final DeckSummary d = parse("[ MAIN ]\r\nnot a card\n Lightning Bolt\n4\n4x Opt\n99999 Forest\n-1 Island\n\n  2 Counterspell|7ED  \r\n|\n");
        assertEquals(d.cards(), 2, "only the well-formed line; section names any case");
        assertEquals(d.key(), "Counterspell");
        assertEquals(d.colors(), "");
    }

    /** A hostile line (the old pattern backtracked quadratically on it) costs its length; spaces before | are fine. */
    @Test(timeOut = 5_000)
    public void hostileLinesAreCheap() {
        final String spaces = " ".repeat(200_000);
        final StringBuilder deck = new StringBuilder("[Main]\n1 Opt  |M10\n");
        for (int i = 0; i < 20; i++) {
            deck.append("1 a").append(spaces).append("|\u2028x\n").append('1').append(spaces).append("|\u2028\n");
        }
        deck.append("1 b").append(" ".repeat(DeckSummary.MAX_LINE)).append("c\n");
        final DeckSummary d = parse(deck.toString());
        assertEquals(d.cards(), 1, "only the short, well-formed line");
        assertEquals(d.key(), "Opt");
    }
}

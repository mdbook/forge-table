package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.testng.annotations.Test;

/** The lobby's Standard check, against a tiny res/: two Standard sets, one that isn't, a banlist, card scripts. */
public class StandardPoolTest {

    private static Path res() throws Exception {
        final Path res = Files.createTempDirectory("ft-std-res");
        Files.createDirectories(res.resolve("formats/Sanctioned"));
        Files.writeString(res.resolve("formats/Sanctioned/Standard.txt"),
                "[format]\nName:Standard\nSets:AAA, BBB\nBanned:Bad Card; Worse Card\n");
        Files.createDirectories(res.resolve("editions"));
        Files.writeString(res.resolve("editions/Alpha Set.txt"), String.join("\n", "[metadata]", "Code=AAA", "Name=Alpha", "",
                "[cards]", "1 C Good Card @Someone", "2 R Bad Card @Someone", "3 M Unholy Annex // Ritual Chamber @A", "4 U Relentless Rats",
                "5 R Seven Dwarves @X", "", "[special guests]", "1 Lightning Bolt|SPG", "", "[tokens]", "1 w_1_1_cat @Y"));
        Files.writeString(res.resolve("editions/Beta Set.txt"), "[metadata]\nCode=BBB\n\n[showcase]\n10 Other Card ${\"x\": \"y\"}\n");
        Files.writeString(res.resolve("editions/Old Set.txt"), "[metadata]\nCode=OLD\n\n[cards]\n1 C Lightning Bolt\n1 C Counterspell\n1 C Opt\n");
        Files.createDirectories(res.resolve("cardsfolder/r"));
        Files.createDirectories(res.resolve("cardsfolder/s"));
        Files.writeString(res.resolve("cardsfolder/r/relentless_rats.txt"), "Name:Relentless Rats\nK:A deck can have any number of cards named CARDNAME.\n");
        Files.writeString(res.resolve("cardsfolder/s/seven_dwarves.txt"), "Name:Seven Dwarves\nK:DeckLimit:7:A deck can have up to seven cards named CARDNAME.\n");
        return res;
    }

    private static List<String> deck(final String... main) {
        final List<String> l = new ArrayList<>(List.of("[metadata]", "Name=t", "[Main]"));
        l.addAll(List.of(main));
        return l;
    }

    private static String judge(final StandardPool p, final String... main) {
        return p.problem(DeckSummary.sections(deck(main)));
    }

    @Test
    public void judgesSetsBansCopiesAndSize() throws Exception {
        final StandardPool p = new StandardPool(res());
        assertTrue(p.ready());
        assertNull(judge(p, "4 Good Card|AAA|1", "4 Other Card", "52 Forest"), "legal: both sets, basics");
        assertNull(judge(p, "4 Good Card", "2 Unholy Annex // Ritual Chamber", "2 Unholy Annex", "52 Snow-Covered Island"),
                "a room by its full name or its first half");
        assertEquals(judge(p, "4 Lightning Bolt", "56 Mountain"), "1 card isn’t in Standard: Lightning Bolt",
                "a special guest is another set's printing");
        assertEquals(judge(p, "4 Lightning Bolt", "4 Counterspell", "4 Opt", "4 good card", "44 Island"),
                "3 cards aren’t in Standard: Lightning Bolt, Counterspell and 1 more", "names match whatever the case");
        assertEquals(judge(p, "4 Bad Card", "56 Plains"), "Banned in Standard: Bad Card");
        assertEquals(judge(p, "4 Bad Card", "4 Lightning Bolt", "52 Plains"), "1 card isn’t in Standard: Lightning Bolt", "the set first");
        assertEquals(judge(p, "5 Good Card", "55 Plains"), "More than 4 copies: Good Card");
        assertNull(judge(p, "20 Relentless Rats", "40 Swamp"), "any number");
        assertNull(judge(p, "7 Seven Dwarves", "53 Mountain"), "its own limit");
        assertEquals(judge(p, "8 Seven Dwarves", "52 Mountain"), "More than 4 copies: Seven Dwarves");
        assertEquals(judge(p, "4 Good Card", "50 Forest"), "54 cards: Standard needs 60");
        final List<String> side = deck("4 Good Card", "56 Forest");
        side.addAll(List.of("[Sideboard]", "3 Good Card"));
        assertEquals(p.problem(DeckSummary.sections(side)), "More than 4 copies: Good Card", "the sideboard counts toward copies");
        side.add("16 Island");
        assertEquals(p.problem(DeckSummary.sections(side)), "19 sideboard cards: Standard allows 15");
    }

    @Test
    public void unreadableResJudgesNothing() throws Exception {
        final Path res = Files.createTempDirectory("ft-std-none");
        final StandardPool p = new StandardPool(res);
        assertFalse(p.ready());
        assertNull(judge(p, "4 Lightning Bolt", "56 Mountain"));
        Files.createDirectories(res.resolve("formats/Sanctioned"));
        Files.writeString(res.resolve("formats/Sanctioned/Standard.txt"), "Sets:ZZZ\n");
        assertFalse(p.ready(), "no edition file for its sets");
    }

    @Test
    public void reloadsWhenStandardChanges() throws Exception {
        final Path res = res();
        final StandardPool p = new StandardPool(res);
        assertNull(judge(p, "4 Good Card", "56 Forest"));
        final Path f = res.resolve("formats/Sanctioned/Standard.txt");
        Files.writeString(f, "Sets:AAA\nBanned:Good Card\n");
        Files.setLastModifiedTime(f, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 60_000));
        assertEquals(judge(p, "4 Good Card", "56 Forest"), "Banned in Standard: Good Card");
    }

    @Test
    public void scriptNames() {
        assertEquals(StandardPool.scriptName("Sphinx's Approach"), "sphinxs_approach");
        assertEquals(StandardPool.scriptName("Nazgûl"), "nazgul");
        assertEquals(StandardPool.scriptName("Fire // Ice"), "fire_ice");
        assertEquals(StandardPool.scriptName("Cid, Timeless Artificer"), "cid_timeless_artificer");
        assertEquals(StandardPool.scriptName("Cori-Steel Cutter"), "cori_steel_cutter");
    }

    @Test
    public void sectionsKeepFileOrder() {
        assertEquals(DeckSummary.sections(List.of("[metadata]", "Name=x", "[Commander]", "1 Aang, at the Crossroads|TLA", "[Main]",
                "2 Opt", "1 Opt", "30 Island", "not a card", "[Sideboard]", "[Avatar]")).toString(),
                "{Commander={Aang, at the Crossroads=1}, Main={Opt=3, Island=30}}");
    }
}

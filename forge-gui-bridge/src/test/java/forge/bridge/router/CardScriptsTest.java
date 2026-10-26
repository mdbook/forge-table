package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNull;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import org.testng.annotations.Test;

/** Card scripts by name, from res/cardsfolder's folders or the zip a release ships, as the deck peek reads them. */
public class CardScriptsTest {

    private static final Map<String, String> SCRIPTS = Map.of(
            "l/lightning_bolt.txt", "Name:Lightning Bolt\nManaCost:R\nTypes:Instant\n",
            "f/fire_ice.txt", "Name:Fire\nManaCost:1 R\nTypes:Instant\nAlternateMode:Split\n\nALTERNATE\n\nName:Ice\nManaCost:1 U\nTypes:Instant\n",
            "d/delver_of_secrets_insectile_aberration.txt", "Name:Delver of Secrets\nManaCost:U\nTypes:Creature Human Wizard\n"
                    + "AlternateMode:DoubleFaced\n\nALTERNATE\n\nName:Insectile Aberration\nManaCost:no cost\nTypes:Creature Human Insect\n",
            "d/delver_of_secrets_decoy.txt", "Name:Delver of Secrets Decoy\nManaCost:9\nTypes:Sorcery\n",
            "u/urzas_tower.txt", "Name:Urza's Tower\nManaCost:no cost\nTypes:Land Urza's Tower\n",
            "o/ornithopter.txt", "Name:Ornithopter\nManaCost:0\nTypes:Artifact Creature Thopter\n",
            "r/relentless_rats.txt", "Name:Relentless Rats\nManaCost:1 B B\nTypes:Creature Rat\nK:A deck can have any number of cards named CARDNAME.\n");

    private static void check(final CardScripts s) {
        assertEquals(s.info("Lightning Bolt"), new CardScripts.Info("Instant", 1, "{R}"));
        assertEquals(s.info("Fire // Ice"), new CardScripts.Info("Instant", 4, "{1}{R} // {1}{U}"), "both halves");
        assertEquals(s.info("Delver of Secrets"), new CardScripts.Info("Creature", 1, "{U}"), "the front, by its faces' file");
        assertEquals(s.info("delver of secrets"), new CardScripts.Info("Creature", 1, "{U}"), "any case");
        assertEquals(s.info("Urza's Tower"), new CardScripts.Info("Land", 0, ""));
        assertEquals(s.info("Ornithopter"), new CardScripts.Info("Creature", 0, "{0}"), "a creature before an artifact");
        assertNull(s.info("Delver"), "a prefix that isn't a card");
        assertNull(s.info("Nope"));
        assertNull(s.info(""));
    }

    @Test
    public void readsTheFolders() throws Exception {
        final Path res = Files.createTempDirectory("ft-scripts");
        for (final Map.Entry<String, String> e : SCRIPTS.entrySet()) {
            final Path p = res.resolve("cardsfolder").resolve(e.getKey());
            Files.createDirectories(p.getParent());
            Files.writeString(p, e.getValue());
        }
        check(new CardScripts(res));
    }

    @Test
    public void readsTheZipAndItsCopyLimits() throws Exception {
        final Path res = Files.createTempDirectory("ft-scripts-zip");
        final Path zip = Files.createDirectories(res.resolve("cardsfolder")).resolve("cardsfolder.zip");
        try (OutputStream o = Files.newOutputStream(zip); ZipOutputStream z = new ZipOutputStream(o)) {
            for (final Map.Entry<String, String> e : SCRIPTS.entrySet()) {
                z.putNextEntry(new ZipEntry(e.getKey()));
                z.write(e.getValue().getBytes(StandardCharsets.UTF_8));
                z.closeEntry();
            }
        }
        final CardScripts s = new CardScripts(res);
        check(s);
        Files.createDirectories(res.resolve("formats/Sanctioned"));
        Files.writeString(res.resolve("formats/Sanctioned/Standard.txt"), "Sets:AAA\n");
        Files.createDirectories(res.resolve("editions"));
        Files.writeString(res.resolve("editions/a.txt"), "[metadata]\nCode=AAA\n\n[cards]\n1 C Relentless Rats\n");
        assertNull(new StandardPool(res, s).problem(DeckSummary.sections(java.util.List.of("[Main]", "20 Relentless Rats", "40 Swamp"))),
                "a release's scripts are only in the zip");
    }

    @Test
    public void scriptsThatArriveLaterAreFound() throws Exception {
        final Path res = Files.createTempDirectory("ft-scripts-late");
        final CardScripts s = new CardScripts(res);
        assertNull(s.info("Lightning Bolt"), "no cardsfolder yet");
        final Path p = Files.createDirectories(res.resolve("cardsfolder/l")).resolve("lightning_bolt.txt");
        Files.writeString(p, SCRIPTS.get("l/lightning_bolt.txt"));
        assertEquals(s.info("Lightning Bolt"), new CardScripts.Info("Instant", 1, "{R}"), "not an empty index forever");
    }

    @Test
    public void costs() {
        assertEquals(CardScripts.braces("2 W/U B/P"), "{2}{W/U}{B/P}");
        assertEquals(CardScripts.cmc("2 W/U B/P"), 4);
        assertEquals(CardScripts.cmc("X X G"), 1);
        assertEquals(CardScripts.cmc("2/W 2/W"), 4, "mono-hybrid counts its number");
        assertEquals(CardScripts.braces("no cost"), "");
        assertEquals(CardScripts.group("Legendary Planeswalker Jace"), "Planeswalker");
        assertEquals(CardScripts.group("Kindred Instant Elf"), "Instant");
        assertEquals(CardScripts.group("Legendary Enchantment Creature God"), "Creature");
        assertEquals(CardScripts.group("Artifact Land"), "Land");
        assertEquals(CardScripts.group("Scheme"), "Other");
    }
}

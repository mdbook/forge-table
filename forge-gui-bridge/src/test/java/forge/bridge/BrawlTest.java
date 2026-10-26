package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertThrows;
import static org.testng.Assert.assertTrue;

import java.io.File;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;

import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.deck.io.DeckSerializer;

/**
 * Competitive Brawl: Arena's deck rules over the shipped Brawl decks and hand-made bad ones, and one whole
 * game in the Brawl variant over the protocol (25 life, the commander in the command zone).
 */
public class BrawlTest {

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

    private static File shippedDecks() {
        return new File(TableTestEnv.options().assetsDir, "res/forge-table/brawl-decks");
    }

    /** A mono-green deck: the commander, {@code extra} once each, Llanowar Elves {@code elves} times, Forests to 100. */
    private static Deck greenDeck(final String commander, final int elves, final int forests, final String... extra) {
        final Deck d = new Deck("Test Brawl");
        d.getOrCreate(DeckSection.Commander).add(commander, 1);
        d.getMain().add("Llanowar Elves", elves);
        for (final String e : extra) {
            d.getMain().add(e, 1);
        }
        d.getMain().add("Forest", forests);
        return d;
    }

    /** Raffine (white-blue-black) and 99 Islands, {@code sideboard} once each. */
    private static Deck islands(final String... sideboard) {
        final Deck d = new Deck("Test Companion");
        d.getOrCreate(DeckSection.Commander).add("Raffine, Scheming Seer", 1);
        d.getMain().add("Island", 99);
        for (final String c : sideboard) {
            d.getOrCreate(DeckSection.Sideboard).add(c, 1);
        }
        return d;
    }

    private static Deck greenDeck(final String commander) {
        return greenDeck(commander, 1, 98);
    }

    @Test
    public void formatNames() {
        assertNull(Formats.parse(null));
        assertNull(Formats.parse(""));
        assertNull(Formats.parse("Constructed"));
        assertEquals(Formats.parse("BRAWL"), Formats.BRAWL);
        assertThrows(IllegalArgumentException.class, () -> Formats.parse("commander"));
        assertNull(Formats.problem(null, new Deck("anything at all")));
    }

    /**
     * The wiki marks 51 of the 59 decks Competitive-legal and the rest illegal for Ragavan or Rusko only: every one
     * must come out the same here (pool, size, singleton, identity, commander all agree with Arena's rules).
     */
    @Test
    public void shippedDecksMatchTheWiki() {
        final File[] files = shippedDecks().listFiles((dir, n) -> n.endsWith(".dck"));
        assertNotNull(files);
        assertEquals(files.length, 59);
        final List<String> wrong = new ArrayList<>();
        int legal = 0;
        for (final File f : files) {
            final Deck d = DeckSerializer.fromFile(f);
            final boolean banned = d.getAllCardsInASinglePool().countByName("Ragavan, Nimble Pilferer") > 0
                    || d.getAllCardsInASinglePool().countByName("Rusko, Clockmaker") > 0;
            final String problem = Formats.problem(Formats.BRAWL, d);
            if (banned != (problem != null) || banned && !problem.contains("Ragavan") && !problem.contains("Rusko")) {
                wrong.add(f.getName() + ": " + problem);
            }
            legal += problem == null ? 1 : 0;
        }
        assertTrue(wrong.isEmpty(), "disagrees with the wiki: " + wrong);
        assertEquals(legal, 51);
    }

    /**
     * The server may run without a UTF-8 locale, where a non-ASCII file name can't be opened, and the AI's
     * random deck failed the whole start on one such deck. Shipped names are ASCII, and the random pick is legal.
     */
    @Test
    public void shippedDeckNamesAreAsciiAndTheAiGetsOne() {
        for (final String n : shippedDecks().list()) {
            assertTrue(n.chars().allMatch(c -> c >= 0x20 && c < 0x7f), "non-ASCII deck file name: " + n);
        }
        for (int i = 0; i < 5; i++) {
            assertNull(Formats.problem(Formats.BRAWL, BridgeApp.randomBrawlDeck()));
        }
    }

    @Test
    public void deckRules() {
        assertNull(Formats.problem(Formats.BRAWL, greenDeck("Fynn, the Fangbearer")));

        final Deck small = greenDeck("Fynn, the Fangbearer", 1, 58);
        assertTrue(Formats.problem(Formats.BRAWL, small).contains("at least 99"), Formats.problem(Formats.BRAWL, small));

        final Deck twoElves = greenDeck("Fynn, the Fangbearer", 2, 97);
        assertTrue(Formats.problem(Formats.BRAWL, twoElves).contains("Llanowar Elves"), Formats.problem(Formats.BRAWL, twoElves));

        final Deck offColour = greenDeck("Fynn, the Fangbearer", 1, 97, "Shock");
        assertNotNull(Formats.problem(Formats.BRAWL, offColour));

        // Banned as commander and in the deck alike.
        final Deck oko = greenDeck("Oko, Thief of Crowns");
        assertTrue(Formats.problem(Formats.BRAWL, oko).contains("Oko"), Formats.problem(Formats.BRAWL, oko));

        // Not legendary: no commander.
        assertNotNull(Formats.problem(Formats.BRAWL, greenDeck("Druid of the Cowl")));

        // The sideboard is a companion's slot only, and Yorion can't meet "twenty over the minimum" at exactly 100.
        final Deck companion = islands("Lurrus of the Dream-Den");
        assertNull(Formats.problem(Formats.BRAWL, companion));
        final Deck notCompanion = islands("Opt");
        assertTrue(Formats.problem(Formats.BRAWL, notCompanion).contains("isn't a companion"), Formats.problem(Formats.BRAWL, notCompanion));
        assertNotNull(Formats.problem(Formats.BRAWL, islands("Lurrus of the Dream-Den", "Gyruda, Doom of Depths")));
        final Deck yorion = islands("Yorion, Sky Nomad");
        assertTrue(Formats.problem(Formats.BRAWL, yorion).contains("Yorion"), Formats.problem(Formats.BRAWL, yorion));
    }

    /**
     * Exactly one free mulligan. The first draws seven again with nothing to bottom (and no prompt for none); the
     * second draws seven and bottoms one; the kept hand is six.
     */
    @Test
    public void oneFreeMulligan() throws Exception {
        final JsonObject params = new JsonObject();
        params.addProperty("format", "brawl");
        params.addProperty("deck", "Halana & Alena - Counter the Stampede");
        params.addProperty("oppDeck", "Elenda's Endless Vigil");
        params.addProperty("ai", "Default");
        try (AutoPassTest.Game g = new AutoPassTest.Game(params, false)) {
            g.autoKeep = false;
            final List<Integer> hands = new ArrayList<>(); // hand size at each keep-or-mulligan question
            final List<Integer> tucks = new ArrayList<>(); // after which mulligan a bottom prompt came
            while (hands.size() < 3) {
                final JsonObject m = g.await(x -> "prompt".equals(x.get("t").getAsString())
                        && List.of("confirm", "mulligan", "mulliganTuck").contains(x.get("kind").getAsString()));
                final JsonObject act = new JsonObject();
                act.addProperty("t", "act");
                act.addProperty("pid", m.get("pid").getAsLong());
                switch (m.get("kind").getAsString()) {
                    case "confirm" -> act.addProperty("kind", "ok"); // play or draw
                    case "mulligan" -> {
                        hands.add(g.players.getAsJsonObject(g.viewer).getAsJsonObject("zones").getAsJsonArray("hand").size());
                        act.addProperty("kind", hands.size() < 3 ? "cancel" : "ok");
                    }
                    default -> {
                        tucks.add(hands.size());
                        assertFalse(m.getAsJsonObject("ok").get("enabled").getAsBoolean(), "nothing chosen yet: " + m);
                        final JsonObject pick = new JsonObject();
                        pick.addProperty("t", "act");
                        pick.addProperty("pid", m.get("pid").getAsLong());
                        pick.addProperty("kind", "card");
                        pick.addProperty("card", g.players.getAsJsonObject(g.viewer).getAsJsonObject("zones").getAsJsonArray("hand").get(0).getAsString());
                        g.send(pick);
                        // One card chosen enables Done: exactly one to bottom.
                        final JsonObject done = g.await(x -> x.get("t").getAsString().startsWith("prompt") && x.has("kind")
                                && "mulliganTuck".equals(x.get("kind").getAsString()) && x.getAsJsonObject("ok").get("enabled").getAsBoolean());
                        act.addProperty("pid", done.get("pid").getAsLong());
                        act.addProperty("kind", "ok");
                    }
                }
                g.send(act);
            }
            assertEquals(hands, List.of(7, 7, 6), "hand sizes at keep-or-mulligan");
            assertEquals(tucks, List.of(2), "a bottom prompt after the second mulligan only");
        }
    }

    /** Arena (2026-06-08): a legendary Vehicle may lead; Forge's own Brawl rule says creature or planeswalker only. */
    @Test
    public void aLegendaryVehicleMayLead() {
        final Deck d = new Deck("Vehicle");
        d.getOrCreate(DeckSection.Commander).add("The Lunar Whale", 1);
        d.getMain().add("Island", 99);
        assertNull(Formats.problem(Formats.BRAWL, d));
    }

    @Test
    public void playsABrawlGame() throws Exception {
        final int errorsBefore = BridgeLog.errorCount();
        final ScriptedClient client = new ScriptedClient(sidecar.port(), sidecar.token, 11L, false, 300);
        final int[] startLife = {-1};
        final boolean[] commanderShown = {false};
        client.onMessage(m -> {
            if (!m.has("seq")) {
                return;
            }
            client.players().values().forEach(pl -> {
                if (startLife[0] < 0 && pl.has("life")) {
                    startLife[0] = pl.get("life").getAsInt();
                }
                final JsonObject zones = pl.getAsJsonObject("zones");
                if (pl.has("commander") || zones != null && zones.has("command") && !zones.getAsJsonArray("command").isEmpty()) {
                    commanderShown[0] = true;
                }
            });
        });
        final JsonObject params = new JsonObject();
        params.addProperty("format", "brawl");
        params.addProperty("deck", "Halana & Alena - Counter the Stampede");
        params.addProperty("oppDeck", "Elenda's Endless Vigil");
        params.addProperty("ai", "Default");
        final ScriptedClient.Result r = client.play(params, Duration.ofSeconds(240));
        System.out.println("[BrawlTest] " + r);
        assertTrue(r.violations.isEmpty(), "violations: " + r.violations);
        assertTrue(r.gameOver, "game did not finish");
        assertEquals(startLife[0], 25, "starting life");
        assertTrue(commanderShown[0], "no commander in the command zone");
        assertEquals(BridgeLog.errorCount() - errorsBefore, 0, "bridge logged errors");
    }
}

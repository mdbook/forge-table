package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.Map;

import org.testng.annotations.Test;

/** The results store: append, read back, skip a bad line, count a game once, roll over, and the records it gives. */
public class ResultsTest {

    private static Results.Result pvp(final String id, final long t, final String a, final String aDeck, final String ar, final String b,
            final String bDeck, final String br) {
        return new Results.Result(id, t, "pvp", null,
                List.of(new Results.Seat(a, a == null ? null : a.toUpperCase(), aDeck, ar, false), new Results.Seat(b, b == null ? null : b.toUpperCase(), bDeck, br, false)));
    }

    private static Results.Result ai(final String id, final long t, final String user, final String deck, final String r) {
        return new Results.Result(id, t, "ai", "standard", List.of(new Results.Seat(user, user, deck, r, false),
                new Results.Seat(null, null, "AI deck", "won".equals(r) ? "lost" : "won", false)));
    }

    private static Path file() throws Exception {
        return Files.createTempDirectory("ft-results").resolve("results.jsonl");
    }

    @Test
    public void savesReadsBackAndCountsAGameOnce() throws Exception {
        final Path f = file();
        final Results r = new Results(f);
        assertTrue(r.add(pvp("g1:1", 100, "alice", "Burn", "won", "bob", "Faeries", "lost")));
        assertFalse(r.add(pvp("g1:1", 100, "alice", "Burn", "won", "bob", "Faeries", "lost")), "the same game twice");
        assertTrue(r.add(pvp("g1:2", 200, "alice", "Burn", "lost", "bob", "Faeries", "won")), "a rematch is a game of its own");
        assertTrue(r.add(ai("g2:1", 300, "alice", "Burn", "won")));
        Files.writeString(f, "{not json\n{\"id\":\"x\",\"t\":1,\"seats\":[{\"r\":\"maybe\"}]}\n", StandardCharsets.UTF_8, StandardOpenOption.APPEND);

        final Results back = new Results(f);
        assertEquals(back.size(), 3, "corrupt lines are skipped");
        assertFalse(back.add(pvp("g1:2", 200, "alice", "Burn", "lost", "bob", "Faeries", "won")), "known after a restart too");
        final Map<String, Results.Stat> decks = back.decks("alice");
        assertEquals(decks.get("Burn"), new Results.Stat(2, 1, 300));
        assertEquals(back.decks("bob").get("Faeries"), new Results.Stat(1, 1, 200));
        assertTrue(back.decks(null).isEmpty());
        assertNull(back.decks("alice").get("AI deck"), "the AI's deck is nobody's");
    }

    @Test
    public void aTornLastLineIsEndedOnStartup() throws Exception {
        final Path f = file();
        new Results(f).add(ai("g1:1", 100, "alice", "Burn", "won"));
        Files.writeString(f, "{\"id\":\"g2:1\",\"t\":2", StandardCharsets.UTF_8, StandardOpenOption.APPEND); // cut short
        final Results r = new Results(f);
        assertEquals(r.size(), 1);
        assertTrue(r.add(ai("g3:1", 300, "alice", "Burn", "lost")));
        final Results back = new Results(f);
        assertEquals(back.size(), 2, "the next game isn't lost to the torn line");
        assertEquals(back.decks("alice").get("Burn"), new Results.Stat(1, 1, 300));
    }

    @Test
    public void opponentsAreOnlyPeopleAndOnlyRecent() throws Exception {
        final Results r = new Results(file());
        r.add(pvp("g1:1", 100, "alice", "Burn", "won", "bob", "Faeries", "lost"));
        r.add(pvp("g2:1", 500, "bob", "Faeries", "won", "alice", "Burn", "lost"));
        r.add(pvp("g3:1", 600, "alice", "Burn", "draw", "bob", "Faeries", "draw"));
        r.add(pvp("g4:1", 700, "alice", "Burn", "won", null, "Guest deck", "lost"));
        r.add(ai("g5:1", 800, "alice", "Burn", "won"));
        r.add(pvp("g6:1", 50, "alice", "Burn", "won", "carol", "Elves", "lost"));

        final Map<String, Results.Opp> opps = r.opponents("alice", 80);
        assertEquals(opps.keySet(), java.util.Set.of("bob"), "no guests, no AI, nobody from before `since`");
        assertEquals(opps.get("bob").stat(), new Results.Stat(1, 1, 600), "draws count for last played, not for W-L");
        assertEquals(opps.get("bob").name(), "BOB");
        assertEquals(r.opponents("bob", 0).get("alice").stat(), new Results.Stat(1, 1, 600));
        assertEquals(r.opponents("alice", 0).get("carol").stat(), new Results.Stat(1, 0, 50));
        assertTrue(r.opponents(null, 0).isEmpty());
    }

    @Test
    public void rollsOverAndForgetsTheFileBeforeLast() throws Exception {
        final Path f = file();
        final Results r = new Results(f, 600); // a line is ~150 bytes here: a few per file
        for (int i = 1; i <= 12; i++) {
            r.add(ai("g" + i + ":1", i, "alice", "Burn", "won"));
        }
        assertTrue(Files.isRegularFile(f.resolveSibling("results.jsonl.1")));
        assertTrue(Files.size(f) <= 600);
        final int kept = r.size();
        assertTrue(kept < 12 && kept > 0, "kept " + kept);
        final Results back = new Results(f, 600);
        assertEquals(back.size(), kept, "memory holds what is on disk");
        assertEquals(back.decks("alice").get("Burn").last(), 12);
    }

    @Test
    public void lineFormat() {
        final Results.Result x = new Results.Result("g1:1", 5, "ai", "brawl",
                List.of(new Results.Seat("alice", "Alice", "Niv", "won", false), new Results.Seat(null, null, null, "lost", true)));
        final String line = Results.toJson(x);
        assertEquals(line, "{\"id\":\"g1:1\",\"t\":5,\"mode\":\"ai\",\"format\":\"brawl\",\"seats\":[{\"user\":\"alice\",\"name\":\"Alice\",\"deck\":\"Niv\",\"r\":\"won\"},{\"r\":\"lost\",\"conceded\":true}]}");
        assertEquals(Results.parse(line), x);
        assertNull(Results.parse(""));
        assertNull(Results.parse("[]"));
    }
}

package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** The lobby's game card table: parsed from a game's /status, then turned to the seat asking. */
public class LobbyTableTest {

    private static final String STATUS = "{\"state\":\"playing\",\"table\":{\"turn\":7,\"active\":1,\"seats\":["
            + "{\"life\":14,\"deck\":\"Izzet Phoenix\",\"key\":\"Arclight Phoenix\"},{\"life\":9,\"deck\":\"Rakdos Madness\"}]}}";

    private static GameHost.Table table() {
        return GameHost.Table.parse(JsonParser.parseString(STATUS).getAsJsonObject().get("table"));
    }

    @Test
    public void parsesTheStatusTable() {
        final GameHost.Table t = table();
        assertEquals(t.turn(), 7);
        assertEquals(t.active(), 1);
        assertEquals(t.seats(), List.of(new GameHost.Table.Seat(14, "Izzet Phoenix", "Arclight Phoenix"), new GameHost.Table.Seat(9, "Rakdos Madness", null)));
        assertNull(GameHost.Table.parse(null));
        assertNull(GameHost.Table.parse(JsonParser.parseString("{\"turn\":1}")), "no seats");
        assertNull(GameHost.Table.parse(JsonParser.parseString("{\"turn\":\"x\",\"active\":0,\"seats\":[]}")));
    }

    @Test
    public void eachSeatSeesItsOwnSide() {
        final JsonObject ai = Router.tableJson(table(), 0, false);
        assertEquals(ai.get("turn").getAsInt(), 7);
        assertFalse(ai.get("mine").getAsBoolean());
        assertEquals(ai.get("life").toString(), "[14,9]");
        assertEquals(ai.get("deck").getAsString(), "Izzet Phoenix");
        assertEquals(ai.get("key").getAsString(), "Arclight Phoenix");
        assertEquals(ai.get("oppDeck").getAsString(), "Rakdos Madness", "the AI's deck is shown");
        assertFalse(ai.has("oppKey"));

        final JsonObject joiner = Router.tableJson(table(), 1, true);
        assertTrue(joiner.get("mine").getAsBoolean());
        assertEquals(joiner.get("life").toString(), "[9,14]");
        assertEquals(joiner.get("deck").getAsString(), "Rakdos Madness");
        assertFalse(joiner.has("oppDeck"), "a person's deck stays theirs");
        assertFalse(joiner.has("oppKey"));

        assertNull(Router.tableJson(null, 0, false));
        assertNull(Router.tableJson(new GameHost.Table(1, 0, List.of(new GameHost.Table.Seat(20, null, null))), 0, false), "not two seats");
    }

    @Test
    public void theKeyCardRule() {
        final Map<String, Integer> main = new LinkedHashMap<>();
        main.put("Opt", 4);
        main.put("Lightning Bolt", 4);
        main.put("Shock", 2);
        assertEquals(DeckSummary.key(null, main), "Opt", "most copies, first listed on a tie");
        assertEquals(DeckSummary.key("Atraxa, Praetors' Voice", main), "Atraxa, Praetors' Voice");
        assertNull(DeckSummary.key(null, Map.of()));
    }
}

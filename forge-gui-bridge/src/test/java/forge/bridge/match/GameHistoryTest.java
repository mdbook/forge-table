package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;

import java.util.ArrayList;
import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.Main;
import forge.bridge.TableTestEnv;
import forge.bridge.proj.Outbox;
import forge.game.Game;
import forge.game.GameLogEntryType;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.RegisteredPlayer;
import forge.player.GamePlayerUtil;

/** The history panel's stream: stamped lines, sent as they're written, and all of them again after a snapshot. */
public class GameHistoryTest {
    @Test
    public void streamsStampedLinesAndResendsTheWholeGameOnRequest() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        try {
            final RegisteredPlayer human = new RegisteredPlayer(sidecar.app.loadDeck("mono-red-madness"));
            human.setPlayer(GamePlayerUtil.getGuiPlayer());
            final RegisteredPlayer opp = new RegisteredPlayer(sidecar.app.loadDeck("mono-blue-faeries"));
            opp.setPlayer(GamePlayerUtil.createAiPlayer("Blue Terror", "Default"));
            final Game game = new Match(new GameRules(GameType.Constructed), List.of(human, opp), "history-test").createGame();
            final Outbox outbox = new Outbox();
            final List<JsonObject> sent = new ArrayList<>();
            outbox.setSink(json -> sent.add(JsonParser.parseString(json).getAsJsonObject()));

            game.getGameLog().add(GameLogEntryType.MULLIGAN, "Blue Terror has kept a hand of 7 cards");
            final GameHistory history = new GameHistory(outbox, game);
            history.watch();
            assertEquals(sent.size(), 1, "the lines from before it watched go out at once");
            assertEquals(sent.get(0).get("from").getAsInt(), 0);

            game.getGameLog().add(GameLogEntryType.STACK_RESOLVE, "Blue Terror cast Candy Trail (42) targeting Face-down card (H3)");
            assertEquals(sent.size(), 2);
            final JsonObject live = sent.get(1);
            assertEquals(live.get("t").getAsString(), "log");
            assertEquals(live.get("game").getAsInt(), game.getId());
            assertEquals(live.get("from").getAsInt(), 1);
            final JsonArray entries = live.getAsJsonArray("entries");
            assertEquals(entries.size(), 1);
            final JsonObject line = entries.get(0).getAsJsonObject();
            assertEquals(line.get("text").getAsString(), "Blue Terror cast Candy Trail targeting Face-down card", "engine ids are stripped");
            assertEquals(line.get("kind").getAsString(), "stackResolve");
            assertEquals(line.get("turn").getAsInt(), 0, "before the first turn");
            assertEquals(line.get("player").getAsString(), "p" + game.getPlayers().get(1).getId(), "the player the line starts with");
            assertFalse(line.has("card"), "no source card, no card");

            history.sendAll();
            assertEquals(sent.size(), 3);
            assertEquals(sent.get(2).get("from").getAsInt(), 0);
            assertEquals(sent.get(2).getAsJsonArray("entries").size(), 2);
        } finally {
            sidecar.stop();
        }
    }

    @Test
    public void kindsAreTheWiresCamelCase() {
        assertEquals(GameHistory.kind("ZONE_CHANGE"), "zoneChange");
        assertEquals(GameHistory.kind("LAND"), "land");
        assertEquals(GameHistory.kind("COMBAT"), "combat");
    }
}

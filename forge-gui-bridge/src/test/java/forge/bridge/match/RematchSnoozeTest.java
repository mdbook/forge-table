package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeGuiBase;
import forge.bridge.Main;
import forge.bridge.TableTestEnv;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.RegisteredPlayer;
import forge.player.GamePlayerUtil;

/**
 * Snoozes belong to one game: a rematch or the next game of a match reuses the {@link TableSession}
 * but restarts card ids, so a snooze must not carry over. A rematch reaches the session through
 * {@code BridgeGuiGame.openView -> TableSession.openView}; this test calls that directly with a real (never
 * started) Game, so there is no game loop, no concede and no waiting. (The end-to-end version flaked in CI: its
 * rematch never actually started.)
 */
public class RematchSnoozeTest {

    private static JsonObject snoozedIn(final TableSession t) {
        return t.describeAutoPass();
    }

    @Test
    public void openingTheViewForANewGameForgetsSnoozes() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        try {
            final RegisteredPlayer human = new RegisteredPlayer(sidecar.app.loadDeck("mono-red-madness"));
            human.setPlayer(GamePlayerUtil.getGuiPlayer());
            final RegisteredPlayer opp = new RegisteredPlayer(sidecar.app.loadDeck("mono-blue-faeries"));
            opp.setPlayer(GamePlayerUtil.createAiPlayer("Opp", "Default"));
            final Match match = new Match(new GameRules(GameType.Constructed), List.of(human, opp), "snooze-test");
            final Game game = match.createGame();

            final TableSession t = new TableSession(new BridgeGuiBase("../forge-gui/", "test"));
            final List<String> sent = new ArrayList<>();
            t.attach(sent::add, null);
            t.openView(game.getView(), game.getPlayers().get(0).getView()); // game one

            t.setSnoozed("c5", true);
            t.setSnoozed("c9", true);
            t.setSnoozed("c9", false);
            assertEquals(snoozedIn(t).getAsJsonArray("snoozed").toString(), "[\"c5\"]");

            sent.clear();
            t.openView(game.getView(), game.getPlayers().get(0).getView()); // the rematch

            assertEquals(snoozedIn(t).getAsJsonArray("snoozed").size(), 0, "the rematch kept the old snooze");
            final JsonObject snap = sent.stream().map(m -> JsonParser.parseString(m).getAsJsonObject())
                    .filter(m -> "snapshot".equals(m.get("t").getAsString())).reduce((a, b) -> b).orElseThrow();
            assertEquals(snap.getAsJsonObject("autoPass").getAsJsonArray("snoozed").size(), 0, "the client was never told");
            assertTrue(sent.size() >= 1);
        } finally {
            sidecar.stop();
        }
    }
}

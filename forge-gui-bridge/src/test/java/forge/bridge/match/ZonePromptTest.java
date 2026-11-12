package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotNull;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

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
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.input.InputSelectCardsFromList;
import forge.gui.FThreads;
import forge.player.GamePlayerUtil;
import forge.player.PlayerControllerHuman;
import forge.player.PlayerZoneUpdate;
import forge.util.collect.FCollection;

/** Zone requests must not escape as unordered notices against an old/waiting Input. */
public class ZonePromptTest {
    @Test
    public void zonesWaitForTheCompletedInputPrompt() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        try {
            final RegisteredPlayer human = new RegisteredPlayer(sidecar.app.loadDeck("mono-red-madness"));
            human.setPlayer(GamePlayerUtil.getGuiPlayer());
            final RegisteredPlayer opp = new RegisteredPlayer(sidecar.app.loadDeck("mono-blue-faeries"));
            opp.setPlayer(GamePlayerUtil.createAiPlayer("Opp", "Default"));
            final Game game = new Match(new GameRules(GameType.Constructed), List.of(human, opp), "zone-test").createGame();
            final Player player = game.getPlayers().get(0);
            final TableSession table = new TableSession(new BridgeGuiBase("../forge-gui/", "test"));
            final PlayerControllerHuman controller = new PlayerControllerHuman(game, player, human.getPlayer());
            controller.setGui(table.gui());
            table.installController(controller, true);
            final List<JsonObject> sent = new ArrayList<>();
            table.attach(m -> sent.add(JsonParser.parseString(m).getAsJsonObject()), null);
            table.openView(game.getView(), player.getView());
            final AtomicReference<JsonObject> before = new AtomicReference<>();
            FThreads.invokeInEdtAndWait(() -> {
                table.gui().tempShowZones(player.getView(), List.of(new PlayerZoneUpdate(player.getView(), ZoneType.Graveyard)));
                // A waiting display or an intermediate flush must not publish the pending reveal.
                table.gui().showPromptMessage(player.getView(), "Waiting", null);
                before.set(table.gui().describePrompt(table.outbox().projector()));
                table.flushPrompt();
            });
            assertEquals(before.get().getAsJsonArray("zones").size(), 0);
            assertFalse(sent.stream().anyMatch(m -> "notice".equals(m.get("t").getAsString())
                    && "zones".equals(m.get("kind").getAsString())), "zone notice overtook the choices");

            // A computed empty set is valid too: readiness must not mean selectable.size() > 0.
            final InputSelectCardsFromList input = new InputSelectCardsFromList(controller, 0, 0, new FCollection<>());
            controller.getInputQueue().setInput(input);
            FThreads.invokeInEdtAndWait(table::flushPrompt); // after showMessageInitial and all constructor UI tasks
            final JsonObject prompt = sent.stream().filter(m -> "prompt".equals(m.get("t").getAsString()))
                    .reduce((a, b) -> b).orElseThrow();
            assertEquals(prompt.get("kind").getAsString(), "selectEntities");
            assertEquals(prompt.getAsJsonArray("selectable").size(), 0);
            assertEquals(prompt.getAsJsonArray("zones").get(0).getAsJsonObject().get("zone").getAsString(), "Graveyard");

            final AtomicReference<JsonObject> hidden = new AtomicReference<>();
            FThreads.invokeInEdtAndWait(() -> {
                input.stop();
                hidden.set(table.gui().describePrompt(table.outbox().projector()));
            });
            assertNotNull(hidden.get());
            assertEquals(hidden.get().getAsJsonArray("zones").size(), 0);
        } finally {
            sidecar.stop();
        }
    }
}

package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.time.Duration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.testng.annotations.Test;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * One complete game over the real protocol against the Forge AI: mulligan to game over,
 * redaction invariants on every message, no bridge errors, and library slot ids re-randomized on shuffle.
 */
public class LiveGameTest {

    @Test
    public void playsAFullGameOverTheProtocol() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        final int errorsBefore = BridgeLog.errorCount();
        final Map<String, Set<String>> librarySlots = new HashMap<>();
        final int[] reshuffleOverlaps = {0};
        final boolean[] printedPt = {false};
        final ScriptedClient client = new ScriptedClient(sidecar.port(), sidecar.token, 7L, false, 1500);
        client.onMessage(m -> {
            if ("beat".equals(m.get("t").getAsString()) && "shuffle".equals(m.get("kind").getAsString())) {
                // Library slot ids after a shuffle must share nothing with the ids before it.
                final String p = m.get("player").getAsString();
                final JsonObject patch = m.getAsJsonObject("patch");
                final Set<String> before = librarySlots.get(p);
                if (patch != null && patch.has("players") && patch.getAsJsonObject("players").has(p) && before != null) {
                    final JsonObject zones = patch.getAsJsonObject("players").getAsJsonObject(p).getAsJsonObject("zones");
                    if (zones.has("library")) {
                        for (final JsonElement id : zones.getAsJsonArray("library")) {
                            if (before.contains(id.getAsString())) {
                                reshuffleOverlaps[0]++;
                            }
                        }
                    }
                }
            }
            if (m.has("seq")) {
                // Track each player's current library slots from the client's model after this message.
                client.players().forEach((id, pl) -> {
                    final JsonObject zones = pl.getAsJsonObject("zones");
                    final Set<String> ids = new HashSet<>();
                    if (zones != null && zones.has("library")) {
                        zones.getAsJsonArray("library").forEach(e -> ids.add(e.getAsString()));
                    }
                    librarySlots.put(id, ids);
                });
                // Creature faces carry their printed P/T from the card rules (the chip compares against it).
                client.cards().values().forEach(c -> {
                    final JsonObject st = c.getAsJsonObject("state");
                    if (st != null && st.has("printedPower") && st.has("printedToughness")) {
                        printedPt[0] = true;
                    }
                });
            }
        });
        final JsonObject params = new JsonObject();
        params.addProperty("deck", "mono-red-madness");
        params.addProperty("oppDeck", "mono-blue-faeries");
        params.addProperty("ai", "Default");
        final ScriptedClient.Result r = client.play(params, Duration.ofSeconds(180));
        sidecar.stop();
        System.out.println("[LiveGameTest] " + r);
        assertTrue(r.violations.isEmpty(), "violations: " + r.violations);
        assertTrue(r.gameOver, "game did not finish");
        assertTrue(r.promptKinds.containsKey("mulligan"), "no mulligan prompt: " + r.promptKinds);
        assertTrue(r.promptKinds.containsKey("priority"), "no priority prompt: " + r.promptKinds);
        assertEquals(reshuffleOverlaps[0], 0, "library slot ids survived a shuffle");
        assertTrue(printedPt[0], "no face carried printedPower/printedToughness");
        assertEquals(BridgeLog.errorCount() - errorsBefore, 0, "bridge logged errors");
    }
}

package forge.bridge;

import static org.testng.Assert.assertFalse;

import java.util.Map;

import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Conceding in the middle of a decision ends the game. Forge's concede releases the Inputs waiting at that moment,
 * but the game thread then goes on with what it was doing (TargetSelection asks again, a cost asks for payment) and
 * may show a new Input after the game is over; that one must not wait for a click that never comes, or the game
 * thread never reaches GameEventGameFinished and the client never gets {@code gameOver}.
 */
public class ConcedeTest {

    @DataProvider
    public Object[][] decisions() {
        return new Object[][] {
            // Concede while the decision is up: Forge's concede releases that Input.
            {"concede-targeting.txt", "Lightning Bolt", "chooseTargets", false},
            {"concede-fireblast.txt", "Fireblast", "selectEntities", false},
            // Concede right behind the click that answers it: the game thread is between two Inputs (the target is
            // picked, the next cost asks for payment) when the game ends, so the next Input comes after game over.
            {"concede-targeting.txt", "Lightning Bolt", "chooseTargets", true},
            {"concede-fireblast.txt", "Fireblast", "chooseTargets", true},
        };
    }

    @Test(dataProvider = "decisions")
    public void concedeMidDecisionEndsTheGame(final String state, final String spell, final String concedeAt,
            final boolean behindAClick) throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game(state, false)) {
            final JsonObject p = g.awaitPriority();
            final String card = g.cards.entrySet().stream()
                    .filter(e -> e.getValue().has("state") && spell.equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                    .map(Map.Entry::getKey).findFirst().orElseThrow();
            final JsonObject cast = new JsonObject();
            cast.addProperty("t", "act");
            cast.addProperty("pid", p.get("pid").getAsLong());
            cast.addProperty("kind", "card");
            cast.addProperty("card", card);
            g.send(cast);
            try {
                // Answer the casting asks (alternative cost: the one that names a sacrifice) and play on until the decision.
                g.await(m -> {
                    final String t = m.get("t").getAsString();
                    if ("ask".equals(t)) {
                        g.send(answer(m));
                        return false;
                    }
                    if ("prompt".equals(t) && "chooseTargets".equals(m.get("kind").getAsString()) && !concedeAt.equals("chooseTargets")) {
                        final JsonArray sel = m.getAsJsonArray("selectable");
                        final JsonObject pick = new JsonObject();
                        pick.addProperty("t", "act");
                        pick.addProperty("pid", m.get("pid").getAsLong());
                        pick.addProperty("kind", "card");
                        pick.addProperty("card", sel.get(0).getAsString());
                        g.send(pick);
                        return false;
                    }
                    return "prompt".equals(t) && concedeAt.equals(m.get("kind").getAsString());
                });
                if (behindAClick) {
                    final JsonObject at = g.prompt;
                    final JsonObject pick = new JsonObject();
                    pick.addProperty("t", "act");
                    pick.addProperty("pid", at.get("pid").getAsLong());
                    pick.addProperty("kind", "card");
                    pick.addProperty("card", at.getAsJsonArray("selectable").get(0).getAsString());
                    g.send(pick);
                }
                final JsonObject concede = new JsonObject();
                concede.addProperty("t", "act");
                concede.addProperty("kind", "concede");
                g.send(concede);
                final JsonObject over = g.await(m -> "gameOver".equals(m.get("t").getAsString()));
                assertFalse(over.has("won") && over.get("won").getAsBoolean(), "the conceding player won: " + over);
            } catch (final AssertionError e) {
                dumpThreads();
                throw e;
            }
        }
    }

    private static JsonObject answer(final JsonObject ask) {
        JsonElement value = null;
        final String kind = ask.get("kind").getAsString();
        if (ask.has("options") && ask.get("options").isJsonArray()) {
            final JsonArray opts = ask.getAsJsonArray("options");
            int pick = 0;
            for (int i = 0; i < opts.size(); i++) {
                if (opts.get(i).toString().contains("acrifice")) {
                    pick = i;
                }
            }
            value = new com.google.gson.JsonPrimitive(pick);
        } else if (ask.has("items")) {
            final JsonArray items = ask.getAsJsonArray("items");
            int pick = 0;
            for (int i = 0; i < items.size(); i++) {
                if (items.get(i).toString().contains("acrifice")) {
                    pick = items.get(i).getAsJsonObject().get("idx").getAsInt();
                }
            }
            final JsonArray arr = new JsonArray();
            arr.add(pick);
            value = arr;
        }
        System.out.println("[ConcedeTest] ask " + kind + " " + ask + " -> " + value);
        final JsonObject r = new JsonObject();
        r.addProperty("t", "reply");
        r.addProperty("id", ask.get("id").getAsString());
        r.add("value", value);
        return r;
    }

    static void dumpThreads() {
        Thread.getAllStackTraces().forEach((t, st) -> {
            if (st.length == 0 || t.getName().startsWith("nioEventLoop") || t.getName().startsWith("ForkJoin")) {
                return;
            }
            final StringBuilder b = new StringBuilder("THREAD " + t.getName() + " " + t.getState() + "\n");
            for (final StackTraceElement s : st) {
                b.append("    at ").append(s).append('\n');
            }
            System.out.println(b);
        });
    }
}

package forge.bridge;

import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Cards of the opponent's hand revealed to me stay face up there while they stay in the hand. */
public class RevealedHandTest {

    @Test
    public void aRevealedHandStaysVisible() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("reveal-hand.txt", false)) {
            try {
                final JsonObject p = g.awaitPriority();
                final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
                final String duress = g.cards.entrySet().stream()
                        .filter(e -> e.getValue().has("state") && "Duress".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                        .map(Map.Entry::getKey).findFirst().orElseThrow();
                g.send(act(p, "card", "card", duress));
                // Answer whatever it asks (target, payment, the reveal, the pick) until it has resolved.
                g.await(m -> {
                    final String t = m.get("t").getAsString();
                    System.out.println("[RevealedHandTest] " + m.toString().substring(0, Math.min(300, m.toString().length())));
                    if ("ask".equals(t)) {
                        final JsonObject r = new JsonObject();
                        r.addProperty("t", "reply");
                        r.addProperty("id", m.get("id").getAsString());
                        final JsonArray v = new JsonArray();
                        if (m.has("items") && m.getAsJsonArray("items").size() > 0) {
                            v.add(m.getAsJsonArray("items").get(0).getAsJsonObject().get("idx").getAsInt());
                        }
                        r.add("value", m.has("options") ? new com.google.gson.JsonPrimitive(0) : v);
                        g.send(r);
                        return false;
                    }
                    if (!"prompt".equals(t)) {
                        return false;
                    }
                    final String kind = m.get("kind").getAsString();
                    if ("chooseTargets".equals(kind)) {
                        g.send(act(m, "player", "player", opp));
                    } else if ("payMana".equals(kind) || "confirm".equals(kind)) {
                        final JsonObject ok = new JsonObject();
                        ok.addProperty("t", "act");
                        ok.addProperty("pid", m.get("pid").getAsLong());
                        ok.addProperty("kind", "ok");
                        g.send(ok);
                    } else if ("priority".equals(kind) && g.stackSize() > 0) {
                        final JsonObject ok = new JsonObject();
                        ok.addProperty("t", "act");
                        ok.addProperty("pid", m.get("pid").getAsLong());
                        ok.addProperty("kind", "ok");
                        g.send(ok);
                    } else if ("priority".equals(kind)) {
                        return g.cards.containsKey(duress) && g.cards.get(duress).has("zone")
                                && "Graveyard".equals(g.cards.get(duress).get("zone").getAsString());
                    } else if (m.has("selectable") && m.getAsJsonArray("selectable").size() > 0) {
                        g.send(act(m, "card", "card", m.getAsJsonArray("selectable").get(0).getAsString()));
                    }
                    return false;
                });
                final JsonArray hand = g.players.getAsJsonObject(opp).getAsJsonObject("zones").getAsJsonArray("hand");
                int known = 0;
                for (final JsonElement id : hand) {
                    if (id.getAsString().startsWith("c")) {
                        known++;
                    }
                }
                assertTrue(hand.size() > 0 && known == hand.size(), "opponent's hand after Duress: " + hand);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    private static JsonObject act(final JsonObject prompt, final String kind, final String key, final String value) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        a.addProperty(key, value);
        return a;
    }
}

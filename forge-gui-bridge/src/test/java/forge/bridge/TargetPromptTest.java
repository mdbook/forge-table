package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Regression (BrawlTest, Earth Rumble): a targeting Input that comes right after another one, like a fight's
 * second target, was sent with no selectable cards and both buttons off, a prompt nobody could answer until a
 * promptUpdate filled it in. Forge's InputProxy queued "show the Input" per change but showed whichever Input was
 * live when it ran, so an older show painted the new Input before its own setSelectables had reached the UI thread.
 * Every target prompt, the first message for its pid included, must offer something to do.
 */
public class TargetPromptTest {

    @Test
    public void everyTargetPromptOffersAnAction() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("earth-rumble.txt", false)) {
            final JsonObject p = g.awaitPriority();
            final String spell = g.cards.entrySet().stream()
                    .filter(e -> e.getValue().has("state") && "Earth Rumble".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                    .map(Map.Entry::getKey).findFirst().orElseThrow();
            send(g, p, "card", spell);
            final List<String> dead = new ArrayList<>();
            final List<String> asked = new ArrayList<>();
            // Earthbend's land, then the reflexive trigger: up to one creature I control, then the opponent's creature.
            g.await(m -> {
                final String t = m.get("t").getAsString();
                if (!"prompt".equals(t) && !"promptUpdate".equals(t)) {
                    return false;
                }
                final String kind = m.get("kind").getAsString();
                if (!"chooseTargets".equals(kind)) {
                    if ("priority".equals(kind) && asked.size() >= 3 && g.stackSize() == 0) {
                        return true;
                    }
                    // Pay with Auto, then pass priority until the spell and its trigger resolve.
                    if ("prompt".equals(t) && ("payMana".equals(kind) || "priority".equals(kind))
                            && m.getAsJsonObject("ok").get("enabled").getAsBoolean()) {
                        send(g, m, "ok", null);
                    }
                    return false;
                }
                final JsonArray sel = m.getAsJsonArray("selectable");
                if (sel.isEmpty() && !m.getAsJsonObject("ok").get("enabled").getAsBoolean()
                        && !m.getAsJsonObject("cancel").get("enabled").getAsBoolean()) {
                    dead.add(t + " " + m);
                }
                if (!sel.isEmpty() && g.firstActOn(m)) {
                    asked.add(m.get("message").getAsString());
                    send(g, m, "card", sel.get(0).getAsString());
                }
                return false;
            });
            assertTrue(dead.isEmpty(), "target prompts with nothing to do: " + dead);
            assertEquals(asked.size(), 3, "the land, my creature, then the opponent's: " + asked);
        }
    }

    private static void send(final AutoPassTest.Game g, final JsonObject prompt, final String kind, final String card) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        if (card != null) {
            a.addProperty("card", card);
        }
        g.send(a);
    }
}

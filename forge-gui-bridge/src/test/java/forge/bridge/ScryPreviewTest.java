package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Scry 1 and surveil 1 look at one library card the client has no card for: both arrive as lanes (arrange) whose
 * item carries the card's face, so the preview can show it.
 */
public class ScryPreviewTest {

    @Test
    public void scryOneShowsTheCard() throws Exception {
        final JsonObject ask = playLandAndAwaitAsk("Temple of Epiphany");
        assertTrue(!ask.has("graveyard") || !ask.get("graveyard").getAsBoolean(), "scry offered a graveyard lane: " + ask);
    }

    @Test
    public void surveilOneShowsTheCard() throws Exception {
        final JsonObject ask = playLandAndAwaitAsk("Undercity Sewers");
        assertTrue(ask.has("graveyard") && ask.get("graveyard").getAsBoolean(), "surveil 1 without a graveyard lane: " + ask);
    }

    private static JsonObject playLandAndAwaitAsk(final String land) throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("scry-one.txt", false)) {
            final JsonObject priority = g.awaitPriority();
            g.send(act(priority, "card", cardId(g.cards, land)));
            // The trigger goes on the stack; pass priority until it resolves into the ask.
            final JsonObject ask = g.await(m -> {
                if ("prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString())) {
                    g.send(act(m, "ok", null));
                }
                return "ask".equals(m.get("t").getAsString());
            });
            assertEquals(ask.get("kind").getAsString(), "arrange", land + ": " + ask);
            final JsonObject item = ask.getAsJsonArray("items").get(0).getAsJsonObject();
            assertTrue(item.has("cardData"), land + ": the item has no face: " + ask);
            assertEquals(item.getAsJsonObject("cardData").getAsJsonObject("state").get("name").getAsString(), "Lightning Bolt");
            return ask;
        }
    }

    private static String cardId(final Map<String, JsonObject> cards, final String name) {
        for (final Map.Entry<String, JsonObject> e : cards.entrySet()) {
            final JsonObject state = e.getValue().getAsJsonObject("state");
            if (state != null && state.has("name") && name.equals(state.get("name").getAsString())) {
                return e.getKey();
            }
        }
        throw new AssertionError("no " + name + " among " + cards.keySet());
    }

    private static JsonObject act(final JsonObject prompt, final String kind, final String card) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        if (card != null) {
            a.addProperty("card", card);
        }
        return a;
    }
}

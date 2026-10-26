package forge.bridge;

import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Regression: a hand card an opponent has been shown (same engine path an opponent's Duress
 * takes) is flagged {@code revealedToOpponent} in its owner's own view, and the flag is gone once the card
 * leaves hand. Self-targeting Inquisition of Kozilek (it allows any player, not just an opponent) puts my own
 * hand through that path without needing the AI to act.
 */
public class RevealedToOpponentTest {

    @Test
    public void revealedHandCardIsFlaggedUntilItLeavesHand() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("reveal-to-opponent.txt", false)) {
            try {
                final JsonObject p = g.awaitPriority();
                final String iok = card(g, "Inquisition of Kozilek");
                final String island = card(g, "Island");

                g.send(act(p, "card", "card", iok));
                final JsonObject p2 = g.await(m -> {
                    final String t = m.get("t").getAsString();
                    if ("ask".equals(t) && m.has("items") && m.getAsJsonArray("items").size() > 0) {
                        final JsonObject r = new JsonObject();
                        r.addProperty("t", "reply");
                        r.addProperty("id", m.get("id").getAsString());
                        final com.google.gson.JsonArray v = new com.google.gson.JsonArray();
                        v.add(0);
                        r.add("value", v);
                        g.send(r);
                        return false;
                    }
                    if (!"prompt".equals(t)) {
                        return false;
                    }
                    final String kind = m.get("kind").getAsString();
                    if ("chooseTargets".equals(kind)) {
                        g.send(act(m, "player", "player", g.viewer));
                    } else if ("payMana".equals(kind) || "confirm".equals(kind)) {
                        g.send(ok(m));
                    } else if ("priority".equals(kind) && g.stackSize() > 0) {
                        g.send(ok(m));
                    } else if ("priority".equals(kind)) {
                        return g.cards.containsKey(iok) && "Graveyard".equals(g.cards.get(iok).get("zone").getAsString());
                    }
                    return false;
                });

                final JsonObject islandCard = g.cards.get(island);
                assertTrue("Hand".equals(islandCard.get("zone").getAsString()), "Island should still be in hand: " + islandCard);
                assertTrue(islandCard.has("revealedToOpponent") && islandCard.get("revealedToOpponent").getAsBoolean(),
                        "expected the surviving hand card to be flagged revealed to the opponent: " + islandCard);

                g.send(act(p2, "card", "card", island));
                g.await(m -> "prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString())
                        && g.cards.containsKey(island) && "Battlefield".equals(g.cards.get(island).get("zone").getAsString()));

                final JsonObject islandAfter = g.cards.get(island);
                assertFalse(islandAfter.has("revealedToOpponent"), "flag should be gone once the card left hand: " + islandAfter);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    private static JsonObject ok(final JsonObject prompt) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", "ok");
        return a;
    }

    private static JsonObject act(final JsonObject prompt, final String kind, final String key, final String value) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        a.addProperty(key, value);
        return a;
    }

    private static String card(final AutoPassTest.Game g, final String name) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString())
                        && "Hand".equals(e.getValue().get("zone").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
    }
}

package forge.bridge;

import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Regression for the Assist/Offering half of {@link DelveHandPromptTest}. {@link
 * forge.game.cost.CostAdjustment} ran Assist's "choose a player to assist" and Offering's "sacrifice a Fox?"
 * choosers during every speculative cost check too (hand-cost preview, actionable-card highlighting), so a human
 * with either card in hand was asked on every priority. Only a real cast may ask.
 */
public class AssistOfferingHandPromptTest {

    @Test
    public void unrelatedActionsDoNotAskToAssistOrOffer() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("assist-offering-hand.txt", false)) {
            // My first priority previews every hand card's cost, Dwarven Lightsmith and Patron of the Kitsune included.
            final JsonObject p = awaitPriorityWithNoAsk(g);

            // An unrelated interaction: play the Plains. Priority comes back around and re-runs the preview.
            playFromHand(g, p, "Plains");
            awaitPriorityWithNoAsk(g);
        }
    }

    @Test
    public void castingTheAssistCardStillAsksForAnAssistant() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("assist-offering-hand.txt", false)) {
            final JsonObject p = awaitPriorityWithNoAsk(g);
            playFromHand(g, p, "Dwarven Lightsmith");

            // The real cast still reaches the assist chooser (a selectEntities prompt), so the fix only gates previews.
            final JsonObject ask = g.await(m -> "prompt".equals(m.get("t").getAsString()) && isAssistOrOffering(m));
            assertTrue(ask.get("message").getAsString().contains("assist"), "no assist prompt on a real cast: " + ask);
        }
    }

    /** Reads until the next priority prompt, failing fast if an assist/offering (or any other) chooser jumps the queue. */
    private static JsonObject awaitPriorityWithNoAsk(final AutoPassTest.Game g) throws InterruptedException {
        return g.await(m -> {
            final String t = m.get("t").getAsString();
            if ("ask".equals(t) || ("prompt".equals(t) && isAssistOrOffering(m))) {
                fail("unexpected prompt while nothing was being cast: " + m);
            }
            return "prompt".equals(t) && "priority".equals(m.get("kind").getAsString());
        });
    }

    /** Assist asks "Choose a player to assist paying this spell"; Offering asks to sacrifice a Fox. */
    private static boolean isAssistOrOffering(final JsonObject m) {
        final String msg = m.has("message") ? m.get("message").getAsString().toLowerCase() : "";
        return msg.contains("assist") || msg.contains("sacrifice") || msg.contains("offering");
    }

    private static void playFromHand(final AutoPassTest.Game g, final JsonObject priorityPrompt, final String name) {
        final JsonObject act = new JsonObject();
        act.addProperty("t", "act");
        act.addProperty("pid", priorityPrompt.get("pid").getAsLong());
        act.addProperty("kind", "card");
        act.addProperty("card", card(g, name));
        g.send(act);
    }

    private static String card(final AutoPassTest.Game g, final String name) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString())
                        && "Hand".equals(e.getValue().get("zone").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
    }
}

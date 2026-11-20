package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Regression for a bug report: "if I have a delve card in my hand, it asks me if I want
 * to delve every single time I do an interaction". {@link forge.game.cost.CostAdjustment} ran Delve's real
 * "how many cards to delve?" chooser during every speculative cost check too (hand-cost preview, actionable
 * -card highlighting), gated only on whether the delved cards actually get exiled, not on whether the
 * chooser itself should run at all. The chooser must fire only once, when the card is actually cast.
 */
public class DelveHandPromptTest {

    @Test
    public void unrelatedActionsDoNotAskToDelve() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("delve-hand.txt", false)) {
            // My first priority previews every hand card's cost right now, Treasure Cruise included.
            JsonObject p = awaitPriorityWithNoAsk(g);

            // An unrelated interaction: play the Island, not Treasure Cruise. Priority comes back around,
            // which used to re-run the same speculative scan and ask again.
            playFromHand(g, p, "Island");
            awaitPriorityWithNoAsk(g);
        }
    }

    @Test
    public void castingTheDelveCardAsksExactlyOnce() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("delve-hand.txt", false)) {
            final JsonObject p = awaitPriorityWithNoAsk(g);
            playFromHand(g, p, "Treasure Cruise");
            final JsonObject[] early = {null};

            // Exactly one real delve prompt: the "how many cards?" chooser.
            final JsonObject ask = g.await(m -> keepWaiting(m, early) || "ask".equals(m.get("t").getAsString()));
            assertEquals(ask.get("kind").getAsString(), "choose", "unexpected ask: " + ask + "; " + g.recent());
            assertTrue(ask.has("items") && ask.getAsJsonArray("items").size() > 1, "no real delve choice offered: " + ask);

            // Decline to delve (idx 0 = "delve 0 cards"): no "which card to exile" follow-up, and no second
            // delve-amount ask either, before the next real prompt (payMana).
            reply(g, ask, 0);
            redeliverLate(g, early);
            final JsonObject next = awaitNextRealPrompt(g, "a second delve-related prompt after declining");
            assertEquals(next.get("kind").getAsString(), "payMana", "unexpected prompt after declining: " + next + "; " + g.recent());
        }
    }

    @Test
    public void castingWithOnlyDelveManaAsksExactlyOnceForAmount() throws Exception {
        // the other two fixtures have enough battlefield mana to cast outright, so delve
        // is only ever optional there. Here it's the only way to pay, so this confirms the fix doesn't also
        // suppress the prompt when delving is actually required. Delving 7 cards is itself a real,
        // expected two-step chooser (how many, then which ones); only the amount-ask must be singular.
        try (AutoPassTest.Game g = new AutoPassTest.Game("delve-hand-required.txt", false)) {
            final JsonObject p = awaitPriorityWithNoAsk(g);
            playFromHand(g, p, "Treasure Cruise");
            final JsonObject[] early = {null};

            final JsonObject amountAsk = g.await(m -> keepWaiting(m, early) || "ask".equals(m.get("t").getAsString()));
            assertEquals(amountAsk.get("kind").getAsString(), "choose", "unexpected ask: " + amountAsk + "; " + g.recent());
            assertTrue(amountAsk.has("items") && amountAsk.getAsJsonArray("items").size() > 1, "no real delve choice offered: " + amountAsk);
            reply(g, amountAsk, 7);
            redeliverLate(g, early);

            // Expect exactly 7 "which card to exile" follow-ups (real delve mechanics), never a repeat of
            // the amount-ask itself, then the next real prompt (payMana). The waiting prompt the game thread's
            // work puts up between asks is not a real prompt: it has no action by design.
            for (int i = 0; i < 7; i++) {
                final JsonObject exileAsk = g.await(m -> !AutoPassTest.Game.isWaiting(m)
                        && ("ask".equals(m.get("t").getAsString()) || "prompt".equals(m.get("t").getAsString())));
                assertEquals(exileAsk.get("t").getAsString(), "ask", "expected exile-choice #" + (i + 1) + ", got: " + exileAsk + "; " + g.recent());
                assertTrue(exileAsk.get("message").getAsString().startsWith("Exile which card"), "unexpected ask: " + exileAsk + "; " + g.recent());
                reply(g, exileAsk, 0);
            }

            final JsonObject next = awaitNextRealPrompt(g, "an unexpected prompt after delving the full amount");
            assertEquals(next.get("kind").getAsString(), "payMana", "unexpected prompt after delving: " + next + "; " + g.recent());
        }
    }

    /** False always; keeps a waiting prompt that came before the first ask. */
    private static boolean keepWaiting(final JsonObject m, final JsonObject[] early) {
        if (AutoPassTest.Game.isWaiting(m)) {
            early[0] = m;
        }
        return false;
    }

    /**
     * The cast puts a waiting prompt up (no Input while the game thread casts) from bridge-ui, while the game thread
     * sends its asks itself, so it can land before the first ask or after it. Here it usually comes first; a slow CI
     * runner had it after the reply (GitHub run 44740490111). Hand it back then, every run.
     */
    private static void redeliverLate(final AutoPassTest.Game g, final JsonObject[] early) {
        if (early[0] != null) {
            g.redeliver(early[0]);
        }
    }

    /** Reads to the next prompt that isn't a waiting one (nothing to do there, by design), failing if an ask comes first. */
    private static JsonObject awaitNextRealPrompt(final AutoPassTest.Game g, final String askFailure) throws InterruptedException {
        return g.await(m -> {
            if (AutoPassTest.Game.isWaiting(m)) {
                return false;
            }
            final String t = m.get("t").getAsString();
            if ("ask".equals(t)) {
                fail(askFailure + ": " + m + "; " + g.recent());
            }
            return "prompt".equals(t);
        });
    }

    private static void reply(final AutoPassTest.Game g, final JsonObject ask, final int choiceIdx) {
        final JsonObject reply = new JsonObject();
        reply.addProperty("t", "reply");
        reply.addProperty("id", ask.get("id").getAsString());
        final JsonArray v = new JsonArray();
        v.add(choiceIdx);
        reply.add("value", v);
        g.send(reply);
    }

    /** Reads until the next priority prompt, failing fast if a delve (or any other) chooser jumps the queue. */
    private static JsonObject awaitPriorityWithNoAsk(final AutoPassTest.Game g) throws InterruptedException {
        return g.await(m -> {
            if ("ask".equals(m.get("t").getAsString())) {
                fail("unexpected prompt while nothing was being cast: " + m);
            }
            return "prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString());
        });
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

package forge.bridge;

import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The payMana prompt's {@code unambiguous} hint (auto-pay when there's no other possible way to pay), from
 * board fixtures in {@code table/states/autopay-*.txt}: set only when exactly one set of lands can pay.
 */
public class AutoPayHintTest {

    @Test
    public void aSingleLandForAnExactCostIsTheOnlyWay() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("autopay-single.txt", false)) {
            assertTrue(unambiguous(cast(g, "Raging Goblin")), "one Mountain for {R}: " + g.prompt);
        }
    }

    @Test
    public void onlyTheLandOfTheRightColourCanPay() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("autopay-colours.txt", false)) {
            final JsonObject pay = cast(g, "Raging Goblin");
            assertTrue(unambiguous(pay), "Mountain + Island for {R}: " + pay);
            // Auto (the act the client sends for the player) taps the Mountain, not the Island.
            final JsonObject ok = new JsonObject();
            ok.addProperty("t", "act");
            ok.addProperty("pid", pay.get("pid").getAsLong());
            ok.addProperty("kind", "ok");
            g.send(ok);
            g.await(m -> "prompt".equals(m.get("t").getAsString()) && !"payMana".equals(m.get("kind").getAsString()));
            assertTrue(tapped(g, "Mountain"), "the Mountain paid: " + g.cards);
            assertFalse(tapped(g, "Island"), "the Island stayed untapped: " + g.cards);
        }
    }

    @Test
    public void aGenericThatTwoLandsCouldPayStillPrompts() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("autopay-choice.txt", false)) {
            final JsonObject pay = cast(g, "Goblin Piker");
            assertFalse(unambiguous(pay), "Mountain, Mountain, Forest for {1}{R} is a choice: " + pay);
            assertTrue(pay.getAsJsonObject("ok").get("enabled").getAsBoolean(), "Auto is still offered: " + pay);
        }
    }

    @Test
    public void aLandOrALotusPetalIsAChoice() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("autopay-petal.txt", false)) {
            assertFalse(unambiguous(cast(g, "Raging Goblin")), "Mountain or Lotus Petal for {R}: " + g.prompt);
        }
    }

    @Test
    public void anXSpellAlwaysPrompts() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("autopay-x.txt", false)) {
            assertFalse(unambiguous(cast(g, "Endless One")), "X spells prompt: " + g.prompt);
        }
    }

    private static boolean unambiguous(final JsonObject pay) {
        return pay.has("unambiguous") && pay.get("unambiguous").getAsBoolean();
    }

    /** Cast the hand card {@code name} from my first priority (X = 2) and return its payMana prompt. */
    private static JsonObject cast(final AutoPassTest.Game g, final String name) throws InterruptedException {
        final JsonObject p = g.awaitPriority();
        final JsonObject act = new JsonObject();
        act.addProperty("t", "act");
        act.addProperty("pid", p.get("pid").getAsLong());
        act.addProperty("kind", "card");
        act.addProperty("card", card(g, name, "Hand"));
        g.send(act);
        return g.await(m -> {
            if ("ask".equals(m.get("t").getAsString())) {
                g.send(answer(m));
                return false;
            }
            return "prompt".equals(m.get("t").getAsString()) && "payMana".equals(m.get("kind").getAsString());
        });
    }

    /** Answer an ask on the way to paying: X = 2 when it's a number, else the first item. */
    private static JsonObject answer(final JsonObject ask) {
        final JsonObject r = new JsonObject();
        r.addProperty("t", "reply");
        r.addProperty("id", ask.get("id").getAsString());
        final JsonArray v = new JsonArray();
        if (ask.has("items")) {
            int pick = -1;
            for (final JsonElement e : ask.getAsJsonArray("items")) {
                final JsonObject it = e.getAsJsonObject();
                if (pick < 0 || "2".equals(it.get("label").getAsString())) {
                    pick = it.get("idx").getAsInt();
                }
            }
            if (pick >= 0) {
                v.add(pick);
            }
            r.add("value", v);
        } else if (ask.has("options")) {
            r.addProperty("value", 0);
        } else {
            r.addProperty("value", "2");
        }
        return r;
    }

    private static String card(final AutoPassTest.Game g, final String name, final String zone) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString())
                        && zone.equals(e.getValue().get("zone").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
    }

    private static boolean tapped(final AutoPassTest.Game g, final String name) {
        final JsonObject c = g.cards.get(card(g, name, "Battlefield"));
        return c.has("tapped") && c.get("tapped").getAsBoolean();
    }
}

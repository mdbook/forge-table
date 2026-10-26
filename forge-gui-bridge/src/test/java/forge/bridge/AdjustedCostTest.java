package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** The prompt's {@code costs}: hand spells that cost other than printed right now (show modified costs). */
public class AdjustedCostTest {

    @Test
    public void affinityShowsTheReducedCost() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("adjusted-cost.txt", false)) {
            final JsonObject p = g.awaitPriority();
            final String thoughtcast = id(g, "Thoughtcast");
            final JsonObject costs = p.getAsJsonObject("costs");
            assertEquals(costs.get(thoughtcast).getAsString(), "{2}{U}", "costs: " + costs);
            assertFalse(costs.has(id(g, "Island")), "a land has no spell cost: " + costs);
        }
    }

    private static String id(final AutoPassTest.Game g, final String name) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString())
                        && "Hand".equals(e.getValue().get("zone").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
    }
}

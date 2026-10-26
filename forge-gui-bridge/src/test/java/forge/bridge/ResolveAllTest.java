package forge.bridge;

import static org.testng.Assert.assertEquals;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** Resolve all: yield{until: stackEmpty} passes until everything on the stack has resolved. */
public class ResolveAllTest {

    @Test
    public void resolveAllEmptiesTheStack() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("resolve-all.txt", false)) {
            try {
                JsonObject p = g.awaitPriority();
                final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
                for (int i = 0; i < 2; i++) {
                    final String bolt = g.cards.entrySet().stream()
                            .filter(e -> e.getValue().has("zone") && "Hand".equals(e.getValue().get("zone").getAsString()) && e.getValue().has("state")
                                    && "Lightning Bolt".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                            .map(Map.Entry::getKey).findFirst().orElseThrow();
                    g.send(act(p, "card", "card", bolt));
                    final JsonObject t = g.await(m -> "prompt".equals(m.get("t").getAsString()) && "chooseTargets".equals(m.get("kind").getAsString()));
                    g.send(act(t, "player", "player", opp));
                    final JsonObject pay = g.await(m -> "prompt".equals(m.get("t").getAsString()) && "payMana".equals(m.get("kind").getAsString()));
                    final JsonObject auto = new JsonObject();
                    auto.addProperty("t", "act");
                    auto.addProperty("pid", pay.get("pid").getAsLong());
                    auto.addProperty("kind", "ok");
                    g.send(auto);
                    p = g.awaitPriority();
                }
                assertEquals(g.stackSize(), 2, "both bolts on the stack");
                final JsonObject all = new JsonObject();
                all.addProperty("t", "act");
                all.addProperty("kind", "yield");
                all.addProperty("until", "stackEmpty");
                g.send(all);
                g.await(m -> "prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString()) && g.stackSize() == 0);
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

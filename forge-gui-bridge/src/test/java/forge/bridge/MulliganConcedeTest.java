package forge.bridge;

import static org.testng.Assert.assertFalse;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** Conceding at the opening hand (keep / mulligan) ends the game cleanly (Forge crashed). */
public class MulliganConcedeTest {

    @Test
    public void concedeAtTheMulliganEndsTheGame() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game((String) null, false)) {
            g.autoKeep = false;
            try {
                g.await(m -> {
                    if ("prompt".equals(m.get("t").getAsString()) && "confirm".equals(m.get("kind").getAsString())) {
                        final JsonObject ok = new JsonObject();
                        ok.addProperty("t", "act");
                        ok.addProperty("kind", "ok");
                        ok.addProperty("pid", m.get("pid").getAsLong());
                        g.send(ok);
                        return false;
                    }
                    return "prompt".equals(m.get("t").getAsString()) && "mulligan".equals(m.get("kind").getAsString());
                });
                final JsonObject concede = new JsonObject();
                concede.addProperty("t", "act");
                concede.addProperty("kind", "concede");
                g.send(concede);
                final JsonObject over = g.await(m -> "gameOver".equals(m.get("t").getAsString()));
                assertFalse(over.has("won") && over.get("won").getAsBoolean(), "the conceding player won: " + over);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }
}

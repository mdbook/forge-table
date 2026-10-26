package forge.bridge;

import static org.testng.Assert.assertNotNull;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** Leave at game over (nextGame QUIT) goes back to the start screen, and a match started there begins. */
public class LeaveTest {

    @Test
    public void aMatchStartedAfterLeaveBegins() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("concede-targeting.txt", false)) {
            g.awaitPriority();
            final JsonObject concede = new JsonObject();
            concede.addProperty("t", "act");
            concede.addProperty("kind", "concede");
            g.send(concede);
            g.await(m -> "gameOver".equals(m.get("t").getAsString()));

            final JsonObject leave = new JsonObject();
            leave.addProperty("t", "act");
            leave.addProperty("kind", "nextGame");
            leave.addProperty("decision", "QUIT");
            g.send(leave);

            final JsonObject params = new JsonObject();
            params.addProperty("deck", "mono-blue-faeries");
            params.addProperty("oppDeck", "mono-red-madness");
            params.addProperty("ai", "Default");
            final JsonObject rpc = new JsonObject();
            rpc.addProperty("t", "rpc");
            rpc.addProperty("id", "start2");
            rpc.addProperty("method", "match.start");
            rpc.add("params", params);
            g.send(rpc);
            g.await(m -> "snapshot".equals(m.get("t").getAsString()));
            // The mulligan is kept by the helper; the new game then asks something of the human (here: the AI-cards reveal).
            try {
                final JsonObject first = g.await(m -> "ask".equals(m.get("t").getAsString())
                        || "prompt".equals(m.get("t").getAsString()) && !"mulligan".equals(m.get("kind").getAsString()));
                assertNotNull(first);
                // End the new game cleanly: Forge is process-global, the next test class boots into it.
                if ("ask".equals(first.get("t").getAsString())) {
                    final JsonObject reply = new JsonObject();
                    reply.addProperty("t", "reply");
                    reply.addProperty("id", first.get("id").getAsString());
                    reply.add("value", new com.google.gson.JsonArray());
                    g.send(reply);
                }
                g.send(concede);
                g.await(m -> "gameOver".equals(m.get("t").getAsString()));
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }
}

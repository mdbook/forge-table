package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgePreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.AutoYieldStore;
import forge.player.PersistentAutoDecisionStore;

/**
 * Auto-responses: act {@code autoResolve} passes while my own spell is on top of the stack, and act
 * {@code triggerAnswer} answers an optional trigger the same way from now on (Forge's Auto-Yield trigger decisions).
 */
public class AutoResponsesTest {

    @Test
    public void autoResolvePassesOverMyOwnSpell() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("resolve-all.txt", false)) {
            try {
                JsonObject p = g.awaitPriority();
                g.act("autoResolve", "on", true);
                g.awaitAutoPass(m -> m.has("autoResolve") && m.get("autoResolve").getAsBoolean());
                // The toggle only sends a notice; the priority prompt on screen stays the one to answer.
                p = castBolt(g, p);
                assertEquals(g.stackSize(), 0, "the bolt resolved without a stop: " + p);

                g.act("autoResolve", "on", false);
                g.awaitAutoPass(m -> m.has("autoResolve") && !m.get("autoResolve").getAsBoolean());
                castBolt(g, p);
                assertEquals(g.stackSize(), 1, "with it off the bolt waits on the stack");
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    @Test
    public void triggerAnswerSticksUntilAskedAgain() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("trigger-answer.txt", false)) {
            try {
                JsonObject p = g.awaitPriority();
                g.autoKeep = false;
                final String me = g.viewer;

                // First bolt: Kor Firewalker asks, and the confirm carries the trigger's key.
                p = castBolt(g, p);
                pass(g, p);
                final JsonObject confirm = g.await(m -> "prompt".equals(m.get("t").getAsString()) && "confirm".equals(m.get("kind").getAsString()));
                assertTrue(confirm.has("triggerKey"), "no triggerKey on " + confirm);
                final String key = confirm.get("triggerKey").getAsString();
                answer(g, key, "accept");
                g.await(m -> life(g, me) == 21);
                g.awaitAutoPass(m -> decisions(m).size() == 1 && "accept".equals(decisions(m).get(0).getAsJsonObject().get("decision").getAsString()));
                final String stored = decisions(g.autoPass.get(g.autoPass.size() - 1)).get(0).getAsJsonObject().get("key").getAsString();
                p = passToEmptyStack(g);

                // Second bolt: no question, the life comes anyway.
                p = castBolt(g, p);
                pass(g, p);
                g.await(m -> {
                    if ("prompt".equals(m.get("t").getAsString()) && "confirm".equals(m.get("kind").getAsString())) {
                        fail("asked again: " + m);
                    }
                    return life(g, me) == 22;
                });

                // Ask again takes the answer back.
                answer(g, stored, "ask");
                g.awaitAutoPass(m -> decisions(m).isEmpty());
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    @Test
    public void answersStayWithTheSeatAndAreCapped() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("resolve-all.txt", false)) {
            // After the sidecar booted Forge's model.
            final ForgePreferences prefs = FModel.getPreferences();
            final String mode = prefs.getPref(FPref.UI_AUTO_DECISION_MODE);
            try {
                g.awaitPriority();
                // Forge's per-install mode is one file for every seat and desktop Forge; Forge Table keeps answers per seat.
                prefs.setPref(FPref.UI_AUTO_DECISION_MODE, ForgeConstants.AUTO_DECISION_PER_ABILITY_INSTALL);
                answer(g, "Forge Table test trigger 0", "accept");
                g.awaitAutoPass(m -> decisions(m).size() == 1);
                assertEquals(PersistentAutoDecisionStore.get().getTriggerDecision("Forge Table test trigger 0"),
                        AutoYieldStore.TriggerDecision.ASK, "the answer went to the shared per-install store");

                for (int i = 1; i < 200; i++) {
                    answer(g, "Forge Table test trigger " + i, "decline");
                }
                g.awaitAutoPass(m -> decisions(m).size() == 200);
                answer(g, "Forge Table test trigger 200", "accept");
                g.await(m -> "notice".equals(m.get("t").getAsString()) && "stale".equals(m.get("kind").getAsString())
                        && "too many trigger answers".equals(m.get("reason").getAsString()));
                // Changing one it already has is still fine.
                answer(g, "Forge Table test trigger 5", "accept");
                g.awaitAutoPass(m -> decisions(m).size() == 200 && "accept".equals(decisionFor(m, "Forge Table test trigger 5")));
                // The solo player outlives this game in the test JVM: leave its store empty for the next test.
                for (int i = 0; i < 200; i++) {
                    answer(g, "Forge Table test trigger " + i, "ask");
                }
                g.awaitAutoPass(m -> decisions(m).isEmpty());
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            } finally {
                prefs.setPref(FPref.UI_AUTO_DECISION_MODE, mode);
            }
        }
    }

    /** Cast a Lightning Bolt from my hand at the opponent; returns the priority prompt after paying. */
    private static JsonObject castBolt(final AutoPassTest.Game g, final JsonObject priority) throws InterruptedException {
        final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
        final String bolt = g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("zone") && "Hand".equals(e.getValue().get("zone").getAsString()) && e.getValue().has("state")
                        && "Lightning Bolt".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
        g.send(act(priority, "card", "card", bolt));
        final JsonObject t = g.await(m -> "prompt".equals(m.get("t").getAsString()) && "chooseTargets".equals(m.get("kind").getAsString()));
        g.send(act(t, "player", "player", opp));
        final JsonObject pay = g.await(m -> "prompt".equals(m.get("t").getAsString()) && "payMana".equals(m.get("kind").getAsString()));
        g.send(act(pay, "ok", null, null));
        return g.awaitPriority();
    }

    private static void pass(final AutoPassTest.Game g, final JsonObject priority) {
        g.send(act(priority, "ok", null, null));
    }

    /** Pass each priority (starting with the one on screen, if any) until the stack is empty; returns that priority. */
    private static JsonObject passToEmptyStack(final AutoPassTest.Game g) throws InterruptedException {
        JsonObject p = g.prompt;
        while (true) {
            if (p != null && "prompt".equals(p.get("t").getAsString()) && "priority".equals(p.get("kind").getAsString())) {
                if (g.stackSize() == 0) {
                    return p;
                }
                pass(g, p);
            }
            p = g.awaitPriority();
        }
    }

    private static void answer(final AutoPassTest.Game g, final String key, final String decision) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", "triggerAnswer");
        a.addProperty("key", key);
        a.addProperty("decision", decision);
        g.send(a);
    }

    private static JsonArray decisions(final JsonObject autoPass) {
        return autoPass.has("answers") ? autoPass.getAsJsonArray("answers") : new JsonArray();
    }

    private static String decisionFor(final JsonObject autoPass, final String key) {
        for (final com.google.gson.JsonElement a : decisions(autoPass)) {
            if (key.equals(a.getAsJsonObject().get("key").getAsString())) {
                return a.getAsJsonObject().get("decision").getAsString();
            }
        }
        return null;
    }

    private static int life(final AutoPassTest.Game g, final String player) {
        return g.players.has(player) ? g.players.getAsJsonObject(player).get("life").getAsInt() : -1;
    }

    private static JsonObject act(final JsonObject prompt, final String kind, final String key, final String value) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        if (key != null) {
            a.addProperty(key, value);
        }
        return a;
    }
}

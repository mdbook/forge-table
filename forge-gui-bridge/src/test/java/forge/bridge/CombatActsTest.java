package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The MTGA-style combat acts against the real engine: {@code block}, {@code unblock} and
 * {@code attack} drive Forge's own InputBlock/InputAttack, and the prompt carries {@code blockable} and
 * {@code defenders}. Board fixtures: {@code table/states/combat-*.txt}.
 */
public class CombatActsTest {

    @Test
    public void blockMoveUnblockAndMenace() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("combat-blocks.txt", true)) {
            JsonObject p = g.await(m -> isPrompt(m, "declareBlockers"));
            final String drake = id(g, "Wind Drake");
            final String brute = id(g, "Boggart Brute");
            final String spider = id(g, "Giant Spider");
            final String bears = id(g, "Grizzly Bears");
            final String giant = id(g, "Hill Giant");

            // Only the reach creature can block the flyer; anyone can (start to) block the menace creature.
            JsonObject bl = p.getAsJsonObject("blockable");
            assertNotNull(bl, "no blockable: " + p);
            assertEquals(ids(bl.get(spider)), Set.of(drake, brute), "blockable " + bl);
            assertEquals(ids(bl.get(bears)), Set.of(brute), "blockable " + bl);
            assertEquals(ids(bl.get(giant)), Set.of(brute), "blockable " + bl);
            assertTrue(!p.has("defenders"));

            // An illegal pair: the usual flash, nothing assigned.
            g.send(act(p, "block", "blocker", bears, "attacker", drake));
            g.await(m -> isNotice(m, "flash"));

            // Spider blocks the Drake; the Spider can still move to the Brute.
            g.send(act(p, "block", "blocker", spider, "attacker", drake));
            p = g.await(m -> isPrompt(m, "declareBlockers") && planned(g, drake).equals(List.of(spider)));
            bl = p.getAsJsonObject("blockable");
            assertEquals(ids(bl.get(spider)), Set.of(brute), "move target: " + bl);
            assertEquals(ids(bl.get(bears)), Set.of(brute), "blockable " + bl);
            assertTrue(planned(g, brute).isEmpty(), "bears were assigned by the illegal act: " + g.game);

            // Move it: off the Drake, onto the Brute.
            g.send(act(p, "block", "blocker", spider, "attacker", brute));
            p = g.await(m -> isPrompt(m, "declareBlockers") && planned(g, brute).equals(List.of(spider)));
            assertTrue(planned(g, drake).isEmpty(), "the Spider still blocks the Drake: " + g.game);
            assertEquals(ids(p.getAsJsonObject("blockable").get(spider)), Set.of(drake));

            // Pull it back.
            g.send(act(p, "unblock", "blocker", spider));
            p = g.await(m -> isPrompt(m, "declareBlockers") && planned(g, brute).isEmpty());
            assertEquals(ids(p.getAsJsonObject("blockable").get(spider)), Set.of(drake, brute));

            // Unknown ids and someone else's creature are refused.
            g.send(act(p, "block", "blocker", "c999999", "attacker", brute));
            g.await(m -> isNotice(m, "stale") && "unknown card".equals(m.get("reason").getAsString()));
            g.send(act(p, "block", "blocker", drake, "attacker", brute));
            g.await(m -> isNotice(m, "stale") && "not your creature".equals(m.get("reason").getAsString()));

            // Menace with one blocker: Forge's validateBlocks refuses the OK.
            g.send(act(p, "block", "blocker", bears, "attacker", brute));
            p = g.await(m -> isPrompt(m, "declareBlockers") && planned(g, brute).equals(List.of(bears)));
            g.send(act(p, "ok"));
            g.await(m -> isNotice(m, "toast"));
            g.send(act(p, "block", "blocker", giant, "attacker", brute));
            p = g.await(m -> isPrompt(m, "declareBlockers") && planned(g, brute).size() == 2);
            g.send(act(p, "ok"));
            g.await(m -> new HashSet<>(blockers(g, brute)).equals(Set.of(bears, giant)));
        }
    }

    @Test
    public void attackPicksAndMovesTheDefender() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("combat-attack.txt", true)) {
            JsonObject p = g.await(m -> isPrompt(m, "declareAttackers"));
            final String bears = id(g, "Grizzly Bears");
            final String giant = id(g, "Hill Giant");
            final String jace = id(g, "Jace Beleren");
            final String opp = g.snapshot.getAsJsonObject("players").keySet().stream().filter(k -> !k.equals(g.viewer)).findFirst().orElseThrow();

            assertEquals(ids(p.get("defenders")), Set.of(opp, jace), "defenders " + p);
            assertTrue(!p.has("blockable"));

            g.send(act(p, "attack", "attacker", bears, "defender", jace));
            p = g.await(m -> isPrompt(m, "declareAttackers") && jace.equals(defender(g, bears)));
            g.send(act(p, "attack", "attacker", bears, "defender", opp));
            p = g.await(m -> isPrompt(m, "declareAttackers") && opp.equals(defender(g, bears)));
            // Again at the same defender: stays declared (a plain click would call it back).
            g.send(act(p, "attack", "attacker", bears, "defender", opp));
            g.send(act(p, "attack", "attacker", giant, "defender", jace));
            p = g.await(m -> isPrompt(m, "declareAttackers") && jace.equals(defender(g, giant)));
            assertEquals(defender(g, bears), opp);

            g.send(act(p, "attack", "attacker", giant, "defender", g.viewer));
            g.await(m -> isNotice(m, "stale") && "not a defender".equals(m.get("reason").getAsString()));
            g.send(act(p, "attack", "attacker", jace, "defender", opp));
            g.await(m -> isNotice(m, "stale") && "not your creature".equals(m.get("reason").getAsString()));
            g.send(act(p, "block", "blocker", bears, "attacker", giant));
            g.await(m -> isNotice(m, "stale") && "not declaring blockers".equals(m.get("reason").getAsString()));
        }
    }

    // ---------------------------------------------------------------- helpers

    private static boolean isPrompt(final JsonObject m, final String kind) {
        final String t = m.get("t").getAsString();
        return ("prompt".equals(t) || "promptUpdate".equals(t)) && kind.equals(m.get("kind").getAsString());
    }

    private static boolean isNotice(final JsonObject m, final String kind) {
        return "notice".equals(m.get("t").getAsString()) && kind.equals(m.get("kind").getAsString());
    }

    private static JsonObject act(final JsonObject prompt, final String kind, final String... kv) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        for (int i = 0; i < kv.length; i += 2) {
            a.addProperty(kv[i], kv[i + 1]);
        }
        return a;
    }

    private static String id(final AutoPassTest.Game g, final String name) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                .map(java.util.Map.Entry::getKey).findFirst().orElseThrow(() -> new AssertionError("no " + name + " in " + g.cards.keySet()));
    }

    private static Set<String> ids(final JsonElement arr) {
        final Set<String> out = new HashSet<>();
        if (arr != null && arr.isJsonArray()) {
            arr.getAsJsonArray().forEach(e -> out.add(e.getAsString()));
        }
        return out;
    }

    private static JsonObject combatOf(final AutoPassTest.Game g, final String attacker) {
        if (!g.game.has("combat")) {
            return null;
        }
        for (final JsonElement e : g.game.getAsJsonArray("combat")) {
            if (attacker.equals(e.getAsJsonObject().get("attacker").getAsString())) {
                return e.getAsJsonObject();
            }
        }
        return null;
    }

    private static List<String> list(final JsonObject entry, final String key) {
        final List<String> out = new ArrayList<>();
        if (entry != null && entry.has(key)) {
            final JsonArray arr = entry.getAsJsonArray(key);
            arr.forEach(e -> out.add(e.getAsString()));
        }
        return out;
    }

    private static List<String> planned(final AutoPassTest.Game g, final String attacker) {
        return list(combatOf(g, attacker), "planned");
    }

    private static List<String> blockers(final AutoPassTest.Game g, final String attacker) {
        return list(combatOf(g, attacker), "blockers");
    }

    private static String defender(final AutoPassTest.Game g, final String attacker) {
        final JsonObject e = combatOf(g, attacker);
        return e == null || !e.has("defender") ? null : e.get("defender").getAsString();
    }
}

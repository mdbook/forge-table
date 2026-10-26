package forge.bridge;

import static org.testng.Assert.assertTrue;

import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * A card of the opponent's library revealed to me, or put on top from a public zone, stays known there;
 * a shuffle or a move within the library (a scry, even one that keeps it on top) forgets it.
 */
public class RevealedLibraryTest {

    @Test
    public void aRevealedTopCardStaysKnown() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("reveal-library.txt", false)) {
            try {
                final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
                // Cerebral Eruption: the AI reveals its top card (Grizzly Bears), which stays on top.
                JsonObject p = g.awaitPriority();
                p = cast(g, p, inHand(g, "Cerebral Eruption"), "player", opp);
                JsonArray lib = library(g, opp);
                assertTrue(lib.size() > 0 && lib.get(0).getAsString().startsWith("c"), "after the reveal: " + lib);
                final String bears = lib.get(0).getAsString();
                // Griptide puts the (public) Hill Giant on top: known too, and the Bears below it still are.
                p = cast(g, p, inHand(g, "Griptide"), "card", named(g, "Hill Giant"));
                lib = library(g, opp);
                assertTrue(lib.get(0).getAsString().startsWith("c") && bears.equals(lib.get(1).getAsString()), "after Griptide: " + lib);
                assertTrue(lib.get(2).getAsString().startsWith("x"), "the rest stays hidden: " + lib);
                // Serene Remembrance shuffles their graveyard Island into their library: nothing there is known any more.
                p = cast(g, p, inHand(g, "Serene Remembrance"), "card", named(g, "Island", "Graveyard"));
                lib = library(g, opp);
                assertTrue(allHidden(lib, lib.size()), "after the shuffle: " + lib);
                // My own Armodon put on top of my library is known to me; Magma Jet's scry 2 keeps it on top, yet that
                // move is the owner's hidden choice, so it is forgotten.
                p = cast(g, p, inHand(g, "Griptide"), "card", named(g, "Trained Armodon"));
                JsonArray mine = library(g, g.viewer);
                assertTrue(mine.get(0).getAsString().startsWith("c"), "my Griptided Armodon: " + mine);
                cast(g, p, inHand(g, "Magma Jet"), "player", opp);
                mine = library(g, g.viewer);
                assertTrue(allHidden(mine, 2), "after scry 2 (kept on top): " + mine);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    private static JsonArray library(final AutoPassTest.Game g, final String player) {
        return g.players.getAsJsonObject(player).getAsJsonObject("zones").getAsJsonArray("library");
    }

    private static boolean allHidden(final JsonArray ids, final int top) {
        for (int i = 0; i < top; i++) {
            if (!ids.get(i).getAsString().startsWith("x")) {
                return false;
            }
        }
        return true;
    }

    private static String inHand(final AutoPassTest.Game g, final String name) {
        return named(g, name, "Hand");
    }

    private static String named(final AutoPassTest.Game g, final String name) {
        return named(g, name, null);
    }

    private static String named(final AutoPassTest.Game g, final String name, final String zone) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                .filter(e -> zone == null || e.getValue().has("zone") && zone.equals(e.getValue().get("zone").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow();
    }

    /** Cast {@code card} at {@code target} from priority {@code p}; answer everything until it has resolved (my next priority). */
    private static JsonObject cast(final AutoPassTest.Game g, final JsonObject p, final String card, final String targetKind, final String target) throws Exception {
        g.send(act(p, "card", "card", card));
        final boolean[] cast = { false };
        final boolean[] targeted = { false };
        return g.await(m -> {
            final String t = m.get("t").getAsString();
            if ("ask".equals(t) && "arrange".equals(m.get("kind").getAsString())) {
                // A scry: keep everything on top.
                final JsonObject r = new JsonObject();
                r.addProperty("t", "reply");
                r.addProperty("id", m.get("id").getAsString());
                final JsonObject v = new JsonObject();
                final JsonArray top = new JsonArray();
                m.getAsJsonArray("items").forEach(i -> top.add(i.getAsJsonObject().get("idx").getAsInt()));
                v.add("top", top);
                v.add("bottom", new JsonArray());
                r.add("value", v);
                g.send(r);
                return false;
            }
            if ("ask".equals(t)) {
                final JsonObject r = new JsonObject();
                r.addProperty("t", "reply");
                r.addProperty("id", m.get("id").getAsString());
                final JsonArray v = new JsonArray();
                if (m.has("items") && m.getAsJsonArray("items").size() > 0) {
                    v.add(m.getAsJsonArray("items").get(0).getAsJsonObject().get("idx").getAsInt());
                }
                r.add("value", m.has("options") ? new com.google.gson.JsonPrimitive(0) : v);
                g.send(r);
                return false;
            }
            if ("promptUpdate".equals(t) && "chooseTargets".equals(m.get("kind").getAsString())) {
                // A target picked and room for more ("up to three"): done.
                g.send(ok(m));
                return false;
            }
            if (!"prompt".equals(t)) {
                return false;
            }
            final String kind = m.get("kind").getAsString();
            if ("chooseTargets".equals(kind) && !targeted[0]) {
                targeted[0] = true;
                g.send(act(m, targetKind, targetKind, target));
            } else if ("chooseTargets".equals(kind)) {
                g.send(ok(m));
            } else if ("payMana".equals(kind) || "confirm".equals(kind)) {
                g.send(ok(m));
            } else if ("priority".equals(kind) && g.stackSize() > 0) {
                cast[0] = true;
                g.send(ok(m));
            } else if ("priority".equals(kind)) {
                return cast[0];
            }
            return false;
        });
    }

    private static JsonObject ok(final JsonObject prompt) {
        final JsonObject ok = new JsonObject();
        ok.addProperty("t", "act");
        ok.addProperty("pid", prompt.get("pid").getAsLong());
        ok.addProperty("kind", "ok");
        return ok;
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

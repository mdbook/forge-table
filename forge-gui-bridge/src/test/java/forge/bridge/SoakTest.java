package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.io.File;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * A soak: games round-robin over the vendored Pauper decks
 * against the Forge AI, with the adversarial client sending stale and duplicate acts. Group
 * {@code table-it}: runs only under {@code -Ptable-it}. {@code -Dtable.soak.games=N} overrides the count.
 */
@Test(groups = "table-it")
public class SoakTest {

    public void soak() throws Exception {
        final int games = Integer.getInteger("table.soak.games", 10);
        final int first = Integer.getInteger("table.soak.first", 0);
        final File[] decks = TableTestEnv.decksDir().listFiles((d, n) -> n.endsWith(".dck"));
        assertTrue(decks != null && decks.length >= 2);
        java.util.Arrays.sort(decks);
        final int errorsBefore = BridgeLog.errorCount();
        final List<String> failures = new ArrayList<>();
        final Map<String, Integer> prompts = new TreeMap<>();
        final Map<String, Integer> asks = new TreeMap<>();
        int staleSent = 0;
        int staleNotices = 0;
        for (int g = first; g < first + games; g++) {
            final String mine = decks[g % decks.length].getName().replace(".dck", "");
            final String theirs = decks[(g * 5 + 3) % decks.length].getName().replace(".dck", "");
            final Main.Running sidecar = TableTestEnv.start();
            final ScriptedClient client = new ScriptedClient(sidecar.port(), sidecar.token, 1000L + g, true, 2500);
            final JsonObject params = new JsonObject();
            params.addProperty("deck", mine);
            params.addProperty("oppDeck", theirs);
            params.addProperty("ai", "Default");
            final ScriptedClient.Result r = client.play(params, Duration.ofSeconds(120));
            sidecar.stop();
            System.out.println("[SoakTest] game " + g + " " + mine + " vs " + theirs + ": " + r);
            if (!r.violations.isEmpty() || !r.gameOver) {
                failures.add("game " + g + " (" + mine + " vs " + theirs + "): " + r.violations);
            }
            r.promptKinds.forEach((k, v) -> prompts.merge(k, v, Integer::sum));
            r.askKinds.forEach((k, v) -> asks.merge(k, v, Integer::sum));
            staleSent += r.staleSent;
            staleNotices += r.staleNotices;
        }
        System.out.println("[SoakTest] coverage: prompts=" + prompts + " asks=" + asks + " stale=" + staleNotices + "/" + staleSent);
        assertTrue(failures.isEmpty(), String.join("\n", failures));
        assertTrue(staleNotices >= staleSent, "superseded-pid acts were not all rejected: " + staleNotices + " < " + staleSent);
        assertEquals(BridgeLog.errorCount() - errorsBefore, 0, "bridge logged errors");
    }
}

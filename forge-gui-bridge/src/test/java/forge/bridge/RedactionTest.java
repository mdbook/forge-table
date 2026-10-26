package forge.bridge;

import static org.testng.Assert.assertTrue;

import java.io.File;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Hidden information never reaches the client: with a face-down Exalted Angel on the AI's
 * side, Lightning Bolt and Counterspell in its hand and Accumulated Knowledges in its library, none of those names
 * appear anywhere in the bytes sent to the human before the game ends, while the human's own face-down Fathom Seer is
 * identified to them with its real face.
 */
public class RedactionTest {

    private static final List<String> SECRETS = List.of("Exalted Angel", "Lightning Bolt", "Counterspell", "Accumulated Knowledge");

    @Test
    public void secretsNeverLeaveTheServer() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        final List<String> leaks = new ArrayList<>();
        final boolean[] sawMyMorph = {false};
        final boolean[] sawTheirMorph = {false};
        final ScriptedClient client = new ScriptedClient(sidecar.port(), sidecar.token, 3L, false, 12);
        client.onMessage(m -> {
            if (client.conceded()) {
                return; // conceding ends the game, and face-down permanents are revealed then (rule 708.9)
            }
            final String text = m.toString();
            for (final String secret : SECRETS) {
                if (text.contains(secret)) {
                    leaks.add(secret + " in " + text.substring(0, Math.min(400, text.length())));
                }
            }
        });
        client.onMessage(m -> {
            client.cards().values().forEach(c -> {
                final String id = c.get("id").getAsString();
                final boolean facedown = c.has("facedown") && c.get("facedown").getAsBoolean();
                if (!facedown) {
                    return;
                }
                if (id.startsWith("c") && c.has("alt") && "Fathom Seer".equals(c.getAsJsonObject("alt").get("name").getAsString())) {
                    sawMyMorph[0] = true;
                }
                if (id.startsWith("f")) {
                    sawTheirMorph[0] = true;
                }
            });
        });
        final JsonObject params = new JsonObject();
        params.addProperty("deck", "mono-blue-faeries");
        params.addProperty("oppDeck", "mono-red-madness");
        params.addProperty("state", fixture("table/states/morph-face-down.txt"));
        final ScriptedClient.Result r = client.play(params, Duration.ofSeconds(120));
        sidecar.stop();
        System.out.println("[RedactionTest] " + r);
        assertTrue(r.violations.isEmpty(), "violations: " + r.violations);
        assertTrue(leaks.isEmpty(), "hidden names reached the client:\n" + String.join("\n", leaks));
        assertTrue(sawMyMorph[0], "own face-down card was not identified to its controller");
        assertTrue(sawTheirMorph[0], "opponent's face-down card was not sent as an unidentified 'f' card");
    }

    private static String fixture(final String resource) throws URISyntaxException {
        return new File(RedactionTest.class.getClassLoader().getResource(resource).toURI()).getAbsolutePath();
    }
}

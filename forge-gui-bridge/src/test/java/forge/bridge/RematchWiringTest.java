package forge.bridge;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/**
 * Rematch wiring: {@code handleRematch}/{@code rematch} remember the deck names
 * {@code match.start} was actually given (the client-facing/file names BridgeApp resolves decks by), not
 * {@code Deck.getName()} (the {@code [metadata] Name}, which differs for {@code mono-red-madness.dck}: its
 * metadata name is "Mono Red Madness" -- see {@link DeckFixturesTest}/{@link RematchDeckResolutionTest}). Before
 * the fix, feeding the metadata name back into {@code loadDeck} on Rematch threw "Deck not found" wherever the
 * two differ; the exception died on the service-executor pool silently (no {@code rpcResult}, no toast), so the
 * new game's snapshot never arrived. Only one seat needs to be "Random deck" to exercise the rematch path at all
 * ({@code handleRematch} requires it); the other, fixed seat's resolution is what this test guards.
 */
public class RematchWiringTest {

    @Test
    public void rematchKeepsAFixedSeatsDeckEvenWhenItsMetadataNameDiffersFromItsFileName() throws Exception {
        final JsonObject params = new JsonObject();
        params.addProperty("deck", "mono-red-madness"); // fixed: [metadata] Name="Mono Red Madness", file name differs
        params.addProperty("oppDeck", "mono-blue-faeries");
        params.addProperty("oppDeckRandom", true); // only the opponent is "Random deck": enough to reach handleRematch
        params.addProperty("ai", "Default");
        try (AutoPassTest.Game g = new AutoPassTest.Game(params, true)) {
            final JsonObject rematch = new JsonObject();
            rematch.addProperty("t", "act");
            rematch.addProperty("kind", "nextGame");
            rematch.addProperty("decision", "NEW");
            g.send(rematch);
            // Pre-fix this hangs until AutoPassTest.Game's 60s await timeout: the rematch throws
            // "Deck not found: Mono Red Madness" on the service executor and nothing is ever sent back.
            g.await(m -> "snapshot".equals(m.get("t").getAsString()));

            // End the new game cleanly: Forge is process-global, the next test class boots into it.
            final JsonObject concede = new JsonObject();
            concede.addProperty("t", "act");
            concede.addProperty("kind", "concede");
            g.send(concede);
            g.await(m -> "gameOver".equals(m.get("t").getAsString()));
        }
    }
}

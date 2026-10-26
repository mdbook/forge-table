package forge.bridge;

import static org.testng.Assert.assertEquals;

import org.testng.annotations.Test;

/**
 * What a sidecar tells the router's reaper: any game in progress is "playing", even when the match before it ended
 * (Forge keeps the match-over flag set through a rematch or the next game until that game ends).
 */
public class GameStateTest {

    @Test
    public void aGameInProgressIsPlaying() {
        assertEquals(BridgeApp.state(true, true, false, true), "playing");
        assertEquals(BridgeApp.state(true, true, true, true), "playing", "rematch: the old match-over flag is still set");
    }

    @Test
    public void aMatchBetweenGamesOrBeforeTheDealIsPlaying() {
        assertEquals(BridgeApp.state(true, false, false, true), "playing", "match.start called, game not dealt yet");
    }

    @Test
    public void overOnlyWithNothingRunning() {
        assertEquals(BridgeApp.state(true, false, true, true), "over", "the game ended, the result panel is up");
        assertEquals(BridgeApp.state(false, false, false, true), "over", "left the match (QUIT) or conceded and left");
        assertEquals(BridgeApp.state(false, false, false, false), "waiting");
    }
}

package forge.bridge.match;

import static org.testng.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.testng.annotations.Test;

/**
 * Scry: the lanes the player arranges must be the library order the engine ends up with. This replays
 * what happens to {@link BridgeGuiGame#arranged}'s answer ({@code PlayerControllerHuman.arrangeForMove} splitting
 * it into top and bottom, then {@code GameAction.scry} moving the cards) on plain lists.
 */
public class ArrangeTest {
    private static List<String> scry(final List<String> library, final int n, final List<Integer> top, final List<Integer> bottom) {
        final List<String> moving = new ArrayList<>(library.subList(0, n));
        final List<String> result = BridgeGuiGame.arranged(library, moving, top, bottom);
        // arrangeForMove
        final List<String> toTop = new ArrayList<>();
        final List<String> toBottom = new ArrayList<>();
        for (int i = 0; i < library.size() && moving.contains(result.get(i)); i++) {
            toTop.add(result.get(i));
        }
        if (toTop.size() < library.size()) {
            for (int i = result.size() - 1; i >= 0 && moving.contains(result.get(i)); i--) {
                toBottom.add(result.get(i));
            }
        }
        // GameAction.scry: reverse the top and put each on top; put each of the bottom on the bottom.
        final List<String> lib = new ArrayList<>(library);
        lib.removeAll(toTop);
        lib.removeAll(toBottom);
        Collections.reverse(toTop);
        for (final String c : toTop) {
            lib.add(0, c);
        }
        lib.addAll(toBottom);
        return lib;
    }

    @Test
    public void keepingEverythingOnTopKeepsTheOrder() {
        assertEquals(scry(List.of("a", "b", "c", "d", "e"), 2, List.of(0, 1), List.of()), List.of("a", "b", "c", "d", "e"));
    }

    @Test
    public void topLaneOrderIsTheNewTop() {
        assertEquals(scry(List.of("a", "b", "c", "d", "e"), 3, List.of(2, 0), List.of(1)), List.of("c", "a", "d", "e", "b"));
    }

    @Test
    public void bottomLaneEndsWithTheVeryBottomCard() {
        assertEquals(scry(List.of("a", "b", "c", "d"), 2, List.of(), List.of(0, 1)), List.of("c", "d", "a", "b"));
        assertEquals(scry(List.of("a", "b", "c", "d"), 2, List.of(), List.of(1, 0)), List.of("c", "d", "b", "a"));
    }

    @Test
    public void wholeLibraryArrangedKeepsLaneOrder() {
        assertEquals(scry(List.of("a", "b", "c"), 3, List.of(1), List.of(2, 0)), List.of("b", "c", "a"));
        assertEquals(scry(List.of("a", "b"), 2, List.of(), List.of(1, 0)), List.of("b", "a"));
    }

    @Test(expectedExceptions = PromptService.InvalidReply.class)
    public void duplicatesAreRejected() {
        final com.google.gson.JsonArray a = new com.google.gson.JsonArray();
        a.add(0);
        a.add(0);
        BridgeGuiGame.indices(a, 2, 0, -1);
    }
}

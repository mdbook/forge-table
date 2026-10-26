package forge.bridge.match;

import static org.testng.Assert.assertEquals;

import java.util.List;

import org.testng.annotations.Test;

import forge.card.mana.ManaAtom;

/** The counting behind the payMana {@code unambiguous} hint: how many different sets of sources pay the pips. */
public class OnlyWayTest {
    private static final int W = ManaAtom.WHITE;
    private static final int U = ManaAtom.BLUE;
    private static final int R = ManaAtom.RED;
    private static final int G = ManaAtom.GREEN;
    private static final int C = ManaAtom.COLORLESS;
    /** A generic pip. */
    private static final int ANY = ManaAtom.ALL_MANA_TYPES;

    private static OnlyWay.Kind k(final int count, final int mask) {
        return new OnlyWay.Kind(count, mask);
    }

    private static int ways(final List<OnlyWay.Kind> kinds, final int... units) {
        return OnlyWay.ways(kinds, units);
    }

    @Test
    public void oneLandForOnePip() {
        assertEquals(ways(List.of(k(1, R)), R), 1);
    }

    @Test
    public void onlyOneOfTwoColoursPays() {
        // Mountain + Island for {R}: just the Mountain. For {1}{R}: both, the Island on the generic.
        assertEquals(ways(List.of(k(1, U), k(1, R)), R), 1);
        assertEquals(ways(List.of(k(1, U), k(1, R)), ANY, R), 1);
    }

    @Test
    public void identicalLandsAreOneWay() {
        // Three Islands for {U}: whichever Island taps, it's the same payment.
        assertEquals(ways(List.of(k(3, U)), U), 1);
        assertEquals(ways(List.of(k(3, U)), ANY, U), 1);
    }

    @Test
    public void aGenericThatCouldComeFromEitherLandIsAChoice() {
        // Mountain, Mountain, Forest for {1}{R}: Mountain + Mountain or Mountain + Forest.
        assertEquals(ways(List.of(k(2, R), k(1, G)), ANY, R), 2);
        // A dual and a basic for {R}: either one.
        assertEquals(ways(List.of(k(1, R | G), k(1, R)), R), 2);
    }

    @Test
    public void aDualIsForcedWhenTheOtherColourIsTaken() {
        // Stomping Ground + Forest for {R}{G}: the Ground must make R.
        assertEquals(ways(List.of(k(1, R | G), k(1, G)), R, G), 1);
        // Hybrid {R/W} with a Plains and a Mountain: either pays it.
        assertEquals(ways(List.of(k(1, W), k(1, R)), R | W), 2);
    }

    @Test
    public void colorlessPipsNeedColorlessMana() {
        assertEquals(ways(List.of(k(1, C), k(1, U)), C), 1);
        assertEquals(ways(List.of(k(1, U)), C), 0);
    }

    @Test
    public void notEnoughSourcesIsNoWay() {
        assertEquals(ways(List.of(k(1, R)), ANY, R), 0);
        assertEquals(ways(List.of(k(2, U)), R), 0);
    }
}

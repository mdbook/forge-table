package forge.game.spellability;

import static junit.framework.Assert.assertEquals;
import static junit.framework.Assert.assertFalse;
import static junit.framework.Assert.assertTrue;

import org.testng.annotations.Test;

import forge.ai.AITest;
import forge.ai.AvailableActions;
import forge.ai.ComputerUtilAbility;
import forge.game.Game;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

/** A gift spell whose extra target only applies once the gift is promised is castable with no such target around. */
public class GiftCastableTest extends AITest {

    @Test
    public void sazacapsBrewWithNoCreatures() {
        Game game = initAndCreateGame();
        Player p = game.getPlayers().get(1);
        Card brew = addCardToZone("Sazacap's Brew", p, ZoneType.Hand);
        addCardToZone("Mountain", p, ZoneType.Hand); // something to discard
        addCards("Mountain", 3, p);
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, p);

        assertFalse("a spell to cast", brew.getAllPossibleAbilities(p, true).isEmpty());
        assertTrue("fully targetable without a creature",
                brew.getAllPossibleAbilities(p, true).stream().anyMatch(ComputerUtilAbility::isFullyTargetable));
        assertTrue("glows as playable", AvailableActions.collectActionable(p, 5000).contains(brew.getView()));
    }

    /** Checking the promised-gift version (it needs a creature) must not leave the card in hand "promised". */
    @Test
    public void checkingThePromisedVersionLeavesTheCardUnpromised() {
        Game game = initAndCreateGame();
        Player p = game.getPlayers().get(1);
        Card brew = addCardToZone("Sazacap's Brew", p, ZoneType.Hand);
        addCardToZone("Mountain", p, ZoneType.Hand);
        addCards("Mountain", 3, p);
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, p);

        SpellAbility spell = brew.getAllPossibleAbilities(p, true).get(0);
        java.util.List<OptionalCostValue> costs = forge.game.GameActionUtil.getOptionalCostValues(spell);
        assertFalse("gift is an optional cost", costs.isEmpty());
        SpellAbility promised = forge.game.GameActionUtil.addOptionalCosts(spell, costs);
        assertTrue(promised.isGiftPromised());
        promised.canPlay(); // any look at the promised version (SpellAbility.canPlay(true) on a failed base) leaves it as the card's castSA
        assertFalse("promising needs a creature to target", ComputerUtilAbility.isFullyTargetable(promised));

        for (SpellAbility sa : brew.getAllPossibleAbilities(p, true)) {
            assertTrue("the unpromised spell still has all its targets: " + sa, ComputerUtilAbility.isFullyTargetable(sa));
        }
        assertTrue("still glows", AvailableActions.collectActionable(p, 5000).contains(brew.getView()));

        // Brew's X = Count$PromisedGift.1.0 follows the spell being looked at, not the card's castSA
        brew.setCastSA(promised); // the stale state a canPlay check on the promised copy leaves behind
        assertEquals(1, AbilityUtils.calculateAmount(brew, "Count$PromisedGift.1.0", promised));
        assertEquals(0, AbilityUtils.calculateAmount(brew, "Count$PromisedGift.1.0", spell));
    }

    /** A gift permanent's own (non-spell) abilities still read the gift from how the card was cast. */
    @Test
    public void giftPermanentReadsItsCastSA() {
        Game game = initAndCreateGame();
        Player p = game.getPlayers().get(1);
        Card scrap = addCardToZone("Scrapshooter", p, ZoneType.Hand);
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, p);

        SpellAbility spell = scrap.getAllPossibleAbilities(p, true).get(0);
        SpellAbility promised = forge.game.GameActionUtil.addOptionalCosts(spell, forge.game.GameActionUtil.getOptionalCostValues(spell));
        assertTrue(promised.isGiftPromised());
        SpellAbility etb = scrap.getTriggers().iterator().next().ensureAbility();
        assertFalse("the enters trigger is not a spell", etb.getRootAbility().isSpell());

        scrap.setCastSA(promised);
        assertEquals(1, AbilityUtils.calculateAmount(scrap, "Count$PromisedGift.1.0", etb));
        scrap.setCastSA(spell);
        assertEquals(0, AbilityUtils.calculateAmount(scrap, "Count$PromisedGift.1.0", etb));
    }
}

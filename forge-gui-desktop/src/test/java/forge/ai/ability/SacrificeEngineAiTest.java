package forge.ai.ability;

import forge.ai.AITest;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardLists;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import org.testng.AssertJUnit;
import org.testng.annotations.Test;

import java.util.List;

/**
 * The AI runs a sacrifice outlet into creatures that return each other from the graveyard when a payoff
 * fires on every recast, and leaves the outlet alone when nothing does.
 */
public class SacrificeEngineAiTest extends AITest {

    private Player setUpEngine(final Game game, final boolean withPayoff) {
        final Player ai = game.getPlayers().get(1);
        ai.setTeam(0);
        game.getPlayers().get(0).setTeam(1);
        if (withPayoff) {
            addCard("Golem Foundry", ai);
        }
        addCard("Ashnod's Altar", ai);
        addCards("Myr Retriever", 2, ai);
        fillLibrary(ai, 10);
        fillLibrary(game.getPlayers().get(0), 10);
        moveToMain2(game, ai);
        return ai;
    }

    private int altarActivations(final Game game) {
        final SpellAbility sac = findCardWithName(game, "Ashnod's Altar").getManaAbilities().getFirst();
        return sac.getActivationsThisTurn();
    }

    @Test
    public void theAiSpinsRetrieversThroughAnAltarToBuildAGolem() {
        final Game game = initAndCreateGame();
        final Player ai = setUpEngine(game, true);

        playUntilPhase(game, PhaseType.END_OF_TURN);

        AssertJUnit.assertTrue("the AI should sacrifice at least 3 times, did " + altarActivations(game),
                altarActivations(game) >= 3);
        final List<Card> golems = CardLists.getType(ai.getCreaturesInPlay(), "Golem");
        AssertJUnit.assertFalse("the AI should make a Golem\n" + gameStateToString(game), golems.isEmpty());
    }

    @Test
    public void theAiKeepsItsRetrieversWhenNothingPaysOff() {
        final Game game = initAndCreateGame();
        setUpEngine(game, false);

        playUntilPhase(game, PhaseType.END_OF_TURN);

        AssertJUnit.assertEquals("the AI should not sacrifice for nothing", 0, altarActivations(game));
        AssertJUnit.assertEquals(2, countCardsWithName(game, "Myr Retriever", ZoneType.Battlefield));
    }
}

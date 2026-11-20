package forge.ai.ability;

import forge.ai.*;
import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.card.mana.ManaCost;
import forge.game.CardTraitPredicates;
import forge.game.ability.AbilityUtils;
import forge.game.ability.ApiType;
import forge.game.card.*;
import forge.game.cost.Cost;
import forge.game.cost.CostRemoveCounter;
import forge.game.cost.CostSacrifice;
import forge.game.keyword.Keyword;
import forge.game.mana.Mana;
import forge.game.mana.ManaPool;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.PlayerCollection;
import forge.game.player.PlayerPredicates;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.Trigger;
import forge.game.trigger.TriggerType;
import forge.game.zone.ZoneType;
import forge.util.Aggregates;
import forge.util.IterableUtil;

import java.util.Arrays;
import java.util.List;

public class ManaAi extends SpellAbilityAi {

    /*
     * (non-Javadoc)
     * 
     * @see forge.ai.SpellAbilityAi#checkAiLogic(forge.game.player.Player,
     * forge.game.spellability.SpellAbility, java.lang.String)
     */
    @Override
    protected boolean checkAiLogic(Player ai, SpellAbility sa, String aiLogic) {
        if (aiLogic.startsWith("ManaRitual") || aiLogic.startsWith("BlackLotus")) {
            return doManaRitualLogic(ai, sa, false);
        } else if ("Always".equals(aiLogic)) {
            return true;
        }
        return super.checkAiLogic(ai, sa, aiLogic);
    }

    /*
     * (non-Javadoc)
     * 
     * @see
     * forge.ai.SpellAbilityAi#checkPhaseRestrictions(forge.game.player.Player,
     * forge.game.spellability.SpellAbility, forge.game.phase.PhaseHandler)
     */
    @Override
    protected boolean checkPhaseRestrictions(Player ai, SpellAbility sa, PhaseHandler ph) {
        if (improvesPosition(ai, sa)) {
            return true;
        }
        if (!ph.is(PhaseType.MAIN2)) {
            return false;
        }
        return super.checkPhaseRestrictions(ai, sa, ph);
    }

    /*
     * (non-Javadoc)
     * 
     * @see
     * forge.ai.SpellAbilityAi#checkPhaseRestrictions(forge.game.player.Player,
     * forge.game.spellability.SpellAbility, forge.game.phase.PhaseHandler,
     * java.lang.String)
     */
    @Override
    protected boolean checkPhaseRestrictions(Player ai, SpellAbility sa, PhaseHandler ph, String logic) {
        if (logic.startsWith("ManaRitual")) {
             return ph.is(PhaseType.MAIN2, ai) || ph.is(PhaseType.MAIN1, ai);
        }
        if ("AtOppEOT".equals(logic)) {
            return ph.is(PhaseType.END_OF_TURN) && ph.getNextTurn() == ai
                    && (!ai.getManaPool().hasBurn() || !ai.canLoseLife() || ai.cantLoseForZeroOrLessLife());
        }
        return super.checkPhaseRestrictions(ai, sa, ph, logic);
    }

    /*
     * (non-Javadoc)
     * 
     * @see forge.ai.SpellAbilityAi#checkApiLogic(forge.game.player.Player,
     * forge.game.spellability.SpellAbility)
     */
    @Override
    protected AiAbilityDecision checkApiLogic(Player ai, SpellAbility sa) {
        if (sa.hasParam("AILogic")) {
            return new AiAbilityDecision(100, AiPlayDecision.WillPlay); // handled elsewhere, does not meet the standard requirements
        }

        // TODO check if it would be worth it to keep mana open for opponents turn anyway
        if (ComputerUtil.activateForCost(sa, ai)) {
            return new AiAbilityDecision(100, AiPlayDecision.WillPlay);
        }

        // the cast and the trigger need sorcery timing, and the cap stops an engine that never runs dry
        if (ai.canCastSorcery() && sa.getActivationsThisTurn() < MAX_ENGINE_SPINS_PER_TURN
                && chooseEngineFodder(ai, sa) != null) {
            return new AiAbilityDecision(100, AiPlayDecision.WillPlay);
        }

        if (sa.getPayCosts().hasNoManaCost() && sa.getPayCosts().isReusuableResource()
                && sa.getSubAbility() == null && (improvesPosition(ai, sa) || ComputerUtil.playImmediately(ai, sa))) {
            return new AiAbilityDecision(100, AiPlayDecision.WillPlay);
        }

        return new AiAbilityDecision(0, AiPlayDecision.CantPlayAi);
    }

    /**
     * @param aiPlayer
     *            the AI player.
     * @param sa
     *            a {@link forge.game.spellability.SpellAbility} object.
     * @param mandatory
     *            a boolean.
     * 
     * @return a boolean.
     */
    @Override
    protected AiAbilityDecision doTriggerNoCost(Player aiPlayer, SpellAbility sa, boolean mandatory) {
        final String logic = sa.getParamOrDefault("AILogic", "");
        if (logic.startsWith("ManaRitual")) {
            boolean result = doManaRitualLogic(aiPlayer, sa, true);
            return result ? new AiAbilityDecision(100, AiPlayDecision.WillPlay) : new AiAbilityDecision(0, AiPlayDecision.CantPlayAi);
        }

        return new AiAbilityDecision(100, AiPlayDecision.WillPlay);
    }
    
    // Dark Ritual and other similar instants/sorceries that add mana to mana pool
    public static boolean doManaRitualLogic(Player ai, SpellAbility sa, boolean fromTrigger) {
        final Card host = sa.getHostCard();
        final String logic = sa.getParamOrDefault("AILogic", "");

        if (sa.usesTargeting()) { // Rousing Refrain
            PlayerCollection targetableOpps = ai.getOpponents().filter(PlayerPredicates.isTargetableBy(sa));
            if (targetableOpps.isEmpty()) {
                return false;
            }
            Player mostCards = targetableOpps.max(PlayerPredicates.compareByZoneSize(ZoneType.Hand));
            sa.resetTargets();
            sa.getTargets().add(mostCards);
            if (fromTrigger) {
                return true;
            }
        }

        CardCollection manaSources = ComputerUtilMana.getAvailableManaSources(ai, true);
        int numManaSrcs = manaSources.size();
        if (manaSources.contains(host) && ComputerUtilCost.isSacrificeSelfCost(sa.getRootAbility().getPayCosts())) {
            numManaSrcs--;
        }
        int manaReceived = sa.hasParam("Amount") ? AbilityUtils.calculateAmount(host, sa.getParam("Amount"), sa) : 1;
        manaReceived *= sa.getParam("Produced").split(" ").length;

        int selfCost = sa.getRootAbility().getPayCosts().getCostMana() != null ? sa.getRootAbility().getPayCosts().getCostMana().getMana().getCMC() : 0;

        String produced = sa.getParam("Produced");
        byte producedColor = produced.equals("Any") ? MagicColor.ALL_COLORS : MagicColor.fromName(produced);

        int numCounters = 0;
        int manaSurplus = 0;
        if ("Count$xPaid".equals(host.getSVar("X")) && sa.getPayCosts().hasSpecificCostType(CostRemoveCounter.class)) {
            CounterType ctrType = sa.getPayCosts().getCostPartByType(CostRemoveCounter.class).counter;
            numCounters = host.getCounters(ctrType);
            manaReceived = numCounters;
            if (logic.startsWith("ManaRitualBattery.")) {
                manaSurplus = Integer.parseInt(logic.substring(18)); // adds an extra mana even if no counters removed
                manaReceived += manaSurplus;
            }
        }

        int searchCMC = numManaSrcs - selfCost + manaReceived;

        if ("X".equals(sa.getParam("Produced"))) {
            String x = host.getSVar("X");
            if ("Count$CardsInYourHand".equals(x) && host.isInZone(ZoneType.Hand)) {
                searchCMC--; // the spell in hand will be used
            } else if (x.startsWith("Count$ValidGraveyard Card.named") && host.isInZone(ZoneType.Graveyard)) {
                searchCMC--; // the spell in graveyard will be used
            }
        }

        if (searchCMC <= 0) {
            return false;
        }

        String restrictValid = sa.getParamOrDefault("RestrictValid", "Card");

        CardCollection cardList = new CardCollection();
        // TODO check other zones
        List<SpellAbility> all = ComputerUtilAbility.getSpellAbilities(ai.getCardsIn(ZoneType.Hand), ai);
        final List<SpellAbility> testable = ComputerUtilAbility.getOriginalAndAltCostAbilities(all, ai);
        // the same untapped sources answer this for every ability in hand, and nothing in the loop
        // taps or adds one, so ask once - and not at all when there is nothing to ask about
        final byte availableColors = testable.isEmpty() ? 0 : ColorSet.fromNames(
                ComputerUtilCost.getAvailableManaColors(ai, (List<Card>)null)).getColor();
        for (final SpellAbility testSa : testable) {
            ManaCost cost = testSa.getPayCosts().getTotalMana();
            boolean canPayWithAvailableColors = cost.canBePaidWithAvailable(availableColors);

            if (cost.getCMC() == 0 && cost.countX() == 0) {
                // no mana cost, no need to activate this SA then (additional mana not needed)
                continue;
            } else if (cost.getColorProfile() != 0 && !canPayWithAvailableColors) {
                // don't have one of each shard represented, may not be able to pay the cost
                continue;
            }

            if (ComputerUtilAbility.getAbilitySourceName(testSa).equals(ComputerUtilAbility.getAbilitySourceName(sa))
                    || testSa.hasParam("AINoRecursiveCheck")) {
                // prevent infinitely recursing mana ritual and other abilities with reentry
                continue;
            }

            SpellAbility testSaNoCost = testSa.copyWithNoManaCost();
            if (testSaNoCost == null) {
                continue;
            }
            testSaNoCost.setActivatingPlayer(ai);
            if (((PlayerControllerAi)ai.getController()).getAi().canPlaySa(testSaNoCost) == AiPlayDecision.WillPlay) {
                if (testSa.getHostCard().isPermanent() && !testSa.getHostCard().hasKeyword(Keyword.HASTE)
                    && !ai.getGame().getPhaseHandler().is(PhaseType.MAIN2)) {
                    // AI will waste a ritual in Main 1 unless the casted permanent is a haste creature
                    continue;
                }
                if (testSa.getHostCard().isInstant()) {
                    // AI is bad at choosing which instants are worth a Ritual
                    continue;
                }

                // the AI is willing to play the spell
                if (!cardList.contains(testSa.getHostCard())) {
                    cardList.add(testSa.getHostCard());
                }
            }
        }

        CardCollection castableSpells = CardLists.filter(cardList,
                Arrays.asList(
                        CardPredicates.restriction(restrictValid.split(","), ai, host, sa),
                        CardPredicates.lessCMC(searchCMC),
                        CardPredicates.isColorless().or(CardPredicates.isColor(producedColor))));

        if (logic.startsWith("ManaRitualBattery")) {
            // Don't remove more counters than would be needed to cast the more expensive thing we want to cast,
            // otherwise the AI grabs too many counters at once.
            int maxCtrs = Aggregates.max(castableSpells, Card::getCMC) - manaSurplus;
            sa.setXManaCostPaid(Math.min(numCounters, maxCtrs));
        }

        // TODO: this will probably still waste the card from time to time. Somehow improve detection of castable material.
        return castableSpells.size() > 0;
    }

    @Override
    protected boolean willPayCosts(final Player payer, final SpellAbility sa, final Cost cost, final Card source) {
        // an engine creature comes back, so losing it is not the cost the generic check takes it for
        return chooseEngineFodder(payer, sa) != null || super.willPayCosts(payer, sa, cost, source);
    }

    // forge-table: sacrifice-and-recursion engines; written to go upstream as is
    /** Laps of a sacrifice engine per outlet ability per turn; ComputerUtil.preventRunAwayActivations starts at 10 too. */
    private static final int MAX_ENGINE_SPINS_PER_TURN = 10;

    /**
     * Finds the creature to feed a sacrifice-for-mana ability when that keeps a recursion engine running, or null.
     * One lap: the creature dies and its own trigger returns a card from the graveyard to hand, the outlet's mana
     * recasts that card, and a payoff triggers on the cast, the card entering or the creature dying (Ashnod's Altar,
     * Myr Retriever and Golem Foundry). Read from abilities, so any engine of that shape qualifies.
     * Timing is left to the caller so cost payment can ask the same question mid-activation.
     */
    public static Card chooseEngineFodder(final Player ai, final SpellAbility sa) {
        final Cost cost = sa.getPayCosts();
        // ponytail: only outlets whose whole cost is one sacrifice (Ashnod's / Phyrexian Altar); extend when an
        // engine needs life or tapping too, and then check those parts as willPayCosts does
        if (!sa.isManaAbility() || cost == null || cost.getCostParts().size() != 1
                || !(cost.getCostParts().get(0) instanceof CostSacrifice sac)
                || sac.payCostFromSource() || sac.getAbilityAmount(sa) != 1) {
            return null;
        }
        final int produced = sa.amountOfManaGenerated(true);
        if (produced <= 0) {
            return null;
        }
        final Card outlet = sa.getHostCard();
        final CardCollection fodder = CardLists.filter(
                CardLists.getValidCards(ai.getCardsIn(ZoneType.Battlefield), sac.getType().split(";"), ai, outlet, sa),
                CardPredicates.CREATURES, CardPredicates.canBeSacrificedBy(sa, false));
        final byte colors = producedColors(sa);
        for (final Card dying : fodder) {
            final Trigger recursion = recursionTrigger(dying);
            if (recursion == null) {
                continue;
            }
            final SpellAbility returns = recursion.ensureAbility();
            for (final Card back : CardLists.getValidCards(ai.getCardsIn(ZoneType.Graveyard),
                    returns.getTargetRestrictions().getValidTgts(), ai, dying, returns)) {
                if (lapPaysOff(ai, dying, recursion, back, produced, colors) && (dying.hasSVar("SacMe")
                        || back.isCreature() && ComputerUtilCard.evaluateCreature(back) >= ComputerUtilCard.evaluateCreature(dying))) {
                    return dying;
                }
            }
            // nothing to return yet: worth priming when another engine creature brings this one back next lap
            if (!dying.hasSVar("SacMe")) {
                continue;
            }
            for (final Card next : fodder) {
                final Trigger nextRecursion = next == dying ? null : recursionTrigger(next);
                if (nextRecursion != null
                        && dying.isValid(nextRecursion.ensureAbility().getTargetRestrictions().getValidTgts(), ai, next, nextRecursion.ensureAbility())
                        && lapPaysOff(ai, next, nextRecursion, dying, produced, colors)) {
                    return dying;
                }
            }
        }
        return null;
    }

    /** The creature's own dies trigger that returns a targeted card from the graveyard to hand, or null. */
    private static Trigger recursionTrigger(final Card creature) {
        for (final Trigger t : creature.getTriggers()) {
            if (t.getMode() != TriggerType.ChangesZone || !zoneParamIncludes(t, "Origin", "Battlefield")
                    || !zoneParamIncludes(t, "Destination", "Graveyard") || !t.matchesValidParam("ValidCard", creature)) {
                continue;
            }
            final SpellAbility effect = t.ensureAbility();
            if (effect != null && effect.getApi() == ApiType.ChangeZone && effect.usesTargeting()
                    && "Graveyard".equals(effect.getParam("Origin")) && "Hand".equals(effect.getParam("Destination"))) {
                return t;
            }
        }
        return null;
    }

    /** Whether the returned card can be recast from the outlet's mana alone and something pays off on the lap. */
    private static boolean lapPaysOff(final Player ai, final Card dying, final Trigger recursion, final Card back,
            final int produced, final byte colors) {
        final ManaCost cost = back.getManaCost();
        if (back == dying || back.isLand() || back.getSpells().isEmpty() || cost.countX() > 0
                || cost.getCMC() > produced || !cost.canBePaidWithAvailable(colors)) {
            return false;
        }
        final CardCollection watchers = new CardCollection(ai.getCardsIn(ZoneType.Battlefield));
        watchers.add(back);
        for (final Card c : watchers) {
            for (final Trigger t : c.getTriggers()) {
                if (t == recursion) {
                    continue;
                }
                final boolean fires = switch (t.getMode()) {
                    case SpellCast, SpellCastOrCopy -> c != back && t.matchesValidParam("ValidCard", back)
                            && t.matchesValidParam("ValidActivatingPlayer", ai);
                    case ChangesZone -> zoneParamIncludes(t, "Destination", "Battlefield")
                            ? back.isPermanent() && zoneParamIncludes(t, "Origin", "Stack") && t.matchesValidParam("ValidCard", back)
                            : c != back && zoneParamIncludes(t, "Origin", "Battlefield")
                                    && zoneParamIncludes(t, "Destination", "Graveyard") && t.matchesValidParam("ValidCard", dying);
                    default -> false;
                };
                if (fires) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean zoneParamIncludes(final Trigger t, final String param, final String zone) {
        if (!t.hasParam(param) || "Any".equals(t.getParam(param))) {
            return true;
        }
        return Arrays.asList(t.getParam(param).split(",")).contains(zone);
    }

    private static byte producedColors(final SpellAbility sa) {
        byte colors = 0;
        for (final AbilityManaPart part : sa.getAllManaParts()) {
            if (part.isAnyMana()) {
                return MagicColor.ALL_COLORS;
            }
            for (final String mana : part.mana(sa).split(" ")) {
                colors |= MagicColor.fromName(mana);
            }
        }
        return colors;
    }

    private boolean improvesPosition(Player ai, SpellAbility sa) {
        boolean activateForTrigger = (!ai.getManaPool().hasBurn() || !ai.canLoseLife() || ai.cantLoseForZeroOrLessLife()) &&
                IterableUtil.any(IterableUtil.filter(sa.getHostCard().getTriggers(), CardTraitPredicates.hasParam("AILogic", "ActivateOnce")),
                t -> sa.getHostCard().getAbilityActivatedThisTurn(t.getOverridingAbility()) == 0);

        PhaseHandler ph = ai.getGame().getPhaseHandler();
        // TODO if threatened use right away
        return ph.is(PhaseType.END_OF_TURN) && (ph.getNextTurn() == ai || ComputerUtilCard.willUntap(ai, sa.getHostCard()))
                && (activateForTrigger || canRampPool(ai, sa.getHostCard()));   
    }

    public static boolean canRampPool(Player ai, Card source) {
        ManaPool mp = ai.getManaPool();
        Mana test = null;
        if (mp.isEmpty()) {
            // TODO use color from ability
            test = new Mana((byte) ManaAtom.COLORLESS, source, null, ai);
            mp.addManaNoEvent(test);
        }
        boolean lose = mp.willManaBeLostAtEndOfPhase();
        if (test != null) {
            mp.removeManaNoEvent(test);
        }
        return !lose;
    }
}

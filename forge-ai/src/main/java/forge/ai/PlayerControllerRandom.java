package forge.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.util.MyRandom;

/**
 * Probe controller: a uniformly random legal-action policy layered on top of
 * PlayerControllerAi. It owns the four hot decisions (priority, attackers,
 * blockers, mulligan) and inherits everything else (targets, mana payment,
 * cost decisions, modes, confirmations) from the stock AI.
 *
 * Purpose: measure the rules-engine cost floor with the AI's decision logic
 * removed from the priority/combat path, for a like-for-like comparison with
 * the XMage random-policy probe. Not a playable AI.
 *
 * System properties:
 *   forge.random.pipeline = psa (default) | ai
 *       psa: forge.game.player.PlaySpellAbility.playSpellAbility(this, player, sa)
 *       ai:  ComputerUtil.handlePlayingSpellAbility (the inherited AI path)
 *   forge.random.passEmpty = 0.3   probability of passing when the stack is empty
 *   forge.random.passStack = 0.3   probability of passing when the stack is non-empty
 *   forge.random.maxActions = 8    cap on non-pass actions per priority window
 */
public class PlayerControllerRandom extends PlayerControllerAi {

    public static final String PIPELINE = System.getProperty("forge.random.pipeline", "psa");
    private static final double PASS_P_EMPTY = Double.parseDouble(System.getProperty("forge.random.passEmpty", "0.3"));
    private static final double PASS_P_STACK = Double.parseDouble(System.getProperty("forge.random.passStack", "0.3"));
    private static final int MAX_ACTIONS_PER_WINDOW = Integer.parseInt(System.getProperty("forge.random.maxActions", "8"));

    // per-game counters (one controller instance per player per game)
    private int priorityDecisions = 0;   // calls to chooseSpellAbilityToPlay
    private int nonPassActions = 0;      // times we returned an SA
    private int landPlays = 0;
    private int spellsPlayed = 0;        // playChosenSpellAbility succeeded (non-land)
    private int playFailures = 0;        // playChosenSpellAbility returned false (non-land)
    private int attackDecisions = 0;
    private int attackFallbacks = 0;     // random subset failed validation, fell back
    private int blockDecisions = 0;
    private int blockFallbacks = 0;
    private int enumerations = 0;        // calls to enumerateLegal (priority calls that did not roll a pass)
    private int legalActionsSum = 0;     // sum of legal-list sizes, for the mean branching factor
    private long enumerateNanos = 0;     // wall time spent inside enumerateLegal()

    private int actionsThisWindow = 0;

    public PlayerControllerRandom(Game game, Player p, LobbyPlayer lp) {
        super(game, p, lp);
    }

    private static Random rnd() {
        return MyRandom.getRandom();
    }

    // ---------------------------------------------------------------- priority

    /**
     * Legal-action enumeration per code-forge-controller.md section 5.2, using
     * forge-game predicates only (never AiController.canPlaySa, which is the
     * AI's willingness, not rules legality).
     */
    private List<SpellAbility> enumerateLegal() {
        final Game game = getGame();
        final List<SpellAbility> legal = new ArrayList<>();

        // land drops (helper returns null when the stack is non-empty or not in a main phase)
        CardCollection lands = ComputerUtilAbility.getAvailableLandsToPlay(game, player);
        if (lands != null) {
            for (Card land : lands) {
                for (SpellAbility sa : land.getAllPossibleAbilities(player, true)) {
                    if (sa.isLandAbility()) {
                        legal.add(sa);
                    }
                }
            }
        }

        // spells and non-mana activated abilities
        CardCollection cards = ComputerUtilCard.dedupeCards(ComputerUtilAbility.getAvailableCards(game, player));
        List<SpellAbility> all = ComputerUtilAbility.getSpellAbilities(cards, player);
        all.removeIf(sa -> sa.isLandAbility() || sa.isManaAbility());
        for (SpellAbility sa : ComputerUtilAbility.getOriginalAndAltCostAbilities(all, player)) {
            if (sa.isLandAbility() || sa.isManaAbility() || sa.isSkip()) {
                continue;
            }
            sa.setActivatingPlayer(player);
            if (!sa.canPlay()) {
                continue;
            }
            if (!sa.canCastTiming(player)) {
                continue;
            }
            if (!sa.checkRestrictions(player)) {
                continue;
            }
            if (!sa.isLegalAfterStack()) {
                continue;
            }
            if (!ComputerUtilAbility.isFullyTargetable(sa)) {
                continue;
            }
            if (!ComputerUtilCost.canPayCost(sa, player, false)) {
                continue;
            }
            legal.add(sa);
        }
        return legal;
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        priorityDecisions++;
        // AiCache is a static, cross-game cache keyed by Card that the stock AI clears at every priority
        // call (AiController.chooseSpellAbilityToPlay). The inherited mana/cost/evaluation code still
        // fills it; without this clear, whole games are retained (measured: +420 Card objects per game,
        // 1.9 GB RSS and +40% ms/turn after 100 games in one JVM).
        AiCache.clear();
        final Game game = getGame();

        if (actionsThisWindow >= MAX_ACTIONS_PER_WINDOW) {
            actionsThisWindow = 0;
            return null;
        }

        final boolean stackEmpty = game.getStack().isEmpty();
        final double passP = stackEmpty ? PASS_P_EMPTY : PASS_P_STACK;
        if (rnd().nextDouble() < passP) {
            actionsThisWindow = 0;
            return null;
        }

        final long t0 = System.nanoTime();
        final List<SpellAbility> legal = enumerateLegal();
        enumerateNanos += System.nanoTime() - t0;
        enumerations++;
        legalActionsSum += legal.size();

        if (legal.isEmpty()) {
            actionsThisWindow = 0;
            return null;
        }

        final SpellAbility pick = legal.get(rnd().nextInt(legal.size()));
        nonPassActions++;
        actionsThisWindow++;
        final List<SpellAbility> out = new ArrayList<>(1);
        out.add(pick);
        return out;
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (sa.isLandAbility()) {
            if (sa.canPlay()) {
                sa.resolve();
                landPlays++;
            }
            return true;
        }
        // stale targets may have been assigned by a probing pass; the pipeline re-chooses them
        sa.resetTargets();
        boolean ok;
        if ("ai".equals(PIPELINE)) {
            ok = super.playChosenSpellAbility(sa);
        } else {
            ok = PlaySpellAbility.playSpellAbility(this, player, sa);
        }
        if (ok) {
            spellsPlayed++;
        } else {
            playFailures++;
            sa.setSkip(true); // do not re-enumerate a spell the pipeline refuses this window
        }
        return ok;
    }

    // ---------------------------------------------------------------- combat

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        attackDecisions++;
        combat.clearAttackers();

        // single defender in 1v1 Pauper: the opponent player (fall back to any defender)
        GameEntity defender = null;
        for (GameEntity d : combat.getDefenders()) {
            if (d instanceof Player) {
                defender = d;
                break;
            }
        }
        if (defender == null && !combat.getDefenders().isEmpty()) {
            defender = combat.getDefenders().get(0);
        }
        if (defender == null) {
            return;
        }

        final Random r = rnd();
        for (Card c : attacker.getCreaturesInPlay()) {
            if (!CombatUtil.canAttack(c, defender)) {
                continue;
            }
            if (r.nextBoolean()) {
                combat.addAttacker(c, defender);
            }
        }

        if (!CombatUtil.validateAttackers(combat)) {
            attackFallbacks++;
            combat.clearAttackers();
            final Map<Card, GameEntity> legal = combat.getAttackConstraints().getLegalAttackers().getLeft();
            for (Map.Entry<Card, GameEntity> e : legal.entrySet()) {
                combat.addAttacker(e.getKey(), e.getValue());
            }
            if (!CombatUtil.validateAttackers(combat)) {
                combat.clearAttackers();
                super.declareAttackers(attacker, combat);
            }
        }
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        blockDecisions++;
        final Random r = rnd();
        final CardCollection attackers = combat.getAttackers();

        for (Card blocker : defender.getCreaturesInPlay()) {
            if (!CombatUtil.canBlock(blocker, combat)) {
                continue;
            }
            final List<Card> legal = new ArrayList<>();
            for (Card a : attackers) {
                if (CombatUtil.canBlock(a, blocker, combat)) {
                    legal.add(a);
                }
            }
            if (legal.isEmpty()) {
                continue;
            }
            final int k = r.nextInt(legal.size() + 1); // index == size means "do not block"
            if (k < legal.size()) {
                combat.addBlocker(legal.get(k), blocker);
            }
        }

        final String err = CombatUtil.validateBlocks(combat, defender);
        if (err != null) {
            blockFallbacks++;
            for (Card b : new CardCollection(combat.getAllBlockers())) {
                if (b.getController().equals(defender)) {
                    combat.removeFromCombat(b);
                }
            }
            super.declareBlockers(defender, combat);
        }
    }

    // ---------------------------------------------------------------- mulligan

    @Override
    public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
        return true;
    }

    // ---------------------------------------------------------------- stats

    public String statsLine() {
        return String.format(
                "RandomStats: %s priority=%d nonpass=%d lands=%d spells=%d failed=%d attacks=%d(fb %d) blocks=%d(fb %d) meanLegal=%.2f enumMs=%.1f enums=%d pipeline=%s",
                player.getName(), priorityDecisions, nonPassActions, landPlays, spellsPlayed, playFailures,
                attackDecisions, attackFallbacks, blockDecisions, blockFallbacks,
                enumerations == 0 ? 0.0 : (double) legalActionsSum / enumerations,
                enumerateNanos / 1e6, enumerations, PIPELINE);
    }

    public int getPriorityDecisions() { return priorityDecisions; }
    public int getSpellsPlayed() { return spellsPlayed; }
    public int getPlayFailures() { return playFailures; }
}

package forge.ai;

import forge.card.MagicColor;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardLists;
import forge.game.card.CardView;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import org.tinylog.Logger;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.Collectors;

// Heuristic: does the player have any playable action this priority window?
// Bounded by timeoutMs; FP-safe on expiry — unvisited cards are marked actionable.
public final class AvailableActions {

    private AvailableActions() {}

    /**
     * Cards a human snoozed (Forge Table: "this doesn't count as something to do"), per game and player id, by card id.
     * Per player, not per game: in a game between two people each one's snoozes are their own. (Keyed by the Game, whose
     * equality is identity; a Player equals any other with its id, so a later game would inherit its snoozes.)
     */
    private static final Map<Game, Map<Integer, Set<Integer>>> SNOOZED = Collections.synchronizedMap(new WeakHashMap<>());

    /** Snoozed cards never count as available actions (so auto-pass-if-no-actions passes over them). */
    public static void setSnoozed(final Player player, final Set<Integer> cardIds) {
        SNOOZED.computeIfAbsent(player.getGame(), g -> new java.util.concurrent.ConcurrentHashMap<>()).put(player.getId(), Set.copyOf(cardIds));
    }

    /** sortByCmc: cheap-cost-first so early-exit hits faster.
     *  Battlefield isn't sorted: activation costs are per-ability, not the permanent's CMC. */
    private record ZoneScan(ZoneType zone, boolean sortByCmc) {}

    private static final List<ZoneScan> SCANS = List.of(
            new ZoneScan(ZoneType.Hand,        true),
            new ZoneScan(ZoneType.Battlefield, false),
            new ZoneScan(ZoneType.Flashback,   true));

    /** Boolean form: early-exits on the first actionable card. */
    public static boolean compute(Player player, long timeoutMs) {
        return withAiController(player, () -> !walk(player, timeoutMs, true).isEmpty());
    }

    /** Set form: walks every card so highlight consumers can mark the actionable subset. */
    public static Set<CardView> collectActionable(Player player, long timeoutMs) {
        return withAiController(player, () -> walk(player, timeoutMs, false));
    }

    /** Run the predictive sweep under an AI controller so cost-adjustment chooseX
     *  dispatches don't prompt (mirrors InputPayMana auto-pay). */
    private static <T> T withAiController(Player player, Supplier<T> body) {
        AtomicReference<T> result = new AtomicReference<>();
        player.runWithController(
                () -> result.set(body.get()),
                new PlayerControllerAi(player.getGame(), player, player.getOriginalLobbyPlayer()));
        return result.get();
    }

    private static Set<CardView> walk(Player player, long timeoutMs, boolean earlyExit) {
        long deadlineNanos = System.nanoTime() + timeoutMs * 1_000_000L;
        Set<CardView> actionable = new HashSet<>();
        Set<CardView> visited = new HashSet<>();
        final Set<Integer> snoozed = SNOOZED.getOrDefault(player.getGame(), Map.of()).getOrDefault(player.getId(), Set.of());

        for (ZoneScan scan : SCANS) {
            Iterable<Card> cards = scan.sortByCmc()
                    ? sortedCardsIn(player, scan.zone())
                    : player.getCardsIn(scan.zone());
            for (Card card : cards) {
                if (checkTimeout(deadlineNanos, timeoutMs)) {
                    addUnvisited(actionable, visited, player);
                    return actionable;
                }
                CardView cv = card.getView();
                visited.add(cv);
                if (snoozed.contains(card.getId())) {
                    continue;
                }
                if (cardHasActionable(card, player)) {
                    actionable.add(cv);
                    if (earlyExit) return actionable;
                }
            }
        }
        return actionable;
    }

    // Land plays come through with no cost, no targets; spells and activated abilities (incl.
    // hand-activations like Channel) all hit the same shape: not a mana ability, affordable, targetable.
    private static boolean cardHasActionable(Card card, Player player) {
        for (SpellAbility sa : card.getAllPossibleAbilities(player, true)) {
            if (!sa.isManaAbility() && canAfford(sa, player)
                    && ComputerUtilAbility.isFullyTargetable(sa)) {
                return true;
            }
        }
        return false;
    }

    /** Timeout fallback: mark only the cards we never got to evaluate (FP-safe).
     *  Cards we visited and ruled out keep their determination. */
    private static void addUnvisited(Set<CardView> actionable, Set<CardView> visited, Player player) {
        for (ZoneScan scan : SCANS) {
            for (Card c : player.getCardsIn(scan.zone())) {
                CardView cv = c.getView();
                if (!visited.contains(cv)) actionable.add(cv);
            }
        }
    }

    // Sort cheap cards first so cheap-to-validate matches early-exit
    private static Iterable<Card> sortedCardsIn(Player player, ZoneType zone) {
        return player.getCardsIn(zone).stream().sorted(CardLists.CmcComparator).collect(Collectors.toList());
    }

    private static boolean canAfford(SpellAbility sa, Player player) {
        if (sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()) {
            return true;
        }
        return ComputerUtilMana.canPayManaCost(sa, player, 0, false) || canAffordThroughFilters(sa, player);
    }

    /**
     * The AI's payment check never uses a mana ability that itself costs mana (ComputerUtilMana.getAIPlayableMana), so
     * a filter like Giant's Boulder ({1},{T}: one mana of any color) never fixes a color. Each usable filter turns one
     * mana into one of a color it can make: retry with that many of the cost's colored shards made generic. Leans
     * toward "playable", as the rest of this heuristic does.
     */
    private static boolean canAffordThroughFilters(SpellAbility sa, Player player) {
        List<Byte> filters = new java.util.ArrayList<>();
        for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
            if (c.equals(sa.getHostCard())) {
                continue;
            }
            for (SpellAbility ma : c.getManaAbilities()) {
                if (ma.getPayCosts() == null || !ma.getPayCosts().hasManaCost() || ma.getManaPart() == null) {
                    continue;
                }
                ma.setActivatingPlayer(player);
                if ((ma.getPayCosts().hasTapCost() && c.isTapped()) || !ma.canPlay()) {
                    continue;
                }
                byte colors = 0;
                for (byte color : MagicColor.WUBRG) {
                    if (ma.getManaPart().canProduce(MagicColor.toShortString(color), ma)) {
                        colors |= color;
                    }
                }
                if (colors != 0) {
                    filters.add(colors);
                }
                break; // one activation per permanent: they share the tap
            }
        }
        if (filters.isEmpty()) {
            return false;
        }
        ManaCostBeingPaid cost = ComputerUtilMana.calculateManaCost(sa.getPayCosts(), sa, player, true, 0, false);
        boolean relaxed = false;
        for (byte colors : filters) {
            for (ManaCostShard shard : cost.getUnpaidShards()) {
                if (shard != ManaCostShard.COLORED_X && (shard.getColorMask() & colors) != 0) {
                    cost.decreaseShard(shard, 1);
                    cost.increaseGenericMana(1);
                    relaxed = true;
                    break;
                }
            }
        }
        return relaxed && ComputerUtilMana.canPayManaCost(cost, sa, player, false);
    }

    private static boolean checkTimeout(long deadlineNanos, long timeoutMs) {
        if (System.nanoTime() < deadlineNanos) {
            return false;
        }
        Logger.warn("AvailableActions: heuristic timed out after {}ms; returning true.", timeoutMs);
        return true;
    }
}

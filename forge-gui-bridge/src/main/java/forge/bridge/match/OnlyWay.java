package forge.bridge.match;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.commons.lang3.StringUtils;

import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.GameActionUtil;
import forge.game.card.Card;
import forge.game.cost.CostTap;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.Player;
import forge.game.replacement.ReplacementEffect;
import forge.game.replacement.ReplacementType;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.SpellAbility;
import forge.game.staticability.StaticAbility;
import forge.game.staticability.StaticAbilityMode;
import forge.game.trigger.Trigger;
import forge.game.trigger.TriggerType;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputPayManaOfCostPayment;

/**
 * The payMana prompt's {@code unambiguous} hint ("where there's no other possible way to do the mana, auto-pay
 * autocompletes"): true when exactly one set of permanents can pay what's left of the cost, so Auto can only tap
 * those and a client may answer the prompt for the player.
 *
 * <p>The check is deliberately narrow: a false "ambiguous" just shows the prompt, a false "unambiguous" taps lands
 * the player wanted to keep. It models only <em>simple</em> sources: a mana ability whose whole cost is {T}, that
 * makes exactly one mana with no restriction or rider (no "spend only on", no "can't be countered", no counters or
 * keywords, no tap trigger on the card). Anything else that could help pay (a Treasure, a painland's coloured
 * ability, Sol Ring, a filter land, a Spirit Guide in hand) means there's a choice. So does anything about the cost
 * a player decides: floating mana, X, Phyrexian or life-for-black, snow, {2/W} hybrids, a spell that cares which
 * colours were spent (sunburst, converge, adamant), and anything on the table that changes what tapping makes
 * (Mana Reflection, Manabarbs) or what mana can pay for (ManaConvert statics).
 *
 * <p>With only simple sources, each taps for one mana, so a payment taps exactly as many sources as the cost has
 * pips. Sources of the same name and colours, untouched (no attachments), are interchangeable: tapping either of
 * two Islands is the same payment. The hint is set when exactly one choice of how many of each kind to tap can pay
 * every pip ({@link #ways}).
 */
final class OnlyWay {
    private OnlyWay() { }

    /** Every pip a generic shard accepts. */
    private static final int ANY = ManaAtom.ALL_MANA_TYPES;
    /** Past this many candidate payments, call it a choice (a board this big has one anyway). */
    private static final int MAX_TRIES = 20000;

    /** Interchangeable sources: {@code count} of them, each tapping for one mana of a colour in {@code mask} (ManaAtom bits). */
    record Kind(int count, int mask) { }

    /** Whether the payMana Input {@code in} has exactly one way to pay. Call on bridge-ui, never mid-payment. */
    static boolean unambiguous(final Input in, final Game game) {
        if (!(in instanceof InputPayManaOfCostPayment pay) || pay.isActivatingManaAbility() || pay.isPaid() || game == null) {
            return false;
        }
        final Player p = game.getPlayer(pay.getOwner());
        if (p == null) {
            return false;
        }
        final SpellAbility sa = p.getPaidForSA();
        final ManaCostBeingPaid cost = sa == null ? null : sa.getManaCostBeingPaid();
        if (cost == null || cost.isPaid() || !p.getManaPool().isEmpty() || sa.tracksManaSpent() || sa.costHasManaX()
                || cost.getXcounter() > 0 || cost.containsPhyrexianMana()
                || (p.hasKeyword("PayLifeInsteadOf:B") && cost.hasAnyKind(ManaAtom.BLACK)) || tableChangesMana(game)) {
            return false;
        }
        final int[] units = units(cost);
        if (units == null || units.length == 0) {
            return false;
        }
        int needs = 0;
        for (final int u : units) {
            needs |= u;
        }
        final Map<String, int[]> kinds = new LinkedHashMap<>();
        for (final Card c : p.getCardsIn(List.of(ZoneType.Battlefield, ZoneType.Hand, ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command))) {
            int mask = 0;
            for (final SpellAbility ma : manaAbilities(c, p)) {
                final int makes = produces(ma);
                if ((makes & needs) == 0) {
                    continue; // can't pay any pip: not a source for this cost
                }
                if (!simple(ma, sa)) {
                    return false;
                }
                mask |= makes;
            }
            if (mask == 0) {
                continue;
            }
            final boolean plain = c.isInZone(ZoneType.Battlefield) && !c.hasCardAttachments();
            final String key = plain ? c.getName() + "|" + mask + "|" + c.isCreature() : "#" + c.getId();
            kinds.computeIfAbsent(key, k -> new int[] {0, 0});
            kinds.get(key)[0]++;
            kinds.get(key)[1] = mask;
        }
        final List<Kind> list = new ArrayList<>();
        kinds.values().forEach(k -> list.add(new Kind(k[0], k[1])));
        return ways(list, units) == 1;
    }

    /**
     * How many different payments of {@code units} (one entry per pip: the ManaAtom colours that pay it) the
     * sources make, where a payment is how many of each kind tap: 0, 1, or 2 for "more than one".
     */
    static int ways(final List<Kind> kinds, final int[] units) {
        final int[] take = new int[kinds.size()];
        final int[] found = {0, 0}; // payments, tries
        count(kinds, units, take, 0, units.length, found);
        return Math.min(found[0], 2);
    }

    private static boolean count(final List<Kind> kinds, final int[] units, final int[] take, final int i, final int left, final int[] found) {
        if (left == 0) {
            if (++found[1] > MAX_TRIES) {
                found[0] = 2;
                return true;
            }
            if (pays(kinds, take, units) && ++found[0] > 1) {
                return true;
            }
            return false;
        }
        if (i == kinds.size()) {
            return false;
        }
        for (int n = Math.min(left, kinds.get(i).count()); n >= 0; n--) {
            take[i] = n;
            if (count(kinds, units, take, i + 1, left - n, found)) {
                take[i] = 0;
                return true;
            }
        }
        take[i] = 0;
        return false;
    }

    /** Whether the chosen sources (take[i] of kind i, one mana each) can be matched one-to-one with the pips. */
    private static boolean pays(final List<Kind> kinds, final int[] take, final int[] units) {
        final List<Integer> masks = new ArrayList<>();
        for (int i = 0; i < take.length; i++) {
            for (int n = 0; n < take[i]; n++) {
                masks.add(kinds.get(i).mask());
            }
        }
        final int[] unitOf = new int[masks.size()];
        final int[] sourceOf = new int[units.length];
        java.util.Arrays.fill(unitOf, -1);
        java.util.Arrays.fill(sourceOf, -1);
        for (int s = 0; s < masks.size(); s++) {
            if (!augment(s, masks, units, unitOf, sourceOf, new boolean[units.length])) {
                return false;
            }
        }
        return true;
    }

    /** Kuhn's augmenting path: give source {@code s} a pip, moving earlier sources along if needed. */
    private static boolean augment(final int s, final List<Integer> masks, final int[] units, final int[] unitOf, final int[] sourceOf, final boolean[] seen) {
        for (int u = 0; u < units.length; u++) {
            if (seen[u] || (masks.get(s) & units[u]) == 0) {
                continue;
            }
            seen[u] = true;
            if (sourceOf[u] < 0 || augment(sourceOf[u], masks, units, unitOf, sourceOf, seen)) {
                sourceOf[u] = s;
                unitOf[s] = u;
                return true;
            }
        }
        return false;
    }

    /** One entry per pip left to pay: the colours that pay it; null for a pip this check doesn't model. */
    private static int[] units(final ManaCostBeingPaid cost) {
        final List<Integer> out = new ArrayList<>();
        for (final ManaCostShard s : cost.getDistinctShards()) {
            final int n = cost.getUnpaidShards(s);
            if (s == ManaCostShard.GENERIC) {
                for (int i = 0; i < n; i++) {
                    out.add(ANY);
                }
                continue;
            }
            if (s.isSnow() || s.isOr2Generic() || s.isPhyrexian() || s.isOfKind(ManaAtom.IS_X)) {
                return null;
            }
            int mask = 0;
            for (final byte t : ManaAtom.MANATYPES) {
                if (s.canBePaidWithManaOfColor(t)) {
                    mask |= t;
                }
            }
            if (mask == 0) {
                return null;
            }
            for (int i = 0; i < n; i++) {
                out.add(mask);
            }
        }
        return out.stream().mapToInt(Integer::intValue).toArray();
    }

    /** The mana abilities of {@code c} that {@code p} can activate right now (as InputPayMana lists them). */
    private static List<SpellAbility> manaAbilities(final Card c, final Player p) {
        final List<SpellAbility> all = new ArrayList<>();
        for (final SpellAbility sa : c.getManaAbilities()) {
            all.add(sa);
            all.addAll(GameActionUtil.getAlternativeCosts(sa, p, false));
        }
        final List<SpellAbility> out = new ArrayList<>();
        for (final SpellAbility sa : all) {
            sa.setActivatingPlayer(p);
            if (sa.canPlay(true)) {
                out.add(sa);
            }
        }
        return out;
    }

    /** The ManaAtom colours {@code ma} can make. */
    private static int produces(final SpellAbility ma) {
        int mask = 0;
        for (final byte t : ManaAtom.MANATYPES) {
            if (ma.canProduce(MagicColor.toShortString(t))) {
                mask |= t;
            }
        }
        return mask;
    }

    /** {T}: add one mana, nothing else: no other cost, no restriction, no rider, no tap trigger on its card. */
    private static boolean simple(final SpellAbility ma, final SpellAbility paidFor) {
        final AbilityManaPart mp = ma.getManaPart();
        if (mp == null || ma.getSubAbility() != null || !ma.isUndoable() || ma.getPayCosts().getCostParts().size() != 1
                || !(ma.getPayCosts().getCostParts().get(0) instanceof CostTap)) {
            return false;
        }
        if (StringUtils.isNotEmpty(mp.getManaRestrictions()) || StringUtils.isNotEmpty(mp.getExtraManaRestriction())
                || mp.isPersistentMana() || mp.isCannotCounterPaidWith() || mp.isSpecialMana() || StringUtils.isNotEmpty(mp.getKeywords())
                || mp.addsCounters(paidFor) || mp.getTriggersWhenSpent() || ma.totalAmountOfManaGenerated(paidFor, true) != 1) {
            return false;
        }
        for (final Trigger t : ma.getHostCard().getTriggers()) {
            if (t.getMode() == TriggerType.Taps || t.getMode() == TriggerType.TapsForMana || t.getMode() == TriggerType.ManaAdded) {
                return false;
            }
        }
        return true;
    }

    /** Something on the table changes what tapping for mana does, or what mana can pay for. */
    private static boolean tableChangesMana(final Game game) {
        for (final Card c : game.getCardsIn(List.of(ZoneType.Battlefield, ZoneType.Command))) {
            for (final Trigger t : c.getTriggers()) {
                if (t.getMode() == TriggerType.TapsForMana || t.getMode() == TriggerType.ManaAdded) {
                    return true;
                }
            }
            for (final ReplacementEffect r : c.getReplacementEffects()) {
                if (r.getMode() == ReplacementType.ProduceMana) {
                    return true;
                }
            }
            for (final StaticAbility st : c.getStaticAbilities()) {
                if (st.checkMode(StaticAbilityMode.ManaConvert)) {
                    return true;
                }
            }
        }
        return false;
    }
}

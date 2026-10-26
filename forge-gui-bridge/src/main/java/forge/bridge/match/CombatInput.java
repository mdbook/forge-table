package forge.bridge.match;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.bridge.proj.ViewCodec;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.IEntityMap;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputAttack;
import forge.gamemodes.match.input.InputBlock;
import forge.player.PlayerControllerHuman;
import forge.util.ITriggerEvent;

/**
 * The MTGA-style combat acts and prompt fields on top of Forge's own {@link InputBlock} and
 * {@link InputAttack}. Every act is a sequence of the clicks a Classic player would make, so Forge still applies
 * (and validates) every assignment; nothing here writes to the combat. Runs on bridge-ui, where those Inputs
 * handle their clicks, while the game thread waits on them.
 */
final class CombatInput {
    private CombatInput() { }

    /** Classic's right-click on a blocker: Forge's own "remove from combat" in {@link InputBlock}. */
    private static final ITriggerEvent RIGHT_CLICK = new ITriggerEvent() {
        @Override public int getButton() { return 3; }
        @Override public int getX() { return 0; }
        @Override public int getY() { return 0; }
    };

    /** What an act did: {@code null} = applied, else why it was refused (sent as a {@code stale} notice). */
    record Outcome(String refused, boolean illegal) {
        static final Outcome OK = new Outcome(null, false);
        static final Outcome ILLEGAL = new Outcome(null, true);
        static Outcome refuse(final String why) {
            return new Outcome(why, false);
        }
    }

    // ---------------------------------------------------------------- prompt fields

    /** Adds {@code blockable} (declareBlockers) or {@code defenders} (declareAttackers) to the prompt body. */
    static void describe(final Input shown, final ViewCodec.Refs refs, final JsonObject body) {
        if (shown instanceof InputBlock in) {
            final JsonObject out = new JsonObject();
            blockable(in.getCombat(), in.getDefender()).forEach((blocker, attackers) -> {
                final String bid = refs.card(blocker.getView());
                if (bid == null) {
                    return;
                }
                final JsonArray arr = new JsonArray();
                for (final Card a : attackers) {
                    final String aid = refs.card(a.getView());
                    if (aid != null) {
                        arr.add(aid);
                    }
                }
                if (!arr.isEmpty()) {
                    out.add(bid, arr);
                }
            });
            body.add("blockable", out);
        } else if (shown instanceof InputAttack in) {
            final JsonArray out = new JsonArray();
            for (final GameEntity ge : in.getCombat().getDefenders()) {
                final JsonElement e = ViewCodec.entity(ge.getView(), refs);
                if (!e.isJsonNull()) {
                    out.add(e);
                }
            }
            body.add("defenders", out);
        }
    }

    /**
     * Each of {@code defender}'s creatures → the attackers it can block with one {@code block} act now:
     * {@link CombatUtil#canBlock(Card, Card, Combat)} against the current combat, or, for a creature already
     * blocking (that can't block one more), against the combat with it pulled back, i.e. where it can be moved.
     * Creatures with no such attacker are left out.
     */
    static Map<Card, List<Card>> blockable(final Combat combat, final Player defender) {
        final Map<Card, List<Card>> out = new LinkedHashMap<>();
        if (combat == null || defender == null) {
            return out;
        }
        final List<Card> attackers = combat.getAttackers();
        for (final Card blocker : defender.getCreaturesInPlay()) {
            final boolean assigned = !combat.getAttackersBlockedBy(blocker).isEmpty();
            if (!assigned && !CombatUtil.canBlock(blocker)) {
                continue;
            }
            Combat freed = null;
            final List<Card> legal = new ArrayList<>();
            for (final Card attacker : attackers) {
                if (combat.isBlocking(blocker, attacker)) {
                    continue;
                }
                if (CombatUtil.canBlock(attacker, blocker, combat)) {
                    legal.add(attacker);
                } else if (assigned) {
                    if (freed == null) {
                        freed = without(combat, blocker);
                    }
                    if (CombatUtil.canBlock(attacker, blocker, freed)) {
                        legal.add(attacker);
                    }
                }
            }
            if (!legal.isEmpty()) {
                out.put(blocker, legal);
            }
        }
        return out;
    }

    /** A scratch copy of {@code combat} (same cards) with {@code blocker} pulled back. The live combat is untouched. */
    private static Combat without(final Combat combat, final Card blocker) {
        final Game game = blocker.getGame();
        final Combat copy = new Combat(combat, new IEntityMap() {
            @Override public Game getGame() { return game; }
            @Override public GameObject map(final GameObject o) { return o; }
        });
        copy.removeFromCombat(blocker);
        return copy;
    }

    // ---------------------------------------------------------------- acts

    /**
     * {@code block {blocker, attacker}}: pick {@code attacker} (as clicking it does), pull {@code blocker} back from
     * whatever it blocks if it can't block one more, then click {@code blocker}. A pair Forge refuses changes
     * nothing (the caller flashes, as for any refused click).
     */
    static Outcome block(final PlayerControllerHuman pch, final InputBlock in, final Card blocker, final Card attacker) {
        final Combat combat = in.getCombat();
        if (combat == null || !combat.isAttacking(attacker)) {
            return Outcome.refuse("not an attacker");
        }
        if (!isMine(blocker, in.getDefender())) {
            return Outcome.refuse("not your creature");
        }
        if (combat.isBlocking(blocker, attacker)) {
            pch.selectCard(attacker.getView(), null, null); // already so; just make it the current attacker
            return Outcome.OK;
        }
        final boolean canNow = CombatUtil.canBlock(attacker, blocker, combat);
        if (!canNow) {
            final boolean move = !combat.getAttackersBlockedBy(blocker).isEmpty()
                    && CombatUtil.canBlock(attacker, blocker, without(combat, blocker));
            if (!move) {
                // Forge's own refusal: the attacker becomes current, the blocker click does nothing.
                pch.selectCard(attacker.getView(), null, null);
                pch.selectCard(blocker.getView(), null, null);
                return Outcome.ILLEGAL;
            }
            pch.selectCard(blocker.getView(), null, RIGHT_CLICK);
        }
        pch.selectCard(attacker.getView(), null, null);
        return pch.selectCard(blocker.getView(), null, null) ? Outcome.OK : Outcome.ILLEGAL;
    }

    /** {@code unblock {blocker}}: Classic's right-click, which takes the blocker off every attacker. */
    static Outcome unblock(final PlayerControllerHuman pch, final InputBlock in, final Card blocker) {
        if (!isMine(blocker, in.getDefender())) {
            return Outcome.refuse("not your creature");
        }
        pch.selectCard(blocker.getView(), null, RIGHT_CLICK);
        return Outcome.OK;
    }

    /**
     * {@code attack {attacker, defender}}: pick {@code defender} (as clicking its plate or card does), then click
     * {@code attacker}, which declares it at that defender or moves it there. Already attacking it: no click
     * (a click would call it back).
     */
    static Outcome attack(final PlayerControllerHuman pch, final InputAttack in, final Card attacker, final GameEntity defender) {
        final Combat combat = in.getCombat();
        if (combat == null || !combat.getDefenders().contains(defender)) {
            return Outcome.refuse("not a defender");
        }
        if (!isMine(attacker, in.getAttackingPlayer())) {
            return Outcome.refuse("not your creature");
        }
        if (defender instanceof Player p) {
            pch.selectPlayer(p.getView(), null);
        } else {
            pch.selectCard(((Card) defender).getView(), null, null);
        }
        if (combat.isAttacking(attacker, defender)) {
            return Outcome.OK;
        }
        return pch.selectCard(attacker.getView(), null, null) ? Outcome.OK : Outcome.ILLEGAL;
    }

    private static boolean isMine(final Card c, final Player me) {
        return me != null && c.isCreature() && c.getController() == me && me.getZone(ZoneType.Battlefield).contains(c);
    }
}

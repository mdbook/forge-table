package forge.game.player;

import java.util.List;

import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.spellability.SpellAbility;

/**
 * Opt-in tap on a human seat's main decisions, for an external recorder (mtg-ai's human-seat capture records them as
 * behaviour-cloning steps). Nothing is registered by default: every {@code notify*} call is then one volatile read and
 * a return, so stock Forge behaves exactly as before.
 *
 * <p>Called by {@code PlayerControllerHuman} on the game thread right AFTER the human has answered (the game state is
 * still the one the human decided in). A failing observer is swallowed and reported once on stderr: it never reaches
 * the game. Subclasses override only what they record.
 */
public abstract class HumanDecisionObserver {
    private static volatile HumanDecisionObserver instance;
    private static volatile boolean warned;

    /** Registers {@code o} (null = off). One observer per JVM. */
    public static void set(final HumanDecisionObserver o) {
        instance = o;
    }

    public static HumanDecisionObserver get() {
        return instance;
    }

    /** The human answered a priority window: {@code chosen} = the ability to play (null / empty = pass). */
    protected void priority(final Player p, final List<SpellAbility> chosen) {
    }

    /** The human answered a keep / mulligan prompt. */
    protected void mulligan(final Player p, final boolean keep, final int cardsToReturn) {
    }

    /** The human put {@code selected} (a subset of {@code hand}) on the bottom after a London mulligan. */
    protected void bottom(final Player p, final CardCollectionView hand, final CardCollectionView selected) {
    }

    /** The human declared attackers: {@code combat} holds them. */
    protected void attackers(final Player p, final Combat combat) {
    }

    /** The human declared blockers: {@code combat} holds them. */
    protected void blockers(final Player p, final Combat combat) {
    }

    public static void notifyPriority(final Player p, final List<SpellAbility> chosen) {
        final HumanDecisionObserver o = instance;
        if (o != null) {
            try {
                o.priority(p, chosen);
            } catch (final Throwable t) {
                failed(t);
            }
        }
    }

    public static void notifyMulligan(final Player p, final boolean keep, final int cardsToReturn) {
        final HumanDecisionObserver o = instance;
        if (o != null) {
            try {
                o.mulligan(p, keep, cardsToReturn);
            } catch (final Throwable t) {
                failed(t);
            }
        }
    }

    public static void notifyBottom(final Player p, final CardCollectionView hand, final CardCollectionView selected) {
        final HumanDecisionObserver o = instance;
        if (o != null) {
            try {
                o.bottom(p, hand, selected);
            } catch (final Throwable t) {
                failed(t);
            }
        }
    }

    public static void notifyAttackers(final Player p, final Combat combat) {
        final HumanDecisionObserver o = instance;
        if (o != null) {
            try {
                o.attackers(p, combat);
            } catch (final Throwable t) {
                failed(t);
            }
        }
    }

    public static void notifyBlockers(final Player p, final Combat combat) {
        final HumanDecisionObserver o = instance;
        if (o != null) {
            try {
                o.blockers(p, combat);
            } catch (final Throwable t) {
                failed(t);
            }
        }
    }

    private static void failed(final Throwable t) {
        if (!warned) {
            warned = true;
            System.err.println("HumanDecisionObserver failed (the game goes on): " + t);
        }
    }
}

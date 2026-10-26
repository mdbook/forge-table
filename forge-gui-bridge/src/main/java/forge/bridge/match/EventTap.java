package forge.bridge.match;

import java.lang.reflect.RecordComponent;
import java.util.Collection;
import java.util.Map;
import java.util.Set;

import com.google.common.collect.Multimap;
import com.google.common.eventbus.AllowConcurrentEvents;
import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.bridge.BridgeLog;
import forge.bridge.proj.Outbox;
import forge.bridge.proj.Outbox.IdLookup;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.event.GameEvent;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventCardRevealed;
import forge.game.event.GameEventCardTapped;
import forge.game.event.GameEventGameFinished;
import forge.game.event.GameEventGameOutcome;
import forge.game.event.GameEventShuffle;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellResolved;
import forge.game.event.GameEventSubgameEnd;
import forge.game.event.GameEventSubgameStart;
import forge.game.event.GameEventZone;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.game.zone.ZoneView;

/**
 * Turns the engine's event stream into beats. One subscription per {@code Game}, annotated
 * {@link AllowConcurrentEvents} so Guava does not serialize it; the outbox lock is the only lock taken, and
 * it is released before {@link Pacer#admit} so pacing never holds a monitor.
 *
 * <p>Each event becomes exactly one beat, whose patch is the state change collected right after the event.
 * Payload fields are the event record's components, with every view reference replaced by a client id.
 */
public final class EventTap {

    /** Events that end a game or swap subgames are never paced. */
    private static final Set<Class<?>> UNPACED = Set.of(
            GameEventGameOutcome.class, GameEventGameFinished.class,
            GameEventSubgameStart.class, GameEventSubgameEnd.class);

    private final Outbox outbox;
    private final Pacer pacer;
    private volatile Thread primaryThread;

    public EventTap(final Outbox outbox, final Pacer pacer) {
        this.outbox = outbox;
        this.pacer = pacer;
    }

    /** Thread that fired this game's first event: the paced primary game thread. */
    public Thread primaryThread() {
        return primaryThread;
    }

    @Subscribe
    @AllowConcurrentEvents
    public void receive(final GameEvent event) {
        if (primaryThread == null) {
            primaryThread = Thread.currentThread();
        }
        final String kind;
        try {
            if (event instanceof GameEventShuffle shuffle && outbox.projector() != null) {
                synchronized (outbox.lock()) {
                    outbox.projector().onShuffle(shuffle.player());
                }
            }
            if (event instanceof GameEventCardChangeZone cz && cz.to() != null && cz.to().zoneType() == ZoneType.Library
                    && outbox.projector() != null) {
                synchronized (outbox.lock()) {
                    outbox.projector().onToLibrary(cz.card(), cz.from() == null ? null : cz.from().zoneType(), cz.to().player());
                }
            }
            if (event instanceof GameEventSpellResolved && outbox.projector() != null) {
                synchronized (outbox.lock()) {
                    outbox.projector().onResolved();
                }
            }
            if (event instanceof GameEventCardRevealed revealed && outbox.projector() != null) {
                synchronized (outbox.lock()) {
                    outbox.projector().onRevealedToOpponent(revealed.cards());
                }
            }
            if (event instanceof GameEventCardChangeZone cz && cz.to() != null && cz.to().zoneType() == ZoneType.Stack
                    && outbox.projector() != null) {
                synchronized (outbox.lock()) {
                    outbox.projector().noteStackCard(cz.card());
                }
            }
            kind = kindOf(event);
            outbox.beat(kind, (before, after, moved) -> encode(event, before, after, moved), !(event instanceof GameEventZone));
        } catch (final RuntimeException e) {
            BridgeLog.error("Failed to translate " + event.getClass().getSimpleName(), e);
            return;
        }
        if (Thread.currentThread() == primaryThread && !UNPACED.contains(event.getClass())) {
            pacer.admit(kind);
        }
    }

    /** Beat kind for an event. */
    static String kindOf(final GameEvent event) {
        if (event instanceof GameEventCardChangeZone cz) {
            return zoneKind(cz.from() == null ? null : cz.from().zoneType(), cz.to() == null ? null : cz.to().zoneType());
        }
        if (event instanceof GameEventCardTapped t) {
            return t.tapped() ? "tap" : "untap";
        }
        if (event instanceof GameEventSpellAbilityCast cast) {
            return cast.sa() != null && !cast.sa().isSpell() ? "activate" : "cast";
        }
        if (event instanceof GameEventSpellResolved r) {
            return r.hasFizzled() ? "fizzle" : "resolve";
        }
        final String n = event.getClass().getSimpleName().replaceFirst("^GameEvent", "");
        return switch (n) {
            case "PlayerLivesChanged" -> "life";
            case "CardDamaged", "PlayerDamaged" -> "damage";
            case "TurnBegan" -> "turn";
            case "TurnPhase" -> "phase";
            case "PlayerPriority" -> "priority";
            case "GameOutcome" -> "gameOver";
            case "AttackersDeclared" -> "attack";
            case "BlockersDeclared" -> "block";
            case "AddLog" -> "log";
            case "PlayerPoisoned" -> "poison";
            case "CardCounters", "PlayerCounters" -> "counters";
            case "CardAttachment" -> "attach";
            case "CardStatsChanged" -> "stats";
            case "SpellRemovedFromStack" -> "removeFromStack";
            default -> Character.toLowerCase(n.charAt(0)) + n.substring(1);
        };
    }

    static String zoneKind(final ZoneType from, final ZoneType to) {
        if (to == null) {
            return "move";
        }
        if (from == ZoneType.Library && to == ZoneType.Hand) {
            return "draw";
        }
        switch (to) {
            case Stack:
                return "toStack";
            case Battlefield:
                return from == null ? "token" : "etb";
            case Graveyard:
                if (from == ZoneType.Battlefield) {
                    return "dies";
                }
                if (from == ZoneType.Hand) {
                    return "discard";
                }
                if (from == ZoneType.Library) {
                    return "mill";
                }
                return "toGraveyard";
            case Exile:
                return "exile";
            case Hand:
                return from == ZoneType.Battlefield || from == ZoneType.Stack ? "bounce" : "toHand";
            case Library:
                return "toLibrary";
            default:
                return "move";
        }
    }

    private static JsonObject encode(final GameEvent event, final IdLookup before, final IdLookup after, final IdLookup moved) {
        final JsonObject out = new JsonObject();
        if (event.getClass().isRecord()) {
            for (final RecordComponent rc : event.getClass().getRecordComponents()) {
                try {
                    final Object v = rc.getAccessor().invoke(event);
                    final JsonElement e = value(v, after, 0);
                    if (e != null && !e.isJsonNull()) {
                        out.add(rc.getName(), e);
                    }
                } catch (final ReflectiveOperationException ex) {
                    BridgeLog.warn("Cannot read " + rc.getName() + " of " + event.getClass().getSimpleName());
                }
            }
        }
        if (event instanceof GameEventCardChangeZone cz && cz.card() != null) {
            final String prev = moved.id(cz.card());
            out.addProperty("fromId", prev != null ? prev : before.id(cz.card()));
        }
        return out;
    }

    /** Encode an event field; every view becomes a client id and engine-only objects are left out. */
    private static JsonElement value(final Object v, final IdLookup ids, final int depth) {
        if (v == null || depth > 4) {
            return null;
        }
        if (v instanceof Boolean b) {
            return new JsonPrimitive(b);
        }
        if (v instanceof Number n) {
            return new JsonPrimitive(n);
        }
        if (v instanceof String s) {
            return new JsonPrimitive(s);
        }
        if (v instanceof Enum<?> e) {
            return new JsonPrimitive(e.name());
        }
        if (v instanceof CardView cv) {
            final String id = ids.id(cv);
            return id == null ? null : new JsonPrimitive(id);
        }
        if (v instanceof PlayerView pv) {
            return new JsonPrimitive("p" + pv.getId());
        }
        if (v instanceof GameEntityView) {
            return JsonNull.INSTANCE;
        }
        if (v instanceof ZoneView zv) {
            final JsonObject o = new JsonObject();
            if (zv.player() != null) {
                o.addProperty("player", "p" + zv.player().getId());
            }
            if (zv.zoneType() != null) {
                o.addProperty("zone", zv.zoneType().name());
            }
            return o;
        }
        if (v instanceof SpellAbilityView sa) {
            final JsonObject o = new JsonObject();
            final String host = sa.getHostCard() == null ? null : ids.id(sa.getHostCard());
            if (host != null) {
                o.addProperty("host", host);
            }
            // The text names the card, so only send it when the host is identified to this viewer.
            if (host != null && host.startsWith("c")) {
                o.addProperty("text", sa.getDescription());
            }
            o.addProperty("spell", sa.isSpell());
            return o;
        }
        if (v instanceof StackItemView si) {
            return new JsonPrimitive("s" + si.getId());
        }
        if (v instanceof CounterType ct) {
            return new JsonPrimitive(ct.getName());
        }
        if (v instanceof Multimap<?, ?> mm) {
            return value(mm.asMap(), ids, depth);
        }
        if (v instanceof Map<?, ?> map) {
            final JsonArray arr = new JsonArray();
            for (final Map.Entry<?, ?> e : map.entrySet()) {
                final JsonElement k = value(e.getKey(), ids, depth + 1);
                final JsonElement val = value(e.getValue(), ids, depth + 1);
                if (k != null && val != null) {
                    final JsonArray pair = new JsonArray();
                    pair.add(k);
                    pair.add(val);
                    arr.add(pair);
                }
            }
            return arr;
        }
        if (v instanceof Collection<?> c) {
            final JsonArray arr = new JsonArray();
            for (final Object o : c) {
                final JsonElement e = value(o, ids, depth + 1);
                if (e != null) {
                    arr.add(e);
                }
            }
            return arr;
        }
        return null; // engine objects without a client representation (outcomes, damage maps, …)
    }
}

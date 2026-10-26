package forge.bridge.proj;

import java.util.Arrays;
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import com.google.common.collect.Multiset;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.StaticData;
import forge.card.CardRules;
import forge.card.CardTypeView;
import forge.card.ICardFace;
import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.card.CardView.CardStateView;
import forge.game.card.CounterType;
import forge.game.keyword.KeywordCollectionView;
import forge.game.keyword.KeywordView;
import forge.game.player.PlayerView;
import forge.trackable.TrackableObject;
import forge.trackable.TrackableProperty;
import forge.trackable.TrackableTypes.TrackableType;
import forge.trackable.TrackableTypes;

/**
 * Encodes {@link TrackableProperty} values as JSON.
 *
 * <p>Every {@link TrackableType} has an explicit encoding here; {@link #isEncodable} is false only for
 * the properties listed in {@link #SERVER_ONLY}, and {@code ViewCodecTest} fails if a property's type has
 * no encoding. References to other objects never carry engine state: a card reference becomes the
 * viewer's client id for that card (or is dropped when the viewer can't see the card) and a player
 * reference becomes {@code "p<id>"}.
 */
public final class ViewCodec {

    /** Resolves object references to per-viewer client ids. */
    public interface Refs {
        /** @return the client id for {@code card}, or {@code null} if the viewer may not know it exists. */
        String card(CardView card);

        default String player(final PlayerView player) {
            return player == null ? null : "p" + player.getId();
        }
    }

    /**
     * Properties that are never sent. Each is either engine-side plumbing or rendered through a
     * dedicated projection instead (zones, stack, combat).
     */
    public static final Set<TrackableProperty> SERVER_ONLY = EnumSet.of(
            TrackableProperty.PaperCardBackup,   // the paper card object; identity is already in the state
            TrackableProperty.Object,            // GameView's backing object handle
            TrackableProperty.Dependencies,      // debug text for static ability layers
            TrackableProperty.DraftNotes,        // draft-only notes map
            TrackableProperty.NeedsTransformAnimation, // legacy repaint hints; beats drive animation
            TrackableProperty.NeedsTapAnimation,
            TrackableProperty.NeedsUntapAnimation,
            // projected separately (ViewProjector)
            TrackableProperty.Stack,
            TrackableProperty.SubInstance,       // stack items are encoded by encodeStackItem
            TrackableProperty.CombatView,
            TrackableProperty.Players,
            TrackableProperty.AttackersWithDefenders,
            TrackableProperty.AttackersWithBlockers,
            TrackableProperty.BandsWithDefenders,
            TrackableProperty.BandsWithBlockers,
            TrackableProperty.AttackersWithPlannedBlockers,
            TrackableProperty.BandsWithPlannedBlockers,
            TrackableProperty.CurrentState,
            TrackableProperty.AlternateState,
            TrackableProperty.LeftSplitState,
            TrackableProperty.RightSplitState);

    /** Player zone properties; the projector emits them with hidden-zone redaction. */
    public static final Set<TrackableProperty> PLAYER_ZONES = EnumSet.of(
            TrackableProperty.Ante, TrackableProperty.Battlefield, TrackableProperty.Command,
            TrackableProperty.Exile, TrackableProperty.Flashback, TrackableProperty.Graveyard,
            TrackableProperty.Hand, TrackableProperty.Library, TrackableProperty.Sideboard,
            TrackableProperty.PlanarDeck, TrackableProperty.SchemeDeck, TrackableProperty.AttractionDeck,
            TrackableProperty.ContraptionDeck, TrackableProperty.Junkyard);

    private ViewCodec() { }

    public static boolean isEncodable(final TrackableProperty prop) {
        return !SERVER_ONLY.contains(prop);
    }

    /** JSON key for a property: lowerCamelCase of the enum constant. */
    public static String key(final TrackableProperty prop) {
        final String n = prop.name();
        if (n.startsWith("SA_")) {
            return "sa" + n.substring(3);
        }
        return Character.toLowerCase(n.charAt(0)) + n.substring(1);
    }

    /**
     * Encode every encodable property set on {@code obj} into {@code out}.
     * @param skip additional properties to leave out
     */
    public static void encodeProps(final TrackableObject obj, final Refs refs, final JsonObject out, final Set<TrackableProperty> skip) {
        final Map<TrackableProperty, Object> props = obj.getProps();
        for (final Map.Entry<TrackableProperty, Object> e : props.entrySet()) {
            final TrackableProperty prop = e.getKey();
            if (!isEncodable(prop) || PLAYER_ZONES.contains(prop) || (skip != null && skip.contains(prop))) {
                continue;
            }
            final JsonElement v = encode(prop, e.getValue(), refs);
            if (v == null || v.isJsonNull() || isEmpty(v) || isZeroText(prop, v)) {
                continue; // defaults are omitted; the client treats a missing key as empty/zero
            }
            out.add(key(prop), v);
        }
    }

    private static boolean isEmpty(final JsonElement v) {
        return (v.isJsonArray() && v.getAsJsonArray().isEmpty()) || (v.isJsonObject() && v.getAsJsonObject().size() == 0);
    }

    /** Loyalty and defense are strings, and faces without them carry "0". */
    private static boolean isZeroText(final TrackableProperty prop, final JsonElement v) {
        return (prop == TrackableProperty.Loyalty || prop == TrackableProperty.Defense) && "0".equals(v.getAsString());
    }

    /** Encode one value according to its property's {@link TrackableType}. Returns {@code null} to omit. */
    @SuppressWarnings("unchecked")
    public static JsonElement encode(final TrackableProperty prop, final Object value, final Refs refs) {
        if (value == null) {
            return null;
        }
        final TrackableType<?> type = prop.getType();
        if (type == TrackableTypes.BooleanType || type == TrackableTypes.IntegerType || type == TrackableTypes.FloatType) {
            if (value instanceof Boolean b) {
                return new JsonPrimitive(b);
            }
            return new JsonPrimitive((Number) value);
        }
        if (type == TrackableTypes.StringType) {
            return new JsonPrimitive(value.toString());
        }
        if (value instanceof Enum<?> en) { // TrackableTypes.EnumType(...) instances
            return new JsonPrimitive(en.name());
        }
        if (type == TrackableTypes.CardViewType) {
            final String id = refs.card((CardView) value);
            return id == null ? null : new JsonPrimitive(id);
        }
        if (type == TrackableTypes.CardViewCollectionType) {
            final JsonArray arr = new JsonArray();
            for (final CardView cv : (Iterable<CardView>) value) {
                final String id = refs.card(cv);
                if (id != null) {
                    arr.add(id);
                }
            }
            return arr;
        }
        if (type == TrackableTypes.PlayerViewType) {
            return new JsonPrimitive(refs.player((PlayerView) value));
        }
        if (type == TrackableTypes.PlayerViewCollectionType) {
            final JsonArray arr = new JsonArray();
            for (final PlayerView pv : (Iterable<PlayerView>) value) {
                arr.add(refs.player(pv));
            }
            return arr;
        }
        if (type == TrackableTypes.GameEntityViewType) {
            return entity((GameEntityView) value, refs);
        }
        if (type == TrackableTypes.CardTypeViewType) {
            return cardType((CardTypeView) value);
        }
        if (type == TrackableTypes.ManaCostType) {
            final ManaCost mc = (ManaCost) value;
            return mc.isNoCost() ? null : new JsonPrimitive(mc.toString());
        }
        if (type == TrackableTypes.ColorSetType) {
            return new JsonPrimitive(colors((ColorSet) value));
        }
        if (type == TrackableTypes.StringListType || type == TrackableTypes.StringSetType || type == TrackableTypes.IntegerSetType) {
            final JsonArray arr = new JsonArray();
            for (final Object o : (Collection<Object>) value) {
                if (o instanceof Number n) {
                    arr.add(n);
                } else {
                    arr.add(String.valueOf(o));
                }
            }
            return arr;
        }
        if (type == TrackableTypes.StringMapType || type == TrackableTypes.IntegerMapType) {
            final JsonObject obj = new JsonObject();
            for (final Map.Entry<Object, Object> e : ((Map<Object, Object>) value).entrySet()) {
                final Object v = e.getValue();
                obj.add(String.valueOf(e.getKey()), v instanceof Number n ? new JsonPrimitive(n) : new JsonPrimitive(String.valueOf(v)));
            }
            return obj;
        }
        if (type == TrackableTypes.ManaMapType) {
            final JsonObject obj = new JsonObject();
            for (final Map.Entry<Byte, Integer> e : ((Map<Byte, Integer>) value).entrySet()) {
                if (e.getValue() != null && e.getValue() != 0) {
                    obj.addProperty(MagicColor.toShortString(e.getKey()), e.getValue());
                }
            }
            return obj;
        }
        if (type == TrackableTypes.CounterMapType) {
            final JsonObject obj = new JsonObject();
            for (final Multiset.Entry<CounterType> e : ((Multiset<CounterType>) value).entrySet()) {
                obj.addProperty(e.getElement().getName(), e.getCount());
            }
            return obj;
        }
        if (type == TrackableTypes.KeywordCollectionViewType) {
            final JsonArray arr = new JsonArray();
            for (final KeywordView kw : (KeywordCollectionView) value) {
                final JsonObject k = new JsonObject();
                k.addProperty("title", kw.title());
                if (kw.reminderText() != null && !kw.reminderText().isEmpty()) {
                    k.addProperty("reminder", kw.reminderText());
                }
                arr.add(k);
            }
            return arr;
        }
        throw new IllegalArgumentException("No JSON encoding for " + prop + " (" + type + ")");
    }

    /** {@code "p<id>"} for players, the viewer's client id for cards, {@code null} if hidden. */
    public static JsonElement entity(final GameEntityView ge, final Refs refs) {
        if (ge instanceof PlayerView pv) {
            return new JsonPrimitive(refs.player(pv));
        }
        if (ge instanceof CardView cv) {
            final String id = refs.card(cv);
            return id == null ? JsonNull.INSTANCE : new JsonPrimitive(id);
        }
        return JsonNull.INSTANCE;
    }

    public static JsonObject cardType(final CardTypeView t) {
        final JsonObject obj = new JsonObject();
        final JsonArray sup = new JsonArray();
        t.getSupertypes().forEach(s -> sup.add(s.name()));
        final JsonArray core = new JsonArray();
        t.getCoreTypes().forEach(c -> core.add(c.name()));
        final JsonArray sub = new JsonArray();
        t.getSubtypes().forEach(sub::add);
        obj.add("super", sup);
        obj.add("core", core);
        obj.add("sub", sub);
        return obj;
    }

    /** Colors as WUBRG letters in canonical order; {@code ""} for colorless. */
    public static String colors(final ColorSet cs) {
        final StringBuilder sb = new StringBuilder(5);
        if (cs.hasWhite()) { sb.append('W'); }
        if (cs.hasBlue()) { sb.append('U'); }
        if (cs.hasBlack()) { sb.append('B'); }
        if (cs.hasRed()) { sb.append('R'); }
        if (cs.hasGreen()) { sb.append('G'); }
        return sb.toString();
    }

    /**
     * The TypeScript type of a property's JSON encoding (used by the protocol codegen). Throws for a type
     * with no encoding, which {@code ViewCodecTest} turns into a failure when the engine adds one.
     */
    public static String tsType(final TrackableProperty prop) {
        final TrackableType<?> type = prop.getType();
        if (type == TrackableTypes.BooleanType) { return "boolean"; }
        if (type == TrackableTypes.IntegerType || type == TrackableTypes.FloatType) { return "number"; }
        if (type == TrackableTypes.StringType || type == TrackableTypes.ManaCostType || type == TrackableTypes.ColorSetType) { return "string"; }
        if (type == TrackableTypes.CardViewType || type == TrackableTypes.PlayerViewType) { return "string"; }
        if (type == TrackableTypes.CardViewCollectionType || type == TrackableTypes.PlayerViewCollectionType) { return "string[]"; }
        if (type == TrackableTypes.GameEntityViewType) { return "string | null"; }
        if (type == TrackableTypes.CardTypeViewType) { return "CardType"; }
        if (type == TrackableTypes.StringListType || type == TrackableTypes.StringSetType) { return "string[]"; }
        if (type == TrackableTypes.IntegerSetType) { return "number[]"; }
        if (type == TrackableTypes.StringMapType) { return "Record<string, string>"; }
        if (type == TrackableTypes.IntegerMapType || type == TrackableTypes.ManaMapType || type == TrackableTypes.CounterMapType) { return "Record<string, number>"; }
        if (type == TrackableTypes.KeywordCollectionViewType) { return "Keyword[]"; }
        final Class<? extends Enum<?>> enumClass = enumClassOf(type);
        if (enumClass != null) {
            final StringBuilder sb = new StringBuilder();
            for (final Enum<?> c : enumClass.getEnumConstants()) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append('"').append(c.name()).append('"');
            }
            return sb.toString();
        }
        throw new IllegalArgumentException("No JSON encoding for " + prop + " (" + type + ")");
    }

    /** The enum class behind a {@code TrackableTypes.EnumType(...)} instance, or {@code null}. */
    @SuppressWarnings("unchecked")
    public static Class<? extends Enum<?>> enumClassOf(final TrackableType<?> type) {
        try {
            final java.lang.reflect.Field f = TrackableTypes.class.getDeclaredField("enumTypes");
            f.setAccessible(true);
            final Map<Class<? extends Enum<?>>, TrackableType<?>> enums = (Map<Class<? extends Enum<?>>, TrackableType<?>>) f.get(null);
            for (final Map.Entry<Class<? extends Enum<?>>, TrackableType<?>> e : enums.entrySet()) {
                if (e.getValue() == type) {
                    return e.getKey();
                }
            }
            return null;
        } catch (final ReflectiveOperationException e) {
            return null;
        }
    }

    /** A card face: every encodable {@link CardStateView} property. */
    public static JsonObject state(final CardStateView state, final Refs refs) {
        final JsonObject out = new JsonObject();
        out.addProperty("face", state.getState().name());
        encodeProps(state, refs, out, null);
        printedPt(state, out);
        return out;
    }

    /**
     * The face's printed P/T from its card rules (the art shows it; Power/Toughness are the current values).
     * Tokens have no card rules: their P/T comes from the token scripts of that name ({@link #tokenPrintedPt}).
     * Omitted for non-numeric P/T ({@code *}) and when it can't be told: the client infers. A face whose printed power
     * or toughness is not a plain integer ({@code *}, {@code 1+*}, {@code X}) gets {@code printedPtVaries: true}
     * instead: the art shows no number, so the client always shows the current P/T.
     */
    private static void printedPt(final CardStateView state, final JsonObject out) {
        printedPt(state.getName(), out);
    }

    static void printedPt(final String name, final JsonObject out) {
        final StaticData data = StaticData.instance();
        if (data == null || name == null || name.isEmpty()) {
            return;
        }
        final CardRules rules = data.getCommonCards().getRules(name, true);
        if (rules == null) {
            final int[] pt = tokenPrintedPt(name);
            if (pt != null) {
                out.addProperty("printedPower", pt[0]);
                out.addProperty("printedToughness", pt[1]);
            }
            return;
        }
        for (final ICardFace f : rules.getAllFaces()) {
            if (f != null && name.equals(f.getName())) {
                final Integer p = intOrNull(f.getPower());
                final Integer t = intOrNull(f.getToughness());
                if (p != null && t != null) {
                    out.addProperty("printedPower", p);
                    out.addProperty("printedToughness", t);
                } else if (varies(f.getPower()) || varies(f.getToughness())) {
                    out.addProperty("printedPtVaries", true);
                }
                return;
            }
        }
    }

    /** Marks a token name whose scripts disagree on P/T (e.g. 1/1 and 2/2 Soldiers). */
    private static final int[] AMBIGUOUS = new int[0];
    /** Token face name, without a trailing " Token", to its printed P/T. Built once from the token scripts. */
    private static volatile Map<String, int[]> tokenPts;

    /**
     * The printed P/T of a token named {@code name} ("Phyrexian Germ" or "Phyrexian Germ Token"), or null when no
     * token script has that name, its P/T isn't numeric, or scripts of that name disagree.
     */
    static int[] tokenPrintedPt(final String name) {
        Map<String, int[]> pts = tokenPts;
        if (pts == null) {
            pts = new HashMap<>();
            final StaticData data = StaticData.instance();
            if (data != null && data.getAllTokens() != null) {
                for (final CardRules r : data.getAllTokens().getRules().values()) {
                    final ICardFace f = r == null ? null : r.getMainPart();
                    if (f == null || f.getName() == null) {
                        continue;
                    }
                    final Integer p = intOrNull(f.getPower());
                    final Integer t = intOrNull(f.getToughness());
                    final int[] pt = p == null || t == null ? AMBIGUOUS : new int[] {p, t};
                    pts.merge(tokenKey(f.getName()), pt, (a, b) -> Arrays.equals(a, b) ? a : AMBIGUOUS);
                }
            }
            tokenPts = pts;
        }
        final int[] pt = pts.get(tokenKey(name));
        return pt == null || pt == AMBIGUOUS ? null : pt;
    }

    private static String tokenKey(final String name) {
        return name.endsWith(" Token") ? name.substring(0, name.length() - " Token".length()) : name;
    }

    /** A P/T string that is present but not a plain integer: {@code *}, {@code 1+*}, {@code *+1}, {@code X}. */
    private static boolean varies(final String s) {
        return s != null && !s.isEmpty() && intOrNull(s) == null;
    }

    private static Integer intOrNull(final String s) {
        if (s == null || !s.matches("-?\\d+")) {
            return null;
        }
        return Integer.valueOf(s);
    }
}

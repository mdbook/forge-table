package forge.bridge.router;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * What the lobby's deck gallery shows of a Forge {@code .dck} file without a game to load it: its card count
 * ({@code [Main]} + {@code [Commander]}), its colours as its basic lands say them (WUBRG order, possibly none), the card
 * whose art stands for it (the commander, else the most-played non-basic of {@code [Main]}, the first listed on a tie)
 * and the commander. Card lines read {@code 4 Lightning Bolt|M10|1} or {@code 1 Lightning Bolt}; anything else is skipped.
 *
 * @param key       the card for the deck's art, or null
 * @param commander the first card of {@code [Commander]}, or null
 * @param dupes     for a deck with a commander, non-basic cards with more than one copy across {@code [Main]} and
 *                  {@code [Commander]}, in deck order:
 *                  what a singleton format (Brawl) refuses, short of the few cards that allow any number
 * @param standard  why the deck isn't Standard ({@link StandardPool#problem}), or null: it looks legal, has a
 *                  commander, or Standard wasn't judged
 */
public record DeckSummary(int cards, String colors, String key, String commander, List<String> dupes, String standard) {

    public DeckSummary(final int cards, final String colors, final String key, final String commander) {
        this(cards, colors, key, commander, List.of(), null);
    }

    public DeckSummary(final int cards, final String colors, final String key, final String commander, final List<String> dupes) {
        this(cards, colors, key, commander, dupes, null);
    }

    /** This summary with {@link #standard} set. */
    public DeckSummary withStandard(final String why) {
        return new DeckSummary(cards, colors, key, commander, dupes, why);
    }

    /**
     * A deck file's cards by section, in file order, as written ({@code Main}, {@code Sideboard}, {@code Commander}…;
     * metadata and other non-card sections skipped), each card name to its count (the same line format as
     * {@link #parse}; a name listed twice adds up).
     */
    public static Map<String, Map<String, Integer>> sections(final List<String> lines) {
        final Map<String, Map<String, Integer>> out = new LinkedHashMap<>();
        Map<String, Integer> cur = null;
        for (final String raw : lines) {
            final String line = raw.strip();
            if (line.startsWith("[") && line.endsWith("]")) {
                final String name = line.substring(1, line.length() - 1).strip();
                cur = name.equalsIgnoreCase("metadata") ? null : out.computeIfAbsent(name, k -> new LinkedHashMap<>());
                continue;
            }
            if (cur == null || line.length() > MAX_LINE) {
                continue;
            }
            final Matcher m = CARD.matcher(line);
            if (!m.matches()) {
                continue;
            }
            final String name = m.group(2).strip();
            if (!name.isEmpty()) {
                cur.merge(name, Integer.parseInt(m.group(1)), Integer::sum);
            }
        }
        out.values().removeIf(Map::isEmpty);
        return out;
    }

    /** Larger deck files are not summarised (a real deck is a few KB). */
    static final long MAX_BYTES = 256 * 1024;

    /** Longer lines are not card lines. */
    static final int MAX_LINE = 300;
    /** Possessive throughout: no backtracking, so a hostile line costs its length, not its length squared. */
    private static final Pattern CARD = Pattern.compile("(\\d{1,4})\\s++([^|]*+)(?:\\|.*)?");
    private static final String SNOW = "Snow-Covered ";
    /** Basic land → its colour ("" for Wastes: a basic, but no colour). */
    private static final Map<String, String> BASICS = Map.of("Plains", "W", "Island", "U", "Swamp", "B", "Mountain", "R",
            "Forest", "G", "Wastes", "");

    /** A deck file's lines, as above. Never fails: a file with no cards is {@code cards = 0}. */
    public static DeckSummary parse(final List<String> lines) {
        String section = "";
        int cards = 0;
        String commander = null;
        final StringBuilder seen = new StringBuilder();
        final Map<String, Integer> main = new LinkedHashMap<>();
        final Map<String, Integer> copies = new LinkedHashMap<>();
        for (final String raw : lines) {
            final String line = raw.strip();
            if (line.startsWith("[") && line.endsWith("]")) {
                section = line.substring(1, line.length() - 1).strip().toLowerCase(java.util.Locale.ROOT);
                continue;
            }
            final boolean isMain = section.equals("main");
            if (!isMain && !section.equals("commander")) {
                continue;
            }
            if (line.length() > MAX_LINE) {
                continue;
            }
            final Matcher m = CARD.matcher(line);
            if (!m.matches()) {
                continue;
            }
            final int n = Integer.parseInt(m.group(1));
            final String name = m.group(2).strip();
            if (name.isEmpty()) {
                continue;
            }
            cards += n;
            final String basic = basicColor(name);
            if (basic != null) {
                seen.append(basic);
            } else {
                copies.merge(name, n, Integer::sum);
                if (isMain) {
                    main.merge(name, n, Integer::sum);
                }
            }
            if (!isMain && commander == null) {
                commander = name;
            }
        }
        final StringBuilder colors = new StringBuilder();
        for (final char c : "WUBRG".toCharArray()) {
            if (seen.indexOf(String.valueOf(c)) >= 0) {
                colors.append(c);
            }
        }
        // Only a deck with a commander can be a Brawl deck; a constructed deck's 4-ofs aren't news.
        final List<String> dupes = commander == null ? List.of()
                : copies.entrySet().stream().filter(e -> e.getValue() > 1).map(Map.Entry::getKey).toList();
        return new DeckSummary(cards, colors.toString(), key(commander, main), commander, dupes);
    }

    /**
     * The card whose art stands for a deck: its commander, else the most-played of {@code main} (non-basics, in deck
     * order: the first listed wins a tie). Null for neither.
     */
    public static String key(final String commander, final Map<String, Integer> main) {
        String key = commander;
        if (key == null) {
            int best = 0;
            for (final Map.Entry<String, Integer> e : main.entrySet()) {
                if (e.getValue() > best) {
                    best = e.getValue();
                    key = e.getKey();
                }
            }
        }
        return key;
    }

    /** A basic land's colour ("" for Wastes), snow-covered or not; null for anything else. */
    static String basicColor(final String name) {
        return BASICS.get(name.startsWith(SNOW) ? name.substring(SNOW.length()) : name);
    }

    /** {@code {cards, colors, key?, commander?, dupes?, standard?}} for {@code GET /api/decks}'s {@code details}. */
    JsonObject toJson() {
        final JsonObject o = new JsonObject();
        o.addProperty("cards", cards);
        o.addProperty("colors", colors);
        if (key != null) {
            o.addProperty("key", key);
        }
        if (commander != null) {
            o.addProperty("commander", commander);
        }
        if (!dupes.isEmpty()) {
            final JsonArray a = new JsonArray();
            dupes.forEach(a::add);
            o.add("dupes", a);
        }
        if (standard != null) {
            o.addProperty("standard", standard);
        }
        return o;
    }
}

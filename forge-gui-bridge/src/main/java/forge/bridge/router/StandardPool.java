package forge.bridge.router;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Standard as the lobby judges it, without a card database: the card names printed in the sets Forge's
 * {@code res/formats/Sanctioned/Standard.txt} lists (read from {@code res/editions/*.txt}), less its banlist, plus four
 * copies at most (a card script's "any number" or {@code DeckLimit} raises that). The game checks the deck again with
 * Forge's own rules when it starts; this only greys out what clearly isn't Standard. Reloaded when Standard.txt changes.
 */
public final class StandardPool {

    /** The collector-numbered sections of an edition file (forge-core's CardEdition.EditionSectionWithCollectorNumbers). */
    private static final Set<String> CARD_SECTIONS = Set.of("cards", "special slot", "precon product", "borderless", "etched",
            "showcase", "full art", "extended art", "alternate art", "retro frame", "buy a box", "promo", "prerelease promo",
            "bundle", "box topper", "jumpstart", "rebalanced", "eternal", "conjured", "scheme", "printsheets");
    /** An edition's card line, as forge-core's CardEdition reads it: [number] [rarity] name [@artist] [${params}]. */
    private static final Pattern EDITION_CARD = Pattern.compile("(^(.?[0-9A-Z-]+\\S*[A-Z]*)\\s)?(([SCURML])\\s)?([^@$]+)( @([^$]*))?( \\$\\{(.+)\\})?$");
    private static final Pattern DECK_LIMIT = Pattern.compile("^K:DeckLimit:(\\d+):", Pattern.MULTILINE);
    private static final String ANY_NUMBER = "K:A deck can have any number of cards named";
    static final int MIN_CARDS = 60;
    static final int MAX_COPIES = 4;
    static final int MAX_SIDEBOARD = 15;

    private final Path res;
    private Object loadedAt;
    private Set<String> legal;
    private Set<String> banned;
    private final Map<String, Integer> limits = new HashMap<>();
    private final CardScripts scripts;

    /** @param res Forge's {@code res} folder */
    public StandardPool(final Path res) {
        this(res, new CardScripts(res));
    }

    /** As above, reading card scripts with {@code scripts} (shared with the deck peek). */
    public StandardPool(final Path res, final CardScripts scripts) {
        this.res = res;
        this.scripts = scripts;
    }

    /** The res/ folder this reads. */
    Path res() {
        return res;
    }

    /** Whether Standard could be read (and so {@link #problem} judges anything). */
    public synchronized boolean ready() {
        reload();
        return legal != null;
    }

    /**
     * Why a deck (its file's sections, {@link DeckSummary#sections}) isn't Standard, in one short line, or null when it
     * looks legal or Standard couldn't be read. A deck with a commander is never judged here.
     */
    public synchronized String problem(final Map<String, Map<String, Integer>> sections) {
        reload();
        if (legal == null) {
            return null;
        }
        final Map<String, Integer> main = section(sections, "main");
        final Map<String, Integer> side = section(sections, "sideboard");
        final int count = main.values().stream().mapToInt(Integer::intValue).sum();
        if (count < MIN_CARDS) {
            return count + " cards: Standard needs " + MIN_CARDS;
        }
        final int sideCount = side.values().stream().mapToInt(Integer::intValue).sum();
        if (sideCount > MAX_SIDEBOARD) {
            return sideCount + " sideboard cards: Standard allows " + MAX_SIDEBOARD;
        }
        final Map<String, Integer> all = new LinkedHashMap<>(main);
        side.forEach((k, v) -> all.merge(k, v, Integer::sum));
        final List<String> out = new ArrayList<>();
        final List<String> ban = new ArrayList<>();
        final List<String> many = new ArrayList<>();
        for (final Map.Entry<String, Integer> e : all.entrySet()) {
            final String name = e.getKey();
            if (DeckSummary.basicColor(name) != null) {
                continue;
            }
            final String k = key(name);
            final String front = front(k);
            if (banned.contains(k) || banned.contains(front)) {
                ban.add(name);
            } else if (!legal.contains(k) && !legal.contains(front)) {
                out.add(name);
            } else if (e.getValue() > MAX_COPIES && e.getValue() > limit(name)) {
                many.add(name);
            }
        }
        if (!out.isEmpty()) {
            return (out.size() == 1 ? "1 card isn’t" : out.size() + " cards aren’t") + " in Standard: " + list(out);
        }
        if (!ban.isEmpty()) {
            return "Banned in Standard: " + list(ban);
        }
        if (!many.isEmpty()) {
            return "More than " + MAX_COPIES + " copies: " + list(many);
        }
        return null;
    }

    private static Map<String, Integer> section(final Map<String, Map<String, Integer>> sections, final String name) {
        return sections.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase(name)).map(Map.Entry::getValue)
                .findFirst().orElse(Map.of());
    }

    /** "A, B and 3 more". */
    static String list(final List<String> names) {
        if (names.size() <= 2) {
            return String.join(names.size() == 2 ? " and " : "", names);
        }
        return names.get(0) + ", " + names.get(1) + " and " + (names.size() - 2) + " more";
    }

    private static String key(final String name) {
        return name.strip().toLowerCase(Locale.ROOT);
    }

    /** A split or room card's first half ("fire // ice" → "fire"); the name itself otherwise. */
    private static String front(final String key) {
        final int i = key.indexOf(" // ");
        return i < 0 ? key : key.substring(0, i);
    }

    /** How many copies a card allows, from its script ({@link CardScripts}): any number, its DeckLimit, else four (also when unreadable). */
    private int limit(final String name) {
        return limits.computeIfAbsent(name, n -> {
            final String s = scripts.text(n);
            if (s == null) {
                return MAX_COPIES;
            }
            if (s.contains(ANY_NUMBER)) {
                return Integer.MAX_VALUE;
            }
            final Matcher m = DECK_LIMIT.matcher(s);
            return m.find() ? Integer.parseInt(m.group(1)) : MAX_COPIES;
        });
    }

    /** A card script's file name: "Sphinx's Approach" → sphinxs_approach, "Nazgûl" → nazgul, "Fire // Ice" → fire_ice. */
    static String scriptName(final String name) {
        final String plain = Normalizer.normalize(name, Normalizer.Form.NFD).replaceAll("\\p{M}", "").toLowerCase(Locale.ROOT)
                .replaceAll("['’]", "");
        return plain.replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
    }

    /** Re-read when Standard.txt changes; unreadable leaves {@link #legal} null. */
    private void reload() {
        final Path format = res.resolve("formats").resolve("Sanctioned").resolve("Standard.txt");
        Object stamp;
        try {
            stamp = Files.getLastModifiedTime(format);
        } catch (final IOException e) {
            stamp = null;
        }
        if (stamp == null) {
            legal = null;
            banned = null;
            loadedAt = null;
            return;
        }
        if (stamp.equals(loadedAt)) {
            return;
        }
        loadedAt = stamp;
        legal = null;
        banned = null;
        try {
            final Map<String, String> f = keyValues(Files.readAllLines(format, StandardCharsets.UTF_8));
            final Set<String> codes = new HashSet<>();
            for (final String c : f.getOrDefault("sets", "").split(",")) {
                if (!c.isBlank()) {
                    codes.add(c.strip().toUpperCase(Locale.ROOT));
                }
            }
            if (codes.isEmpty()) {
                return;
            }
            final Set<String> l = new HashSet<>();
            names(f.get("additional")).forEach(n -> addName(l, n));
            final Set<String> found = new HashSet<>();
            try (Stream<Path> files = Files.list(res.resolve("editions"))) {
                for (final Path p : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".txt"))::iterator) {
                    readEdition(p, codes, l, found);
                }
            }
            if (found.isEmpty()) {
                return; // no edition files for Standard's sets: can't judge
            }
            final Set<String> b = new HashSet<>();
            names(f.get("banned")).forEach(n -> b.add(key(n)));
            legal = l;
            banned = b;
        } catch (final IOException | RuntimeException e) {
            legal = null;
            banned = null;
        }
    }

    /** An edition file's card names into {@code legal}, when its Code is one of {@code codes}. */
    private static void readEdition(final Path p, final Set<String> codes, final Set<String> legal, final Set<String> found) throws IOException {
        if (Files.size(p) > 4 * 1024 * 1024) {
            return;
        }
        try (java.io.BufferedReader r = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
            readEdition(r, codes, legal, found);
        }
    }

    /** Reads only as far as the metadata's Code for a set that isn't Standard's. */
    private static void readEdition(final java.io.BufferedReader r, final Set<String> codes, final Set<String> legal, final Set<String> found)
            throws IOException {
        String section = "";
        boolean ours = false;
        for (String raw = r.readLine(); raw != null; raw = r.readLine()) {
            final String line = raw.strip();
            if (line.startsWith("[") && line.endsWith("]")) {
                section = line.substring(1, line.length() - 1).strip().toLowerCase(Locale.ROOT);
                continue;
            }
            if (section.equals("metadata")) {
                if (line.regionMatches(true, 0, "Code=", 0, 5)) {
                    ours = codes.contains(line.substring(5).strip().toUpperCase(Locale.ROOT));
                    if (!ours) {
                        return;
                    }
                    found.add(line.substring(5).strip());
                }
                continue;
            }
            if (!ours || !CARD_SECTIONS.contains(section) || line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            final Matcher m = EDITION_CARD.matcher(line);
            if (m.matches() && m.group(5) != null) {
                addName(legal, m.group(5).split("\\|", 2)[0]);
            }
        }
    }

    private static void addName(final Set<String> legal, final String name) {
        final String k = key(name);
        if (!k.isEmpty()) {
            legal.add(k);
            legal.add(front(k));
        }
    }

    private static List<String> names(final String semicolons) {
        final List<String> out = new ArrayList<>();
        if (semicolons != null) {
            for (final String n : semicolons.split(";")) {
                if (!n.isBlank()) {
                    out.add(n.strip());
                }
            }
        }
        return out;
    }

    /** "Key:value" lines (keys lower-cased), as Forge's format files are written. */
    private static Map<String, String> keyValues(final List<String> lines) {
        final Map<String, String> out = new HashMap<>();
        for (final String line : lines) {
            final int i = line.indexOf(':');
            if (i > 0) {
                out.put(line.substring(0, i).strip().toLowerCase(Locale.ROOT), line.substring(i + 1).strip());
            }
        }
        return out;
    }
}

package forge.bridge.router;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Forge's card scripts by card name, without a card database: {@code res/cardsfolder}'s per-letter folders, or the
 * {@code cardsfolder.zip} a release ships there instead. A script's file is its name's {@link StandardPool#scriptName}
 * ("fire_ice"), or that plus the other faces' ("delver_of_secrets_insectile_aberration"), so a miss tries the files that
 * start with it and keeps the one whose first {@code Name:} is the card's. Indexed on first use, again when the zip changes (or while there are no scripts at all).
 */
public final class CardScripts {

    /** A card as the deck peek shows it: its group, mana value and cost ({@code {2}{R}{R}}, "" for none). */
    public record Info(String type, int cmc, String cost) { }

    /** The groups, a card in the first that its front face's types name. */
    static final String[] GROUPS = {"Creature", "Planeswalker", "Battle", "Land", "Instant", "Sorcery", "Artifact", "Enchantment"};
    private static final int MAX_SCRIPT = 64 * 1024;
    private static final int MAX_CACHED = 5_000;

    private final Path dir;
    private FileTime indexedAt;
    private ZipFile zip;
    /** By file name less ".txt": the zip's entry name, or the file. */
    private TreeMap<String, Object> index;
    private final Map<String, String> texts = new LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(final Map.Entry<String, String> e) {
            return size() > MAX_CACHED;
        }
    };

    /** @param res Forge's {@code res} folder */
    public CardScripts(final Path res) {
        this.dir = res.resolve("cardsfolder");
    }

    /** Card {@code name}'s script, or null: no such card, too big, or unreadable. */
    public synchronized String text(final String name) {
        reindex();
        final String stem = StandardPool.scriptName(name);
        if (index == null || stem.isEmpty()) {
            return null;
        }
        final String key = name.strip().toLowerCase(Locale.ROOT);
        if (texts.containsKey(key)) {
            return texts.get(key);
        }
        String found = null;
        final Object exact = index.get(stem);
        if (exact != null) {
            found = read(exact);
        } else {
            int tries = 0;
            for (final Object o : index.subMap(stem + "_", stem + "_￿").values()) {
                final String s = read(o);
                if (s != null && key.equals(firstName(s))) {
                    found = s;
                    break;
                }
                if (++tries >= 20) {
                    break;
                }
            }
        }
        texts.put(key, found);
        return found;
    }

    /** {@link #text}, read as the deck peek shows it; null when there is no script. */
    public Info info(final String name) {
        final String s = text(name);
        return s == null ? null : parse(s);
    }

    /** A script's group, mana value and cost: its front face's, both halves' for a split card. */
    static Info parse(final String script) {
        final String[] faces = script.split("\\r?\\nALTERNATE\\r?\\n", 2);
        final Map<String, String> front = fields(faces[0]);
        String cost = braces(front.get("manacost"));
        int cmc = cmc(front.get("manacost"));
        if (faces.length > 1 && "split".equalsIgnoreCase(front.getOrDefault("alternatemode", ""))) {
            final String back = fields(faces[1]).get("manacost");
            cost = cost + " // " + braces(back);
            cmc += cmc(back);
        }
        return new Info(group(front.getOrDefault("types", "")), cmc, cost);
    }

    /** The first of {@link #GROUPS} the types line names, else "Other". */
    static String group(final String types) {
        final java.util.Set<String> words = new java.util.HashSet<>(java.util.Arrays.asList(types.split("\\s+")));
        for (final String g : GROUPS) {
            if (words.contains(g)) {
                return g;
            }
        }
        return "Other";
    }

    /** Forge's "2 R R" as "{2}{R}{R}"; "no cost" (or none) as "". */
    static String braces(final String cost) {
        if (cost == null || cost.isBlank() || cost.strip().equalsIgnoreCase("no cost")) {
            return "";
        }
        final StringBuilder b = new StringBuilder();
        for (final String t : cost.strip().split("\\s+")) {
            b.append('{').append(t).append('}');
        }
        return b.toString();
    }

    /** A Forge cost's mana value: a number counts as itself, X as 0, any other symbol (a hybrid "2/W" as 2) as 1. */
    static int cmc(final String cost) {
        if (cost == null || cost.isBlank() || cost.strip().equalsIgnoreCase("no cost")) {
            return 0;
        }
        int n = 0;
        for (final String t : cost.strip().split("\\s+")) {
            final String first = t.split("/", 2)[0];
            if (first.matches("\\d+")) {
                n += Integer.parseInt(first);
            } else if (!t.equalsIgnoreCase("X") && !t.equalsIgnoreCase("Y") && !t.equalsIgnoreCase("Z")) {
                n++;
            }
        }
        return n;
    }

    /** "Key:value" lines of one face, keys lower-cased; the first of each wins. */
    private static Map<String, String> fields(final String face) {
        final Map<String, String> out = new java.util.HashMap<>();
        for (final String line : face.split("\\r?\\n")) {
            final int i = line.indexOf(':');
            if (i > 0) {
                out.putIfAbsent(line.substring(0, i).strip().toLowerCase(Locale.ROOT), line.substring(i + 1).strip());
            }
        }
        return out;
    }

    private static String firstName(final String script) {
        final String n = fields(script.split("\\r?\\nALTERNATE\\r?\\n", 2)[0]).get("name");
        return n == null ? null : n.strip().toLowerCase(Locale.ROOT);
    }

    private String read(final Object o) {
        try {
            if (o instanceof ZipEntry e) {
                if (e.getSize() > MAX_SCRIPT) {
                    return null;
                }
                try (InputStream in = zip.getInputStream(e)) {
                    final byte[] b = in.readNBytes(MAX_SCRIPT + 1); // an entry of unknown size (-1) is checked here
                    return b.length > MAX_SCRIPT ? null : new String(b, StandardCharsets.UTF_8);
                }
            }
            final Path p = (Path) o;
            return Files.size(p) <= MAX_SCRIPT ? Files.readString(p, StandardCharsets.UTF_8) : null;
        } catch (final IOException | RuntimeException e) {
            return null;
        }
    }

    /** (Re)build the index: the zip when there is one (again when its mtime changes), else the folders, once. */
    private void reindex() {
        final Path z = dir.resolve("cardsfolder.zip");
        FileTime stamp;
        try {
            stamp = Files.getLastModifiedTime(z);
        } catch (final IOException e) {
            stamp = null;
        }
        if (index != null && !index.isEmpty() && java.util.Objects.equals(stamp, indexedAt)) {
            return;
        }
        indexedAt = stamp;
        texts.clear();
        closeZip();
        final TreeMap<String, Object> idx = new TreeMap<>();
        try {
            if (stamp != null) {
                zip = new ZipFile(z.toFile());
                for (final Enumeration<? extends ZipEntry> en = zip.entries(); en.hasMoreElements();) {
                    final ZipEntry e = en.nextElement();
                    final String n = e.getName();
                    if (!e.isDirectory() && n.endsWith(".txt")) {
                        idx.putIfAbsent(n.substring(n.lastIndexOf('/') + 1, n.length() - 4), e);
                    }
                }
            } else if (Files.isDirectory(dir)) {
                try (Stream<Path> files = Files.walk(dir, 2)) {
                    files.filter(p -> p.getFileName().toString().endsWith(".txt")).forEach(p -> {
                        final String n = p.getFileName().toString();
                        idx.putIfAbsent(n.substring(0, n.length() - 4), p);
                    });
                }
            }
            index = idx;
        } catch (final IOException | RuntimeException e) {
            closeZip();
            index = new TreeMap<>(); // unreadable: no cards until the zip changes
        }
    }

    private void closeZip() {
        if (zip != null) {
            try {
                zip.close();
            } catch (final IOException e) {
                // nothing to do
            }
            zip = null;
        }
    }
}

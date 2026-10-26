package forge.bridge;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.ImageKeys;

/**
 * Whether the Neural opponent can be seated here: mtg-ai's lobby player and ONNX
 * Runtime on the classpath, and a model directory with {@code latest.json}. Cheap (no class init, no model
 * load). A seat that still fails later (say, no native ONNX Runtime for this OS) falls back to the Default AI
 * through {@code GamePlayerUtil}, which tells the user with a toast.
 *
 * <p>{@code decks} are the deck names the model was trained to pilot, strongest first ({@code decks} in
 * {@code latest.json}, base names of {@code .dck} files); a model that doesn't say has none.
 */
public record NeuralStatus(boolean ok, String reason, List<String> decks) {
    /** Same property and default as {@code GamePlayerUtil.NEURAL_CLASS}. */
    static final String NEURAL_CLASS = System.getProperty("forge.mtgai.neuralPlayer", "mtgai.humanseat.LobbyPlayerNeural");
    static final String ORT_CLASS = "ai.onnxruntime.OrtEnvironment";
    /** The reason when the plugin itself is missing (then the UI doesn't offer Neural at all). */
    static final String NO_PLUGIN = "no Neural AI plugin is installed with this Forge Table";
    /** The decks of models whose {@code latest.json} doesn't name any. */
    static final List<String> DEFAULT_DECKS = List.of();
    /**
     * What the UI calls the Neural AI: {@code -Dforge.table.neuralLabel}, else env {@code FT_NEURAL_LABEL}, else the
     * model's own name ({@code name} in {@code latest.json}), else "Neural". Children inherit all three from the router.
     */
    static final String LABEL = label(System.getProperty("forge.table.neuralLabel"), System.getenv("FT_NEURAL_LABEL"),
            modelName(Path.of(System.getProperty("mtgai.neural.dir", "neural"))));

    /** {@link #LABEL}, for the router's lobby (which has no game to say it). */
    public static String label() {
        return LABEL;
    }

    static String label(final String prop, final String env, final String model) {
        for (final String v : new String[] {prop, env, model}) {
            if (v != null && !v.isBlank()) {
                return v.trim();
            }
        }
        return "Neural";
    }

    /** The largest avatar picture served; a bigger file is ignored. */
    static final long AVATAR_MAX = 1024 * 1024;

    /** A picture file as last read: its bytes (null: not a usable picture), kept while its size and time stay the same. */
    private record Read(long size, long modified, byte[] bytes) { }

    private static final Map<Path, Read> AVATARS = new ConcurrentHashMap<>();

    /**
     * The Neural AI's profile picture, or null for none (the UI draws its monogram): the image file
     * {@code -Dforge.table.neuralAvatar} names, else env {@code FT_NEURAL_AVATAR}, else {@code avatar.png} or
     * {@code avatar.webp} in the model folder ({@code -Dmtgai.neural.dir}). Children inherit the settings. A file is
     * read once and again only when it changes (a stat per call). Last comes {@link #avatarCard()}, which the servers
     * fetch as card art themselves, so it isn't in these bytes.
     */
    public static byte[] avatar() {
        return avatar(System.getProperty("forge.table.neuralAvatar"), System.getenv("FT_NEURAL_AVATAR"),
                Path.of(System.getProperty("mtgai.neural.dir", "neural")));
    }

    /**
     * {@link #avatar()} from these settings. A path that is set is the only one tried; a file that is missing,
     * unreadable, over {@link #AVATAR_MAX} or not a PNG, WebP or JPEG gives none.
     */
    static byte[] avatar(final String prop, final String env, final Path modelDir) {
        for (final String v : new String[] {prop, env}) {
            if (v != null && !v.isBlank()) {
                return readAvatar(Path.of(v.trim()));
            }
        }
        for (final String name : new String[] {"avatar.png", "avatar.webp"}) {
            final byte[] b = readAvatar(modelDir.resolve(name));
            if (b != null) {
                return b;
            }
        }
        return null;
    }

    private static byte[] readAvatar(final Path p) {
        try {
            final BasicFileAttributes a = Files.readAttributes(p, BasicFileAttributes.class);
            if (!a.isRegularFile()) {
                return null;
            }
            final long modified = a.lastModifiedTime().toMillis();
            final Read last = AVATARS.get(p);
            if (last != null && last.size() == a.size() && last.modified() == modified) {
                return last.bytes();
            }
            final byte[] read = a.size() > AVATAR_MAX ? null : Files.readAllBytes(p);
            final byte[] b = read != null && read.length <= AVATAR_MAX && avatarType(read) != null ? read : null;
            if (b == null) {
                BridgeLog.warn("Neural avatar " + p + " ignored: not a PNG, WebP or JPEG of at most " + AVATAR_MAX + " bytes");
            }
            AVATARS.put(p, new Read(a.size(), modified, b));
            return b;
        } catch (final java.io.IOException | RuntimeException e) {
            return null; // missing or unreadable
        }
    }

    /**
     * The card whose art crop is the picture when no file is: {@code -Dforge.table.neuralAvatarCard}, else env
     * {@code FT_NEURAL_AVATAR_CARD}, else {@code avatar_card} from {@code latest.json}. A card name, or {@code Name|SET}
     * for a printing. Null when there is none or it isn't a plain string (no control characters, {@code ..} or
     * backslash, at most 200 characters). The setting is for installs whose model updater rewrites {@code latest.json}.
     */
    public static String avatarCard() {
        return avatarCard(System.getProperty("forge.table.neuralAvatarCard"), System.getenv("FT_NEURAL_AVATAR_CARD"),
                Path.of(System.getProperty("mtgai.neural.dir", "neural")));
    }

    static String avatarCard(final String prop, final String env, final Path dir) {
        for (final String v : new String[] {prop, env}) {
            if (v != null && !v.isBlank()) {
                return plainCard(v);
            }
        }
        return avatarCard(dir);
    }

    static String avatarCard(final Path dir) {
        try {
            final JsonElement e = JsonParser.parseString(Files.readString(dir.resolve("latest.json"))).getAsJsonObject().get("avatar_card");
            if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                return null;
            }
            return plainCard(e.getAsString());
        } catch (final java.io.IOException | RuntimeException ex) {
            return null;
        }
    }

    private static String plainCard(final String raw) {
        final String v = raw.trim();
        final boolean ok = !avatarCardName(v).isEmpty() && v.length() <= 200 && !v.contains("..") && v.indexOf('\\') < 0
                && v.chars().noneMatch(Character::isISOControl);
        return ok ? v : null;
    }

    /** The card name of an {@link #avatarCard()}: before any {@code |SET}. */
    public static String avatarCardName(final String card) {
        final int bar = card.indexOf('|');
        return (bar < 0 ? card : card.substring(0, bar)).trim();
    }

    /** The image key of an {@link #avatarCard()}, as a game asks for its crop ({@code /img/crop/<key>}). */
    public static String avatarCardKey(final String card) {
        return ImageKeys.CARD_PREFIX + card;
    }

    /**
     * Whether the servers have a picture to serve: a file ({@link #avatar()}), else the {@link #avatarCard()} when
     * {@code cardArt} (the server shows card art at all). The crop may still not be fetchable; the client then draws the monogram.
     */
    public static boolean hasAvatar(final boolean cardArt) {
        return avatar() != null || cardArt && avatarCard() != null;
    }

    /** The Content-Type of a PNG, WebP or JPEG by its first bytes; null for anything else. */
    public static String avatarType(final byte[] b) {
        if (b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0d && b[5] == 0x0a
                && b[6] == 0x1a && b[7] == 0x0a) {
            return "image/png";
        }
        if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B'
                && b[11] == 'P') {
            return "image/webp";
        }
        if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) {
            return "image/jpeg";
        }
        return null;
    }

    /** {@code name} from {@code dir/latest.json}, or null when there is none or it can't be read. */
    static String modelName(final Path dir) {
        try {
            final JsonElement e = JsonParser.parseString(Files.readString(dir.resolve("latest.json"))).getAsJsonObject().get("name");
            return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
        } catch (final java.io.IOException | RuntimeException ex) {
            return null;
        }
    }

    /** Whether the Neural AI plugin's classes are on the classpath (a model may still be missing). */
    public static boolean pluginInstalled() {
        final ClassLoader cl = NeuralStatus.class.getClassLoader();
        try {
            Class.forName(NEURAL_CLASS, false, cl);
            Class.forName(ORT_CLASS, false, cl);
            return true;
        } catch (final ClassNotFoundException | LinkageError e) {
            return false;
        }
    }

    public static NeuralStatus probe() {
        final Path dir = Path.of(System.getProperty("mtgai.neural.dir", "neural"));
        final List<String> decks = trainedDecks(dir);
        if (!pluginInstalled()) {
            return new NeuralStatus(false, NO_PLUGIN, decks);
        }
        if (!Files.isRegularFile(dir.resolve("latest.json"))) {
            return new NeuralStatus(false, "no Neural model found in " + dir.toAbsolutePath(), decks);
        }
        return new NeuralStatus(true, null, decks);
    }

    /**
     * {@code decks} from {@code dir/latest.json}: its strings, in order, without blanks or repeats. Missing, unreadable
     * or not a list of names: {@link #DEFAULT_DECKS}.
     */
    static List<String> trainedDecks(final Path dir) {
        try {
            final JsonElement e = JsonParser.parseString(Files.readString(dir.resolve("latest.json"))).getAsJsonObject().get("decks");
            if (e == null || !e.isJsonArray()) {
                return DEFAULT_DECKS;
            }
            final List<String> out = new ArrayList<>();
            for (final JsonElement d : e.getAsJsonArray()) {
                if (d.isJsonPrimitive() && d.getAsJsonPrimitive().isString()) {
                    final String n = d.getAsString().trim().replaceAll("(?i)\\.dck$", "");
                    if (!n.isEmpty() && out.stream().noneMatch(n::equalsIgnoreCase)) {
                        out.add(n);
                    }
                }
            }
            return out.isEmpty() ? DEFAULT_DECKS : List.copyOf(out);
        } catch (final java.io.IOException | RuntimeException ex) {
            return DEFAULT_DECKS;
        }
    }

    /**
     * The trained decks this sidecar has, spelled as in its deck list (names compare case-insensitively), strongest
     * first.
     */
    public List<String> decksIn(final Collection<String> available) {
        final List<String> out = new ArrayList<>();
        for (final String want : decks) {
            for (final String have : available) {
                if (have.equalsIgnoreCase(want)) {
                    out.add(have);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * {ok, label, avatar?, reason?, plugin?, decks}: {@code avatar} true when {@link #hasAvatar} has a picture;
     * {@code plugin} false with no plugin; {@code decks} only those in {@code available}.
     */
    public JsonObject toJson(final Collection<String> available, final boolean cardArt) {
        final JsonObject o = new JsonObject();
        o.addProperty("ok", ok);
        o.addProperty("label", LABEL);
        if (hasAvatar(cardArt)) {
            o.addProperty("avatar", true);
        }
        if (reason != null) {
            o.addProperty("reason", reason);
        }
        if (NO_PLUGIN.equals(reason)) {
            o.addProperty("plugin", false);
        }
        final JsonArray arr = new JsonArray();
        decksIn(available).forEach(arr::add);
        o.add("decks", arr);
        // The model's version and release date (latest.json "version", "released_at" when the release says).
        try {
            final JsonObject m = JsonParser.parseString(Files.readString(
                    Path.of(System.getProperty("mtgai.neural.dir", "neural")).resolve("latest.json"))).getAsJsonObject();
            if (m.has("version")) {
                o.addProperty("version", m.get("version").getAsInt());
            }
            if (m.has("released_at")) {
                o.addProperty("releasedAt", m.get("released_at").getAsString());
            }
        } catch (final java.io.IOException | RuntimeException e) {
            // no model here: nothing to show
        }
        return o;
    }
}

package forge.bridge.art;

import java.io.IOException;
import java.io.Reader;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

/**
 * Picks one image per card name from Scryfall's {@code default_cards} bulk data: the cleanest standard
 * physical printing, and among equally clean ones the newest (the old default looked dated).
 *
 * <p>Started as a port of mtg's {@code scripts/build_image_map.py} (the {@code card_images.json} spec); the
 * score is still that script's, plus these additions, which that script doesn't have: modern-frame bonus,
 * low-res/placeholder/not-yet-released/textless/playtest/acorn/Secret Lair penalties, and the
 * newest-release tie-break in place of "first seen wins". Ties on both score and date keep
 * the first seen printing, as before. Bump {@link CardArtIndex#FORMAT} whenever a rule here changes, so
 * cached maps are rebuilt once.
 */
public final class CuratedPrintings {
    /** Layouts that aren't a real card face. */
    static final Set<String> SKIP_LAYOUTS = Set.of(
            "art_series", "token", "double_faced_token", "emblem", "scheme",
            "planar", "vanguard", "augment", "host");
    /** Joke, oversized and special-art set types. */
    static final Set<String> BAD_SET_TYPES = Set.of("funny", "memorabilia", "masterpiece");
    /** Set types whose printings are stylised one-offs (Secret Lair): readable, but not the card's standard look. */
    static final Set<String> ODD_SET_TYPES = Set.of("box");
    /** Frames of 2015 and later: the look players know from current sets. */
    static final Set<String> MODERN_FRAMES = Set.of("2015", "future");
    /** Frame treatments that aren't the standard printing. */
    static final Set<String> SPECIAL_FRAME_EFFECTS = Set.of("showcase", "extendedart", "inverted", "etched", "companion");

    /** Key suffix for a double-faced card's back-face artist in {@link #artists()} ({@code "Name|back"}; no card name has a bar). */
    static final String BACK = "|back";

    private record Best(int score, String released, String url, String artist, String backArtist) { }

    private final Map<String, Best> best = new HashMap<>();
    private final String today;
    private int seen;

    public CuratedPrintings() {
        this(LocalDate.now());
    }

    /** @param today printings releasing after this are previews (spoiled cards, often with placeholder scans) */
    public CuratedPrintings(final LocalDate today) {
        this.today = today.toString();
    }

    /** The normal-size image of a printing: top-level first, else the first face that has one (DFCs). */
    static String imageOf(final JsonObject card) {
        final String top = str(obj(card, "image_uris"), "normal");
        if (top != null) {
            return top;
        }
        final JsonArray faces = arr(card, "card_faces");
        if (faces != null) {
            for (final JsonElement f : faces) {
                if (f.isJsonObject()) {
                    final String u = str(obj(f.getAsJsonObject(), "image_uris"), "normal");
                    if (u != null) {
                        return u;
                    }
                }
            }
        }
        return null;
    }

    /** Who painted the face {@link #imageOf} picks: the printing's own {@code artist}, else the first face with an image. */
    static String artistOf(final JsonObject card) {
        final String top = str(card, "artist");
        if (top != null) {
            return top;
        }
        final JsonArray faces = arr(card, "card_faces");
        if (faces != null) {
            for (final JsonElement f : faces) {
                if (f.isJsonObject() && obj(f.getAsJsonObject(), "image_uris") != null) {
                    return str(f.getAsJsonObject(), "artist");
                }
            }
        }
        return null;
    }

    /** The back face's artist of a double-faced printing (faces with their own images), else null. */
    static String backArtistOf(final JsonObject card) {
        final JsonArray faces = arr(card, "card_faces");
        if (faces == null || faces.size() < 2 || !faces.get(1).isJsonObject()) {
            return null;
        }
        final JsonObject back = faces.get(1).getAsJsonObject();
        return obj(back, "image_uris") != null ? str(back, "artist") : null;
    }

    /** Higher is a cleaner, more standard printing; null means never use this printing. */
    static Integer score(final JsonObject card) {
        return score(card, LocalDate.now().toString());
    }

    /** @param today ISO date; a printing releasing after it is a preview */
    static Integer score(final JsonObject card, final String today) {
        if (in(SKIP_LAYOUTS, str(card, "layout"))) {
            return null;
        }
        int s = 0;
        if ("en".equals(str(card, "lang"))) {
            s += 1000; // language dominates: always prefer the English face
        }
        if (in(BAD_SET_TYPES, str(card, "set_type"))) {
            s -= 1000;
        }
        if (in(ODD_SET_TYPES, str(card, "set_type"))) {
            s -= 150;
        }
        if (bool(card, "oversized")) {
            s -= 1000;
        }
        if (bool(card, "promo")) {
            s -= 200;
        }
        if (bool(card, "digital")) {
            s -= 200;
        }
        if (contains(arr(card, "promo_types"), "universesbeyond")) {
            s -= 5000;
        }
        if ("triangle".equals(str(card, "security_stamp"))) {
            s -= 5000;
        }
        if ("acorn".equals(str(card, "security_stamp")) || contains(arr(card, "promo_types"), "playtest")) {
            s -= 1000; // not a real, legal card
        }
        if (bool(card, "textless")) {
            s -= 300; // no rules text on the face: useless at card size
        }
        final String status = str(card, "image_status");
        if ("missing".equals(status) || "placeholder".equals(status)) {
            s -= 1000; // a "no image yet" stand-in, never the art
        } else if ("lowres".equals(status)) {
            s -= 50;
        }
        final String released = str(card, "released_at");
        if (released != null && released.compareTo(today) > 0) {
            s -= 150; // spoiled but not out yet: usually a rough scan
        }
        if (in(MODERN_FRAMES, str(card, "frame"))) {
            s += 50;
        }
        final JsonArray frames = arr(card, "frame_effects");
        if (frames != null) {
            for (final String fx : SPECIAL_FRAME_EFFECTS) {
                if (contains(frames, fx)) {
                    s -= 100;
                    break;
                }
            }
        }
        if (bool(card, "full_art")) {
            s -= 100;
        }
        if ("borderless".equals(str(card, "border_color"))) {
            s -= 100;
        }
        if ("black".equals(str(card, "border_color"))) {
            s += 20;
        }
        if (bool(card, "highres_image")) {
            s += 10;
        }
        if (!bool(card, "digital")) {
            s += 5;
        }
        return s;
    }

    /** Offer one printing, in bulk-file order. */
    public void accept(final JsonObject card) {
        seen++;
        final String name = str(card, "name");
        if (name == null) {
            return;
        }
        final String url = imageOf(card);
        if (url == null) {
            return;
        }
        final Integer sc = score(card, today);
        if (sc == null) {
            return;
        }
        final String released = str(card, "released_at") == null ? "" : str(card, "released_at");
        final String artist = artistOf(card);
        final String backArtist = backArtistOf(card);
        offer(name, sc, released, url, artist, backArtist);
        // Also index the front face of "A // B" (split, adventure, DFC) under "A".
        final int sep = name.indexOf(" // ");
        if (sep >= 0) {
            offer(name.substring(0, sep).trim(), sc, released, url, artist, backArtist);
        }
    }

    /** A higher score wins; at equal score the later release (ISO dates sort as text); still equal, the first seen stays. */
    private void offer(final String name, final int sc, final String released, final String url, final String artist, final String backArtist) {
        final Best cur = best.get(name);
        if (cur == null || sc > cur.score || sc == cur.score && released.compareTo(cur.released) > 0) {
            best.put(name, new Best(sc, released, url, artist, backArtist));
        }
    }

    public int printingsSeen() {
        return seen;
    }

    /** name → image URL for every winner. */
    public Map<String, String> result() {
        final Map<String, String> out = new LinkedHashMap<>(best.size() * 2);
        best.forEach((n, b) -> out.put(n, b.url));
        return out;
    }

    /**
     * name → the artist of that winner's image (the credit Scryfall's terms ask for beside an art crop), with
     * {@code "Name|back"} for a double-faced winner's back face. Names without a known artist are left out.
     */
    public Map<String, String> artists() {
        final Map<String, String> out = new LinkedHashMap<>(best.size());
        best.forEach((n, b) -> {
            if (b.artist != null) {
                out.put(n, b.artist);
            }
            if (b.backArtist != null) {
                out.put(n + BACK, b.backArtist);
            }
        });
        return out;
    }

    /** Feed a whole bulk file: either a JSON array of printings ({@code .json}) or one printing per line ({@code .jsonl}). */
    public void readAll(final Reader in) throws IOException {
        final JsonReader r = new JsonReader(in);
        r.setLenient(true); // JSONL is a sequence of top-level values
        if (r.peek() == JsonToken.BEGIN_ARRAY) {
            r.beginArray();
            while (r.hasNext()) {
                acceptElement(JsonParser.parseReader(r));
            }
            r.endArray();
        } else {
            while (r.peek() != JsonToken.END_DOCUMENT) {
                acceptElement(JsonParser.parseReader(r));
            }
        }
    }

    private void acceptElement(final JsonElement e) {
        if (e != null && e.isJsonObject()) {
            accept(e.getAsJsonObject());
        }
    }

    // ---------------------------------------------------------------- Python-style lookups (missing → falsy)

    private static JsonObject obj(final JsonObject o, final String k) {
        if (o == null) {
            return null;
        }
        final JsonElement e = o.get(k);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : null;
    }

    private static JsonArray arr(final JsonObject o, final String k) {
        final JsonElement e = o.get(k);
        return e != null && e.isJsonArray() ? e.getAsJsonArray() : null;
    }

    private static String str(final JsonObject o, final String k) {
        if (o == null) {
            return null;
        }
        final JsonElement e = o.get(k);
        if (e == null || !e.isJsonPrimitive()) {
            return null;
        }
        final String s = e.getAsString();
        return s.isEmpty() ? null : s;
    }

    /** {@code Set.of} sets throw on contains(null); Python's {@code in} doesn't. */
    private static boolean in(final Set<String> set, final String v) {
        return v != null && set.contains(v);
    }

    private static boolean bool(final JsonObject o, final String k) {
        final JsonElement e = o.get(k);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
    }

    private static boolean contains(final JsonArray a, final String v) {
        if (a == null) {
            return false;
        }
        for (final JsonElement e : a) {
            if (e.isJsonPrimitive() && v.equals(e.getAsString())) {
                return true;
            }
        }
        return false;
    }
}

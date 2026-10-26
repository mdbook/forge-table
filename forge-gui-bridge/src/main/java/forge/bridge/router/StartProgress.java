package forge.bridge.router;

import java.util.List;
import java.util.function.LongSupplier;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/**
 * How far a starting game is, for the lobby's progress bar. The child prints
 * {@code FORGE_TABLE_PROGRESS {"stage":…,"pct":…}} lines while it boots ({@link forge.bridge.BootProgress}); before
 * its first line, the router knows its JVM is starting. Each stage owns a band of the bar, so the bar only moves
 * forward: a stage never goes back, a percent never drops, and the lobby's percent is the highest one shown so far.
 * Within a stage the bar also creeps towards 90 % of its band over the stage's usual length, so it never sits still
 * on steps that report nothing (Forge indexing editions, loading AI profiles).
 *
 * <p>Nothing the child prints reaches the lobby as text: stages are matched against {@link #BANDS} and the label
 * is the router's own; anything else (unknown stage, bad JSON, an overlong line) is ignored.
 */
final class StartProgress {

    /** A stage, the slice of the bar it fills and how long it usually takes (measured on a cold boot). */
    record Band(String stage, String label, int from, int to, long usualMs) { }

    static final List<Band> BANDS = List.of(
            new Band("java", "Starting Java", 0, 5, 1_500),
            new Band("cards", "Loading card database", 5, 65, 9_000),
            new Band("ai", "Preparing the AI opponent", 65, 95, 5_000),
            new Band("table", "Setting the table", 95, 99, 1_000));
    static final String PREFIX = "FORGE_TABLE_PROGRESS ";
    static final int MAX_LINE = 256;
    /** How far the creep goes within a band, in percent of it. */
    static final double CREEP_MAX = 90;

    private final LongSupplier clock;
    private int band;
    private int reported;
    private long since;
    private int shown;

    StartProgress() {
        this(System::currentTimeMillis);
    }

    StartProgress(final LongSupplier clock) {
        this.clock = clock;
        this.since = clock.getAsLong();
    }

    /** True if {@code line} is a progress line (valid or not): the caller needn't look at it further. */
    static boolean isProgress(final String line) {
        return line.startsWith(PREFIX);
    }

    /** Take one progress line from the child. Returns whether it moved anything. */
    synchronized boolean accept(final String line) {
        if (!isProgress(line) || line.length() > MAX_LINE) {
            return false;
        }
        final JsonObject o;
        try {
            final JsonElement e = JsonParser.parseString(line.substring(PREFIX.length()));
            if (!e.isJsonObject()) {
                return false;
            }
            o = e.getAsJsonObject();
        } catch (final RuntimeException e) {
            return false;
        }
        final int b = bandOf(o.get("stage"));
        if (b < 1 || b < band) { // the child never reports the JVM stage, and never goes back
            return false;
        }
        final int pct = percent(o.get("pct"));
        if (b > band) {
            band = b;
            reported = pct;
            since = clock.getAsLong();
            return true;
        }
        if (pct > reported) {
            reported = pct;
            return true;
        }
        return false;
    }

    private static int bandOf(final JsonElement stage) {
        if (stage == null || !stage.isJsonPrimitive() || !stage.getAsJsonPrimitive().isString()) {
            return -1;
        }
        final String s = stage.getAsString();
        for (int i = 0; i < BANDS.size(); i++) {
            if (BANDS.get(i).stage().equals(s)) {
                return i;
            }
        }
        return -1;
    }

    private static int percent(final JsonElement pct) {
        if (pct == null || !pct.isJsonPrimitive()) {
            return 0;
        }
        final JsonPrimitive p = pct.getAsJsonPrimitive();
        if (!p.isNumber()) {
            return 0;
        }
        final double d = p.getAsDouble();
        return Double.isNaN(d) ? 0 : (int) Math.max(0, Math.min(100, d));
    }

    /** The stage, the router's label for it, and the bar's overall percent (never lower than last time). */
    synchronized GameHost.Progress view() {
        final Band b = BANDS.get(band);
        final double usual = Math.max(1, b.usualMs());
        final double creep = CREEP_MAX * (1 - Math.exp(-(clock.getAsLong() - since) / usual));
        final double within = Math.max(reported, creep);
        final int overall = (int) (b.from() + (b.to() - b.from()) * within / 100);
        shown = Math.max(shown, Math.min(overall, b.to()));
        return new GameHost.Progress(b.stage(), b.label(), shown);
    }
}

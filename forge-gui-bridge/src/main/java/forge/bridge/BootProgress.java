package forge.bridge;

import java.io.PrintStream;
import java.util.List;
import java.util.function.LongSupplier;

import forge.gui.interfaces.IProgressBar;
import forge.util.Localizer;

/**
 * Boot progress on stdout for whoever started this sidecar (the router's lobby shows it as a progress bar):
 * {@code FORGE_TABLE_PROGRESS {"stage":"cards","pct":63}}, where {@code pct} is the percent of that stage. Stages
 * only move forward, in the order of {@link #STAGES}; a stage change is printed at once, progress within a stage at
 * most every {@link #MIN_GAP_MS}. Only with {@code --progress}: a terminal launch stays quiet.
 *
 * <p>As Forge's {@link IProgressBar} it follows the card readers: the main card folder fills the first
 * {@link #MAIN_READER_SHARE} percent of the cards stage, the token folder the rest. Forge then says it is loading
 * decks, after which come AI profiles and the Neural check, so that starts the {@code ai} stage. Calls arrive on
 * the UI thread, stage changes on the main one, hence the lock.
 */
public final class BootProgress implements IProgressBar {

    /** The stages a sidecar reports, in order. The router knows one more before them: its JVM starting. */
    public static final List<String> STAGES = List.of("cards", "ai", "table");
    static final long MIN_GAP_MS = 250;
    static final int MAIN_READER_SHARE = 80;

    private final PrintStream out;
    private final LongSupplier clock;
    private int stage = -1;
    private int pct;
    private long lastPrinted = Long.MIN_VALUE / 2;
    private int reader;
    private int maximum;
    private String decks;

    public BootProgress(final PrintStream out) {
        this(out, System::currentTimeMillis);
    }

    /** With a clock, so tests can step time. */
    BootProgress(final PrintStream out, final LongSupplier clock) {
        this.out = out;
        this.clock = clock;
    }

    /** Move on to {@code name} (one of {@link #STAGES}); a stage already passed is ignored. */
    public synchronized void stage(final String name) {
        final int i = STAGES.indexOf(name);
        if (i <= stage) {
            return;
        }
        stage = i;
        pct = 0;
        print();
    }

    /** Percent of the current stage; never goes back. */
    public synchronized void pct(final int p) {
        final int v = Math.max(0, Math.min(100, p));
        if (stage < 0 || v <= pct) {
            return;
        }
        pct = v;
        if (clock.getAsLong() - lastPrinted >= MIN_GAP_MS) {
            print();
        }
    }

    private void print() {
        lastPrinted = clock.getAsLong();
        if (out == null) {
            return;
        }
        out.println("FORGE_TABLE_PROGRESS {\"stage\":\"" + STAGES.get(stage) + "\",\"pct\":" + pct + "}");
        out.flush();
    }

    // ---------------------------------------------------------------- IProgressBar (Forge's card readers)

    @Override
    public synchronized void setDescription(final String s) {
        if (decks == null) {
            decks = Localizer.getInstance().getMessage("splash.loading.decks");
        }
        if (s != null && s.equals(decks)) {
            stage("ai");
        }
    }

    @Override
    public synchronized void setMaximum(final int maximum0) {
        maximum = maximum0;
    }

    @Override
    public synchronized int getMaximum() {
        return maximum;
    }

    @Override
    public synchronized void setValue(final int progress) {
        if (progress == 0) {
            reader++; // every reader starts with report(0, parts)
        }
        if (maximum <= 0 || stage != 0) {
            return;
        }
        final double done = Math.min(1.0, progress / (double) maximum);
        pct((int) (reader <= 1 ? done * MAIN_READER_SHARE : MAIN_READER_SHARE + done * (100 - MAIN_READER_SHARE)));
    }

    @Override public void reset() { }
    @Override public void setShowETA(final boolean b0) { }
    @Override public void setShowCount(final boolean b0) { }
    @Override public void setPercentMode(final boolean percentMode0) { }
}

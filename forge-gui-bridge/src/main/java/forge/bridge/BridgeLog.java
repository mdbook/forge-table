package forge.bridge;

import java.io.PrintStream;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/** Minimal stderr logger for the sidecar; the shell drains and rotates stderr into userdata/logs. */
public final class BridgeLog {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");
    private static volatile boolean debug = Boolean.getBoolean("forge.bridge.debug");
    private static final java.util.concurrent.atomic.AtomicInteger ERRORS = new java.util.concurrent.atomic.AtomicInteger();

    private BridgeLog() { }

    public static void setDebug(final boolean on) { debug = on; }
    public static boolean isDebug() { return debug; }

    public static void debug(final String msg) {
        if (debug) {
            write("DEBUG", msg, null);
        }
    }

    public static void info(final String msg) { write("INFO", msg, null); }
    public static void warn(final String msg) { write("WARN", msg, null); }
    public static void error(final String msg, final Throwable t) {
        ERRORS.incrementAndGet();
        write("ERROR", msg, t);
    }

    /** Errors logged since start (tests assert the bridge logged none). */
    public static int errorCount() { return ERRORS.get(); }

    private static void write(final String level, final String msg, final Throwable t) {
        final PrintStream err = System.err;
        synchronized (err) {
            err.println(LocalTime.now().format(TIME) + " [" + Thread.currentThread().getName() + "] " + level + " " + msg);
            if (t != null) {
                t.printStackTrace(err);
            }
        }
    }
}

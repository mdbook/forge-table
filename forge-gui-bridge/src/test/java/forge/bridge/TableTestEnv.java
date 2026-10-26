package forge.bridge;

import java.io.File;
import java.net.URISyntaxException;
import java.net.URL;

/**
 * Boots Forge headless once per test JVM (surefire fork) and hands out fresh sidecar servers.
 * Uses {@code --test-prefs}; user.home points into target/ (pom).
 */
public final class TableTestEnv {
    private TableTestEnv() { }

    public static File decksDir() {
        final URL url = TableTestEnv.class.getClassLoader().getResource("table/decks");
        if (url == null) {
            throw new IllegalStateException("table/decks fixtures missing from the test classpath");
        }
        try {
            return new File(url.toURI());
        } catch (final URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    public static BridgeApp.Options options() {
        final BridgeApp.Options o = new BridgeApp.Options();
        o.assetsDir = System.getProperty("forge.bridge.assets", "../forge-gui/");
        o.deckDirs.add(decksDir().getAbsolutePath());
        o.testPrefs = true;
        o.deck = "mono-red-madness";
        o.oppDeck = "mono-blue-faeries";
        o.ai = "Default";
        return o;
    }

    /** A new server on an ephemeral port, sharing the process-wide Forge model. */
    public static Main.Running start() throws Exception {
        return Main.boot(options());
    }
}

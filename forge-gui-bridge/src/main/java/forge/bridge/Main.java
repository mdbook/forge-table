package forge.bridge;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.StandardOpenOption;
import java.security.SecureRandom;
import java.util.HexFormat;

import com.google.gson.JsonObject;

import forge.bridge.net.BridgeServer;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgePreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.util.BuildInfo;

/**
 * Forge Table sidecar entry point.
 *
 * <pre>
 * java @forge-table.args forge.bridge.Main [--port N] [--open-browser] [--assets DIR] [--web DIR]
 *      [--decks DIR] [--deck NAME] [--opp-deck NAME] [--ai PROFILE] [--state FILE] [--speed X] [--record FILE]
 *      [--card-art curated|printed|off] [--card-image-map FILE] [--progress] [--pvp [--seat1-decks DIR]] [--format constructed|standard|brawl]
 *      [--checkpoint FILE [--resume]]
 * java @forge-table.args forge.bridge.Main --router …   (many games: see {@link forge.bridge.router.Router}; first argument)
 * java @forge-table.args forge.bridge.Main --users …    (native sign-in's accounts: see {@link forge.bridge.auth.UsersCli})
 * </pre>
 *
 * Prints one line, {@code FORGE_TABLE_READY {json}}, on stdout once the server is listening. The session
 * token is only ever printed there (never taken from argv, where {@code ps} would show it). With {@code --progress}
 * (the router passes it) boot progress comes first, as {@code FORGE_TABLE_PROGRESS {json}} lines ({@link BootProgress}). The process
 * exits when stdin reaches EOF, so it can never outlive the shell that spawned it.
 */
public final class Main {
    private Main() { }

    /** A running sidecar (server + app), as returned by {@link #boot}. */
    public static final class Running {
        public final BridgeApp app;
        public final BridgeServer server;
        public final String token;

        Running(final BridgeApp app, final BridgeServer server, final String token) {
            this.app = app;
            this.server = server;
            this.token = token;
        }

        public int port() {
            return server.port();
        }

        public void stop() {
            app.flushCheckpoint();
            server.stop();
        }
    }

    private static volatile BridgeGuiBase bootedBase;
    private static FileLock heldLock;

    public static void main(final String[] args) throws Exception {
        if (routerMode(args)) {
            forge.bridge.router.Router.main(args); // many games, one child sidecar each
            return;
        }
        if (args.length > 0 && "--users".equals(args[0])) { // native sign-in's accounts (--auth users)
            System.exit(forge.bridge.auth.UsersCli.main(java.util.Arrays.copyOfRange(args, 1, args.length)));
            return;
        }
        final BridgeApp.Options o = parse(args);
        final Running r = boot(o);

        final JsonObject ready = new JsonObject();
        ready.addProperty("port", r.port());
        ready.addProperty("token", r.token);
        ready.addProperty("userDir", ForgeConstants.USER_DIR);
        ready.addProperty("url", "http://127.0.0.1:" + r.port() + "/#t=" + r.token);
        System.out.println("FORGE_TABLE_READY " + Outboxes.toJson(ready));
        System.out.flush();

        // A stop by signal (the router's unit, a container) still gets the last save onto disk.
        Runtime.getRuntime().addShutdownHook(new Thread(r.app::flushCheckpoint, "checkpoint-flush"));

        if (o.openBrowser) {
            openBrowser("http://127.0.0.1:" + r.port() + "/#t=" + r.token);
        }

        // Exit with the parent: stdin EOF means the shell is gone. A plain terminal launch blocks here too.
        final Thread watchdog = new Thread(() -> {
            try (InputStream in = System.in) {
                while (in.read() != -1) {
                    // drain
                }
            } catch (final IOException ignored) {
                // treat as EOF
            }
            if (!Boolean.getBoolean("forge.table.ignoreStdin")) {
                BridgeLog.info("stdin closed; shutting down");
                r.stop();
                System.exit(0);
            }
        }, "stdin-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        Thread.currentThread().join();
    }

    /** Router mode only when {@code --router} comes first (a deck name can never switch it on). */
    public static boolean routerMode(final String[] args) {
        return args.length > 0 && "--router".equals(args[0]);
    }

    /**
     * Boot Forge headless and start a server. Forge's model is process-global, so the first call
     * initializes it and later calls (tests) reuse it with a fresh app and server.
     */
    public static synchronized Running boot(final BridgeApp.Options o) throws Exception {
        System.setProperty("java.awt.headless", "true");
        final BootProgress progress = new BootProgress(o.progress ? System.out : null);
        progress.stage("cards");
        BridgeGuiBase base = bootedBase;
        if (base == null) {
            final File assets = new File(o.assetsDir);
            if (System.getProperty("forge.table.root") != null) {
                selfCheck(assets);
            }
            base = new BridgeGuiBase(assets.getAbsolutePath(), BuildInfo.getVersionString());
            // A game behind the router keeps its data in the home the router laid out (user.home), never where the
            // build's forge.profile.properties points: the launcher layout's ../../user/ is inside the read-only
            // release on a server. Forge skips the profile file in "app directory" mode.
            if (o.namesOnly) {
                GuiBase.setUsingAppDirectory(true);
            }
            // Must precede any ForgeConstants/FModel access: ASSETS_DIR and the profile dirs derive from it.
            GuiBase.setInterface(base);

            heldLock = lockUserDir();
            if (heldLock == null) {
                System.out.println("FORGE_TABLE_ERROR {\"reason\":\"Another Forge Table is already using this user folder\"}");
                System.exit(3);
            }

            FModel.initialize(progress, prefs -> {
                if (o.testPrefs) {
                    adjustForTests(prefs);
                }
                if (prefs.getPref(FPref.PLAYER_NAME).isBlank()) {
                    prefs.setPref(FPref.PLAYER_NAME, "Player");
                }
                return null;
            });
            bootedBase = base;
        }

        progress.stage("ai"); // AI profiles are loaded by now; the app checks for Neural
        final String token = randomHex(16);
        final BridgeApp app = new BridgeApp(base, o, token, randomHex(8));
        final File web = o.webDir == null ? null : new File(o.webDir);
        progress.stage("table");
        final BridgeServer server = new BridgeServer(app, web);
        server.start(o.port);
        if (!o.testPrefs) {
            app.art().prewarm(); // load (or start building) the curated art map before the first game needs it
        }
        app.resume(); // --resume: the saved game, before anyone connects
        return new Running(app, server, token);
    }

    static BridgeApp.Options parse(final String[] args) {
        final BridgeApp.Options o = new BridgeApp.Options();
        o.assetsDir = System.getProperty("forge.bridge.assets", new File(".").getAbsolutePath());
        for (int i = 0; i < args.length; i++) {
            final String a = args[i];
            switch (a) {
                case "--port" -> o.port = Integer.parseInt(args[++i]);
                case "--open-browser" -> o.openBrowser = true;
                case "--assets" -> o.assetsDir = args[++i];
                case "--web" -> o.webDir = args[++i];
                case "--decks" -> o.deckDirs.add(args[++i]);
                case "--deck" -> o.deck = args[++i];
                case "--opp-deck" -> o.oppDeck = args[++i];
                case "--ai" -> o.ai = args[++i];
                case "--state" -> o.state = args[++i];
                case "--speed" -> o.speed = Double.parseDouble(args[++i]);
                case "--record" -> o.record = args[++i];
                case "--test-prefs" -> o.testPrefs = true;
                case "--names-only" -> o.namesOnly = true;
                case "--card-art" -> o.cardArt = args[++i];
                case "--card-image-map" -> o.cardImageMap = args[++i];
                case "--progress" -> o.progress = true;
                case "--pvp" -> o.pvp = true;
                case "--seat1-decks" -> o.seat1Decks = args[++i];
                case "--format" -> o.format = Formats.parse(args[++i]);
                case "--checkpoint" -> o.checkpoint = args[++i];
                case "--resume" -> o.resume = true;
                case "--debug" -> BridgeLog.setDebug(true);
                default -> throw new IllegalArgumentException("Unknown option " + a);
            }
        }
        return o;
    }

    /** Packaged mode (-Dforge.table.root=.): the zip layout must be intact before anything loads. */
    private static void selfCheck(final File assets) {
        final File res = new File(assets, "res");
        if (!res.isDirectory()) {
            System.out.println("FORGE_TABLE_ERROR {\"reason\":\"res/ folder not found next to Forge Table: " + res.getAbsolutePath().replace("\\", "/") + "\"}");
            System.exit(2);
        }
    }

    /** Hold USER_DIR/.forge-table.lock for the process lifetime (single writer). */
    private static FileLock lockUserDir() throws IOException {
        final File f = new File(ForgeConstants.USER_DIR, ".forge-table.lock");
        f.getParentFile().mkdirs();
        final FileChannel ch = FileChannel.open(f.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        final FileLock lock = ch.tryLock();
        if (lock == null) {
            ch.close();
        }
        return lock;
    }

    /** Deterministic, fast test configuration (only with --test-prefs, never for real profiles). */
    static void adjustForTests(final ForgePreferences prefs) {
        prefs.setPref(FPref.UI_ENABLE_ONLINE_IMAGE_FETCHER, false);
        prefs.setPref(FPref.UI_MATCHES_PER_GAME, "1");
    }

    private static String randomHex(final int bytes) {
        final byte[] b = new byte[bytes];
        new SecureRandom().nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    private static void openBrowser(final String url) {
        try {
            final String os = System.getProperty("os.name").toLowerCase();
            if (os.contains("win")) {
                new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", url).start();
            } else if (os.contains("mac")) {
                new ProcessBuilder("open", url).start();
            } else {
                new ProcessBuilder("xdg-open", url).start();
            }
        } catch (final IOException | RuntimeException e) {
            BridgeLog.warn("Could not open a browser; open " + url.replaceAll("#t=.*", "#t=…") + " yourself");
        }
    }
}

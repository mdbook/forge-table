package forge.bridge;

import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import org.jupnp.UpnpServiceConfiguration;

import forge.bridge.match.BridgeGuiGame;
import forge.gamemodes.match.HostedMatch;
import forge.gui.download.GuiDownloadService;
import forge.gui.interfaces.IGuiBase;
import forge.gui.interfaces.IGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.localinstance.skin.ISkinImage;
import forge.sound.IAudioClip;
import forge.sound.IAudioMusic;
import forge.util.FSerializableFunction;
import forge.util.ImageFetcher;

/**
 * Swing-free {@link IGuiBase} for the Forge Table sidecar.
 *
 * <p>Owns the two bridge executors: {@code bridge-ui}, the single "event dispatch thread" on which Input
 * prompts are shown and Input-scoped client actions run, and {@code bridge-svc}, a small pool for I/O and
 * background work. {@link #isGuiThread()} is true only on {@code bridge-ui}, so the engine's
 * {@code FThreads.assertExecutedByEdt} checks stay meaningful ({@link #hasNetGame()} is false).
 *
 * <p>Dialog-style calls (option/input dialogs, choices) are routed to the session's {@link DialogRouter}
 * when one is installed; otherwise they return the default value, as a headless GUI must.
 */
public final class BridgeGuiBase implements IGuiBase {

    /** Routes IGuiBase-level dialogs to the connected client. */
    public interface DialogRouter {
        /** @return the chosen option index, or {@code defaultOption} when no client can answer. */
        int showOptionDialog(String message, String title, List<String> options, int defaultOption);
        /** @return the entered text, or {@code null} for cancel. */
        String showInputDialog(String message, String title, String initialInput, List<String> inputOptions, boolean isNumeric);
        void toast(String level, String title, String message);
    }

    private final String assetsDir;
    private final String version;
    private final ExecutorService ui;
    private final ExecutorService svc;
    private volatile Thread uiThread;
    private volatile DialogRouter dialogRouter;
    private volatile BridgeGuiGame.Factory guiGameFactory;
    private volatile Runnable afterUiTask;

    public BridgeGuiBase(final String assetsDir, final String version) {
        this.assetsDir = assetsDir.endsWith(File.separator) || assetsDir.endsWith("/") ? assetsDir : assetsDir + File.separator;
        this.version = version;
        this.ui = Executors.newSingleThreadExecutor(runnable -> {
            final Thread t = new Thread(runnable, "bridge-ui");
            t.setDaemon(true);
            uiThread = t;
            return t;
        });
        this.svc = Executors.newFixedThreadPool(4, namedDaemons("bridge-svc"));
        // Start the UI thread eagerly so isGuiThread() is well-defined before the first task.
        final CountDownLatch started = new CountDownLatch(1);
        ui.execute(started::countDown);
        try {
            started.await();
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static ThreadFactory namedDaemons(final String prefix) {
        final AtomicInteger n = new AtomicInteger();
        return runnable -> {
            final Thread t = new Thread(runnable, prefix + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    public ExecutorService uiExecutor() { return ui; }
    public ExecutorService serviceExecutor() { return svc; }

    public void setDialogRouter(final DialogRouter router) { this.dialogRouter = router; }
    public void setGuiGameFactory(final BridgeGuiGame.Factory factory) { this.guiGameFactory = factory; }

    /** Runs on bridge-ui after every task, e.g. to flush the accumulated prompt bar. */
    public void setAfterUiTask(final Runnable hook) { this.afterUiTask = hook; }

    @Override public boolean isRunningOnDesktop() { return true; }
    @Override public boolean isLibgdxPort() { return false; }
    @Override public String getCurrentVersion() { return version; }

    @Override
    public void invokeInEdtNow(final Runnable runnable) {
        runnable.run();
    }

    @Override
    public void invokeInEdtLater(final Runnable runnable) {
        ui.execute(uiTask(runnable));
    }

    private Runnable uiTask(final Runnable r) {
        return () -> {
            try {
                r.run();
            } catch (final Throwable t) {
                BridgeLog.error("Uncaught exception on bridge-ui", t);
            } finally {
                final Runnable hook = afterUiTask;
                if (hook != null) {
                    try {
                        hook.run();
                    } catch (final Throwable t) {
                        BridgeLog.error("After-task hook failed", t);
                    }
                }
            }
        };
    }

    @Override
    public void invokeInEdtAndWait(final Runnable proc) {
        if (isGuiThread()) {
            proc.run();
            return;
        }
        final CountDownLatch done = new CountDownLatch(1);
        final RuntimeException[] failure = new RuntimeException[1];
        ui.execute(uiTask(() -> {
            try {
                proc.run();
            } catch (final RuntimeException e) {
                failure[0] = e;
            } finally {
                done.countDown();
            }
        }));
        try {
            done.await();
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (failure[0] != null) {
            throw failure[0];
        }
    }

    @Override
    public void runBackgroundTask(final String message, final Runnable task) {
        svc.execute(guard(task));
    }

    @Override
    public boolean isGuiThread() {
        return Thread.currentThread() == uiThread;
    }

    private static Runnable guard(final Runnable r) {
        return () -> {
            try {
                r.run();
            } catch (final Throwable t) {
                BridgeLog.error("Uncaught exception on " + Thread.currentThread().getName(), t);
            }
        };
    }

    @Override public String getAssetsDir() { return assetsDir; }
    @Override public ImageFetcher getImageFetcher() { return null; }
    @Override public ISkinImage getSkinIcon(final FSkinProp skinProp) { return null; }
    @Override public ISkinImage getUnskinnedIcon(final String path) { return null; }
    @Override public ISkinImage getCardArt(final PaperCard card, final boolean backFace) { return null; }
    @Override public ISkinImage createLayeredImage(final PaperCard card, final FSkinProp background, final String overlayFilename, final float opacity) { return null; }
    @Override public void clearImageCache() { }
    @Override public String encodeSymbols(final String str, final boolean formatReminderText) { return str; }
    // Legacy avatar and sleeve sprites are WotC art and are never used by Forge Table.
    @Override public int getAvatarCount() { return 0; }
    @Override public int getSleevesCount() { return 0; }
    @Override public float getScreenScale() { return 1.0f; }
    @Override public void preventSystemSleep(final boolean preventSleep) { }
    @Override public void download(final GuiDownloadService service, final Consumer<Boolean> callback) { callback.accept(false); }

    @Override
    public void copyToClipboard(final String text) {
        final DialogRouter r = dialogRouter;
        if (r != null) {
            r.toast("clipboard", "", text);
        }
    }

    @Override
    public void browseToUrl(final String url) {
        final DialogRouter r = dialogRouter;
        if (r != null) {
            r.toast("openUrl", "", url);
        }
    }

    @Override public void showCardList(final String title, final String message, final List<PaperCard> list) { }
    @Override public boolean showBoxedProduct(final String title, final String message, final List<PaperCard> list) { return false; }

    @Override
    public void showBugReportDialog(final String title, final String text, final boolean showExitAppBtn) {
        BridgeLog.error(title + "\n" + text, null);
        final DialogRouter r = dialogRouter;
        if (r != null) {
            r.toast("error", title, "Forge hit an internal error; details are in the log.");
        }
    }

    @Override public void showImageDialog(final ISkinImage image, final String message, final String title) { }

    @Override
    public int showOptionDialog(final String message, final String title, final FSkinProp icon, final List<String> options, final int defaultOption) {
        final DialogRouter r = dialogRouter;
        if (r == null) {
            BridgeLog.info("showOptionDialog without a client, defaulting: " + title + ": " + message);
            return defaultOption;
        }
        return r.showOptionDialog(message, title, options, defaultOption);
    }

    @Override
    public String showInputDialog(final String message, final String title, final FSkinProp icon, final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
        final DialogRouter r = dialogRouter;
        if (r == null) {
            return initialInput;
        }
        return r.showInputDialog(message, title, initialInput, inputOptions, isNumeric);
    }

    @Override public String showFileDialog(final String title, final String defaultDir) { return null; }
    @Override public File getSaveFile(final File defaultFile) { return null; }

    @Override
    public <T> List<T> order(final String title, final String top, final int remainingObjectsMin, final int remainingObjectsMax, final List<T> sourceChoices, final List<T> destChoices) {
        final List<T> result = new ArrayList<>();
        if (destChoices != null) {
            result.addAll(destChoices);
        }
        return result;
    }

    @Override
    public <T> List<T> getChoices(final String message, final int min, final int max, final Collection<T> choices, final Collection<T> selected, final FSerializableFunction<T, String> display) {
        final List<T> result = new ArrayList<>();
        if (selected != null) {
            result.addAll(selected);
        }
        if (result.size() < min) {
            for (final T c : choices) {
                if (result.size() >= min) {
                    break;
                }
                if (!result.contains(c)) {
                    result.add(c);
                }
            }
        }
        return result;
    }

    @Override public PaperCard chooseCard(final String title, final String message, final List<PaperCard> list) { return list.isEmpty() ? null : list.get(0); }

    // The client plays all audio.
    @Override public boolean isSupportedAudioFormat(final File file) { return false; }
    @Override public IAudioClip createAudioClip(final String filename) { return null; }
    @Override public IAudioMusic createAudioMusic(final String filename) { return null; }
    @Override public void startAltSoundSystem(final String filename, final boolean isSynchronized) { }

    @Override public void showSpellShop() { }
    @Override public void showBazaar() { }

    @Override
    public IGuiGame getNewGuiGame() {
        final BridgeGuiGame.Factory f = guiGameFactory;
        return f == null ? null : f.create();
    }

    @Override public HostedMatch hostMatch() { return new HostedMatch(); }
    @Override public UpnpServiceConfiguration getUpnpPlatformService() { return null; }
    // false keeps FThreads.assertExecutedByEdt active, so the game thread can never be bridge-ui.
    @Override public boolean hasNetGame() { return false; }
}

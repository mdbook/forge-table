package forge.bridge.art;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.Writer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.zip.GZIPInputStream;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import forge.bridge.BridgeLog;

/**
 * The curated {@code card name → Scryfall image URL} map ({@link CuratedPrintings}), kept as
 * {@code card_images.v<FORMAT>.json} in the table cache. Loaded from disk when present; otherwise built once from
 * Scryfall's {@code default_cards} bulk file, streamed (about 80 MB compressed) and never stored whole.
 * A map older than {@link #MAX_AGE} is rebuilt in the background while the old one stays in use. A map the
 * user supplies ({@code --card-image-map}) is used as-is and never rebuilt.
 *
 * <p>The same build also writes {@code card_artists.v<FORMAT>.json} ({@code card name → artist}, see
 * {@link CuratedPrintings#artists()}) for the credit under an art crop. A built map from before that file existed is
 * rebuilt in the background (the old one stays in use meanwhile); a user-supplied map has no artists.
 *
 * <p>Router mode runs one process per game over one shared cache, so a background rebuild is claimed across
 * processes: {@code card_images.building.lock} (created atomically, taken over once older than {@link #LOCK_TTL})
 * while one runs, and {@code card_images.failed} (its mtime) after a failed build, which holds every process
 * off for {@link #BACKOFF}. Without them each game would re-stream the 80 MB bulk file.
 */
public final class CardArtIndex {
    static final String BULK_META = "https://api.scryfall.com/bulk-data/default-cards";
    static final Duration MAX_AGE = Duration.ofDays(30);
    /** A rebuild lock older than this is a dead process's (the bulk download itself gives up after 10 minutes). */
    static final Duration LOCK_TTL = Duration.ofMinutes(15);
    /** After a failed build nobody retries for this long. */
    static final Duration BACKOFF = Duration.ofMinutes(30);
    /**
     * Version of the picking rules ({@link CuratedPrintings}). It is part of the built map's file name, so a
     * map made by older rules is simply never found and the map is rebuilt once. Bump it with any rule change.
     */
    static final int FORMAT = 2;

    /** Where this service keeps the map it builds: {@code card_images.v<FORMAT>.json} ({@code card_images.json} was format 1). */
    public static Path builtFile(final Path tableCache) {
        return tableCache.resolve("card_images.v" + FORMAT + ".json");
    }

    private static final String ARTISTS_NAME = "card_artists.v" + FORMAT + ".json";

    /** Where this service keeps the artists it builds, next to {@link #builtFile}. */
    public static Path builtArtistsFile(final Path tableCache) {
        return tableCache.resolve(ARTISTS_NAME);
    }

    private final Path file;
    private final Path lockFile;
    private final Path failedFile;
    private final String bulkMeta;
    /** The artists file next to {@link #file}; null for a user-supplied map. */
    private final Path artistsFile;
    private final boolean userSupplied;
    private final HttpClient http;
    private final String userAgent;
    private final Executor executor;

    private volatile Map<String, String> map;
    private volatile Map<String, String> artists = Collections.emptyMap();
    private volatile CompletableFuture<Map<String, String>> building;
    private volatile String failure;

    public CardArtIndex(final Path file, final boolean userSupplied, final HttpClient http, final String userAgent, final Executor executor) {
        this(file, userSupplied, http, userAgent, executor, BULK_META);
    }

    /** @param bulkMeta where the bulk file is looked up (tests point it at a local stand-in) */
    CardArtIndex(final Path file, final boolean userSupplied, final HttpClient http, final String userAgent, final Executor executor, final String bulkMeta) {
        this.file = file;
        this.lockFile = file.resolveSibling("card_images.building.lock");
        this.failedFile = file.resolveSibling("card_images.failed");
        this.bulkMeta = bulkMeta;
        this.artistsFile = userSupplied ? null : file.resolveSibling(ARTISTS_NAME);
        this.userSupplied = userSupplied;
        this.http = http;
        this.userAgent = userAgent;
        this.executor = executor;
    }

    /** The map, loading or building it on first use. Completes with an empty map if it can't be had. */
    public synchronized CompletableFuture<Map<String, String>> ensure() {
        if (map != null) {
            if (!userSupplied && building == null && (isStale() || missingArtists()) && claimRebuild()) {
                building = CompletableFuture.supplyAsync(() -> buildTracked(true), executor).whenComplete((m, e) -> finishBuild(m, e));
            }
            return CompletableFuture.completedFuture(map);
        }
        if (building != null) {
            return building;
        }
        if (Files.isRegularFile(file)) {
            try {
                map = read(file);
                artists = readArtists();
                BridgeLog.info("Card art index: " + map.size() + " names from " + file);
                return ensure();
            } catch (final IOException | RuntimeException e) {
                BridgeLog.warn("Card art index unreadable (" + e.getMessage() + ")" + (userSupplied ? "" : "; rebuilding"));
                if (userSupplied) {
                    failure = "unreadable card image map: " + e.getMessage();
                    map = Collections.emptyMap();
                    return CompletableFuture.completedFuture(map);
                }
            }
        } else if (userSupplied) {
            failure = "card image map not found: " + file;
            BridgeLog.warn("Card art index: " + failure);
            map = Collections.emptyMap();
            return CompletableFuture.completedFuture(map);
        }
        building = CompletableFuture.supplyAsync(() -> buildTracked(false), executor).whenComplete((m, e) -> finishBuild(m, e));
        return building;
    }

    /** True when the built map predates the artists file. */
    private boolean missingArtists() {
        return !Files.isRegularFile(artistsFile);
    }

    /**
     * Whether this process may rebuild the map in the background now: no other process is at it (the lock is made
     * atomically; one older than {@link #LOCK_TTL} is taken over) and no build failed within {@link #BACKOFF}.
     * Holds the lock when it says yes; {@link #buildLocked} lets it go.
     */
    boolean claimRebuild() {
        if (youngerThan(failedFile, BACKOFF)) {
            return false;
        }
        try {
            Files.createDirectories(lockFile.toAbsolutePath().getParent());
            try {
                Files.createFile(lockFile);
                return true;
            } catch (final FileAlreadyExistsException held) {
                if (youngerThan(lockFile, LOCK_TTL)) {
                    return false;
                }
                // A dead process's lock. (Two processes taking it over at once can both build: harmless, just wasteful.)
                Files.deleteIfExists(lockFile);
                Files.createFile(lockFile);
                return true;
            }
        } catch (final IOException e) {
            return false; // a cache dir we can't write to can't hold a rebuilt map either
        }
    }

    private static boolean youngerThan(final Path f, final Duration age) {
        try {
            return Files.getLastModifiedTime(f).toInstant().isAfter(Instant.now().minus(age));
        } catch (final IOException e) {
            return false;
        }
    }

    private Map<String, String> readArtists() {
        if (artistsFile == null || !Files.isRegularFile(artistsFile)) {
            return Collections.emptyMap();
        }
        try {
            return read(artistsFile);
        } catch (final IOException | RuntimeException e) {
            BridgeLog.warn("Card artists unreadable (" + e.getMessage() + "); art crops go uncredited until the map is rebuilt");
            return Collections.emptyMap();
        }
    }

    /**
     * A build with its bookkeeping: success clears the backoff, failure starts it. {@code locked}: a claimed
     * background rebuild, whose lock is let go when it ends.
     */
    private Map<String, String> buildTracked(final boolean locked) {
        try {
            final Map<String, String> m = buildAndSave();
            try {
                Files.deleteIfExists(failedFile);
            } catch (final IOException ignored) {
                // the backoff just runs out by itself
            }
            return m;
        } catch (final RuntimeException e) {
            try {
                Files.write(failedFile, new byte[0]); // rewriting refreshes its mtime
            } catch (final IOException ignored) {
                // no backoff then: the lock's TTL still spaces retries out
            }
            throw e;
        } finally {
            if (locked) {
                try {
                    Files.deleteIfExists(lockFile);
                } catch (final IOException ignored) {
                    // goes stale after LOCK_TTL
                }
            }
        }
    }

    private synchronized void finishBuild(final Map<String, String> m, final Throwable e) {
        if (e != null) {
            failure = String.valueOf(e.getCause() != null ? e.getCause().getMessage() : e.getMessage());
            BridgeLog.warn("Card art index build failed: " + failure);
            if (map == null) {
                map = Collections.emptyMap();
            }
        } else {
            map = m;
            failure = null;
        }
        building = null;
    }

    /** True while the first build is running (no map to answer from yet). */
    public boolean isBuilding() {
        return map == null && building != null;
    }

    /** True while the artists are being built (an older map is serving): a crop now would go out uncredited. */
    public boolean artistsPending() {
        return !userSupplied && artists.isEmpty() && building != null;
    }

    /** Why the map is empty, or null. */
    public String failure() {
        return failure;
    }

    /** The image URL for a card name (exact, or the front of "A // B"), or null. Never blocks. */
    public String lookup(final String name) {
        return byName(map, name, "");
    }

    /**
     * The artist of the curated image for a card name (or the front of "A // B"), or null when unknown.
     * {@code back}: the back face of a double-faced card. Never blocks.
     */
    public String artist(final String name, final boolean back) {
        return byName(artists, name, back ? CuratedPrintings.BACK : "");
    }

    /**
     * A name-keyed entry of one of these maps ({@code name + suffix}, else the front of "A // B" + suffix), or null.
     * Shared with {@link CachedCrops}, which reads the same files without ever building them.
     */
    static String byName(final Map<String, String> m, final String name, final String suffix) {
        if (m == null || name == null) {
            return null;
        }
        final String exact = m.get(name + suffix);
        if (exact != null) {
            return exact;
        }
        final int sep = name.indexOf(" // ");
        return sep >= 0 ? m.get(name.substring(0, sep).trim() + suffix) : null;
    }

    private boolean isStale() {
        try {
            return Files.getLastModifiedTime(file).toInstant().isBefore(Instant.now().minus(MAX_AGE));
        } catch (final IOException e) {
            return false;
        }
    }

    private Map<String, String> buildAndSave() {
        try {
            final long t0 = System.nanoTime();
            final JsonObject meta = JsonParser.parseString(getString(bulkMeta)).getAsJsonObject();
            final String uri = meta.has("download_uri") ? meta.get("download_uri").getAsString()
                    : meta.get("jsonl_download_uri").getAsString();
            BridgeLog.info("Card art index: building from " + uri);
            final CuratedPrintings picks = new CuratedPrintings();
            final HttpResponse<InputStream> res = http.send(request(uri).timeout(Duration.ofMinutes(10)).build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            if (res.statusCode() != 200) {
                res.body().close();
                throw new IOException("HTTP " + res.statusCode() + " for " + uri);
            }
            try (Reader in = new InputStreamReader(maybeGunzip(res.body()), StandardCharsets.UTF_8)) {
                picks.readAll(in);
            }
            final Map<String, String> out = picks.result();
            if (out.isEmpty()) {
                throw new IOException("no printings in " + uri);
            }
            // The artists first: the map's presence is what says a build finished.
            final Map<String, String> who = picks.artists();
            write(artistsFile, who);
            write(file, out);
            artists = who;
            BridgeLog.info(String.format("Card art index: %d names from %d printings in %.1f s",
                    out.size(), picks.printingsSeen(), (System.nanoTime() - t0) / 1e9));
            return out;
        } catch (final IOException e) {
            throw new java.io.UncheckedIOException(e);
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", e);
        }
    }

    private String getString(final String url) throws IOException, InterruptedException {
        final HttpResponse<String> res = http.send(request(url).header("Accept", "application/json").timeout(Duration.ofSeconds(30)).build(),
                HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) {
            throw new IOException("HTTP " + res.statusCode() + " for " + url);
        }
        return res.body();
    }

    private HttpRequest.Builder request(final String url) {
        return HttpRequest.newBuilder(URI.create(url)).header("User-Agent", userAgent).header("Accept", "*/*");
    }

    /** Bulk files come as {@code .jsonl.gz}; sniff the gzip magic rather than trusting names or headers. */
    static InputStream maybeGunzip(final InputStream raw) throws IOException {
        final BufferedInputStream in = new BufferedInputStream(raw, 1 << 16);
        in.mark(2);
        final int b0 = in.read();
        final int b1 = in.read();
        in.reset();
        return b0 == 0x1f && b1 == 0x8b ? new GZIPInputStream(in, 1 << 16) : in;
    }

    static Map<String, String> read(final Path f) throws IOException {
        try (Reader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
            final Map<String, String> m = new Gson().fromJson(r, new TypeToken<Map<String, String>>() { }.getType());
            if (m == null) {
                throw new IOException("empty map");
            }
            return m;
        }
    }

    static void write(final Path f, final Map<String, String> m) throws IOException {
        final File dir = f.toAbsolutePath().getParent().toFile();
        dir.mkdirs();
        // A unique temp name: several games (router mode) may rebuild the shared map at once.
        final Path tmp = Files.createTempFile(dir.toPath(), f.getFileName().toString(), ".tmp");
        try {
            try (Writer w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                new Gson().toJson(m, w);
            }
            Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }
}

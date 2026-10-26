package forge.bridge.art;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * The curated art crops games have already downloaded into the shared table cache, by card name, for a page with no
 * game behind it (the router's lobby). Reads {@link CardArtIndex}'s map and artists files and resolves a crop's file
 * the way {@link CardArtService} stores it ({@code <cache>/table/art/<Scryfall path>}), but never builds a map or
 * downloads anything itself: {@link #findOrFetch} fetches a crop the map names but nobody has fetched yet (from
 * Scryfall's CDN only) into the same file a game would. Each file is re-read when its mtime changes (a game rebuilt
 * it); a missing or unreadable one is an empty map.
 */
public final class CachedCrops {

    /** Fetches that may wait for one of the four threads; more are refused. */
    static final int QUEUE = 64;

    /** A cached crop and its artist (null when unknown). */
    public record Crop(Path file, String artist) { }

    /** Fetch {@code url} into {@code dest}; true when the file is there now. */
    @FunctionalInterface
    public interface Download {
        boolean fetch(String url, Path dest);
    }

    /** The only host a crop is fetched from: where the curated map's scans live. */
    static final String CDN_HOST = "cards.scryfall.io";
    /** A crop that failed to fetch isn't tried again for this long. */
    private static final long MISS_TTL_MS = Duration.ofMinutes(2).toMillis();

    private final Path artDir;
    private final Loaded images;
    /** Null for a user-supplied map, which has no artists. */
    private final Loaded artists;
    /** Null: never fetch (only what games cached). */
    private final Download download;
    private final ExecutorService pool;
    /** By crop URL: one fetch at a time per crop, however many tiles ask. */
    private final ConcurrentHashMap<String, CompletableFuture<Void>> inflight = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> missUntil = new ConcurrentHashMap<>();

    /**
     * @param tableCache the shared table cache ({@code <data>/cache/table}, which every game's {@code .cache/forge/table} links to)
     * @param userMap    the operator's {@code --card-image-map}, or null for the one games build there
     */
    public CachedCrops(final Path tableCache, final Path userMap) {
        this(tableCache, userMap, null);
    }

    /** As above, fetching a missing crop with {@code download} (null: never), four at a time. */
    public CachedCrops(final Path tableCache, final Path userMap, final Download download) {
        this.artDir = tableCache.resolve("art");
        this.images = new Loaded(userMap != null ? userMap : CardArtIndex.builtFile(tableCache));
        this.artists = userMap != null ? null : new Loaded(CardArtIndex.builtArtistsFile(tableCache));
        this.download = download;
        // A bounded queue: a burst past QUEUE waiting fetches is refused (the tile keeps its colour wash), not queued.
        this.pool = download == null ? null : new ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(QUEUE), r -> {
            final Thread t = new Thread(r, "router-crop");
            t.setDaemon(true);
            return t;
        });
    }

    /** The real download: the games' own fetch (Scryfall's rate limiter, 30 s timeout, images only, atomic write). */
    public static Download scryfall(final String userAgent) {
        // Never follow a redirect: the URL was checked to be on CDN_HOST, a redirect target was not.
        final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(15)).build();
        return (url, dest) -> CardArtService.download(http, userAgent, url, dest) == CardArtService.Dl.OK;
    }

    /**
     * {@link #find}, else (when this fetches) the crop fetched first: only for a name the map has, from
     * {@link #CDN_HOST} over https, into the file a game would use (still inside the art folder after links). Null when
     * there is none, or the fetch failed (not retried for {@link #MISS_TTL_MS}).
     */
    public CompletableFuture<Crop> findOrFetch(final String name) {
        return findOrFetch(name, false);
    }

    /** {@link #findOrFetch(String)}, or with {@code full} the whole card's scan (the map's own URL) the same way. */
    public CompletableFuture<Crop> findOrFetch(final String name, final boolean full) {
        final Crop have = find(name, full);
        if (have != null || download == null) {
            return CompletableFuture.completedFuture(have);
        }
        final String url = urlFor(name, full);
        final Path dest = url == null ? null : fetchTarget(url);
        if (dest == null) {
            return CompletableFuture.completedFuture(null);
        }
        final Long until = missUntil.get(url);
        if (until != null && until > System.currentTimeMillis()) {
            return CompletableFuture.completedFuture(null);
        }
        final CompletableFuture<Void> f;
        try {
            f = inflight.computeIfAbsent(url, u -> CompletableFuture.runAsync(() -> {
            boolean ok;
            try {
                ok = download.fetch(u, dest);
            } catch (final RuntimeException e) {
                ok = false;
            }
            if (ok) {
                missUntil.remove(u);
            } else {
                missUntil.put(u, System.currentTimeMillis() + MISS_TTL_MS);
            }
        }, pool));
        } catch (final RejectedExecutionException e) {
            return CompletableFuture.completedFuture(null); // too many fetches waiting
        }
        f.whenComplete((r, e) -> inflight.remove(url, f));
        return f.handle((r, e) -> find(name, full));
    }

    /**
     * Where a fetched crop goes ({@code <art>/<Scryfall path>}, as {@link CardArtService} stores it), or null: not an
     * https URL on {@link #CDN_HOST}, a path that leaves the art folder, a file already there, or a folder on the way
     * that links out of it.
     */
    Path fetchTarget(final String url) {
        try {
            final URI u = URI.create(url);
            if (!"https".equals(u.getScheme()) || !CDN_HOST.equals(u.getHost()) || u.getPort() != -1 || u.getUserInfo() != null) {
                return null;
            }
            Files.createDirectories(artDir);
            final Path root = artDir.toRealPath();
            final Path dest = root.resolve(CardArtService.pathFor(url)).normalize();
            if (!dest.startsWith(root) || Files.exists(dest, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                return null; // out of the folder, or something find() refused (a link out) is already there
            }
            Path p = dest.getParent();
            while (p != null && !Files.exists(p)) {
                p = p.getParent();
            }
            return p != null && p.toRealPath().startsWith(root) ? dest : null;
        } catch (final IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * The crop for a card name (the front face), or null when the map lacks the name or the crop isn't on disk. The
     * file comes only from the map's URL (never from the name), and must be a regular file inside the art folder after
     * following links.
     */
    public Crop find(final String name) {
        return find(name, false);
    }

    /** {@link #find(String)}, or with {@code full} the whole card's scan, stored as a game stores it. */
    public Crop find(final String name, final boolean full) {
        final String url = urlFor(name, full);
        if (url == null) {
            return null;
        }
        try {
            final Path root = artDir.toRealPath();
            final Path f = root.resolve(CardArtService.pathFor(url)).normalize();
            if (!f.startsWith(root) || !Files.isRegularFile(f)) {
                return null;
            }
            final Path real = f.toRealPath();
            if (!real.startsWith(root)) {
                return null;
            }
            return new Crop(real, artists == null ? null : CardArtIndex.byName(artists.map(), name, ""));
        } catch (final IOException | RuntimeException e) {
            return null; // no art folder yet, the file went away, or a map URL that is not a URI
        }
    }

    /** The map's scan URL for a card name ({@code /normal/}), or its crop's; null when the map lacks the name. */
    private String urlFor(final String name, final boolean full) {
        final String normal = CardArtIndex.byName(images.map(), name, "");
        final String crop = CardArtService.cropUrl(normal, false);
        return crop == null ? null : full ? normal : crop;
    }

    /** One name-keyed JSON map file, re-read when its mtime changes. */
    private static final class Loaded {
        private final Path file;
        private FileTime loadedAt;
        private Map<String, String> map = Collections.emptyMap();

        Loaded(final Path file) {
            this.file = file;
        }

        synchronized Map<String, String> map() {
            FileTime now;
            try {
                now = Files.getLastModifiedTime(file);
            } catch (final IOException e) {
                now = null;
            }
            if (now == null) {
                map = Collections.emptyMap();
            } else if (!now.equals(loadedAt)) {
                try {
                    map = CardArtIndex.read(file);
                } catch (final IOException | RuntimeException e) {
                    map = Collections.emptyMap(); // retried once the file changes
                }
            }
            loadedAt = now;
            return map;
        }
    }
}

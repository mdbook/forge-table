package forge.bridge.art;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

import forge.ImageKeys;
import forge.StaticData;
import forge.bridge.BridgeLog;
import forge.card.CardEdition;
import forge.gui.download.CdnUuidCache;
import forge.item.IPaperCard;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgeConstants;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.util.ImageUtil;
import forge.util.ScryfallRateLimiter;

/**
 * Card images for {@code GET /img/card/<imageKey>}, and their art crops for {@code GET /img/crop/<imageKey>}.
 *
 * <ul>
 * <li><b>curated</b> (the default): the card's cleanest standard printing, by name, from {@link CardArtIndex}.
 * Cached under {@code <cache>/table/art/} by Scryfall path, so every copy of a card shares one file.</li>
 * <li><b>printed</b>: the exact printing in the deck, the way Classic does it: Forge's own picture cache first
 * (so Classic's downloads are reused), else Scryfall by set and collector number.</li>
 * <li><b>off</b>: no images; the client draws procedural faces.</li>
 * </ul>
 *
 * Curated falls back to printed for names the map lacks (or a back face it can't place), and tokens always
 * use their printing. Placeholder keys (face-down, hidden) have no image: the client draws its own back.
 * Downloads keep Scryfall's bytes as-is (no re-encode) and land via a temp file and an atomic rename.
 *
 * <p>A crop is the illustration alone (Scryfall's {@code art_crop}: the same CDN path as the scan under
 * {@code /art_crop/}, or {@code version=art_crop} for a printing), for the client's own card frame. It comes with
 * the artist (Scryfall's terms ask for the credit): the curated printing's, from {@link CardArtIndex}, or the deck
 * printing's own from Forge's card data when the crop is that printing's. Crops are only ever downloaded (Forge's
 * picture cache holds scans), so a busy Scryfall is a retry, never a local fallback.
 */
public final class CardArtService {
    public enum Mode {
        CURATED, PRINTED, OFF;

        public static Mode parse(final String s) {
            return valueOf(s.trim().toUpperCase(Locale.ROOT));
        }
    }

    /**
     * status 200 with a file, or 404 (served as 204, no art). A lookup still running when HTTP stops waiting is a 202.
     * {@code artist}: who painted a crop (null for a scan, or when unknown).
     */
    public record Result(File file, int status, String artist) {
        static Result ok(final File f) {
            return new Result(f, 200, null);
        }

        static Result missing() {
            return new Result(null, 404, null);
        }

        /** A download that failed for now (rate limit, timeout, 5xx): the client asks again; never cached as a miss. */
        static Result later() {
            return new Result(null, 503, null);
        }

        /** This result, credited to {@code who} when it is a file. */
        Result by(final String who) {
            return status == 200 && who != null && !who.isEmpty() ? new Result(file, 200, who) : this;
        }
    }

    /** Prefix of a crop's key in the in-flight and miss tables (no image key starts with it). */
    private static final String CROP_SLOT = "crop:";
    private static final Duration MISS_TTL = Duration.ofMinutes(10);
    private static final int MAX_BYTES = 10 << 20;
    private static final Pattern SAFE_PATH = Pattern.compile("[A-Za-z0-9_./-]+");
    /** ImageKeys keeps an unsynchronized cache. */
    private static final Object IMAGE_KEYS_LOCK = new Object();

    private final Mode mode;
    private final Path cacheDir;
    private final CardArtIndex index;
    private final HttpClient http;
    private final String userAgent;
    private final ExecutorService pool;
    private final ConcurrentHashMap<String, CompletableFuture<Result>> inflight = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> missUntil = new ConcurrentHashMap<>();

    /**
     * @param cacheDir  where downloads go ({@code <cache>/table/art})
     * @param indexFile the curated map: the user's ({@code userSupplied}) or the one this service builds
     */
    public CardArtService(final Mode mode, final Path cacheDir, final Path indexFile, final boolean userSupplied, final String userAgent) {
        this.mode = mode;
        this.cacheDir = cacheDir;
        this.userAgent = userAgent;
        final AtomicInteger n = new AtomicInteger();
        this.pool = Executors.newFixedThreadPool(4, r -> {
            final Thread t = new Thread(r, "bridge-art-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
        this.http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(15)).build();
        this.index = mode == Mode.CURATED ? new CardArtIndex(indexFile, userSupplied, http, userAgent, pool) : null;
    }

    public Mode mode() {
        return mode;
    }

    /** Load or start building the curated map now, so the first game's art isn't waiting on it. */
    public void prewarm() {
        if (index != null) {
            index.ensure();
        }
    }

    /** True while the curated map's first build is running. */
    public boolean indexBuilding() {
        return index != null && index.isBuilding();
    }

    /** The image for a key. Concurrent lookups of one key share one download. */
    public CompletableFuture<Result> lookup(final String imageKey) {
        return lookup(imageKey, false);
    }

    /** The art crop (and its artist) for a key; shares nothing with {@link #lookup(String)}. */
    public CompletableFuture<Result> lookupCrop(final String imageKey) {
        return lookup(imageKey, true);
    }

    private CompletableFuture<Result> lookup(final String imageKey, final boolean crop) {
        if (mode == Mode.OFF || imageKey == null || imageKey.length() < 3) {
            return CompletableFuture.completedFuture(Result.missing());
        }
        final String slot = crop ? CROP_SLOT + imageKey : imageKey;
        final Long until = missUntil.get(slot);
        if (until != null) {
            if (System.currentTimeMillis() < until) {
                return CompletableFuture.completedFuture(Result.missing());
            }
            missUntil.remove(slot, until);
        }
        final CompletableFuture<Result> running = inflight.get(slot);
        if (running != null) {
            return running;
        }
        final CompletableFuture<Result> created = new CompletableFuture<>();
        final CompletableFuture<Result> prev = inflight.putIfAbsent(slot, created);
        if (prev != null) {
            return prev;
        }
        final CompletableFuture<?> ready = index != null && imageKey.startsWith(ImageKeys.CARD_PREFIX)
                ? index.ensure() : CompletableFuture.completedFuture(null);
        ready.handleAsync((m, e) -> resolve(imageKey, crop), pool).whenComplete((r, e) -> {
            final Result res = e != null || r == null ? Result.missing() : r;
            if (e != null) {
                BridgeLog.warn("Card art for " + imageKey + " failed: " + e);
            }
            if (res.status() == 404) {
                missUntil.put(slot, System.currentTimeMillis() + MISS_TTL.toMillis());
            }
            inflight.remove(slot, created);
            created.complete(res);
        });
        return created;
    }

    // ---------------------------------------------------------------- resolution (on bridge-art)

    private Result resolve(final String key, final boolean crop) {
        final int dollar = key.indexOf('$');
        final String base = dollar > 0 ? key.substring(0, dollar) : key;
        final String face = dollar > 0 ? faceOf(key.substring(dollar)) : "";
        if (key.startsWith(ImageKeys.CARD_PREFIX)) {
            return crop ? resolveCardCrop(key, base, face) : resolveCard(key, base, face);
        }
        if (key.startsWith(ImageKeys.TOKEN_PREFIX)) {
            return resolveToken(key, base, face, crop);
        }
        return Result.missing();
    }

    private Result resolveCard(final String key, final String base, final String face) {
        final PaperCard pc = ImageUtil.getPaperCardFromImageKey(base);
        if (pc == null) {
            return Result.missing();
        }
        if (mode == Mode.CURATED) {
            String url = index.lookup(pc.getName());
            if (url != null && "back".equals(face)) {
                // Double-faced printings keep the back next to the front on Scryfall's CDN.
                url = url.contains("/front/") ? url.replace("/front/", "/back/") : null;
            }
            if (url != null) {
                final Path dest = cacheDir.resolve(pathFor(url));
                if (Files.isRegularFile(dest)) {
                    return Result.ok(dest.toFile());
                }
                final Dl d = download(url, dest);
                if (d == Dl.OK) {
                    return Result.ok(dest.toFile());
                }
                if (d == Dl.LATER) {
                    // Scryfall is busy or unreachable: the printing fallback would hit the same wall (a card
                    // stayed procedural until a reload).
                    final File local = forgeCacheFile(key);
                    return local != null ? Result.ok(local) : Result.later();
                }
            }
        }
        final File local = forgeCacheFile(key);
        if (local != null) {
            return Result.ok(local);
        }
        if (IPaperCard.NO_COLLECTOR_NUMBER.equals(pc.getCollectorNumber()) || pc.getRules().isCustom()) {
            return Result.missing();
        }
        final CardEdition ed = StaticData.instance().getEditions().get(pc.getEdition());
        if (ed == null) {
            return Result.missing();
        }
        final String set = ed.getScryfallCode();
        final String lang = CdnUuidCache.resolvePreferredLangCode(prefLang(), set, pc.getCollectorNumber(), ed.getCardsLangCode());
        final String url = ForgeConstants.URL_PIC_SCRYFALL_DOWNLOAD + ImageUtil.getScryfallDownloadUrl(pc, face, set, lang, false);
        final Path dest = cacheDir.resolve("printed").resolve(safeName(key) + ".jpg");
        return fetched(url, dest);
    }

    private Result resolveCardCrop(final String key, final String base, final String face) {
        final PaperCard pc = ImageUtil.getPaperCardFromImageKey(base);
        if (pc == null) {
            return Result.missing();
        }
        if (mode == Mode.CURATED) {
            final boolean back = "back".equals(face);
            if (index.artistsPending()) {
                return Result.later(); // the map is being rebuilt with artists: wait, so the crop isn't cached uncredited
            }
            final String url = cropUrl(index.lookup(pc.getName()), back);
            if (url != null) {
                final String artist = index.artist(pc.getName(), back);
                final Path dest = cacheDir.resolve(pathFor(url));
                if (Files.isRegularFile(dest)) {
                    return Result.ok(dest.toFile()).by(artist);
                }
                final Dl d = download(url, dest);
                if (d == Dl.OK) {
                    return Result.ok(dest.toFile()).by(artist);
                }
                if (d == Dl.LATER) {
                    return Result.later();
                }
            }
        }
        // The deck's own printing, so its own artist.
        if (IPaperCard.NO_COLLECTOR_NUMBER.equals(pc.getCollectorNumber()) || pc.getRules().isCustom()) {
            return Result.missing();
        }
        final CardEdition ed = StaticData.instance().getEditions().get(pc.getEdition());
        if (ed == null) {
            return Result.missing();
        }
        final String set = ed.getScryfallCode();
        final String lang = CdnUuidCache.resolvePreferredLangCode(prefLang(), set, pc.getCollectorNumber(), ed.getCardsLangCode());
        final String url = ForgeConstants.URL_PIC_SCRYFALL_DOWNLOAD + ImageUtil.getScryfallDownloadUrl(pc, face, set, lang, true);
        final Path dest = cacheDir.resolve("printed-crop").resolve(safeName(key) + ".jpg");
        return fetched(url, dest).by(pc.getArtist());
    }

    private Result resolveToken(final String key, final String base, final String face, final boolean crop) {
        final String[] parts = base.substring(ImageKeys.TOKEN_PREFIX.length()).split("\\|");
        if (parts.length < 2) {
            return Result.missing(); // t:hidden, t:morph, …: placeholders the client draws itself
        }
        final File local = crop ? null : forgeCacheFile(key);
        if (local != null) {
            return Result.ok(local);
        }
        final CardEdition ed = StaticData.instance().getEditions().get(parts[1]);
        if (ed == null || ed.getType() == CardEdition.Type.CUSTOM_SET) {
            return Result.missing();
        }
        String cn = parts.length > 2 ? parts[2] : null;
        String artist = null;
        for (final CardEdition.EditionEntry e : ed.getTokens().get(parts[0])) {
            final boolean numbered = e.collectorNumber() != null && !e.collectorNumber().isEmpty();
            if (cn == null && numbered) {
                cn = e.collectorNumber();
            }
            if (numbered && e.collectorNumber().equals(cn)) {
                artist = e.artistName();
                break;
            }
        }
        if (cn == null) {
            return Result.missing();
        }
        final String tokenSet = ed.getTokensCode();
        final String lang = CdnUuidCache.resolvePreferredLangCode(prefLang(), tokenSet, cn, ed.getCardsLangCode());
        final String url = ForgeConstants.URL_PIC_SCRYFALL_DOWNLOAD + ImageUtil.getScryfallTokenDownloadUrl(cn, tokenSet, lang, face);
        if (crop) {
            final Path dest = cacheDir.resolve("tokens-crop").resolve(safeName(key) + ".jpg");
            return fetched(url.replace("version=normal", "version=art_crop"), dest).by(artist);
        }
        final Path dest = cacheDir.resolve("tokens").resolve(safeName(key) + ".jpg");
        return fetched(url, dest);
    }

    /**
     * The art-crop URL for a curated scan URL: Scryfall serves {@code /art_crop/} where it serves {@code /normal/},
     * same path and query. {@code back}: the back face of a double-faced card. Null when the URL isn't that shape.
     */
    static String cropUrl(final String normalUrl, final boolean back) {
        if (normalUrl == null || !normalUrl.contains("/normal/")) {
            return null;
        }
        String url = normalUrl.replace("/normal/", "/art_crop/");
        if (back) {
            // Double-faced printings keep the back next to the front on Scryfall's CDN.
            url = url.contains("/front/") ? url.replace("/front/", "/back/") : null;
        }
        return url;
    }

    private static String faceOf(final String postfix) {
        return switch (postfix) {
            case ImageKeys.BACKFACE_POSTFIX -> "back";
            case ImageKeys.SPECFACE_W -> "white";
            case ImageKeys.SPECFACE_U -> "blue";
            case ImageKeys.SPECFACE_B -> "black";
            case ImageKeys.SPECFACE_R -> "red";
            case ImageKeys.SPECFACE_G -> "green";
            default -> "";
        };
    }

    private static String prefLang() {
        return FModel.getPreferences().getPref(FPref.UI_CARD_DOWNLOAD_LANG);
    }

    /** A picture Classic (or the user) already put in Forge's cache. */
    private static File forgeCacheFile(final String key) {
        synchronized (IMAGE_KEYS_LOCK) {
            final File f = ImageKeys.getImageFile(key);
            return f != null && f.isFile() ? f : null;
        }
    }

    // ---------------------------------------------------------------- download

    private Result fetched(final String url, final Path dest) {
        if (Files.isRegularFile(dest)) {
            return Result.ok(dest.toFile());
        }
        return switch (download(url, dest)) {
            case OK -> Result.ok(dest.toFile());
            case GONE -> Result.missing();
            case LATER -> Result.later();
        };
    }

    /** How a download went: it worked, there is nothing there (404, not an image), or try again later. */
    enum Dl { OK, GONE, LATER }

    private Dl download(final String url, final Path dest) {
        return download(http, userAgent, url, dest);
    }

    /** Fetch {@code url} into {@code dest} (atomically: a temp file, then a move), paced by Scryfall's rate limiter. */
    static Dl download(final HttpClient http, final String userAgent, final String url, final Path dest) {
        if (ScryfallRateLimiter.shouldSkip(url)) {
            return Dl.LATER;
        }
        try {
            ScryfallRateLimiter.acquire(url);
            final HttpRequest req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(30))
                    .header("User-Agent", userAgent).header("Accept", "*/*").build();
            final HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() != 200) {
                ScryfallRateLimiter.noteIfRateLimited(res.statusCode(), url, res.headers().firstValue("Retry-After").orElse(null));
                BridgeLog.warn("Card art: HTTP " + res.statusCode() + " for " + url);
                return res.statusCode() == 404 || res.statusCode() == 410 ? Dl.GONE : Dl.LATER;
            }
            final byte[] body = res.body();
            final String type = res.headers().firstValue("Content-Type").orElse("");
            if (body.length == 0 || body.length > MAX_BYTES || !type.startsWith("image/")) {
                BridgeLog.warn("Card art: not an image (" + type + ", " + body.length + " bytes) from " + url);
                return Dl.GONE;
            }
            Files.createDirectories(dest.getParent());
            // A unique temp name: several games (router mode) may fetch the same card into the shared cache at once.
            final Path tmp = Files.createTempFile(dest.getParent(), dest.getFileName().toString(), ".tmp");
            try {
                Files.write(tmp, body);
                Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(tmp);
            }
            return Dl.OK;
        } catch (final IOException | RuntimeException e) {
            BridgeLog.warn("Card art: " + e + " for " + url);
            return Dl.LATER;
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
            return Dl.LATER;
        }
    }

    /** {@code https://cards.scryfall.io/normal/front/a/b/<id>.jpg?123} → {@code normal/front/a/b/<id>.jpg}. */
    static String pathFor(final String url) {
        final URI u = URI.create(url);
        final String p = u.getPath() == null ? "" : u.getPath().replaceFirst("^/+", "");
        if (!p.isEmpty() && SAFE_PATH.matcher(p).matches() && !p.contains("..")) {
            return p;
        }
        return "by-url/" + sha1(url) + ".jpg";
    }

    /** A filesystem-safe, collision-free name for an image key. */
    static String safeName(final String key) {
        String s = key.replaceAll("[^A-Za-z0-9._-]", "_");
        if (s.length() > 80) {
            s = s.substring(0, 80);
        }
        return s + "-" + sha1(key).substring(0, 8);
    }

    private static String sha1(final String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

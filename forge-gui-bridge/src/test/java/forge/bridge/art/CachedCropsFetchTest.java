package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotNull;
import static org.testng.Assert.assertNull;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.testng.annotations.Test;

/** The lobby's fetch of a crop no game has fetched yet: once per crop however many ask, only into the art cache. */
public class CachedCropsFetchTest {
    private static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, (byte) 0xff, (byte) 0xd9};

    @Test
    public void manyAskersOneFetch() throws Exception {
        final Path table = Files.createTempDirectory("ft-crops");
        Files.writeString(CardArtIndex.builtFile(table), "{\"Opt\":\"https://cards.scryfall.io/normal/front/c/d/opt.jpg\"}");
        final AtomicInteger calls = new AtomicInteger();
        final CountDownLatch go = new CountDownLatch(1);
        final CachedCrops crops = new CachedCrops(table, null, (url, dest) -> {
            calls.incrementAndGet();
            try {
                go.await(5, TimeUnit.SECONDS);
                Files.createDirectories(dest.getParent());
                Files.write(dest, JPEG);
                return true;
            } catch (final Exception e) {
                return false;
            }
        });
        final List<CompletableFuture<CachedCrops.Crop>> asks = List.of(crops.findOrFetch("Opt"), crops.findOrFetch("Opt"), crops.findOrFetch("Opt"));
        go.countDown();
        for (final CompletableFuture<CachedCrops.Crop> a : asks) {
            assertNotNull(a.get(5, TimeUnit.SECONDS));
        }
        assertEquals(calls.get(), 1);
        assertEquals(Files.readAllBytes(table.resolve("art/art_crop/front/c/d/opt.jpg")), JPEG);
        assertNotNull(crops.findOrFetch("Opt").get(5, TimeUnit.SECONDS));
        assertEquals(calls.get(), 1, "on disk now: no second fetch");
    }

    @Test
    public void onlyTheCdnAndOnlyInsideTheCache() throws Exception {
        final Path table = Files.createTempDirectory("ft-crops-safe");
        final CachedCrops crops = new CachedCrops(table, null, (url, dest) -> false);
        assertNotNull(crops.fetchTarget("https://cards.scryfall.io/art_crop/front/a/b/x.jpg"));
        assertNull(crops.fetchTarget("http://cards.scryfall.io/art_crop/front/a/b/x.jpg"), "https only");
        assertNull(crops.fetchTarget("https://cards.scryfall.io.evil.example/art_crop/front/a/b/x.jpg"));
        assertNull(crops.fetchTarget("https://evil.example/art_crop/front/a/b/x.jpg"));
        assertNull(crops.fetchTarget("https://cards.scryfall.io:8443/art_crop/front/a/b/x.jpg"), "default port only");
        assertNull(crops.fetchTarget("https://u@cards.scryfall.io/art_crop/front/a/b/x.jpg"), "no user info");
        final Path out = Files.createTempDirectory("ft-crops-out");
        Files.createDirectories(table.resolve("art/art_crop/front"));
        Files.createSymbolicLink(table.resolve("art/art_crop/front/e"), out);
        assertNull(crops.fetchTarget("https://cards.scryfall.io/art_crop/front/e/x.jpg"), "a linked folder");
        assertNull(crops.fetchTarget("https://cards.scryfall.io/art_crop/front/e/deeper/x.jpg"), "below a linked folder");
        Files.createDirectories(table.resolve("art/art_crop/front/a/b"));
        Files.createSymbolicLink(table.resolve("art/art_crop/front/a/b/l.jpg"), out.resolve("secret.jpg"));
        assertNull(crops.fetchTarget("https://cards.scryfall.io/art_crop/front/a/b/l.jpg"), "a link already there");
        final Path evil = crops.fetchTarget("https://cards.scryfall.io/art_crop/../../x.jpg");
        assertNotNull(evil, "a .. path is stored by its hash, inside the cache");
        assertEquals(evil.getParent().getFileName().toString(), "by-url");
    }

    @Test
    public void noDownloaderNeverFetches() throws Exception {
        final Path table = Files.createTempDirectory("ft-crops-none");
        Files.writeString(CardArtIndex.builtFile(table), "{\"Opt\":\"https://cards.scryfall.io/normal/front/c/d/opt.jpg\"}");
        assertNull(new CachedCrops(table, null).findOrFetch("Opt").get(5, TimeUnit.SECONDS));
    }
}

package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import com.sun.net.httpserver.HttpServer;

import forge.bridge.BridgeApp;
import forge.bridge.Main;
import forge.bridge.TableTestEnv;
import forge.localinstance.properties.ForgeConstants;

/**
 * GET /img/crop/&lt;key&gt; end to end, offline: a built curated map and artists file (as the service writes them)
 * point at a local stand-in for Scryfall's CDN that serves /art_crop/ where the real one does. Covers the crop
 * download and cache, the artist header (percent-encoded UTF-8) and what stays the same for /img/card.
 */
public class CropEndpointTest {
    private static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 9, 8, 7, 6, (byte) 0xff, (byte) 0xd9};

    private HttpServer cdn;
    private final AtomicInteger crops = new AtomicInteger();
    private Main.Running sidecar;
    private Path mapFile;
    private Path artistsFile;
    private final HttpClient http = HttpClient.newHttpClient();

    private void serve(final String path, final AtomicInteger hits) {
        cdn.createContext(path, ex -> {
            if (hits != null) {
                hits.incrementAndGet();
            }
            ex.getResponseHeaders().set("Content-Type", "image/jpeg");
            ex.sendResponseHeaders(200, JPEG.length);
            ex.getResponseBody().write(JPEG);
            ex.close();
        });
    }

    @BeforeClass
    public void start() throws Exception {
        cdn = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serve("/art_crop/front/t/e/bolt.jpg", crops);
        serve("/art_crop/front/s/h/shock.jpg", null);
        serve("/art_crop/front/d/e/delver.jpg", null);
        serve("/art_crop/back/d/e/delver.jpg", null);
        serve("/normal/front/t/e/bolt.jpg", null);
        cdn.start();
        final BridgeApp.Options o = TableTestEnv.options();
        o.cardArt = "curated";
        sidecar = Main.boot(o);
        // Written once Forge is up (the cache dir is known then); the map is only read on the first request.
        final String base = "http://127.0.0.1:" + cdn.getAddress().getPort();
        final Path table = Path.of(ForgeConstants.CACHE_DIR, "table");
        mapFile = CardArtIndex.builtFile(table);
        artistsFile = CardArtIndex.builtArtistsFile(table);
        Files.createDirectories(table);
        Files.writeString(mapFile, "{\"Lightning Bolt\":\"" + base + "/normal/front/t/e/bolt.jpg?1700000000\","
                + "\"Shock\":\"" + base + "/normal/front/s/h/shock.jpg?1\","
                + "\"Delver of Secrets\":\"" + base + "/normal/front/d/e/delver.jpg?1\"}");
        // Shock has no known artist; Lightning Bolt's is not ASCII; Delver's back face has its own.
        Files.writeString(artistsFile, "{\"Lightning Bolt\":\"Christopher Rush \\u00e9\\u00f4\","
                + "\"Delver of Secrets\":\"Michael Komarck\",\"Delver of Secrets|back\":\"Jaime Jones\"}");
        // A previous run's downloads would hide the first fetch.
        for (final String f : new String[] {"art_crop/front/t/e/bolt", "art_crop/front/s/h/shock", "art_crop/front/d/e/delver",
                "art_crop/back/d/e/delver", "normal/front/t/e/bolt"}) {
            Files.deleteIfExists(Path.of(ForgeConstants.CACHE_DIR, "table", "art", f + ".jpg"));
        }
    }

    @AfterClass(alwaysRun = true)
    public void stop() throws Exception {
        if (sidecar != null) {
            sidecar.stop();
        }
        if (cdn != null) {
            cdn.stop(0);
        }
        Files.deleteIfExists(mapFile);
        Files.deleteIfExists(artistsFile);
    }

    private HttpResponse<byte[]> get(final String kind, final String key, final boolean withToken) throws Exception {
        final String url = "http://127.0.0.1:" + sidecar.port() + "/img/" + kind + "/" + URLEncoder.encode(key, StandardCharsets.UTF_8).replace("+", "%20")
                + (withToken ? "?t=" + sidecar.token : "");
        return http.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static String artist(final HttpResponse<?> r) {
        return r.headers().firstValue("X-Card-Artist").map(v -> URLDecoder.decode(v, StandardCharsets.UTF_8)).orElse(null);
    }

    @Test
    public void cropIsServedWithItsArtistAndCached() throws Exception {
        final HttpResponse<byte[]> r = get("crop", "c:Lightning Bolt|M10|1", true);
        assertEquals(r.statusCode(), 200);
        assertEquals(r.headers().firstValue("Content-Type").orElse(""), "image/jpeg");
        assertEquals(r.body(), JPEG);
        assertEquals(artist(r), "Christopher Rush éô");
        // On the wire the name is ASCII (percent-encoded UTF-8).
        final String raw = r.headers().firstValue("X-Card-Artist").orElseThrow();
        assertTrue(raw.chars().allMatch(c -> c < 128), raw);
        assertTrue(raw.contains("%C3%A9"), raw);
        // Another printing of the card shares the crop and its credit; the second request is a cache hit.
        final int after = crops.get();
        final HttpResponse<byte[]> again = get("crop", "c:Lightning Bolt|M11|1", true);
        assertEquals(again.statusCode(), 200);
        assertEquals(artist(again), "Christopher Rush éô");
        assertEquals(crops.get(), after, "served from cache");
    }

    @Test
    public void unknownArtistSendsNoHeader() throws Exception {
        final HttpResponse<byte[]> r = get("crop", "c:Shock|M19|1", true);
        assertEquals(r.statusCode(), 200);
        assertNull(artist(r));
    }

    @Test
    public void backFaceHasItsOwnArtist() throws Exception {
        assertEquals(artist(get("crop", "c:Delver of Secrets|ISD|1", true)), "Michael Komarck");
        final HttpResponse<byte[]> back = get("crop", "c:Delver of Secrets|ISD|1$alt", true);
        assertEquals(back.statusCode(), 200);
        assertEquals(artist(back), "Jaime Jones");
    }

    @Test
    public void scansAreUnchangedAndCropsNeedTheToken() throws Exception {
        final HttpResponse<byte[]> scan = get("card", "c:Lightning Bolt|M10|1", true);
        assertEquals(scan.statusCode(), 200);
        assertFalse(scan.headers().firstValue("X-Card-Artist").isPresent());
        assertEquals(get("crop", "c:Lightning Bolt|M10|1", false).statusCode(), 401);
        // No art is 204, as for scans: placeholders and unknown cards.
        assertEquals(get("crop", "t:morph", true).statusCode(), 204);
        assertEquals(get("crop", "c:Definitely Not A Card|XYZ|1", true).statusCode(), 204);
        assertEquals(get("nope", "c:Lightning Bolt|M10|1", true).statusCode(), 404);
    }

    /** GET /img/avatar/neural from the model's avatar_card: that card's crop, as /img/crop/ gives it; a file wins; art off is 404. */
    @Test
    public void neuralAvatarFromACard() throws Exception {
        final Path model = Files.createTempDirectory("ft-neural-model");
        Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Lightning Bolt|M10\"}");
        System.setProperty("mtgai.neural.dir", model.toString());
        try {
            final HttpResponse<byte[]> r = get("avatar", "neural", true);
            assertEquals(r.statusCode(), 200);
            assertEquals(r.headers().firstValue("Content-Type").orElse(""), "image/jpeg");
            assertEquals(r.body(), JPEG);
            assertEquals(artist(r), "Christopher Rush éô", "credited like any crop");
            assertEquals(get("avatar", "neural", false).statusCode(), 401);
            // A picture file wins over the card.
            final byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d};
            Files.write(model.resolve("avatar.png"), png);
            assertEquals(get("avatar", "neural", true).body(), png);
            Files.delete(model.resolve("avatar.png"));
            // Not in the map: no art, not an error.
            Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Definitely Not A Card\"}");
            assertEquals(get("avatar", "neural", true).statusCode(), 204);
            // Card art off: 404, and the card is never asked for.
            Files.writeString(model.resolve("latest.json"), "{\"avatar_card\":\"Lightning Bolt|M10\"}");
            final BridgeApp.Options o = TableTestEnv.options();
            o.cardArt = "off";
            final Main.Running off = Main.boot(o);
            try {
                final String url = "http://127.0.0.1:" + off.port() + "/img/avatar/neural?t=" + off.token;
                assertEquals(http.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofByteArray()).statusCode(), 404);
            } finally {
                off.stop();
            }
        } finally {
            System.clearProperty("mtgai.neural.dir");
        }
    }
}

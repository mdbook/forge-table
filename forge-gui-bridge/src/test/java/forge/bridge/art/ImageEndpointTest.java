package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
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
 * GET /img/card/&lt;key&gt; end to end, offline: a user-supplied curated map points at a local stand-in for
 * Scryfall's CDN. Covers the download, the cache, one download for concurrent requests, auth and placeholders.
 */
public class ImageEndpointTest {
    private static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2, 3, 4, (byte) 0xff, (byte) 0xd9};

    private HttpServer cdn;
    private final AtomicInteger hits = new AtomicInteger();
    private Main.Running sidecar;
    private final HttpClient http = HttpClient.newHttpClient();

    @BeforeClass
    public void start() throws Exception {
        cdn = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        cdn.createContext("/normal/front/t/e/bolt.jpg", ex -> {
            hits.incrementAndGet();
            try {
                Thread.sleep(300); // long enough for concurrent requests to overlap
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            ex.getResponseHeaders().set("Content-Type", "image/jpeg");
            ex.sendResponseHeaders(200, JPEG.length);
            ex.getResponseBody().write(JPEG);
            ex.close();
        });
        cdn.start();
        final Path map = Files.createTempFile("card_images", ".json");
        Files.writeString(map, "{\"Lightning Bolt\":\"http://127.0.0.1:" + cdn.getAddress().getPort()
                + "/normal/front/t/e/bolt.jpg?1700000000\"}");
        final BridgeApp.Options o = TableTestEnv.options();
        o.cardArt = "curated";
        o.cardImageMap = map.toString();
        sidecar = Main.boot(o);
        // A previous run's download would hide the first fetch.
        Files.deleteIfExists(Path.of(ForgeConstants.CACHE_DIR, "table", "art", "normal", "front", "t", "e", "bolt.jpg"));
    }

    @AfterClass(alwaysRun = true)
    public void stop() {
        if (sidecar != null) {
            sidecar.stop();
        }
        if (cdn != null) {
            cdn.stop(0);
        }
    }

    private HttpResponse<byte[]> get(final String key, final boolean withToken) throws Exception {
        return getAsync(key, withToken).get();
    }

    private CompletableFuture<HttpResponse<byte[]>> getAsync(final String key, final boolean withToken) {
        final String url = "http://127.0.0.1:" + sidecar.port() + "/img/card/" + URLEncoder.encode(key, StandardCharsets.UTF_8).replace("+", "%20")
                + (withToken ? "?t=" + sidecar.token : "");
        return http.sendAsync(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    @Test
    public void curatedArtIsDownloadedOnceAndServedFromCache() throws Exception {
        final List<CompletableFuture<HttpResponse<byte[]>>> concurrent = new ArrayList<>();
        // Different printings of one card share the curated image (and so one download).
        concurrent.add(getAsync("c:Lightning Bolt|M10|1", true));
        concurrent.add(getAsync("c:Lightning Bolt|M10|1", true));
        concurrent.add(getAsync("c:Lightning Bolt|M11|1", true));
        for (final CompletableFuture<HttpResponse<byte[]>> f : concurrent) {
            final HttpResponse<byte[]> r = f.get();
            assertEquals(r.statusCode(), 200);
            assertEquals(r.headers().firstValue("Content-Type").orElse(""), "image/jpeg");
            assertEquals(r.body(), JPEG);
        }
        final int afterFirst = hits.get();
        assertTrue(afterFirst >= 1 && afterFirst <= 2, "one download per key at most, got " + afterFirst);
        assertEquals(get("c:Lightning Bolt|M10|1", true).statusCode(), 200);
        assertEquals(hits.get(), afterFirst, "served from cache");
    }

    @Test
    public void tokenRequiredAndPlaceholdersHaveNoArt() throws Exception {
        assertEquals(get("c:Lightning Bolt|M10|1", false).statusCode(), 401);
        // No art is 204 (not an error status, so browsers don't log it); the client keeps its own face.
        assertEquals(get("t:morph", true).statusCode(), 204);
        assertEquals(get("t:hidden", true).statusCode(), 204);
        assertEquals(get("c:Definitely Not A Card|XYZ|1", true).statusCode(), 204);
    }

    /** GET /img/avatar/neural: the Neural AI's picture behind the same token, 404 when there is none. */
    @Test
    public void neuralAvatar() throws Exception {
        final String url = "http://127.0.0.1:" + sidecar.port() + "/img/avatar/neural";
        final HttpRequest withToken = HttpRequest.newBuilder(URI.create(url + "?t=" + sidecar.token)).build();
        assertEquals(http.send(withToken, HttpResponse.BodyHandlers.ofByteArray()).statusCode(), 404, "none here");
        final Path png = Files.write(Files.createTempFile("avatar", ".img"),
                new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d});
        System.setProperty("forge.table.neuralAvatar", png.toString());
        try {
            assertEquals(http.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofByteArray()).statusCode(), 401);
            final HttpResponse<byte[]> r = http.send(withToken, HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(r.statusCode(), 200);
            assertEquals(r.body(), Files.readAllBytes(png));
            assertEquals(r.headers().firstValue("Content-Type").orElse(""), "image/png");
            assertEquals(r.headers().firstValue("X-Content-Type-Options").orElse(""), "nosniff");
            assertEquals(r.headers().firstValue("Cache-Control").orElse(""), "private, max-age=3600");
        } finally {
            System.clearProperty("forge.table.neuralAvatar");
        }
    }
}

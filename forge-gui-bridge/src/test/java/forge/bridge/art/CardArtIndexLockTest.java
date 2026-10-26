package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

import com.sun.net.httpserver.HttpServer;

/**
 * Router mode runs one process per game over one cache: a background rebuild of the card map must be claimed across
 * processes (two {@link CardArtIndex} instances over one directory stand in for two), and a failed one must hold
 * everybody off for a while. The bulk file comes from a local stand-in, never Scryfall; the rebuilds are queued
 * on a test executor and run by hand.
 */
public class CardArtIndexLockTest {
    private static final byte[] BULK = ("{\"name\":\"Lightning Bolt\",\"layout\":\"normal\",\"lang\":\"en\","
            + "\"image_uris\":{\"normal\":\"https://cards.example/normal/front/a/b/bolt.jpg\"},\"artist\":\"Zoë Robinson\"}\n")
            .getBytes(StandardCharsets.UTF_8);

    private HttpServer bulk;
    private final AtomicBoolean down = new AtomicBoolean();
    private Path dir;
    private Path map;
    private final HttpClient http = HttpClient.newHttpClient();

    @BeforeMethod
    public void start() throws Exception {
        down.set(false);
        bulk = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bulk.createContext("/meta", ex -> {
            final byte[] body = ("{\"download_uri\":\"http://127.0.0.1:" + bulk.getAddress().getPort() + "/bulk.jsonl\"}").getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(down.get() ? 500 : 200, down.get() ? -1 : body.length);
            if (!down.get()) {
                ex.getResponseBody().write(body);
            }
            ex.close();
        });
        bulk.createContext("/bulk.jsonl", ex -> {
            ex.sendResponseHeaders(200, BULK.length);
            ex.getResponseBody().write(BULK);
            ex.close();
        });
        bulk.start();
        dir = Files.createTempDirectory("art-lock");
        map = dir.resolve("card_images.v2.json");
        // A map built before artists existed: fresh, so only the missing artists file asks for a rebuild.
        Files.writeString(map, "{\"Lightning Bolt\":\"https://cards.example/normal/front/a/b/bolt.jpg\"}");
    }

    @AfterMethod(alwaysRun = true)
    public void stop() throws Exception {
        bulk.stop(0);
        try (var files = Files.list(dir)) {
            for (final Path f : files.toList()) {
                Files.deleteIfExists(f);
            }
        }
        Files.deleteIfExists(dir);
    }

    /** One "process": its own index over the shared directory, whose background work waits in {@code queue}. */
    private CardArtIndex process(final List<Runnable> queue) {
        return new CardArtIndex(map, false, http, "test", queue::add, "http://127.0.0.1:" + bulk.getAddress().getPort() + "/meta");
    }

    private static void age(final Path f, final long minutes) throws Exception {
        Files.setLastModifiedTime(f, FileTime.from(Instant.now().minusSeconds(minutes * 60)));
    }

    @Test
    public void onlyOneProcessRebuildsAndTheOthersLeaveItAlone() throws Exception {
        final List<Runnable> qa = new ArrayList<>();
        final List<Runnable> qb = new ArrayList<>();
        final CardArtIndex a = process(qa);
        final CardArtIndex b = process(qb);
        a.ensure();
        assertEquals(qa.size(), 1, "the first process claims the rebuild");
        assertTrue(Files.exists(dir.resolve("card_images.building.lock")));
        b.ensure();
        assertEquals(qb.size(), 0, "the second sees the lock and keeps its old map");
        assertEquals(b.lookup("Lightning Bolt"), "https://cards.example/normal/front/a/b/bolt.jpg", "and still serves from it");

        qa.get(0).run();
        assertFalse(Files.exists(dir.resolve("card_images.building.lock")), "the lock is let go");
        assertTrue(Files.exists(dir.resolve("card_artists.v2.json")));
        assertEquals(a.artist("Lightning Bolt", false), "Zoë Robinson");

        final CardArtIndex c = process(new ArrayList<>());
        c.ensure();
        assertEquals(c.artist("Lightning Bolt", false), "Zoë Robinson", "a later process just loads what was built");
        final List<Runnable> qd = new ArrayList<>();
        process(qd).ensure();
        assertEquals(qd.size(), 0, "nothing left to rebuild");
    }

    @Test
    public void aStaleLockIsTakenOverAFreshOneIsNot() throws Exception {
        final Path lock = dir.resolve("card_images.building.lock");
        Files.createFile(lock);
        age(lock, 5);
        final List<Runnable> fresh = new ArrayList<>();
        process(fresh).ensure();
        assertEquals(fresh.size(), 0, "a 5 minute old lock is a build still running");

        age(lock, CardArtIndex.LOCK_TTL.toMinutes() + 5);
        final List<Runnable> stale = new ArrayList<>();
        process(stale).ensure();
        assertEquals(stale.size(), 1, "a lock past its TTL belongs to a dead process");
        assertTrue(Files.getLastModifiedTime(lock).toInstant().isAfter(Instant.now().minusSeconds(60)), "and is now ours");
    }

    @Test
    public void aFailedBuildHoldsEveryoneOffUntilTheBackoffRunsOut() throws Exception {
        down.set(true);
        final List<Runnable> qa = new ArrayList<>();
        process(qa).ensure();
        qa.get(0).run();
        final Path failed = dir.resolve("card_images.failed");
        assertTrue(Files.exists(failed), "a failed build leaves its mark");
        assertFalse(Files.exists(dir.resolve("card_images.building.lock")), "and its lock");
        assertFalse(Files.exists(dir.resolve("card_artists.v2.json")));

        final List<Runnable> qb = new ArrayList<>();
        process(qb).ensure();
        assertEquals(qb.size(), 0, "no process retries inside the backoff");

        age(failed, CardArtIndex.BACKOFF.toMinutes() + 5);
        down.set(false);
        final List<Runnable> qc = new ArrayList<>();
        final CardArtIndex c = process(qc);
        c.ensure();
        assertEquals(qc.size(), 1, "after it, one process tries again (no restart needed)");
        qc.get(0).run();
        assertFalse(Files.exists(failed), "a good build clears the mark");
        assertEquals(c.artist("Lightning Bolt", false), "Zoë Robinson");
    }
}

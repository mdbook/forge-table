package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonParser;

/**
 * Saved games ({@code checkpoint.json} in the game's folder, written by the game itself): a game that stops with a save
 * is paused, not ended, and its owner can resume it; a router restart keeps saved games, and resumes by itself the
 * ones marked as being played. The stand-in "game" is a shell script that finds {@code --checkpoint} on its command
 * line, writes a save there and crashes, or, started with {@code --resume}, says so and waits.
 */
public class PauseResumeTest {

    /**
     * Saves, then crashes; with --resume, notes it beside the save (a line per start) and waits, a game still starting,
     * until its stdin closes (as the real game: it saves and exits on EOF).
     */
    private static final String SAVE_THEN_CRASH = "cp=; prev=; for a in \"$0\" \"$@\"; do [ \"$prev\" = --checkpoint ] && cp=$a; "
            + "[ \"$a\" = --resume ] && { echo x >> \"$(dirname \"$cp\")/resumed\"; cat > /dev/null; exit 0; }; prev=$a; done; "
            + "echo '{\"v\":1}' > \"$cp\"; exit 3";

    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;
    private ChildProcessHost host;

    @AfterMethod(alwaysRun = true)
    public void stop() throws Exception {
        if (router != null) {
            router.stop();
            router = null;
        } else if (host != null) {
            host.close();
        }
        host = null;
        waitFor(() -> ProcessHandle.current().children().noneMatch(ProcessHandle::isAlive), 30, "stand-in children left running");
    }

    private static ChildProcessHost.Config config(final String name, final boolean clear) throws Exception {
        final ChildProcessHost.Config cfg = new ChildProcessHost.Config();
        cfg.java = "/bin/sh";
        cfg.jvmArgs = List.of("-c", SAVE_THEN_CRASH);
        cfg.classpath = "unused";
        cfg.dataDir = Path.of("target", "pause-resume-test", name).toAbsolutePath();
        if (clear) {
            ChildProcessHost.deleteTree(cfg.dataDir);
        }
        cfg.graceMs = 500;
        cfg.tickMs = 100;
        return cfg;
    }

    @Test
    public void aCrashedGameWithASaveIsPausedAndResumes() throws Exception {
        host = new ChildProcessHost(config("crash", true));
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        o.maxPerUser = 1;
        router = new Router(o, host);
        router.start();

        final HttpResponse<String> made = call("alice", "POST", "/api/matches", "{}");
        assertEquals(made.statusCode(), 201, made.body());
        final String id = JsonParser.parseString(made.body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> list("alice").contains("\"paused\""), 15, "a crashed game with a save is not paused");
        final Path dir = host.userDir("alice").getParent().getParent().resolve("matches").resolve(id);
        assertTrue(Files.isRegularFile(dir.resolve("checkpoint.json")), "its folder (and save) stay");
        assertTrue(Files.isRegularFile(dir.resolve("game.json")));
        assertEquals(call("alice", "POST", "/api/matches", "{}").statusCode(), 429, "a paused game counts for its owner");
        assertEquals(call("bob", "POST", "/api/matches/" + id + "/resume", "").statusCode(), 403, "only its players resume it");

        final HttpResponse<String> resumed = call("alice", "POST", "/api/matches/" + id + "/resume", "");
        assertEquals(resumed.statusCode(), 200, resumed.body());
        assertEquals(JsonParser.parseString(resumed.body()).getAsJsonObject().get("status").getAsString(), "starting");
        waitFor(() -> Files.exists(dir.resolve("resumed")), 10, "not started again with --resume");

        assertEquals(call("alice", "DELETE", "/api/matches/" + id, null).statusCode(), 200);
        waitFor(() -> !list("alice").contains(id), 20, "an ended paused game is still listed");
    }

    @Test
    public void aRestartKeepsSavedGamesAndResumesTheOnesBeingPlayed() throws Exception {
        final ChildProcessHost.Config cfg = config("restart", true);
        final Path matches = cfg.dataDir.resolve("matches");
        saved(matches, "aaaa0000aaaa0000", false, false);
        saved(matches, "bbbb0000bbbb0000", false, true);
        Files.createDirectories(matches.resolve("cccc0000cccc0000")); // no save: the earlier run's scratch
        saved(matches, "dddd0000dddd0000", true, true); // pvp, but nobody signed in had joined: no router facts
        Files.delete(matches.resolve("dddd0000dddd0000").resolve("router.json"));

        host = new ChildProcessHost(cfg);
        assertEquals(host.status("aaaa0000aaaa0000").status(), GameHost.Status.PAUSED);
        assertEquals(host.ai("aaaa0000aaaa0000"), "Default");
        assertFalse(Files.exists(matches.resolve("cccc0000cccc0000")), "a folder without a save is cleared");
        assertNull(host.status("dddd0000dddd0000"));
        waitFor(() -> Files.exists(matches.resolve("bbbb0000bbbb0000").resolve("resumed")), 10, "the game being played was not resumed");
        assertFalse(Files.exists(matches.resolve("bbbb0000bbbb0000").resolve("autoresume")), "the mark is used once");
        assertFalse(Files.exists(matches.resolve("aaaa0000aaaa0000").resolve("resumed")), "a paused game waits for its owner");
    }

    /** Stopping the router closes the game's stdin (it saves and exits); one being resumed resumes again at the next start. */
    @Test
    public void aGameBeingResumedWhenTheRouterStopsResumesAtTheNextStart() throws Exception {
        final ChildProcessHost.Config cfg = config("stop-start", true);
        final Path matches = cfg.dataDir.resolve("matches");
        final Path resumed = matches.resolve("eeee0000eeee0000").resolve("resumed");
        saved(matches, "eeee0000eeee0000", false, false);
        final ChildProcessHost first = new ChildProcessHost(cfg);
        assertEquals(first.resume("eeee0000eeee0000").status(), GameHost.Status.STARTING);
        waitFor(() -> Files.exists(resumed), 10, "not started with --resume");
        final long t0 = System.currentTimeMillis();
        first.close();
        assertTrue(System.currentTimeMillis() - t0 < 4_000, "the game didn't exit on stdin EOF: it waited for SIGTERM");
        assertTrue(Files.exists(matches.resolve("eeee0000eeee0000").resolve("autoresume")), "a game starting from its save is marked");
        assertTrue(Files.isRegularFile(matches.resolve("eeee0000eeee0000").resolve("checkpoint.json")), "the router's stop keeps the folder");

        host = new ChildProcessHost(cfg);
        waitFor(() -> Files.readAllLines(resumed).size() == 2, 10, "not resumed at the next start");
    }

    /** Two resumes of one game (two tabs, two players): one new process; both get the game. */
    @Test
    public void aDoubleResumeStartsOneGame() throws Exception {
        final ChildProcessHost.Config cfg = config("double", true);
        final Path matches = cfg.dataDir.resolve("matches");
        saved(matches, "ffff0000ffff0000", true, false); // pvp alice (creator) and bob
        host = new ChildProcessHost(cfg);
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        router = new Router(o, host);
        router.start();
        assertTrue(list("bob").contains("ffff0000ffff0000"), "the pvp game's seats were kept over the restart: " + list("bob"));
        final HttpResponse<String> a = call("alice", "POST", "/api/matches/ffff0000ffff0000/resume", "");
        final HttpResponse<String> b = call("bob", "POST", "/api/matches/ffff0000ffff0000/resume", "");
        assertEquals(a.statusCode(), 200, a.body());
        assertEquals(b.statusCode(), 200, b.body());
        assertEquals(JsonParser.parseString(b.body()).getAsJsonObject().get("status").getAsString(), "starting");
        final Path resumed = matches.resolve("ffff0000ffff0000").resolve("resumed");
        waitFor(() -> Files.exists(resumed), 10, "not resumed");
        Thread.sleep(500);
        assertEquals(Files.readAllLines(resumed).size(), 1, "started twice");
    }

    /** A save whose game file can't be read is moved aside, never deleted; a guest's game isn't kept over a restart. */
    @Test
    public void anUnreadableSaveIsKeptAsideAndAGuestsGameEnds() throws Exception {
        final ChildProcessHost.Config cfg = config("unreadable", true);
        final Path matches = cfg.dataDir.resolve("matches");
        saved(matches, "1111000011110000", false, false);
        Files.writeString(matches.resolve("1111000011110000").resolve("game.json"), "{\"id\":", StandardCharsets.UTF_8); // torn
        saved(matches, "2222000022220000", false, false, "guest-0123456789abcdef");
        host = new ChildProcessHost(cfg);
        assertNull(host.status("1111000011110000"));
        assertFalse(Files.exists(matches.resolve("1111000011110000")));
        try (java.util.stream.Stream<Path> s = Files.list(cfg.dataDir.resolve("unreadable"))) {
            final List<Path> aside = s.toList();
            assertEquals(aside.size(), 1);
            assertTrue(aside.get(0).getFileName().toString().startsWith("1111000011110000-"));
            assertTrue(Files.isRegularFile(aside.get(0).resolve("checkpoint.json")), "the save is kept");
        }
        assertEquals(host.status("2222000022220000").status(), GameHost.Status.PAUSED);
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        router = new Router(o, host);
        router.start();
        waitFor(() -> host.status("2222000022220000") == null, 10, "a guest's game was kept over the restart");
    }

    /** A game folder as a router left it: its facts, a save, and (when it was being played) the resume mark. */
    private static void saved(final Path matches, final String id, final boolean pvp, final boolean auto) throws Exception {
        saved(matches, id, pvp, auto, "alice");
    }

    private static void saved(final Path matches, final String id, final boolean pvp, final boolean auto, final String owner) throws Exception {
        final Path d = matches.resolve(id);
        Files.createDirectories(d);
        Files.writeString(d.resolve("game.json"), "{\"id\":\"" + id + "\",\"owner\":\"" + owner + "\",\"pvp\":" + pvp + ",\"ai\":\"Default\",\"created\":1}",
                StandardCharsets.UTF_8);
        Files.writeString(d.resolve("checkpoint.json"), "{\"v\":1}", StandardCharsets.UTF_8);
        if (pvp) {
            Files.writeString(d.resolve("router.json"), "{\"pvp\":{\"creator\":\"alice\",\"joiner\":\"bob\"}}", StandardCharsets.UTF_8);
        }
        if (auto) {
            Files.writeString(d.resolve("autoresume"), "", StandardCharsets.UTF_8);
        }
    }

    private HttpResponse<String> call(final String user, final String method, final String path, final String json) throws Exception {
        final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + path)).header("X-authentik-username", user);
        if (json != null) {
            b.header("Content-Type", "application/json");
        }
        return http.send(b.method(method, json == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private String list(final String user) throws Exception {
        return call(user, "GET", "/api/matches", null).body();
    }

    private interface Check {
        boolean ok() throws Exception;
    }

    private static void waitFor(final Check c, final int seconds, final String what) throws Exception {
        final long end = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < end) {
            if (c.ok()) {
                return;
            }
            Thread.sleep(100);
        }
        fail(what);
    }
}

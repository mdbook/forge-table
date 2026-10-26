package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import com.google.gson.JsonParser;

/**
 * {@link ChildProcessHost} with stand-in children (a shell, no Forge): a closing game holds its cap slot until its
 * process is gone, crashed games count per user and are reaped, and what a child is started with.
 */
public class ChildHostTest {

    private final HttpClient http = HttpClient.newHttpClient();
    private Router router;
    private ChildProcessHost host;

    @AfterMethod(alwaysRun = true)
    public void stop() throws Exception {
        if (router != null) {
            router.stop();
            router = null;
        }
        waitFor(() -> children().isEmpty(), 30, "stand-in children left running");
    }

    /** A host whose "game" is {@code sh -c script} (the rest of the command line becomes ignored arguments). */
    private ChildProcessHost host(final String name, final String script, final long graceMs) throws Exception {
        return host(name, script, graceMs, 20);
    }

    private ChildProcessHost host(final String name, final String script, final long graceMs, final int keepEnded) throws Exception {
        final ChildProcessHost.Config cfg = new ChildProcessHost.Config();
        cfg.keepEnded = keepEnded;
        cfg.java = "/bin/sh";
        cfg.jvmArgs = List.of("-c", script);
        cfg.classpath = "unused";
        cfg.dataDir = Path.of("target", "child-host-test", name).toAbsolutePath();
        ChildProcessHost.deleteTree(cfg.dataDir);
        cfg.graceMs = graceMs;
        cfg.tickMs = 100;
        cfg.silentMs = 1_000;
        return new ChildProcessHost(cfg);
    }

    private void start(final ChildProcessHost h, final int maxMatches, final int maxPerUser) throws Exception {
        host = h;
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = maxMatches;
        o.maxPerUser = maxPerUser;
        router = new Router(o, h);
        router.start();
    }

    private HttpResponse<String> create(final String user) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches")).header("X-authentik-username", user)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString());
    }

    private int delete(final String user, final String id) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches/" + id)).header("X-authentik-username", user)
                .DELETE().build(), HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    private String list(final String user) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/matches")).header("X-authentik-username", user)
                .GET().build(), HttpResponse.BodyHandlers.ofString()).body();
    }

    /**
     * Create-then-delete in a loop must never leave more live processes than the cap. The stand-in ignores
     * stdin EOF and SIGTERM, like a child still booting, so each one takes the full stop sequence to go.
     */
    @Test
    public void closingGamesHoldTheirCapUntilTheyExit() throws Exception {
        start(host("h1", "trap '' TERM HUP; while :; do sleep 1; done", 60_000), 2, 50);
        int created = 0;
        int full = 0;
        int maxLive = 0;
        for (int i = 0; i < 12; i++) {
            final HttpResponse<String> r = create("mallory");
            if (r.statusCode() == 201) {
                created++;
                final String id = JsonParser.parseString(r.body()).getAsJsonObject().get("id").getAsString();
                waitFor(() -> host.pid(id) > 0, 10, "stand-in never started");
                assertEquals(delete("mallory", id), 200);
                assertTrue(list("mallory").contains("\"stopping\""), "a closing game is listed as closing");
            } else {
                assertEquals(r.statusCode(), 503, r.body());
                full++;
            }
            maxLive = Math.max(maxLive, children().size());
            Thread.sleep(50);
        }
        assertTrue(maxLive <= 2, "live processes " + maxLive + " > cap 2");
        assertEquals(created, 2, "only the cap's worth of games may start while the others are still closing");
        assertEquals(full, 10);
        // Once they're gone, slots free up again.
        waitFor(() -> children().isEmpty(), 40, "stopped games never exited");
        waitFor(() -> !list("mallory").contains("\"id\""), 10, "stopped games still listed");
        assertEquals(create("mallory").statusCode(), 201);
    }

    /** A crashed game counts against its owner's limit until it is reaped after the grace period, folder and all. */
    @Test
    public void crashedGamesCountPerUserAndAreReaped() throws Exception {
        start(host("m4", "exit 3", 1_500), 10, 1);
        final HttpResponse<String> first = create("alice");
        assertEquals(first.statusCode(), 201);
        final String id = JsonParser.parseString(first.body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> list("alice").contains("\"crashed\""), 10, "not reported as crashed");
        assertTrue(list("alice").contains("the game stopped unexpectedly (code 3)"), "a generic reason, no paths");
        assertEquals(create("alice").statusCode(), 429, "a crashed game still counts for its owner");
        assertEquals(create("bob").statusCode(), 201, "but not against the server total");
        waitFor(() -> !list("alice").contains(id), 15, "crashed game not reaped");
        final Path data = host.userDir("alice").getParent().getParent();
        waitFor(() -> !Files.exists(data.resolve("matches").resolve(id)), 10, "crashed game's folder kept");
        // Its folder and log move to ended/, without the links to the shared folders.
        waitFor(() -> Files.isRegularFile(data.resolve("ended").resolve(id).resolve("child.log")), 10, "ended game's log not kept");
        assertFalse(Files.exists(data.resolve("ended").resolve(id).resolve("home/.forge/decks/constructed"), java.nio.file.LinkOption.NOFOLLOW_LINKS));
        assertTrue(Files.isDirectory(host.userDir("alice").resolve("decks")), "the user's decks stay");
        assertEquals(create("alice").statusCode(), 201);
    }

    /** Ended games' folders: the newest few are kept, older than a day or beyond the count are pruned. */
    @Test
    public void endedFoldersArePruned() throws Exception {
        start(host("prune", "echo bye; exit 3", 200, 2), 10, 10);
        final Path ended = host.userDir("x").getParent().getParent().resolve("ended");
        for (int i = 0; i < 4; i++) {
            final HttpResponse<String> r = create("carol");
            assertEquals(r.statusCode(), 201);
            final String id = JsonParser.parseString(r.body()).getAsJsonObject().get("id").getAsString();
            waitFor(() -> Files.isDirectory(ended.resolve(id)), 15, "ended folder " + id + " not kept");
            Thread.sleep(20); // distinct modification times
        }
        waitFor(() -> !list("carol").contains("\"id\""), 15, "crashed games not reaped");
        try (var s = Files.list(ended)) {
            assertEquals(s.count(), 2L, "only the newest 2 kept");
        }
        try (var s = Files.list(ended)) {
            for (final Path p : s.toList()) {
                ChildProcessHost.deleteTree(p);
            }
        }
        final Path old = ended.resolve("0123456789abcdef");
        Files.createDirectories(old.resolve("home"));
        Files.setLastModifiedTime(old, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() - 25 * 3_600_000L));
        host.pruneEnded();
        assertFalse(Files.exists(old), "a day old");
    }

    /** The lobby sees a starting game's boot progress (router labels only), and none once it is ready. */
    @Test
    public void startingGameShowsProgress() throws Exception {
        final Path go = Path.of("target", "child-host-test", "progress-go").toAbsolutePath();
        Files.createDirectories(go.getParent());
        Files.deleteIfExists(go);
        start(host("progress", "echo 'FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":50,\"label\":\"<i>x</i>\"}'; "
                + "while [ ! -e '" + go + "' ]; do sleep 0.1; done; "
                + "echo 'FORGE_TABLE_READY {\"port\":9,\"token\":\"t\"}'; while :; do sleep 1; done", 60_000), 2, 2);
        final HttpResponse<String> r = create("alice");
        assertEquals(r.statusCode(), 201);
        assertTrue(r.body().contains("\"progress\":{\"stage\":\"java\",\"label\":\"Starting Java\""), r.body());
        waitFor(() -> list("alice").contains("\"stage\":\"cards\""), 10, "progress line not picked up");
        final com.google.gson.JsonObject p = JsonParser.parseString(list("alice")).getAsJsonObject().getAsJsonArray("matches").get(0)
                .getAsJsonObject().getAsJsonObject("progress");
        assertEquals(p.get("label").getAsString(), "Loading card database");
        assertTrue(p.get("pct").getAsInt() >= 35 && p.get("pct").getAsInt() < 65, p.toString());
        assertTrue(p.has("elapsed"));
        assertFalse(list("alice").contains("<i>"), "the child's text never reaches the lobby");
        Files.createFile(go);
        waitFor(() -> list("alice").contains("\"ready\""), 10, "never ready");
        assertFalse(list("alice").contains("progress"), "no progress once ready");
    }

    /** The proxy hands the browser an art crop's artist, and still only that: any other header of the child's stays inside. */
    @Test
    public void proxyPassesTheCropArtistAndDropsOtherChildHeaders() throws Exception {
        final com.sun.net.httpserver.HttpServer game = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        game.createContext("/img/crop/x", ex -> {
            final byte[] body = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xd9};
            ex.getResponseHeaders().set("Content-Type", "image/jpeg");
            ex.getResponseHeaders().set("X-Card-Artist", "Zo%C3%AB%20Robinson");
            ex.getResponseHeaders().set("X-Child-Secret", "internal");
            ex.sendResponseHeaders(200, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        });
        game.start();
        try {
            start(host("artist", "echo 'FORGE_TABLE_READY {\"port\":" + game.getAddress().getPort() + ",\"token\":\"t\"}'; while :; do sleep 1; done", 60_000), 2, 2);
            final HttpResponse<String> made = create("alice");
            assertEquals(made.statusCode(), 201);
            final String id = JsonParser.parseString(made.body()).getAsJsonObject().get("id").getAsString();
            waitFor(() -> list("alice").contains("\"ready\""), 10, "never ready");
            final HttpResponse<byte[]> r = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/m/" + id + "/img/crop/x"))
                    .header("X-authentik-username", "alice").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(r.statusCode(), 200);
            assertEquals(r.headers().firstValue("Content-Type").orElse(""), "image/jpeg");
            assertEquals(r.headers().firstValue("X-Card-Artist").orElse(null), "Zo%C3%AB%20Robinson");
            assertFalse(r.headers().firstValue("X-Child-Secret").isPresent(), "headers outside the copied set stay inside");
        } finally {
            game.stop(0);
        }
    }

    /** A child copies only heap/stack sizes, module opens/exports and -D properties, and always gets --names-only. */
    @Test
    public void childCommandLine() throws Exception {
        assertEquals(ChildProcessHost.childJvmArgs(List.of("-Xmx1536m", "-Xms256m", "-Xss8m", "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED", "-Dmtgai.neural.dir=neural", "-Duser.home=/home/x", "-Dforge.table.ignoreStdin=true",
                "-agentlib:jdwp=transport=dt_socket,server=y,address=5005", "-javaagent:/x.jar", "-XX:+HeapDumpOnOutOfMemoryError",
                "--add-modules=ALL-DEFAULT", "-Xrunjdwp:x")),
                List.of("-Xmx1536m", "-Xms256m", "-Xss8m", "--add-opens=java.base/java.lang=ALL-UNNAMED", "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED",
                        "-Dmtgai.neural.dir=neural"));
        final ChildProcessHost h = host("cmd", "exit 0", 1000);
        try {
            final List<String> cmd = h.command(Path.of("/tmp/home"), "--router", null, "Default");
            final int main = cmd.indexOf("forge.bridge.Main");
            assertTrue(main > 0);
            assertTrue(cmd.subList(main, cmd.size()).contains("--names-only"));
            assertFalse(forge.bridge.Main.routerMode(cmd.subList(main + 1, cmd.size()).toArray(new String[0])),
                    "a deck named --router can't switch a child into router mode");
        } finally {
            h.close();
        }
        assertTrue(forge.bridge.Main.routerMode(new String[] {"--router", "--port", "1"}));
        assertFalse(forge.bridge.Main.routerMode(new String[] {"--deck", "--router"}));
    }

    /** Consent gates the capture itself: only a game with an upload URL gets the shared (flushed) trajectory dir, any other
     * gets the EMPTY value (mtg-ai: no files, no flush). The dir sits under the channel's persistent data, never
     * {@code matches/}, which the constructor wipes on restart. */
    @Test
    public void childCommandLineCarriesNeuralUpload() throws Exception {
        final ChildProcessHost h = host("neural", "exit 0", 1000);
        try {
            for (final String none : new String[] {null, "", "  "}) {
                final List<String> off = h.command(Path.of("/tmp/home"), null, null, null, none, Path.of("/tmp/consent"));
                assertTrue(off.contains("-Dmtgai.neural.games="), off.toString());
                assertFalse(off.stream().anyMatch(a -> a.startsWith("-Dmtgai.neural.games=") && a.length() > "-Dmtgai.neural.games=".length()),
                        "no consent, no shared dir: " + off);
                assertFalse(off.stream().anyMatch(a -> a.startsWith("-Dmtgai.neural.upload=")), "no URL asked, no upload property");
                assertFalse(off.stream().anyMatch(a -> a.startsWith("-Dmtgai.neural.consent=")), "no URL asked, no consent folder");
            }
            assertTrue(h.command(Path.of("/tmp/home"), null, null, null, "https://intake.example/", null).contains("-Dmtgai.neural.games="),
                    "a URL without a consent folder is no consent");
            assertTrue(h.command(Path.of("/tmp/home"), null, null, null).contains("-Dmtgai.neural.games="), "the short overload is no-consent too");

            final List<String> on = h.command(Path.of("/tmp/home"), null, null, null, "https://intake.example/", Path.of("/tmp/consent/ab/g1"));
            assertTrue(on.stream().anyMatch(a -> a.matches("-Dmtgai\\.neural\\.games=.*neural-games")), on.toString());
            assertTrue(on.contains("-Dmtgai.neural.upload=https://intake.example/"));
            assertTrue(on.contains("-Dmtgai.neural.consent=/tmp/consent/ab/g1"), on.toString());
        } finally {
            h.close();
        }
    }

    /** A consenting game gets its own consent folder; turning upload off deletes all of that owner's (running or ended
     * games alike), nobody else's; game end never does; old ones are pruned. */
    @Test
    public void uploadOffWithdrawsTheOwnersConsent() throws Exception {
        final ChildProcessHost h = host("consent", "while :; do sleep 1; done", 60_000);
        host = h;
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        o.maxPerUser = 10;
        o.uploadMode = "on";
        o.uploadUrl = "https://intake.example/";
        o.dataDir = h.userDir("x").getParent().getParent();
        router = new Router(o, h);
        router.start();
        final String a1 = JsonParser.parseString(create("alice").body()).getAsJsonObject().get("id").getAsString();
        final String a2 = JsonParser.parseString(create("alice").body()).getAsJsonObject().get("id").getAsString();
        final String b1 = JsonParser.parseString(create("bob").body()).getAsJsonObject().get("id").getAsString();
        final Path alice = h.ownerConsentDir("alice");
        final Path bob = h.ownerConsentDir("bob");
        waitFor(() -> Files.isDirectory(alice.resolve(a1)) && Files.isDirectory(alice.resolve(a2)) && Files.isDirectory(bob.resolve(b1)), 10,
                "consent folders not made at spawn");
        assertFalse(alice.toString().contains("alice"), "no user names on disk");
        assertEquals(delete("alice", a2), 200);
        waitFor(() -> !list("alice").contains(a2), 30, "ended game still listed");
        assertTrue(Files.isDirectory(alice.resolve(a2)), "game end keeps consent: a backoff retry may still be queued");

        final HttpResponse<String> off = putUpload("alice", false);
        assertEquals(off.statusCode(), 200, off.body());
        assertFalse(Files.exists(alice), "alice's consent withdrawn, running and ended games alike");
        assertTrue(Files.isDirectory(bob.resolve(b1)), "bob's untouched");

        assertEquals(putUpload("alice", false).statusCode(), 200, "withdrawing twice is a no-op");
        try (var w = Files.list(alice.getParent().getParent().resolve("withdrawn"))) {
            assertEquals(w.count(), 0L, "withdrawn folders are deleted");
        }

        // back on: old games stay withdrawn, a new game gets a new folder
        assertEquals(putUpload("alice", true).statusCode(), 200);
        final String a3 = JsonParser.parseString(create("alice").body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> Files.isDirectory(alice.resolve(a3)), 10, "re-enabled game has no consent folder");
        assertFalse(Files.exists(alice.resolve(a1)), "a game withdrawn once stays withdrawn");

        // the spawn re-checks consent: a withdrawal between create and spawn wins
        h.uploadConsent(owner -> false);
        final String a4 = JsonParser.parseString(create("alice").body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> h.pid(a4) > 0, 10, "stand-in never started");
        assertFalse(Files.exists(alice.resolve(a4)), "no consent at spawn, no folder");

        Files.setLastModifiedTime(bob.resolve(b1), java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() - 8 * 24 * 3_600_000L));
        h.pruneConsent();
        assertFalse(Files.exists(bob), "older than a week: pruned, empty owner folder too");
    }

    /** Opt-in channel: a user who never chose gets no folder; at start the router withdraws everyone not opted in. */
    @Test
    public void optInChannelReconcilesAtStart() throws Exception {
        final ChildProcessHost h = host("consent-optin", "while :; do sleep 1; done", 60_000);
        host = h;
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        o.maxPerUser = 10;
        o.uploadMode = "optin";
        o.uploadUrl = "https://intake.example/";
        o.dataDir = h.userDir("x").getParent().getParent();
        Files.createDirectories(h.ownerConsentDir("carol").resolve("left-over"));
        Files.createDirectories(h.ownerConsentDir("dave").resolve("left-over"));
        new UploadPrefs(o.dataDir.resolve("mtgai-upload-prefs.json")).set("dave", true);
        router = new Router(o, h);
        router.start();
        assertFalse(Files.exists(h.ownerConsentDir("carol")), "never opted in: withdrawn at start");
        assertTrue(Files.isDirectory(h.ownerConsentDir("dave").resolve("left-over")), "opted in: kept");
        final String c1 = JsonParser.parseString(create("carol").body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> h.pid(c1) > 0, 10, "stand-in never started");
        assertFalse(Files.exists(h.ownerConsentDir("carol")), "no choice on an opt-in channel: no folder");
    }

    /** An unreadable choices file: nobody consents (not "the default"), it is never overwritten, and start withdraws all. */
    @Test
    public void unreadablePrefsMeanNobodyUploads() throws Exception {
        final ChildProcessHost h = host("consent-corrupt", "while :; do sleep 1; done", 60_000);
        host = h;
        final Router.Options o = new Router.Options();
        o.trustHeader = "X-authentik-username";
        o.maxMatches = 10;
        o.maxPerUser = 10;
        o.uploadMode = "on";
        o.uploadUrl = "https://intake.example/";
        o.dataDir = h.userDir("x").getParent().getParent();
        final Path prefs = o.dataDir.resolve("mtgai-upload-prefs.json");
        Files.writeString(prefs, "{not json");
        Files.createDirectories(h.ownerConsentDir("erin").resolve("left-over"));
        router = new Router(o, h);
        router.start();
        assertFalse(Files.exists(h.ownerConsentDir("erin")), "withdrawn at start");
        final String e1 = JsonParser.parseString(create("erin").body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> h.pid(e1) > 0, 10, "stand-in never started");
        assertFalse(Files.exists(h.ownerConsentDir("erin")), "default-on channel, unknown choice: no folder");
        assertEquals(putUpload("erin", true).statusCode(), 500);
        assertEquals(Files.readString(prefs), "{not json", "never overwritten");
    }

    private HttpResponse<String> putUpload(final String user, final boolean on) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + router.port() + "/api/upload"))
                .header("X-authentik-username", user).header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString("{\"on\":" + on + "}")).build(), HttpResponse.BodyHandlers.ofString());
    }

    /** Trajectories queued before the gate cannot be attributed to a consenting game: moved out of {@code traj/} once,
     * so no flush ever sees them; the marker keeps later (consented) files from being moved on the next start. */
    @Test
    public void preGateTrajectoriesAreQuarantinedOnce() throws Exception {
        final Path data = Path.of("target", "child-host-test", "quarantine").toAbsolutePath();
        ChildProcessHost.deleteTree(data);
        final Path traj = data.resolve("neural-games").resolve("traj");
        Files.createDirectories(traj.resolve("sent"));
        Files.writeString(traj.resolve("20261010T120000Z-abcdef.mtgt"), "x");
        Files.writeString(traj.resolve("20261010T120000Z-abcdef.json"), "{}");
        Files.writeString(traj.resolve("sent").resolve("20261009T120000Z-123456.json"), "{}");
        Files.writeString(data.resolve("neural-games").resolve("games.jsonl"), "{}\n");
        ChildProcessHost.Config cfg = new ChildProcessHost.Config();
        cfg.java = "/bin/sh";
        cfg.classpath = "unused";
        cfg.dataDir = data;
        cfg.tickMs = 100;
        new ChildProcessHost(cfg).close();
        final Path games = data.resolve("neural-games");
        try (var s = Files.list(traj)) {
            assertEquals(s.filter(Files::isRegularFile).count(), 0L, "nothing left to flush");
        }
        assertTrue(Files.exists(games.resolve("quarantine").resolve("20261010T120000Z-abcdef.mtgt")));
        assertTrue(Files.exists(games.resolve("quarantine").resolve("20261010T120000Z-abcdef.json")));
        assertTrue(Files.exists(traj.resolve("sent").resolve("20261009T120000Z-123456.json")), "delivered history stays");
        assertTrue(Files.exists(games.resolve("games.jsonl")), "local logs are not the upload queue");

        // a consenting game's file written after the gate survives the next start
        Files.writeString(traj.resolve("20261011T010000Z-fedcba.json"), "{}");
        new ChildProcessHost(cfg).close();
        assertTrue(Files.exists(traj.resolve("20261011T010000Z-fedcba.json")));
    }

    /** Drain mode end to end: a real router process, drained over its admin port, exits with code 0. */
    @Test
    public void drainedRouterProcessExitsZero() throws Exception {
        final Path data = Path.of("target", "child-host-test", "drain").toAbsolutePath();
        ChildProcessHost.deleteTree(data);
        final int admin;
        try (java.net.ServerSocket free = new java.net.ServerSocket(0)) {
            admin = free.getLocalPort();
        }
        final Process p = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp", System.getProperty("java.class.path"),
                "forge.bridge.Main", "--router", "--port", "0", "--admin-port", String.valueOf(admin), "--data", data.toString())
                .redirectErrorStream(true).start();
        try {
            final java.io.BufferedReader out = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()));
            String line;
            while ((line = out.readLine()) != null && !line.startsWith("FORGE_TABLE_READY")) {
                // boot output
            }
            assertTrue(line != null, "router never got ready");
            final HttpResponse<String> d = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + admin + "/admin/drain"))
                    .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(d.statusCode(), 200);
            assertTrue(p.waitFor(30, java.util.concurrent.TimeUnit.SECONDS), "drained router didn't exit");
            assertEquals(p.exitValue(), 0);
        } finally {
            p.destroyForcibly();
        }
    }

    /**
     * A game between two people: its child gets {@code --pvp} and seat 1's own deck folder, an empty
     * {@code -Dmtgai.neural.games=} and no other {@code -Dmtgai.*} (nothing captured), and no AI or opponent deck.
     */
    @Test
    public void pvpChildCommandLine() throws Exception {
        final ChildProcessHost.Config cfg = new ChildProcessHost.Config();
        cfg.jvmArgs = List.of("-Xmx512m", "-Dmtgai.neural.dir=neural", "-Dmtgai.humanseat.log=/x", "-Dforge.x=1");
        cfg.classpath = "unused";
        cfg.dataDir = Path.of("target", "child-host-test", "pvp-cmd").toAbsolutePath();
        ChildProcessHost.deleteTree(cfg.dataDir);
        final ChildProcessHost h = new ChildProcessHost(cfg);
        try {
            final List<String> cmd = h.pvpCommand(Path.of("/tmp/home"), "mono-red-madness", Path.of("/tmp/g/seat1/decks"));
            assertTrue(cmd.contains("-Dmtgai.neural.games="), cmd.toString());
            assertEquals(cmd.stream().filter(a -> a.startsWith("-Dmtgai.")).toList(), List.of("-Dmtgai.neural.games="), cmd.toString());
            assertTrue(cmd.contains("-Dforge.x=1") && cmd.contains("--names-only"));
            final int i = cmd.indexOf("--seat1-decks");
            assertTrue(cmd.contains("--pvp") && i > 0 && cmd.get(i + 1).equals("/tmp/g/seat1/decks"), cmd.toString());
            assertFalse(cmd.contains("--opp-deck") || cmd.contains("--ai"), cmd.toString());
            assertEquals(cmd.get(cmd.indexOf("--deck") + 1), "mono-red-madness");
        } finally {
            h.close();
        }
    }

    /** The router's hello stamp wins over anything the browser sent: token, seat and name. */
    @Test
    public void helloIsStampedWithTheSeat() {
        final String forged = "{\"t\":\"hello\",\"token\":\"guess\",\"seat\":1,\"name\":\"bob\",\"client\":{\"speed\":1}}";
        final com.google.gson.JsonObject h = JsonParser.parseString(ChildProcessHost.rewriteHello(forged, "tok", 0, "alice")).getAsJsonObject();
        assertEquals(h.get("token").getAsString(), "tok");
        assertEquals(h.get("seat").getAsInt(), 0);
        assertEquals(h.get("name").getAsString(), "alice");
        assertEquals(h.getAsJsonObject("client").get("speed").getAsInt(), 1);
        assertFalse(JsonParser.parseString(ChildProcessHost.rewriteHello(forged, "tok", 1, null)).getAsJsonObject().has("name"),
                "no name from the router: none at all, not the browser's");
        assertEquals(ChildProcessHost.rewriteHello("{\"t\":\"act\",\"seat\":0}", "tok", 1, "x"), null);
        assertEquals(ChildProcessHost.rewriteHello("not json", "tok", 1, "x"), null);
    }

    /**
     * Seat 1 gets exactly the one deck its player joined with: from the shared folders or that player's own, never
     * anyone else's, never by a path. The lobby's deck list is the shared decks plus the user's own.
     */
    @Test
    public void joinerDeckIsTheOnlyOneHandedOver() throws Exception {
        final ChildProcessHost h = host("pvp-deck", "sleep 30", 60_000);
        final Path shared = Files.createDirectories(Path.of("target", "child-host-test", "pvp-deck-shared").toAbsolutePath());
        Files.writeString(shared.resolve("burn.dck"), "[metadata]\nName=Burn\n[Main]\n20 Mountain\n");
        try {
            final java.lang.reflect.Field f = ChildProcessHost.class.getDeclaredField("cfg");
            f.setAccessible(true);
            ((ChildProcessHost.Config) f.get(h)).childArgs.addAll(List.of("--decks", shared.toString()));
            final Path aliceDecks = Files.createDirectories(h.userDir("alice").resolve("decks"));
            Files.writeString(aliceDecks.resolve("mine.dck"), "[metadata]\nName=Mine\n[Main]\n20 Island\n");
            Files.writeString(aliceDecks.resolve("other.dck"), "[metadata]\nName=Other\n[Main]\n20 Swamp\n");
            assertEquals(h.decks("alice"), List.of("burn", "mine", "other"));
            assertEquals(h.decks(null), List.of("burn"), "no user, shared decks only");

            final String id = h.createPvp("carol", "burn").id();
            final String ai = h.create("carol", null, null, null).id();
            assertFalse(h.seatDeck(id, "bob", "mine"), "bob has no deck called mine");
            assertFalse(h.seatDeck(id, "alice", "../alice/decks/mine"));
            assertFalse(h.seatDeck(id, null, "mine"), "a guest only has the shared decks");
            assertFalse(h.seatDeck(ai, "alice", "mine"), "a game against the AI has no seat 1");
            assertTrue(h.seatDeck(id, "alice", "mine"));
            final Path seat1 = Path.of("target", "child-host-test", "pvp-deck", "matches", id, "seat1", "decks").toAbsolutePath();
            try (java.util.stream.Stream<Path> s = Files.list(seat1)) {
                assertEquals(s.map(p -> p.getFileName().toString()).toList(), List.of("mine.dck"), "only the chosen deck");
            }
        } finally {
            h.close();
        }
    }

    /**
     * The lobby's deck details come from the very file a game would load by that name (shared folders first, then the
     * user's own); a deck that can't be read (too big, a link out of its folder) is listed without them.
     */
    @Test
    public void deckSummariesReadTheGamesFile() throws Exception {
        final ChildProcessHost h = host("deck-summaries", "sleep 30", 60_000);
        final Path shared = Files.createDirectories(Path.of("target", "child-host-test", "deck-summaries-shared").toAbsolutePath());
        Files.writeString(shared.resolve("burn.dck"), "[metadata]\nName=Burn\n[Main]\n4 Lightning Bolt|M10|1\n16 Mountain\n");
        try {
            final java.lang.reflect.Field f = ChildProcessHost.class.getDeclaredField("cfg");
            f.setAccessible(true);
            ((ChildProcessHost.Config) f.get(h)).childArgs.addAll(List.of("--decks", shared.toString()));
            final Path mine = Files.createDirectories(h.userDir("alice").resolve("decks"));
            Files.writeString(mine.resolve("burn.dck"), "[Main]\n60 Island\n"); // shadowed by the shared one, as in a game
            Files.writeString(mine.resolve("huge.dck"), "[Main]\n" + "1 Opt\n".repeat(50_000));
            Files.writeString(mine.resolve("ramp.dck"), "[Commander]\n1 Omnath, Locus of Mana\n[Main]\n98 Forest\n");
            final Path outside = Files.writeString(shared.resolveSibling("deck-summaries-outside.dck"), "[Main]\n1 Secret\n");
            Files.deleteIfExists(mine.resolve("link.dck"));
            Files.createSymbolicLink(mine.resolve("link.dck"), outside);
            assertEquals(h.decks("alice"), List.of("burn", "huge", "link", "ramp"));
            final java.util.Map<String, DeckSummary> d = h.deckSummaries("alice", null);
            assertEquals(d.keySet(), java.util.Set.of("burn", "ramp"), "too big and a link out: listed, no details");
            assertEquals(d.get("burn"), new DeckSummary(20, "R", "Lightning Bolt", null));
            assertEquals(d.get("ramp"), new DeckSummary(99, "G", "Omnath, Locus of Mana", "Omnath, Locus of Mana"));
            assertEquals(h.deckSummaries(null, null).keySet(), java.util.Set.of("burn"), "no user, shared decks only");
            assertFalse(h.standardChecked(), "no res/ here: Standard isn't judged");
            assertEquals(h.deckCards("alice", null, "burn").toString(), "{Main={Lightning Bolt=4, Mountain=16}}", "the shared one, as a game loads it");
            assertNull(h.deckCards("alice", null, "link"), "a link out");
            assertNull(h.deckCards("bob", null, "ramp"), "another user's");
            assertNull(h.deckCards("alice", null, "../deck-summaries-outside"));

            // with Forge's res/ (--assets): non-commander decks are judged for Standard
            final Path assets = Files.createDirectories(Path.of("target", "child-host-test", "deck-summaries-assets").toAbsolutePath());
            Files.createDirectories(assets.resolve("res/formats/Sanctioned"));
            Files.createDirectories(assets.resolve("res/editions"));
            Files.writeString(assets.resolve("res/formats/Sanctioned/Standard.txt"), "Sets:AAA\n");
            Files.writeString(assets.resolve("res/editions/a.txt"), "[metadata]\nCode=AAA\n[cards]\n1 C Opt\n");
            ((ChildProcessHost.Config) f.get(h)).childArgs.addAll(List.of("--assets", assets.toString()));
            assertTrue(h.standardChecked());
            final java.util.Map<String, DeckSummary> std = h.deckSummaries("alice", null);
            assertEquals(std.get("burn").standard(), "20 cards: Standard needs 60");
            assertNull(std.get("ramp").standard(), "a commander deck isn't judged");
            assertNull(h.deckSummaries("alice", "brawl").get("burn").standard(), "nor in Brawl");
        } finally {
            h.close();
        }
    }

    /** A Brawl game also offers the shared Brawl decks from the children's res/, to list and to join with. */
    @Test
    public void brawlGamesOfferTheBrawlDecks() throws Exception {
        final ChildProcessHost h = host("brawl-deck", "sleep 30", 60_000);
        final Path assets = Path.of("target", "child-host-test", "brawl-assets").toAbsolutePath();
        final Path brawl = Files.createDirectories(assets.resolve("res").resolve("forge-table").resolve("brawl-decks"));
        Files.writeString(brawl.resolve("vigil.dck"), "[metadata]\nName=Vigil\n[Main]\n99 Plains\n");
        try {
            final java.lang.reflect.Field f = ChildProcessHost.class.getDeclaredField("cfg");
            f.setAccessible(true);
            ((ChildProcessHost.Config) f.get(h)).childArgs.addAll(List.of("--assets", assets.toString()));
            assertEquals(h.decks(null), List.of(), "not in a Constructed game");
            assertEquals(h.decks(null, "brawl"), List.of("vigil"));
            final GameHost.Game brawlGame = h.createPvp("carol", "vigil", "brawl");
            assertEquals(brawlGame.format(), "brawl");
            assertTrue(h.seatDeck(brawlGame.id(), null, "vigil"));
            assertFalse(h.seatDeck(h.createPvp("carol", "x").id(), null, "vigil"), "a Constructed game has no Brawl decks");
        } finally {
            h.close();
        }
    }

    /**
     * A browser socket that goes quiet without closing (a sleeping laptop, a dropped network) is closed once it
     * stops answering pings, so the finished game is reaped. A socket that answers stays open.
     */
    @Test
    public void silentSocketIsClosedSoItsFinishedGameIsReaped() throws Exception {
        final String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        start(host("silent", "exec '" + java + "' -cp '" + System.getProperty("java.class.path") + "' '" + FakeChild.class.getName() + "'", 500), 10, 3);
        final String id = JsonParser.parseString(create("alice").body()).getAsJsonObject().get("id").getAsString();
        waitFor(() -> list("alice").contains("\"playing\""), 30, "the stand-in never started");
        final URI ws = URI.create("ws://127.0.0.1:" + router.port() + "/m/" + id + "/ws");
        final CompletableFuture<Integer> liveClosed = new CompletableFuture<>();
        final WebSocket live = http.newWebSocketBuilder().header("X-authentik-username", "alice").buildAsync(ws, new WebSocket.Listener() {
            @Override
            public CompletionStage<?> onClose(final WebSocket w, final int code, final String reason) {
                liveClosed.complete(code);
                return null;
            }
        }).get(10, TimeUnit.SECONDS); // answers pings on its own
        try (Socket silent = new Socket("127.0.0.1", router.port())) {
            final OutputStream out = silent.getOutputStream();
            out.write(("GET /m/" + id + "/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nX-authentik-username: alice\r\nUpgrade: websocket\r\n"
                    + "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            silent.setSoTimeout(15_000);
            final InputStream in = silent.getInputStream();
            try {
                while (in.read() >= 0) {
                    // the 101, then pings it never answers, then the router hangs up
                }
            } catch (final SocketTimeoutException e) {
                fail("a socket that never answers pings is still open");
            }
        }
        assertFalse(liveClosed.isDone(), "a socket that answers pings stays open");
        waitFor(() -> list("alice").contains("\"over\""), 10, "the stand-in never reported its match over");
        assertTrue(list("alice").contains(id), "an open game isn't reaped");
        live.abort();
        waitFor(() -> !list("alice").contains(id), 15, "finished game not reaped once its sockets were gone");
    }

    /**
     * A stand-in game: says it's ready, plays until the router's socket arrives, then reports its match over; it never
     * says a word on that socket.
     */
    public static final class FakeChild {
        private static volatile boolean joined;

        public static void main(final String[] args) throws Exception {
            final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            System.out.println("FORGE_TABLE_READY {\"port\":" + server.getLocalPort() + ",\"token\":\"t\"}");
            System.out.flush();
            final Thread stdin = new Thread(() -> {
                try {
                    while (System.in.read() >= 0) {
                        // the router closes stdin to stop a game
                    }
                } catch (final IOException ignored) {
                    // gone
                }
                System.exit(0);
            });
            stdin.setDaemon(true);
            stdin.start();
            while (true) {
                final Socket s = server.accept();
                final Thread t = new Thread(() -> serve(s));
                t.setDaemon(true);
                t.start();
            }
        }

        private static void serve(final Socket s) {
            try (s) {
                final BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
                final String first = in.readLine();
                String key = null;
                String line;
                while ((line = in.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase(Locale.ROOT).startsWith("sec-websocket-key:")) {
                        key = line.substring("sec-websocket-key:".length()).trim();
                    }
                }
                final OutputStream out = s.getOutputStream();
                if (first != null && first.startsWith("GET /ws")) {
                    final String accept = Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-1")
                            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
                    out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept
                            + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    joined = true;
                    while (s.getInputStream().read() >= 0) {
                        // hold it open
                    }
                } else {
                    final byte[] body = ("{\"state\":\"" + (joined ? "over" : "playing") + "\"}").getBytes(StandardCharsets.US_ASCII);
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n")
                            .getBytes(StandardCharsets.US_ASCII));
                    out.write(body);
                    out.flush();
                }
            } catch (final Exception ignored) {
                // the router went away
            }
        }
    }

    private static List<ProcessHandle> children() {
        return ProcessHandle.current().children().filter(ProcessHandle::isAlive).toList();
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

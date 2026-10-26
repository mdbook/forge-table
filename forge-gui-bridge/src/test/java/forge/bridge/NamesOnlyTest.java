package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * {@code --names-only} (router games): match.start takes bare deck names found inside the deck
 * folders, never a path, a link out of a deck folder or a board-state file, and every refusal reads the same.
 */
public class NamesOnlyTest {

    private Main.Running sidecar;
    private WebSocket ws;
    private final BlockingQueue<JsonObject> inbox = new LinkedBlockingQueue<>();
    private Path root;
    private int rpcId;

    @BeforeClass
    public void boot() throws Exception {
        root = Path.of("target", "names-only").toAbsolutePath();
        if (Files.exists(root)) {
            try (var walk = Files.walk(root)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(f -> f.toFile().delete());
            }
        }
        final Path fixture = TableTestEnv.decksDir().toPath().resolve("mono-red-madness.dck");
        // Another user's imports, and a deck folder holding a link that leads out of it.
        Files.createDirectories(root.resolve("users/bob/decks"));
        Files.copy(fixture, root.resolve("users/bob/decks/secret.dck"), StandardCopyOption.REPLACE_EXISTING);
        Files.createDirectories(root.resolve("mine"));
        Files.createSymbolicLink(root.resolve("mine/escape.dck"), root.resolve("users/bob/decks/secret.dck"));

        final BridgeApp.Options o = TableTestEnv.options();
        o.deckDirs.add(root.resolve("mine").toString());
        o.namesOnly = true;
        sidecar = Main.boot(o);
        ws = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + sidecar.port() + "/ws"), new WebSocket.Listener() {
            private final StringBuilder partial = new StringBuilder();

            @Override
            public CompletionStage<?> onText(final WebSocket w, final CharSequence data, final boolean last) {
                partial.append(data);
                if (last) {
                    inbox.add(JsonParser.parseString(partial.toString()).getAsJsonObject());
                    partial.setLength(0);
                }
                w.request(1);
                return null;
            }
        }).get(30, TimeUnit.SECONDS);
        final JsonObject hello = new JsonObject();
        hello.addProperty("t", "hello");
        hello.addProperty("proto", 1);
        hello.addProperty("token", sidecar.token);
        ws.sendText(hello.toString(), true).join();
        next("welcome");
    }

    @AfterClass(alwaysRun = true)
    public void stop() {
        if (ws != null) {
            ws.abort();
        }
        if (sidecar != null) {
            sidecar.stop();
        }
    }

    private JsonObject next(final String type) throws InterruptedException {
        while (true) {
            final JsonObject m = inbox.poll(60, TimeUnit.SECONDS);
            if (m == null) {
                throw new AssertionError("no " + type);
            }
            if (type.equals(m.get("t").getAsString())) {
                return m;
            }
        }
    }

    /** match.start with these params; the rpcResult. */
    private JsonObject start(final String key, final String value) throws InterruptedException {
        final JsonObject params = new JsonObject();
        params.addProperty("oppDeck", "mono-blue-faeries");
        params.addProperty("deck", "mono-red-madness");
        params.addProperty(key, value);
        final JsonObject rpc = new JsonObject();
        rpc.addProperty("t", "rpc");
        rpc.addProperty("id", "r" + ++rpcId);
        rpc.addProperty("method", "match.start");
        rpc.add("params", params);
        ws.sendText(rpc.toString(), true).join();
        return next("rpcResult");
    }

    private void refused(final String key, final String value, final String expected) throws InterruptedException {
        final JsonObject r = start(key, value);
        assertFalse(r.get("ok").getAsBoolean(), key + "=" + value + " was accepted");
        assertEquals(r.get("error").getAsString(), expected, key + "=" + value);
    }

    @Test
    public void pathsAndStatesAreRefusedAlike() throws Exception {
        final String secret = root.resolve("users/bob/decks/secret.dck").toString();
        final File fixture = TableTestEnv.decksDir();
        refused("deck", secret, "Unknown deck");                                   // absolute path to a real file
        refused("deck", secret + ".missing", "Unknown deck");                      // … and to none: same answer
        refused("deck", new File(fixture, "mono-red-madness.dck").getAbsolutePath(), "Unknown deck");
        refused("deck", "../users/bob/decks/secret", "Unknown deck");              // traversal into another user's folder
        refused("oppDeck", "../../names-only/users/bob/decks/secret", "Unknown deck");
        refused("deck", "..\\users\\bob\\decks\\secret", "Unknown deck");
        refused("deck", "escape", "Unknown deck");                                 // a link out of a deck folder
        refused("deck", ".hidden", "Unknown deck");
        refused("deck", "--router", "Unknown deck");
        refused("state", fixture.getAbsolutePath(), "Board states aren't available here");
        // A plain name still works.
        final JsonObject ok = start("deck", "mono-red-madness");
        assertTrue(ok.get("ok").getAsBoolean(), ok.toString());
        // Leave only once the game is really up (its first prompt): leaving while Forge still sets up the zones
        // crashes the half-started game a moment later, inside whichever test runs next.
        next("prompt");
        final JsonObject leave = new JsonObject();
        leave.addProperty("t", "rpc");
        leave.addProperty("id", "leave");
        leave.addProperty("method", "match.leave");
        ws.sendText(leave.toString(), true).join();
        next("rpcResult");
    }
}

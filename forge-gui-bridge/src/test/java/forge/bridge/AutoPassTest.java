package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.io.File;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Auto-skip and pass-until-end-of-turn against the real engine, from board fixtures in
 * {@code table/states/autopass-*.txt}. Auto-skip is Forge's "auto-pass when no actions": a priority where the
 * player can cast, play or activate nothing but mana abilities never reaches the client. Pass until end of turn
 * is Forge's End Turn yield: it ends at cleanup, or early when an opponent attacks or casts.
 */
public class AutoPassTest {

    private static final Duration WAIT = Duration.ofSeconds(60);

    @Test
    public void autoSkipPassesTheOpponentsTurnWhenNothingIsPlayable() throws Exception {
        try (Game g = new Game("autopass-nothing.txt", true)) {
            assertTrue(g.snapshot.getAsJsonObject("autoPass").get("autoSkip").getAsBoolean(), "snapshot autoPass: " + g.snapshot);
            final JsonObject p = g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer, "auto-skip stopped on the AI's turn: " + p);
            assertEquals(g.phase(), "MAIN1");
        }
    }

    @Test
    public void autoSkipOffStopsAtTheOpponentsStops() throws Exception {
        try (Game g = new Game("autopass-nothing.txt", false)) {
            assertTrue(!g.snapshot.getAsJsonObject("autoPass").get("autoSkip").getAsBoolean(), "snapshot autoPass: " + g.snapshot);
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "no stop on the AI's turn with auto-skip off");
        }
    }

    @Test
    public void anActivatedAbilityIsSomethingToDo() throws Exception {
        try (Game g = new Game("autopass-ability.txt", true)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "auto-skip passed with Mogg Fanatic's ability available");
        }
    }

    /**
     * A filter mana source fixes colours ("auto-skip skips when you can still do things with Giant's Boulder"): a
     * Plains into the Boulder's {1},{T} makes the {R} for Lightning Bolt, so the Bolt is playable and auto-skip stops.
     */
    @Test
    public void aFilterManaSourceMakesASpellPlayable() throws Exception {
        try (Game g = new Game("autopass-filter.txt", true)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "auto-skip passed with Lightning Bolt castable through Giant's Boulder");
            final String bolt = g.cardNamed("Lightning Bolt");
            assertTrue(g.weak().has(bolt), "Lightning Bolt not playable: " + g.prompt);
        }
    }

    /** The same board with the Boulder tapped: nothing makes {R}, so auto-skip passes the AI's turn. */
    @Test
    public void aTappedFilterManaSourceFixesNothing() throws Exception {
        try (Game g = new Game("autopass-filter-tapped.txt", true)) {
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer, "auto-skip stopped with no way to make {R}");
            assertEquals(g.phase(), "MAIN1");
        }
    }

    /** A snoozed card isn't something to do: with Mogg Fanatic snoozed, auto-skip passes the AI's turn. */
    @Test
    public void aSnoozedCardIsNotSomethingToDo() throws Exception {
        try (Game g = new Game("autopass-ability.txt", false)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer);
            final String fanatic = g.cards.entrySet().stream()
                    .filter(e -> e.getValue().has("state") && "Mogg Fanatic".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                    .map(java.util.Map.Entry::getKey).findFirst().orElseThrow();
            final JsonObject snooze = new JsonObject();
            snooze.addProperty("t", "act");
            snooze.addProperty("kind", "snooze");
            snooze.addProperty("card", fanatic);
            snooze.addProperty("on", true);
            g.send(snooze);
            g.awaitAutoPass(s -> s.has("snoozed") && s.getAsJsonArray("snoozed").toString().contains(fanatic));
            g.act("autoSkip", "on", true);
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer, "auto-skip stopped for a snoozed Mogg Fanatic");
            assertEquals(g.phase(), "MAIN1");
        }
    }

    /**
     * Snoozing drops a card's playable highlight (the prompt's "weak" set) and un-snoozing brings it back at once, without
     * waiting for another action to push a fresh prompt ("unsnoozing doesn't show the card as castable until I do
     * something else").
     */
    @Test
    public void unsnoozingShowsTheCardAsPlayableAgain() throws Exception {
        try (Game g = new Game("autopass-ability.txt", false)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer);
            final String fanatic = g.cards.entrySet().stream()
                    .filter(e -> e.getValue().has("state") && "Mogg Fanatic".equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                    .map(java.util.Map.Entry::getKey).findFirst().orElseThrow();
            assertTrue(g.weak().has(fanatic), "Mogg Fanatic not playable at the AI's stop: " + g.prompt);
            g.snooze(fanatic, true);
            g.awaitPrompt(p -> !p.getAsJsonObject("weak").has(fanatic));
            g.snooze(fanatic, false);
            g.awaitPrompt(p -> p.getAsJsonObject("weak").has(fanatic));
        }
    }

    @Test
    public void turningAutoSkipOnPassesAtOnce() throws Exception {
        try (Game g = new Game("autopass-nothing.txt", false)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer);
            // Sitting at the AI's stop with nothing to do: switching auto-skip on passes it, and the rest of the turn.
            g.act("autoSkip", "on", true);
            g.awaitAutoPass(s -> s.get("autoSkip").getAsBoolean());
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer, "auto-skip did not pass the rest of the AI's turn");
            assertEquals(g.phase(), "MAIN1");
        }
    }

    @Test
    public void passUntilEndOfTurnEndsAtCleanup() throws Exception {
        try (Game g = new Game("autopass-my-turn.txt", false)) {
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer);
            g.yieldEndOfTurn();
            g.awaitAutoPass(s -> s.get("untilEndOfTurn").getAsBoolean());
            // My Main 2 stop is passed; the next stop is the AI's turn, and the yield was off by then.
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "passing stopped on my own turn");
            assertTrue(g.sawAutoPass(s -> !s.get("untilEndOfTurn").getAsBoolean()), "yield never reported off: " + g.autoPass);
        }
    }

    @Test
    public void passUntilEndOfTurnStopsWhenAttacked() throws Exception {
        try (Game g = new Game("autopass-attack.txt", false)) {
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer);
            assertEquals(g.phase(), "COMBAT_BEGIN");
            g.yieldEndOfTurn();
            g.awaitAutoPass(s -> s.get("untilEndOfTurn").getAsBoolean());
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "passing went on past the attack");
            assertEquals(g.phase(), "COMBAT_DECLARE_ATTACKERS");
            assertTrue(g.game.has("combat") && g.game.getAsJsonArray("combat").size() > 0, "no attackers: " + g.game);
            assertTrue(g.sawAutoPass(s -> !s.get("untilEndOfTurn").getAsBoolean()), "yield never reported off: " + g.autoPass);
        }
    }

    /** Neither auto-skip nor passing the turn ever answers a decision: blocks are always asked. */
    @Test(dataProvider = "passing")
    public void blocksAreAlwaysAsked(final boolean autoSkip, final boolean passTurn) throws Exception {
        try (Game g = new Game("autopass-block.txt", autoSkip)) {
            final boolean[] passed = {!passTurn};
            final JsonObject block = g.await(m -> {
                if (!"prompt".equals(m.get("t").getAsString())) {
                    return false;
                }
                if ("priority".equals(m.get("kind").getAsString())) {
                    if (!passed[0]) {
                        passed[0] = true;
                        g.yieldEndOfTurn();
                    } else {
                        // Being attacked ends the pass (Forge stops there): pass priority on, as a player would.
                        final JsonObject ok = new JsonObject();
                        ok.addProperty("t", "act");
                        ok.addProperty("kind", "ok");
                        ok.addProperty("pid", m.get("pid").getAsLong());
                        g.send(ok);
                    }
                }
                return "declareBlockers".equals(m.get("kind").getAsString());
            });
            assertTrue(block.has("blockable") && block.getAsJsonObject("blockable").size() > 0, "nothing to block with: " + block);
        }
    }

    @org.testng.annotations.DataProvider
    public Object[][] passing() {
        return new Object[][] {{true, false}, {true, true}, {false, true}};
    }

    /**
     * A triggered ability isn't a spell: passing the turn goes on through one, the opponent's or mine, with auto-skip on
     * or off ("pass turn gets undone after a trigger if auto-skip is enabled"). Mogg Fanatic gives me something to
     * do, so auto-skip alone would not hide a stop at the trigger.
     */
    @Test(dataProvider = "triggers")
    public void passUntilEndOfTurnGoesOnThroughATrigger(final String state, final boolean autoSkip) throws Exception {
        try (Game g = new Game(state, autoSkip)) {
            g.awaitPriority();
            assertEquals(g.turnPlayer(), g.viewer);
            assertEquals(g.phase(), "MAIN1");
            g.yieldEndOfTurn();
            g.awaitAutoPass(s -> s.get("untilEndOfTurn").getAsBoolean());
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "passing stopped on my own turn at " + g.phase() + ": " + g.game);
        }
    }

    @org.testng.annotations.DataProvider
    public Object[][] triggers() {
        return new Object[][] {
                {"autopass-trigger-opp.txt", true}, {"autopass-trigger-opp.txt", false},
                {"autopass-trigger-mine.txt", true}, {"autopass-trigger-mine.txt", false}};
    }

    @Test
    public void passUntilEndOfTurnStopsOnAnOpponentsSpell() throws Exception {
        try (Game g = new Game("autopass-cast.txt", false)) {
            g.awaitPriority();
            if (g.stackSize() > 0) {
                fail("the AI cast Grizzly Bears before combat; the fixture needs a later cast: " + g.game);
            }
            g.yieldEndOfTurn();
            g.awaitAutoPass(s -> s.get("untilEndOfTurn").getAsBoolean());
            g.awaitPriority();
            assertNotEquals(g.turnPlayer(), g.viewer, "passing went on past the AI's spell");
            assertEquals(g.stackSize(), 1, "expected Grizzly Bears on the stack: " + g.game);
            assertTrue(g.sawAutoPass(s -> !s.get("untilEndOfTurn").getAsBoolean()), "yield never reported off: " + g.autoPass);
        }
    }

    /** A client that comes back mid-match is told the match's AI (the table shows the Neural AI's picture by it). */
    @Test
    public void aReconnectIsToldTheMatchsAi() throws Exception {
        try (Game g = new Game("autopass-nothing.txt", true)) {
            final BlockingQueue<JsonObject> inbox = new LinkedBlockingQueue<>();
            final WebSocket again = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + g.sidecar.port() + "/ws"),
                    new WebSocket.Listener() {
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
            try {
                final JsonObject hello = new JsonObject();
                hello.addProperty("t", "hello");
                hello.addProperty("proto", 1);
                hello.addProperty("token", g.sidecar.token);
                again.sendText(hello.toString(), true).join();
                JsonObject w;
                do {
                    w = inbox.poll(60, TimeUnit.SECONDS);
                    assertTrue(w != null, "no welcome");
                } while (!"welcome".equals(w.get("t").getAsString()));
                assertTrue(w.get("match").getAsBoolean());
                assertEquals(w.get("ai").getAsString(), "Default");
            } finally {
                again.abort();
            }
        }
    }

    // ---------------------------------------------------------------- a minimal protocol client

    /** One sidecar, one match from a fixture, and a client that keeps the game object and the autoPass notices. */
    static final class Game implements AutoCloseable, WebSocket.Listener {
        private final Main.Running sidecar;
        private final WebSocket ws;
        private final BlockingQueue<JsonObject> inbox = new LinkedBlockingQueue<>();
        private final StringBuilder partial = new StringBuilder();
        final List<JsonObject> autoPass = new ArrayList<>();
        final java.util.Map<String, JsonObject> cards = new java.util.HashMap<>();
        JsonObject snapshot;
        JsonObject game = new JsonObject();
        final JsonObject players = new JsonObject();
        JsonObject prompt;
        String viewer;
        /** The helper keeps the opening hand (and answers play-or-draw); off to test the mulligan itself. */
        volatile boolean autoKeep = true;

        Game(final String state, final boolean autoSkip) throws Exception {
            this(defaultParams(state), autoSkip);
        }

        static JsonObject defaultParams(final String state) throws URISyntaxException {
            final JsonObject params = new JsonObject();
            params.addProperty("deck", "mono-red-madness");
            params.addProperty("oppDeck", "mono-blue-faeries");
            params.addProperty("ai", "Default");
            if (state != null) {
                params.addProperty("state", fixture("table/states/" + state));
            }
            return params;
        }

        /** A game started with these match.start params. */
        Game(final JsonObject params, final boolean autoSkip) throws Exception {
            this(TableTestEnv.start(), params, autoSkip);
        }

        /** A game on {@code sidecar}: started with these match.start params, or (null) the one it is already playing. */
        Game(final Main.Running sidecar, final JsonObject params, final boolean autoSkip) throws Exception {
            this(sidecar, params, autoSkip, null, null);
        }

        /** {@link #Game(Main.Running, JsonObject, boolean)} at a game between two people: the router's seat and name in the hello. */
        Game(final Main.Running sidecar, final JsonObject params, final boolean autoSkip, final Integer seat, final String name) throws Exception {
            this.sidecar = sidecar;
            ws = HttpClient.newHttpClient().newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + sidecar.port() + "/ws"), this).get(30, TimeUnit.SECONDS);
            final JsonObject client = new JsonObject();
            client.addProperty("speed", 0);
            client.addProperty("autoSkip", autoSkip);
            final JsonObject hello = new JsonObject();
            hello.addProperty("t", "hello");
            hello.addProperty("proto", 1);
            hello.addProperty("token", sidecar.token);
            if (seat != null) {
                hello.addProperty("seat", seat);
                hello.addProperty("name", name);
            }
            hello.add("client", client);
            send(hello);
            await(m -> "welcome".equals(m.get("t").getAsString()));
            if (params != null) {
                final JsonObject rpc = new JsonObject();
                rpc.addProperty("t", "rpc");
                rpc.addProperty("id", "start");
                rpc.addProperty("method", "match.start");
                rpc.add("params", params);
                send(rpc);
            }
            snapshot = await(m -> "snapshot".equals(m.get("t").getAsString()));
        }

        Main.Running sidecar() {
            return sidecar;
        }

        String turnPlayer() {
            return game.has("playerTurn") ? game.get("playerTurn").getAsString() : null;
        }

        String phase() {
            return game.has("phase") ? game.get("phase").getAsString() : null;
        }

        int stackSize() {
            return game.has("stack") ? game.getAsJsonArray("stack").size() : 0;
        }

        JsonObject awaitPriority() throws InterruptedException {
            return await(m -> "prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString()));
        }

        void awaitAutoPass(final Predicate<JsonObject> state) throws InterruptedException {
            if (sawAutoPassLast(state)) {
                return;
            }
            await(m -> "notice".equals(m.get("t").getAsString()) && "autoPass".equals(m.get("kind").getAsString()) && state.test(m));
        }

        private boolean sawAutoPassLast(final Predicate<JsonObject> state) {
            return !autoPass.isEmpty() && state.test(autoPass.get(autoPass.size() - 1));
        }

        boolean sawAutoPass(final Predicate<JsonObject> state) {
            return autoPass.stream().anyMatch(state);
        }

        void act(final String kind, final String key, final boolean value) {
            final JsonObject a = new JsonObject();
            a.addProperty("t", "act");
            a.addProperty("kind", kind);
            a.addProperty(key, value);
            send(a);
        }

        /** The client id of the first card with this name. */
        String cardNamed(final String name) {
            return cards.entrySet().stream()
                    .filter(e -> e.getValue().has("state") && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                    .map(java.util.Map.Entry::getKey).findFirst().orElseThrow(() -> new AssertionError("no " + name + " in " + cards.keySet()));
        }

        /** The playable highlights of the prompt on screen. */
        JsonObject weak() {
            return prompt.getAsJsonObject("weak");
        }

        void snooze(final String card, final boolean on) {
            final JsonObject a = new JsonObject();
            a.addProperty("t", "act");
            a.addProperty("kind", "snooze");
            a.addProperty("card", card);
            a.addProperty("on", on);
            send(a);
        }

        /** Reads until a prompt or prompt update matches. */
        void awaitPrompt(final Predicate<JsonObject> want) throws InterruptedException {
            await(m -> ("prompt".equals(m.get("t").getAsString()) || "promptUpdate".equals(m.get("t").getAsString())) && want.test(m));
        }

        void yieldEndOfTurn() {
            final JsonObject a = new JsonObject();
            a.addProperty("t", "act");
            a.addProperty("kind", "yield");
            a.addProperty("until", "endOfTurn");
            send(a);
        }

        /** Read messages (keeping the model current) until one matches; game over or a timeout fails. */
        JsonObject await(final Predicate<JsonObject> want) throws InterruptedException {
            final long deadline = System.nanoTime() + WAIT.toNanos();
            while (true) {
                final JsonObject m = inbox.poll(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (m == null) {
                    fail("timed out; game " + game + "; last prompt " + prompt);
                }
                apply(m);
                if (want.test(m)) {
                    return m;
                }
                if ("gameOver".equals(m.get("t").getAsString())) {
                    fail("game ended first: " + m);
                }
            }
        }

        private void apply(final JsonObject m) {
            switch (m.get("t").getAsString()) {
                case "snapshot" -> {
                    viewer = m.get("viewer").getAsString();
                    game = m.getAsJsonObject("game");
                    m.getAsJsonObject("players").entrySet().forEach(e -> players.add(e.getKey(), e.getValue()));
                    cards.clear();
                    m.getAsJsonObject("cards").entrySet().forEach(e -> cards.put(e.getKey(), e.getValue().getAsJsonObject()));
                }
                case "beat", "settle" -> {
                    final JsonObject patch = m.getAsJsonObject("patch");
                    if (patch != null && patch.has("game")) {
                        game = patch.getAsJsonObject("game");
                    }
                    if (patch != null && patch.has("players")) {
                        patch.getAsJsonObject("players").entrySet().forEach(e -> players.add(e.getKey(), e.getValue()));
                    }
                    if (patch != null && patch.has("cards")) {
                        patch.getAsJsonObject("cards").entrySet().forEach(e -> {
                            if (e.getValue().isJsonNull()) {
                                cards.remove(e.getKey());
                            } else {
                                cards.put(e.getKey(), e.getValue().getAsJsonObject());
                            }
                        });
                    }
                }
                case "prompt", "promptUpdate" -> {
                    prompt = m;
                    final String kind = m.get("kind").getAsString();
                    if (autoKeep && "prompt".equals(m.get("t").getAsString()) && ("mulligan".equals(kind) || "confirm".equals(kind))) {
                        // Before turn 1 the fixtures still go through play-or-draw and an empty keep.
                        final JsonObject ok = new JsonObject();
                        ok.addProperty("t", "act");
                        ok.addProperty("kind", "ok");
                        ok.addProperty("pid", m.get("pid").getAsLong());
                        send(ok);
                    }
                }
                case "notice" -> {
                    if ("autoPass".equals(m.get("kind").getAsString())) {
                        autoPass.add(m);
                    }
                }
                default -> { }
            }
        }

        void send(final JsonObject msg) {
            synchronized (this) {
                ws.sendText(msg.toString(), true).join();
            }
        }

        @Override
        public CompletionStage<?> onText(final WebSocket webSocket, final CharSequence data, final boolean last) {
            partial.append(data);
            if (last) {
                inbox.add(JsonParser.parseString(partial.toString()).getAsJsonObject());
                partial.setLength(0);
            }
            webSocket.request(1);
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void close() throws Exception {
            try {
                final JsonObject concede = new JsonObject();
                concede.addProperty("t", "act");
                concede.addProperty("kind", "concede");
                send(concede);
                final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                JsonObject m;
                while ((m = inbox.poll(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS)) != null
                        && !"gameOver".equals(m.get("t").getAsString())) {
                    // drain to game over
                }
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "done");
            } finally {
                sidecar.stop();
            }
        }

        private static String fixture(final String resource) throws URISyntaxException {
            return new File(AutoPassTest.class.getClassLoader().getResource(resource).toURI()).getAbsolutePath();
        }
    }
}

package forge.bridge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/**
 * A protocol-level test client: drives a real game over the real
 * WebSocket with a seeded random-legal policy, keeps a local copy of the projected model, and checks
 * invariants on every message. Uses {@code java.net.http}'s WebSocket, which has no frame-size cap.
 *
 * <p>Adversarial mode also sends, with jitter, acts carrying an already-superseded pid and duplicate
 * acts; every superseded-pid act must come back as a {@code stale} notice.
 */
public final class ScriptedClient implements WebSocket.Listener {

    /** What a finished game looked like from the client. */
    public static final class Result {
        public boolean gameOver;
        public boolean won;
        public String winner;
        public int beats;
        public int acts;
        public int staleSent;
        public int staleNotices;
        public boolean capped;
        public final Map<String, Integer> promptKinds = new HashMap<>();
        public final Map<String, Integer> askKinds = new HashMap<>();
        public final Map<String, Integer> beatKinds = new HashMap<>();
        /** Acts sent by kind (block, attack… show the one-step combat acts got exercised). */
        public final Map<String, Integer> actKinds = new HashMap<>();
        public final Map<String, Integer> staleReasons = new HashMap<>();
        public final List<String> violations = new ArrayList<>();
        public long millis;

        @Override
        public String toString() {
            return "won=" + won + " winner=" + winner + " beats=" + beats + " acts=" + acts + " stale=" + staleNotices + "/" + staleSent
                    + " capped=" + capped + " ms=" + millis + " prompts=" + promptKinds + " asks=" + askKinds + " actKinds=" + actKinds
                    + " staleReasons=" + staleReasons;
        }
    }

    /** Violation prefix of the known null-fromId own-draw flake, so tests can tell it apart. */
    public static final String NULL_FROM_ID_DRAW = "own draw beat without a fromId (known flake)";

    private final URI uri;
    private final Map<String, String> headers;
    private final String token;
    private final Random random;
    private final boolean adversarial;
    private final int actCap;
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        final Thread t = new Thread(r, "scripted-client");
        t.setDaemon(true);
        return t;
    });
    private final StringBuilder partial = new StringBuilder();
    private final CountDownLatch done = new CountDownLatch(1);
    private final AtomicInteger rpcIds = new AtomicInteger();
    private final Result result = new Result();
    private final List<Consumer<JsonObject>> observers = new ArrayList<>();
    private WebSocket ws;
    private long started;

    // Local model (applied from snapshot/beat/settle) and the prompt on screen.
    private JsonObject game = new JsonObject();
    private final Map<String, JsonObject> players = new LinkedHashMap<>();
    private final Map<String, JsonObject> cards = new LinkedHashMap<>();
    private String viewer;
    private JsonObject prompt;
    private long lastSeq;
    private final List<Long> supersededPids = new ArrayList<>();
    private final Map<Long, Integer> pokesPerPid = new HashMap<>();
    private int asksSincePrompt;
    private int promptVersion;
    private JsonObject startParams = new JsonObject();
    /** Extra hello fields (a pvp seat's {@code seat} and {@code name}, as the router stamps them). */
    private final JsonObject helloExtra = new JsonObject();

    public ScriptedClient(final int port, final String token, final long seed, final boolean adversarial, final int actCap) {
        this(URI.create("ws://127.0.0.1:" + port + "/ws"), Map.of(), token, seed, adversarial, actCap);
    }

    /** A client for any socket URL (a router's {@code /m/<id>/ws}), sending {@code headers} with the upgrade. */
    public ScriptedClient(final URI uri, final Map<String, String> headers, final String token, final long seed, final boolean adversarial,
            final int actCap) {
        this.uri = uri;
        this.headers = headers;
        this.token = token;
        this.random = new Random(seed);
        this.adversarial = adversarial;
        this.actCap = actCap;
    }

    public ScriptedClient onMessage(final Consumer<JsonObject> observer) {
        observers.add(observer);
        return this;
    }

    public ScriptedClient helloExtra(final String key, final JsonElement value) {
        helloExtra.add(key, value);
        return this;
    }

    public Map<String, JsonObject> cards() { return cards; }
    public Map<String, JsonObject> players() { return players; }
    public JsonObject game() { return game; }
    public String viewer() { return viewer; }
    /** True once the client conceded (act cap reached); the engine then reveals face-down cards. */
    public boolean conceded() { return result.capped; }

    /** Connect, start a match with {@code params} (deck, oppDeck, ai) and play it to game over. */
    public Result play(final JsonObject params, final Duration timeout) throws Exception {
        this.startParams = params;
        started = System.currentTimeMillis();
        final WebSocket.Builder b = HttpClient.newHttpClient().newWebSocketBuilder();
        headers.forEach(b::header);
        ws = b.buildAsync(uri, this).get(30, TimeUnit.SECONDS);
        final JsonObject hello = new JsonObject();
        hello.addProperty("t", "hello");
        hello.addProperty("proto", 1);
        hello.addProperty("token", token);
        final JsonObject client = new JsonObject();
        client.addProperty("speed", 0); // Instant: the Pacer never holds the engine for a scripted client
        hello.add("client", client);
        helloExtra.entrySet().forEach(e -> hello.add(e.getKey(), e.getValue()));
        send(hello);
        final boolean finished = done.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
        result.millis = System.currentTimeMillis() - started;
        if (!finished) {
            result.violations.add("timeout after " + timeout + "; last prompt " + prompt);
            dumpThreads(); // an in-process sidecar's game thread shows where the game stands (AI, an Input, a prompt)
        }
        ws.sendClose(WebSocket.NORMAL_CLOSURE, "done");
        exec.shutdownNow();
        return result;
    }

    private static void dumpThreads() {
        final StringBuilder b = new StringBuilder("[ScriptedClient] timeout thread dump\n");
        Thread.getAllStackTraces().forEach((t, st) -> {
            if (st.length == 0 || t.getName().startsWith("nioEventLoop") || t.getName().startsWith("ForkJoinPool")) {
                return;
            }
            b.append("THREAD ").append(t.getName()).append(' ').append(t.getState()).append('\n');
            for (int i = 0; i < Math.min(st.length, 60); i++) {
                b.append("    at ").append(st[i]).append('\n');
            }
        });
        System.out.println(b);
    }

    private void send(final JsonObject msg) {
        synchronized (this) {
            ws.sendText(msg.toString(), true).join();
        }
    }

    @Override
    public CompletionStage<?> onText(final WebSocket webSocket, final CharSequence data, final boolean last) {
        partial.append(data);
        if (last) {
            final String text = partial.toString();
            partial.setLength(0);
            if (exec.isShutdown()) {
                return CompletableFuture.completedFuture(null); // a late frame after the game ended
            }
            exec.execute(() -> {
                try {
                    handle(JsonParser.parseString(text).getAsJsonObject());
                } catch (final RuntimeException e) {
                    result.violations.add("client exception: " + e);
                    e.printStackTrace();
                }
            });
        }
        webSocket.request(1);
        return CompletableFuture.completedFuture(null);
    }

    private void handle(final JsonObject m) {
        observers.forEach(o -> o.accept(m));
        final String t = m.get("t").getAsString();
        if (m.has("seq")) {
            final long seq = m.get("seq").getAsLong();
            if (!"snapshot".equals(t) && seq <= lastSeq) {
                result.violations.add("seq went backwards: " + seq + " after " + lastSeq + " (" + t + ")");
            }
            lastSeq = seq;
        }
        switch (t) {
            case "welcome" -> rpc("match.start", startParams);
            case "rpcResult" -> {
                if (!m.get("ok").getAsBoolean()) {
                    result.violations.add("rpc failed: " + m);
                    done.countDown();
                }
            }
            case "snapshot" -> {
                viewer = m.has("viewer") ? m.get("viewer").getAsString() : null;
                game = m.getAsJsonObject("game");
                players.clear();
                m.getAsJsonObject("players").entrySet().forEach(e -> players.put(e.getKey(), e.getValue().getAsJsonObject()));
                cards.clear();
                m.getAsJsonObject("cards").entrySet().forEach(e -> cards.put(e.getKey(), e.getValue().getAsJsonObject()));
                checkModel("snapshot");
            }
            case "beat" -> {
                result.beats++;
                result.beatKinds.merge(m.get("kind").getAsString(), 1, Integer::sum);
                checkBeat(m);
                applyPatch(m.getAsJsonObject("patch"));
                checkModel("beat " + m.get("kind").getAsString());
            }
            case "settle" -> {
                applyPatch(m.getAsJsonObject("patch"));
                checkModel("settle");
            }
            case "prompt", "promptUpdate" -> onPrompt(m);
            case "promptClear" -> {
                if (prompt != null && prompt.get("pid").getAsLong() == m.get("pid").getAsLong()) {
                    supersededPids.add(prompt.get("pid").getAsLong());
                    prompt = null;
                }
            }
            case "ask" -> onAsk(m);
            case "notice" -> {
                if ("stale".equals(m.get("kind").getAsString())) {
                    result.staleNotices++;
                    result.staleReasons.merge(m.has("reason") ? m.get("reason").getAsString() : "?", 1, Integer::sum);
                }
            }
            case "gameOver" -> {
                result.gameOver = true;
                result.won = m.has("won") && m.get("won").getAsBoolean();
                result.winner = m.has("winner") ? m.get("winner").getAsString() : null;
                done.countDown();
            }
            default -> { }
        }
    }

    private void rpc(final String method, final JsonObject params) {
        final JsonObject r = new JsonObject();
        r.addProperty("t", "rpc");
        r.addProperty("id", "r" + rpcIds.incrementAndGet());
        r.addProperty("method", method);
        r.add("params", params);
        send(r);
    }

    private void applyPatch(final JsonObject patch) {
        if (patch == null) {
            return;
        }
        if (patch.has("game")) {
            game = patch.getAsJsonObject("game");
        }
        if (patch.has("players")) {
            patch.getAsJsonObject("players").entrySet().forEach(e -> players.put(e.getKey(), e.getValue().getAsJsonObject()));
        }
        if (patch.has("cards")) {
            patch.getAsJsonObject("cards").entrySet().forEach(e -> {
                if (e.getValue().isJsonNull()) {
                    cards.remove(e.getKey());
                } else {
                    cards.put(e.getKey(), e.getValue().getAsJsonObject());
                }
            });
        }
    }

    /** Beat payload invariants the client's choreography relies on. */
    private void checkBeat(final JsonObject m) {
        final String kind = m.get("kind").getAsString();
        if ("toStack".equals(kind) && !m.has("card")) {
            result.violations.add("toStack beat without a card: " + m);
        }
        if ("draw".equals(kind) && m.has("to") && viewer != null
                && viewer.equals(m.getAsJsonObject("to").has("player") ? m.getAsJsonObject("to").get("player").getAsString() : null)) {
            final String from = m.has("fromId") && !m.get("fromId").isJsonNull() ? m.get("fromId").getAsString() : "";
            final String card = m.has("card") ? m.get("card").getAsString() : "";
            // From a hidden slot, or from a card its owner already knows (put back by Brainstorm, looked at with Ponder).
            if (!(from.startsWith("x") || from.equals(card)) || !card.startsWith("c")) {
                result.violations.add((from.isEmpty() ? NULL_FROM_ID_DRAW : "own draw should go from a hidden (or already known) library card to a visible one: from=" + from)
                        + " card=" + card + " beat=" + m);
            }
        }
    }

    /** Redaction invariants checked after every state message. */
    private void checkModel(final String where) {
        for (final String id : cards.keySet()) {
            if (!id.startsWith("c") && !id.startsWith("f")) {
                result.violations.add(where + ": card object for non-visible id " + id);
            }
        }
        for (final JsonObject card : cards.values()) {
            if (card.get("id").getAsString().startsWith("f") && (card.has("alt") || card.has("left") || card.has("right"))) {
                result.violations.add(where + ": unidentified face-down card carries a hidden face " + card.get("id"));
            }
        }
        for (final Map.Entry<String, JsonObject> p : players.entrySet()) {
            final JsonObject zones = p.getValue().getAsJsonObject("zones");
            if (zones == null) {
                continue;
            }
            if (zones.has("library")) {
                for (final JsonElement id : zones.getAsJsonArray("library")) {
                    if (!id.getAsString().startsWith("x") && !cards.containsKey(id.getAsString())) {
                        result.violations.add(where + ": library id " + id + " is neither hidden nor a known card");
                    }
                }
            }
            if (!p.getKey().equals(viewer) && zones.has("hand")) {
                for (final JsonElement id : zones.getAsJsonArray("hand")) {
                    final String s = id.getAsString();
                    if (!s.startsWith("x")) {
                        // Visible only while revealed (PlayerMayLook); the card object must then exist.
                        if (!cards.containsKey(s)) {
                            result.violations.add(where + ": opponent hand id " + s + " visible without a card object");
                        }
                    }
                }
            }
        }
    }

    private void onPrompt(final JsonObject m) {
        promptVersion++;
        asksSincePrompt = 0;
        final long pid = m.get("pid").getAsLong();
        if (prompt != null && prompt.get("pid").getAsLong() != pid) {
            supersededPids.add(prompt.get("pid").getAsLong());
        }
        prompt = m;
        final String kind = m.get("kind").getAsString();
        if ("prompt".equals(m.get("t").getAsString())) {
            result.promptKinds.merge(kind, 1, Integer::sum);
        }
        if ("waiting".equals(kind)) {
            return;
        }
        if (result.acts >= actCap) {
            if (!result.capped) {
                result.capped = true;
                final JsonObject concede = new JsonObject();
                concede.addProperty("t", "act");
                concede.addProperty("kind", "concede");
                send(concede);
            }
            return;
        }
        final JsonObject act = decide(m, kind);
        if (act == null) {
            return;
        }
        if (adversarial && !supersededPids.isEmpty() && random.nextInt(4) == 0) {
            final long old = supersededPids.get(random.nextInt(supersededPids.size()));
            final JsonObject stale = act.deepCopy();
            stale.addProperty("pid", old);
            exec.schedule(() -> {
                result.staleSent++;
                send(stale);
            }, random.nextInt(50), TimeUnit.MILLISECONDS);
        }
        result.acts++;
        result.actKinds.merge(act.get("kind").getAsString(), 1, Integer::sum);
        send(act);
        // An act that changes nothing (e.g. clicking a card that can't be played now) produces no new prompt:
        // decide again after a pause, so the game always moves on.
        final int version = promptVersion;
        exec.schedule(() -> {
            if (promptVersion == version && prompt == m && !result.gameOver) {
                onPrompt(m);
            }
        }, 150, TimeUnit.MILLISECONDS);
        if (adversarial && random.nextInt(6) == 0) {
            // A duplicate press: if the first press moved the engine on, this one must be dropped.
            exec.schedule(() -> send(act), random.nextInt(30), TimeUnit.MILLISECONDS);
        }
    }

    private JsonObject decide(final JsonObject m, final String kind) {
        final boolean ok = m.getAsJsonObject("ok").get("enabled").getAsBoolean();
        final boolean cancel = m.getAsJsonObject("cancel").get("enabled").getAsBoolean();
        final long pid = m.get("pid").getAsLong();
        final List<String> sel = new ArrayList<>();
        m.getAsJsonArray("selectable").forEach(e -> sel.add(e.getAsString()));
        if ("priority".equals(kind)) {
            // Cards the engine marks as playable now (weakly selectable), else anything in hand or on my side
            // of the battlefield: the engine decides whether a click plays, casts or activates something.
            m.getAsJsonObject("weak").keySet().forEach(sel::add);
            if (sel.isEmpty() && viewer != null && players.containsKey(viewer)) {
                final JsonObject zones = players.get(viewer).getAsJsonObject("zones");
                for (final String z : new String[] {"hand", "battlefield"}) {
                    if (zones != null && zones.has(z)) {
                        zones.getAsJsonArray(z).forEach(e -> sel.add(e.getAsString()));
                    }
                }
            }
        }
        if ("declareBlockers".equals(kind) && sel.isEmpty() && viewer != null && players.containsKey(viewer)) {
            // InputBlock marks nothing selectable: any attacker (to pick it) or my creature (to block with it) is a click.
            if (game != null && game.has("combat")) {
                game.getAsJsonArray("combat").forEach(b -> sel.add(b.getAsJsonObject().get("attacker").getAsString()));
            }
            final JsonObject zones = players.get(viewer).getAsJsonObject("zones");
            if (zones != null && zones.has("battlefield")) {
                zones.getAsJsonArray("battlefield").forEach(e -> sel.add(e.getAsString()));
            }
        }
        final JsonObject act = new JsonObject();
        act.addProperty("t", "act");
        act.addProperty("pid", pid);
        // Mostly progress; poke a selectable card (play, cast, target, pay, block…) at most 3 times per prompt.
        final int pokes = pokesPerPid.getOrDefault(pid, 0);
        final boolean poke = !sel.isEmpty() && pokes < 3 && random.nextInt(100) < ("priority".equals(kind) ? 70 : 60);
        // Half the combat pokes use the one-step acts: block {blocker, attacker} from the prompt's blockable
        // pairs (sometimes unblock), attack {attacker, defender} at one of its defenders.
        final JsonObject blockable = m.has("blockable") ? m.getAsJsonObject("blockable") : null;
        final JsonArray defenders = m.has("defenders") ? m.getAsJsonArray("defenders") : null;
        if (poke && random.nextBoolean() && blockable != null && !blockable.isEmpty()) {
            pokesPerPid.put(pid, pokes + 1);
            final List<String> blockers = new ArrayList<>(blockable.keySet());
            final String blocker = blockers.get(random.nextInt(blockers.size()));
            if (random.nextInt(5) == 0) {
                act.addProperty("kind", "unblock");
            } else {
                final JsonArray attackers = blockable.getAsJsonArray(blocker);
                act.addProperty("kind", "block");
                act.addProperty("attacker", attackers.get(random.nextInt(attackers.size())).getAsString());
            }
            act.addProperty("blocker", blocker);
            return act;
        }
        // (InputAttack marks nothing selectable, so this one doesn't wait for a poke.)
        if (pokes < 3 && random.nextInt(100) < 30 && defenders != null && !defenders.isEmpty() && "declareAttackers".equals(kind)
                && m.getAsJsonObject("weak").size() > 0) {
            pokesPerPid.put(pid, pokes + 1);
            final List<String> attackers = new ArrayList<>(m.getAsJsonObject("weak").keySet());
            act.addProperty("kind", "attack");
            act.addProperty("attacker", attackers.get(random.nextInt(attackers.size())));
            act.addProperty("defender", defenders.get(random.nextInt(defenders.size())).getAsString());
            return act;
        }
        if (poke) {
            pokesPerPid.put(pid, pokes + 1);
            act.addProperty("kind", "card");
            act.addProperty("card", sel.get(random.nextInt(sel.size())));
        } else if (ok) {
            act.addProperty("kind", "ok");
        } else if (cancel) {
            act.addProperty("kind", "cancel");
        } else if (!sel.isEmpty()) {
            act.addProperty("kind", "card");
            act.addProperty("card", sel.get(random.nextInt(sel.size())));
        } else {
            result.violations.add("no action possible for prompt " + m);
            return null;
        }
        return act;
    }

    /** Split: combat damage lethal to each item in order (the rest to the last), else each item's min, then fill in order. */
    private static JsonArray split(final JsonObject m) {
        final int n = m.getAsJsonArray("items").size();
        int left = m.get("amount").getAsInt();
        final int[] give = new int[n];
        if (m.has("lethal")) {
            final JsonArray lethal = m.getAsJsonArray("lethal");
            for (int i = 0; i < n; i++) {
                give[i] = i == n - 1 ? left : Math.min(lethal.get(i).getAsInt(), left);
                left -= give[i];
            }
        } else {
            for (int i = 0; i < n; i++) {
                give[i] = m.has("min") ? m.getAsJsonArray("min").get(i).getAsInt() : 0;
                left -= give[i];
            }
            for (int i = 0; i < n && left > 0; i++) {
                final int room = m.has("max") ? m.getAsJsonArray("max").get(i).getAsInt() - give[i] : left;
                final int more = Math.min(room, left);
                give[i] += more;
                left -= more;
            }
        }
        final JsonArray arr = new JsonArray();
        for (final int g : give) {
            arr.add(g);
        }
        return arr;
    }

    private void onAsk(final JsonObject m) {
        final String kind = m.get("kind").getAsString();
        result.askKinds.merge(kind, 1, Integer::sum);
        if (++asksSincePrompt == 300) {
            // The engine (or a validation loop) keeps asking without ever reaching an Input: report and bail.
            result.violations.add("ask loop: " + m.toString().substring(0, Math.min(1500, m.toString().length())));
            final JsonObject concede = new JsonObject();
            concede.addProperty("t", "act");
            concede.addProperty("kind", "concede");
            send(concede);
        }
        final JsonElement value;
        switch (kind) {
            case "confirm", "options" -> {
                final int n = m.getAsJsonArray("options").size();
                value = new JsonPrimitive(random.nextInt(n));
            }
            case "text" -> value = m.has("options") ? m.getAsJsonArray("options").get(0) : new JsonPrimitive(m.has("numeric") && m.get("numeric").getAsBoolean() ? "1" : "x");
            case "order" -> {
                final int n = m.getAsJsonArray("items").size();
                final int min = m.get("min").getAsInt();
                final int max = m.get("max").getAsInt();
                final int k = min + random.nextInt(Math.max(1, max - min + 1));
                final List<Integer> idx = new ArrayList<>();
                for (int i = 0; i < n; i++) {
                    idx.add(i);
                }
                java.util.Collections.shuffle(idx, random);
                final JsonArray order = new JsonArray();
                idx.subList(0, Math.min(k, n)).forEach(order::add);
                final JsonObject o = new JsonObject();
                o.add("order", order);
                value = o;
            }
            case "arrange" -> {
                final int n = m.getAsJsonArray("items").size();
                final boolean topOk = m.get("top").getAsBoolean();
                final boolean bottomOk = m.get("bottom").getAsBoolean();
                final List<Integer> idx = new ArrayList<>();
                for (int i = 0; i < n; i++) {
                    idx.add(i);
                }
                java.util.Collections.shuffle(idx, random);
                final JsonArray top = new JsonArray();
                final JsonArray bottom = new JsonArray();
                for (final int i : idx) {
                    (topOk && (!bottomOk || random.nextBoolean()) ? top : bottom).add(i);
                }
                final JsonObject o = new JsonObject();
                o.add("top", top);
                o.add("bottom", bottom);
                value = o;
            }
            case "split" -> value = split(m);
            default -> {
                final JsonArray items = m.getAsJsonArray("items");
                final int min = m.get("min").getAsInt();
                final int max = m.get("max").getAsInt();
                final List<Integer> enabled = new ArrayList<>();
                for (final JsonElement it : items) {
                    final JsonObject o = it.getAsJsonObject();
                    if (!o.has("enabled") || o.get("enabled").getAsBoolean()) {
                        enabled.add(o.get("idx").getAsInt());
                    }
                }
                java.util.Collections.shuffle(enabled, random);
                final int k = Math.min(enabled.size(), Math.max(min, Math.min(max, 1)));
                final JsonArray arr = new JsonArray();
                enabled.subList(0, k).forEach(arr::add);
                value = arr;
            }
        }
        final JsonObject reply = new JsonObject();
        reply.addProperty("t", "reply");
        reply.addProperty("id", m.get("id").getAsString());
        reply.add("value", value);
        send(reply);
    }

    @Override
    public void onError(final WebSocket webSocket, final Throwable error) {
        result.violations.add("websocket error: " + error);
        done.countDown();
    }

    @Override
    public CompletionStage<?> onClose(final WebSocket webSocket, final int statusCode, final String reason) {
        if (!result.gameOver) {
            result.violations.add("closed early: " + statusCode + " " + reason);
        }
        done.countDown();
        return null;
    }
}

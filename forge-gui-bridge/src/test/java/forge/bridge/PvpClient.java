package forge.bridge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Predicate;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/**
 * One seat of a game between two people, straight on the sidecar's socket with the hello the router would send
 * ({@code token}, {@code seat}, {@code name}). Keeps every message it gets (and its raw text, for leak checks) and, while
 * {@link #passive}, plays the dullest legal game: it keeps its hand, passes every priority, plays nothing, discards
 * the first card asked for and answers every question with its first option.
 */
final class PvpClient implements WebSocket.Listener, AutoCloseable {

    private final List<JsonObject> messages = new ArrayList<>();
    private final StringBuilder partial = new StringBuilder();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        final Thread t = new Thread(r, "pvp-client");
        t.setDaemon(true);
        return t;
    });
    private final AtomicInteger ids = new AtomicInteger();
    private final List<Consumer<String>> textObservers = new ArrayList<>();
    private WebSocket ws;
    private JsonObject prompt;
    volatile boolean passive = true;
    volatile int closeCode = -1;

    /** Connect and say hello; {@code seat}/{@code name} null leave them out (as a hello without the router's stamp). */
    static PvpClient connect(final Main.Running sidecar, final Integer seat, final String name) throws Exception {
        final PvpClient c = new PvpClient();
        c.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://127.0.0.1:" + sidecar.port() + "/ws"), c).get(30, TimeUnit.SECONDS);
        final JsonObject client = new JsonObject();
        client.addProperty("speed", 0);
        final JsonObject hello = new JsonObject();
        hello.addProperty("t", "hello");
        hello.addProperty("proto", 1);
        hello.addProperty("token", sidecar.token);
        if (seat != null) {
            hello.addProperty("seat", seat);
        }
        if (name != null) {
            hello.addProperty("name", name);
        }
        hello.add("client", client);
        c.send(hello);
        return c;
    }

    /** Every raw text frame from now on (called on the client's thread, in order). */
    PvpClient onText(final Consumer<String> observer) {
        synchronized (textObservers) {
            textObservers.add(observer);
        }
        return this;
    }

    void send(final JsonObject msg) {
        synchronized (this) {
            ws.sendText(msg.toString(), true).join();
        }
    }

    void act(final String kind) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", kind);
        send(a);
    }

    /** Call an rpc and wait for its result. */
    JsonObject rpc(final String method, final JsonObject params) throws InterruptedException {
        final String id = "r" + ids.incrementAndGet();
        final JsonObject r = new JsonObject();
        r.addProperty("t", "rpc");
        r.addProperty("id", id);
        r.addProperty("method", method);
        r.add("params", params == null ? new JsonObject() : params);
        send(r);
        return await(0, m -> "rpcResult".equals(t(m)) && id.equals(m.get("id").getAsString()), 30);
    }

    /** How many messages have arrived so far (a mark for {@link #await(int, Predicate, int)}). */
    int mark() {
        synchronized (messages) {
            return messages.size();
        }
    }

    /** The first message at index {@code from} or later that matches, waiting up to {@code seconds}. */
    JsonObject await(final int from, final Predicate<JsonObject> p, final int seconds) throws InterruptedException {
        final long until = System.currentTimeMillis() + seconds * 1000L;
        synchronized (messages) {
            int i = from;
            while (true) {
                for (; i < messages.size(); i++) {
                    if (p.test(messages.get(i))) {
                        return messages.get(i);
                    }
                }
                final long left = until - System.currentTimeMillis();
                if (left <= 0) {
                    throw new AssertionError("timed out waiting; last messages: " + tail());
                }
                messages.wait(left);
            }
        }
    }

    /** Whether any message from index {@code from} on matches. */
    boolean anyFrom(final int from, final Predicate<JsonObject> p) {
        synchronized (messages) {
            return messages.subList(Math.min(from, messages.size()), messages.size()).stream().anyMatch(p);
        }
    }

    /** Whether any message so far matches. */
    boolean any(final Predicate<JsonObject> p) {
        synchronized (messages) {
            return messages.stream().anyMatch(p);
        }
    }

    private String tail() {
        final StringBuilder b = new StringBuilder();
        for (int i = Math.max(0, messages.size() - 5); i < messages.size(); i++) {
            final String s = messages.get(i).toString();
            b.append('\n').append(s, 0, Math.min(300, s.length()));
        }
        return b.toString();
    }

    static String t(final JsonObject m) {
        return m.has("t") ? m.get("t").getAsString() : "";
    }

    static boolean is(final JsonObject m, final String t, final String kind) {
        return t.equals(t(m)) && (kind == null || m.has("kind") && kind.equals(m.get("kind").getAsString()));
    }

    @Override
    public CompletionStage<?> onText(final WebSocket webSocket, final CharSequence data, final boolean last) {
        partial.append(data);
        if (last) {
            final String text = partial.toString();
            partial.setLength(0);
            exec.execute(() -> handle(text));
        }
        webSocket.request(1);
        return CompletableFuture.completedFuture(null);
    }

    private void handle(final String text) {
        synchronized (textObservers) {
            textObservers.forEach(o -> o.accept(text));
        }
        final JsonObject m = JsonParser.parseString(text).getAsJsonObject();
        synchronized (messages) {
            messages.add(m);
            messages.notifyAll();
        }
        if (!passive) {
            return;
        }
        switch (t(m)) {
            case "prompt", "promptUpdate" -> {
                prompt = m;
                play(m);
            }
            case "snapshot" -> {
                if (m.has("prompt")) {
                    prompt = m.getAsJsonObject("prompt");
                    play(prompt);
                }
                if (m.has("asks")) {
                    m.getAsJsonArray("asks").forEach(a -> answer(a.getAsJsonObject()));
                }
            }
            case "promptClear" -> prompt = null;
            case "notice" -> {
                // A press the engine dropped (the prompt moved on): don't keep pressing it.
                final JsonObject was = prompt;
                if ("stale".equals(m.get("kind").getAsString()) && was != null && m.getAsJsonObject("act").has("pid")
                        && m.getAsJsonObject("act").get("pid").getAsLong() == was.get("pid").getAsLong()) {
                    prompt = null;
                }
            }
            case "ask" -> answer(m);
            default -> { }
        }
    }

    /** Keep, pass, discard the first card: never anything that makes a hidden card public. */
    private void play(final JsonObject p) {
        final String kind = p.get("kind").getAsString();
        if ("waiting".equals(kind)) {
            return;
        }
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", p.get("pid").getAsLong());
        final JsonArray sel = p.getAsJsonArray("selectable");
        if (p.getAsJsonObject("ok").get("enabled").getAsBoolean()) {
            a.addProperty("kind", "ok");
        } else if (sel != null && !sel.isEmpty()) {
            a.addProperty("kind", "card");
            a.addProperty("card", sel.get(0).getAsString());
        } else if (p.getAsJsonObject("cancel").get("enabled").getAsBoolean()) {
            a.addProperty("kind", "cancel");
        } else {
            return;
        }
        send(a);
        // A press that changed nothing raises no new prompt: press again shortly.
        final JsonObject was = p;
        exec.schedule(() -> {
            if (passive && prompt == was) {
                play(was);
            }
        }, 300, TimeUnit.MILLISECONDS);
    }

    private void answer(final JsonObject ask) {
        final String kind = ask.get("kind").getAsString();
        final JsonElement value;
        switch (kind) {
            case "confirm", "options" -> value = new JsonPrimitive(0);
            case "text" -> value = ask.has("options") ? ask.getAsJsonArray("options").get(0) : new JsonPrimitive("1");
            case "order" -> {
                final JsonObject o = new JsonObject();
                o.add("order", first(ask.get("min").getAsInt()));
                value = o;
            }
            case "arrange" -> {
                final JsonObject o = new JsonObject();
                final int n = ask.getAsJsonArray("items").size();
                o.add(ask.get("top").getAsBoolean() ? "top" : "bottom", first(n));
                value = o;
            }
            case "split" -> value = ask.has("lethal") ? ask.get("lethal") : new JsonArray();
            default -> value = first(ask.has("min") ? ask.get("min").getAsInt() : 0);
        }
        final JsonObject r = new JsonObject();
        r.addProperty("t", "reply");
        r.addProperty("id", ask.get("id").getAsString());
        r.add("value", value);
        send(r);
    }

    private static JsonArray first(final int n) {
        final JsonArray a = new JsonArray();
        for (int i = 0; i < n; i++) {
            a.add(i);
        }
        return a;
    }

    @Override
    public CompletionStage<?> onClose(final WebSocket webSocket, final int statusCode, final String reason) {
        closeCode = statusCode;
        synchronized (messages) {
            messages.notifyAll();
        }
        return null;
    }

    @Override
    public void onError(final WebSocket webSocket, final Throwable error) {
        closeCode = 1006;
    }

    /** Drop the connection (as a closed tab). */
    @Override
    public void close() {
        passive = false;
        try {
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").join();
        } catch (final RuntimeException e) {
            ws.abort();
        }
        exec.shutdownNow();
    }
}

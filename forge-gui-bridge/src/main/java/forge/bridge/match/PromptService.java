package forge.bridge.match;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.bridge.BridgeLog;
import forge.bridge.proj.Outbox;

/**
 * Turns blocking {@code IGuiGame}/{@code IGuiBase} calls into asynchronous client prompts.
 *
 * <p>{@link #ask} may be called on the primary game thread, a helper thread, or {@code bridge-ui}
 * (re-entrantly, from an Input handler). It settles, registers the prompt on an ordered stack, sends it,
 * and waits for {@link #reply}, which runs on the network thread, so a prompt raised on {@code bridge-ui}
 * can always be answered. Replies are validated by the caller's parser; an invalid reply re-asks.
 */
public final class PromptService {

    /** A reply could not be mapped back to engine objects; the prompt is asked again. */
    public static final class InvalidReply extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public InvalidReply(final String message) {
            super(message);
        }
    }

    private static final class Pending {
        final String id;
        final long spawningPid;
        final JsonObject message;
        final CompletableFuture<JsonElement> future = new CompletableFuture<>();
        final JsonElement cancelValue;

        Pending(final String id, final long spawningPid, final JsonObject message, final JsonElement cancelValue) {
            this.id = id;
            this.spawningPid = spawningPid;
            this.message = message;
            this.cancelValue = cancelValue;
        }
    }

    private final Outbox outbox;
    private final AtomicLong ids = new AtomicLong();
    private final List<Pending> stack = new ArrayList<>();
    private volatile boolean closed;

    public PromptService(final Outbox outbox) {
        this.outbox = outbox;
    }

    /**
     * Ask the client and block until it answers.
     *
     * @param kind        overlay kind ({@code choose}, {@code confirm}, {@code options}, {@code text}, …)
     * @param payload     display data: labels and indices only, never engine objects
     * @param spawningPid the Input pid current when the prompt was raised ({@code 0} if none)
     * @param parse       maps the reply to a result; throws {@link InvalidReply} to re-ask
     * @param cancelValue reply used when the prompt is cancelled (game over, concede, shutdown)
     */
    public <R> R ask(final String kind, final JsonObject payload, final long spawningPid,
            final Function<JsonElement, R> parse, final JsonElement cancelValue) {
        String error = null;
        while (true) {
            if (closed) {
                return parse.apply(cancelValue);
            }
            final String id = "q" + ids.incrementAndGet();
            final JsonObject msg = payload.deepCopy();
            msg.addProperty("t", "ask");
            msg.addProperty("id", id);
            msg.addProperty("kind", kind);
            if (spawningPid != 0) {
                msg.addProperty("pid", spawningPid);
            }
            if (error != null) {
                msg.addProperty("error", error);
            }
            final Pending p = new Pending(id, spawningPid, msg, cancelValue);
            // Register before sending so a reply can never arrive for an unknown id.
            synchronized (stack) {
                stack.add(p);
            }
            outbox.sendOrdered(msg, null);
            JsonElement value;
            try {
                value = p.future.get();
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
                value = cancelValue;
            } catch (final ExecutionException e) {
                value = cancelValue;
            } finally {
                synchronized (stack) {
                    stack.remove(p);
                }
            }
            final JsonObject done = new JsonObject();
            done.addProperty("t", "askClear");
            done.addProperty("id", id);
            outbox.sendOrdered(done, null);
            try {
                return parse.apply(value);
            } catch (final InvalidReply | IllegalArgumentException | ClassCastException | IllegalStateException e) {
                if (value == cancelValue) {
                    throw e;
                }
                error = e.getMessage() == null ? "Invalid choice" : e.getMessage();
                BridgeLog.warn("Invalid reply to " + kind + " " + id + ": " + error);
            }
        }
    }

    /** Complete a prompt. Called on the network thread. @return false if no such prompt is pending. */
    public boolean reply(final String id, final JsonElement value) {
        final Pending p;
        synchronized (stack) {
            p = stack.stream().filter(x -> x.id.equals(id)).findFirst().orElse(null);
        }
        if (p == null) {
            return false;
        }
        return p.future.complete(value);
    }

    /** Cancel every outstanding prompt with its cancel value (concede, game over, teardown). */
    public void cancelAll() {
        final List<Pending> copy;
        synchronized (stack) {
            copy = new ArrayList<>(stack);
        }
        for (final Pending p : copy) {
            p.future.complete(p.cancelValue);
        }
    }

    /** Stop accepting prompts: cancel the outstanding ones and answer future ones with their cancel value. */
    public void close() {
        closed = true;
        cancelAll();
    }

    public boolean hasOutstanding() {
        synchronized (stack) {
            return !stack.isEmpty();
        }
    }

    /** The outstanding prompts, bottom to top, for resume. */
    public List<JsonObject> outstanding() {
        final List<JsonObject> out = new ArrayList<>();
        synchronized (stack) {
            for (final Pending p : stack) {
                out.add(p.message.deepCopy());
            }
        }
        return out;
    }
}

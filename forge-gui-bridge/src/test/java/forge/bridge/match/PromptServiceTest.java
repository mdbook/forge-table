package forge.bridge.match;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import forge.bridge.proj.Outbox;

/** Blocking asks become async prompts; replies validate and re-ask; cancel unblocks. */
public class PromptServiceTest {

    private final List<JsonObject> sent = new CopyOnWriteArrayList<>();

    private PromptService service() {
        sent.clear();
        final Outbox outbox = new Outbox();
        outbox.setSink(json -> sent.add(JsonParser.parseString(json).getAsJsonObject()));
        return new PromptService(outbox);
    }

    private JsonObject awaitAsk(final int n) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            final long asks = sent.stream().filter(m -> "ask".equals(m.get("t").getAsString())).count();
            if (asks >= n) {
                return sent.stream().filter(m -> "ask".equals(m.get("t").getAsString())).skip(n - 1).findFirst().get();
            }
            Thread.sleep(10);
        }
        throw new AssertionError("no ask #" + n + " in " + sent);
    }

    @Test
    public void replyCompletesAndInvalidReplyReasks() throws Exception {
        final PromptService ps = service();
        final ExecutorService ex = Executors.newSingleThreadExecutor();
        final Future<Integer> f = ex.submit(() -> ps.ask("confirm", new JsonObject(), 0, v -> {
            final int i = v.getAsInt();
            if (i > 1) {
                throw new PromptService.InvalidReply("Invalid option");
            }
            return i;
        }, new JsonPrimitive(1)));
        final JsonObject first = awaitAsk(1);
        assertTrue(ps.hasOutstanding());
        assertTrue(ps.reply(first.get("id").getAsString(), new JsonPrimitive(7)));
        final JsonObject second = awaitAsk(2);
        assertEquals(second.get("error").getAsString(), "Invalid option");
        assertFalse(ps.reply(first.get("id").getAsString(), new JsonPrimitive(0)), "old id must be dead");
        assertTrue(ps.reply(second.get("id").getAsString(), new JsonPrimitive(0)));
        assertEquals(f.get(5, TimeUnit.SECONDS).intValue(), 0);
        assertFalse(ps.hasOutstanding());
        assertTrue(sent.stream().anyMatch(m -> "askClear".equals(m.get("t").getAsString())));
        ex.shutdownNow();
    }

    @Test
    public void cancelAllUnblocksWithCancelValueAndOutstandingIsReplayable() throws Exception {
        final PromptService ps = service();
        final ExecutorService ex = Executors.newFixedThreadPool(2);
        final Future<Integer> a = ex.submit(() -> ps.ask("confirm", new JsonObject(), 3, v -> v.getAsInt(), new JsonPrimitive(1)));
        final Future<Integer> b = ex.submit(() -> ps.ask("options", new JsonObject(), 0, v -> v.getAsInt(), new JsonPrimitive(2)));
        awaitAsk(2);
        assertEquals(ps.outstanding().size(), 2);
        ps.cancelAll();
        assertEquals(a.get(5, TimeUnit.SECONDS).intValue(), 1);
        assertEquals(b.get(5, TimeUnit.SECONDS).intValue(), 2);
        ex.shutdownNow();
    }
}

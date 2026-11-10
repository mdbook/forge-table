package forge.bridge.proj;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.Main;
import forge.bridge.TableTestEnv;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.player.GamePlayerUtil;
import forge.trackable.TrackableProperty;

/** A batch has no animation costs and preserves the latest state before asks, reconnects and normal beats. */
public class OutboxBatchTest {
    @Test
    public void batchesFlushInOrderWithoutChargingThePacer() throws Exception {
        final Main.Running sidecar = TableTestEnv.start();
        try {
            final RegisteredPlayer human = new RegisteredPlayer(sidecar.app.loadDeck("mono-red-madness"));
            human.setPlayer(GamePlayerUtil.getGuiPlayer());
            final RegisteredPlayer opp = new RegisteredPlayer(sidecar.app.loadDeck("mono-blue-faeries"));
            opp.setPlayer(GamePlayerUtil.createAiPlayer("Opp", "Default"));
            final Game game = new Match(new GameRules(GameType.Constructed), List.of(human, opp), "batch-test").createGame();
            final PlayerView viewer = game.getPlayers().get(0).getView();
            final String playerId = "p" + viewer.getId();
            final Outbox outbox = new Outbox();
            final List<JsonObject> sent = new ArrayList<>();
            final AtomicBoolean batching = new AtomicBoolean(true);
            final AtomicInteger charged = new AtomicInteger();
            final AtomicInteger built = new AtomicInteger();
            outbox.setSink(json -> sent.add(JsonParser.parseString(json).getAsJsonObject()));
            outbox.setBatching(batching::get);
            outbox.setBeatListener((seq, kind) -> charged.incrementAndGet());
            outbox.bind(game.getView(), viewer, null);
            sent.clear();
            final long before = outbox.seq();
            for (int life = 20; life >= 10; life--) {
                viewer.set(TrackableProperty.Life, life);
                outbox.beat("life", (old, now, moved) -> {
                    built.incrementAndGet();
                    return new JsonObject();
                });
                outbox.settle();
            }
            assertTrue(sent.isEmpty(), "intermediate actions must not reach the browser");
            assertEquals(outbox.seq(), before);
            assertEquals(charged.get(), 0);
            assertEquals(built.get(), 0, "beat payloads are not built; the flush diff does the id bookkeeping");

            final JsonObject ask = new JsonObject();
            ask.addProperty("t", "ask");
            outbox.sendOrdered(ask, null);
            assertEquals(sent.size(), 2);
            assertEquals(sent.get(0).get("t").getAsString(), "settle");
            assertEquals(sent.get(0).getAsJsonObject("patch").getAsJsonObject("players")
                    .getAsJsonObject(playerId).get("life").getAsInt(), 10);
            assertEquals(sent.get(0).get("seq").getAsLong(), before + 1);
            assertEquals(sent.get(1).get("seq").getAsLong(), before + 2);

            // Reconnecting mid-loop gets a mirror with a seq covering every change it contains.
            viewer.set(TrackableProperty.Life, 9);
            outbox.settle();
            outbox.sendSnapshot(null);
            assertEquals(sent.get(2).get("t").getAsString(), "settle");
            assertEquals(sent.get(3).get("t").getAsString(), "snapshot");
            assertEquals(sent.get(3).get("seq"), sent.get(2).get("seq"));
            assertEquals(sent.get(3).getAsJsonObject("players").getAsJsonObject(playerId).get("life").getAsInt(), 9);

            // Stopping/cancelling flushes once; normal animation and pacing resume afterwards.
            viewer.set(TrackableProperty.Life, 8);
            outbox.settle();
            batching.set(false);
            outbox.settle();
            assertEquals(sent.get(4).get("t").getAsString(), "settle");
            outbox.beat("life", (old, now, moved) -> new JsonObject());
            assertEquals(sent.get(5).get("t").getAsString(), "beat");
            assertEquals(charged.get(), 1);
            assertEquals(outbox.seq(), before + 5);
        } finally {
            sidecar.stop();
        }
    }
}

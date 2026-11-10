package forge.bridge.proj;

import java.io.IOException;
import java.io.Writer;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

import forge.bridge.BridgeLog;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.player.PlayerView;

/**
 * The single ordered channel for everything sent to one viewer.
 *
 * <p>Under one lock it projects the current {@link GameView}, assigns the next {@code seq}, updates the
 * projection mirror and enqueues the message, so beats, settle patches and prompts share one total order and
 * the per-viewer projection is never touched by two threads at once. Resume snapshots are built from the
 * same mirror (flushing any staged loop patch first), so a snapshot is exactly consistent with its {@code seq}.
 */
public final class Outbox {

    /** Resolves a card to the client id the viewer knows it by (visible, face-down or opaque slot). */
    public interface IdLookup {
        String id(CardView card);
    }

    /**
     * Builds a beat payload. {@code before} resolves ids as the viewer knew them before the beat's patch
     * (e.g. the hidden library slot a drawn card left); {@code after} resolves them once it is applied.
     */
    public interface BeatBuilder {
        /** {@code moved} returns (and consumes) the id a card had before its last id change. */
        JsonObject build(IdLookup before, IdLookup after, IdLookup moved);
    }

    /** Called with the beat's seq and the time cost the client declared for its kind (for the Pacer). */
    public interface BeatListener {
        void beatSent(long seq, String kind);
    }

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();

    private final Object lock = new Object();
    private long seq;
    private ViewProjector projector;
    private GameView gameView;
    private volatile Consumer<String> sink;
    private volatile Writer recorder;
    private volatile BeatListener beatListener;
    private BooleanSupplier batching = () -> false;
    private boolean batchDirty;

    public Object lock() {
        return lock;
    }

    public void setSink(final Consumer<String> sink) {
        this.sink = sink;
    }

    public boolean hasSink() {
        return sink != null;
    }

    public void setRecorder(final Writer recorder) {
        this.recorder = recorder;
    }

    public void setBeatListener(final BeatListener listener) {
        this.beatListener = listener;
    }

    /** Server-side loop playback: keep projection/visibility bookkeeping, but send only the resulting state. */
    public void setBatching(final BooleanSupplier batching) {
        this.batching = batching;
    }

    public boolean isBatching() {
        return batching.getAsBoolean();
    }

    /** Bind the game and viewer; resets the projection and sends a full snapshot. */
    public void bind(final GameView gv, final PlayerView viewer, final JsonObject extra) {
        synchronized (lock) {
            this.gameView = gv;
            batchDirty = false;
            this.projector = new ViewProjector(viewer);
            projector.diff(gv);
            sendSnapshotLocked(extra);
        }
    }

    public ViewProjector projector() {
        return projector;
    }

    public GameView gameView() {
        return gameView;
    }

    public long seq() {
        synchronized (lock) {
            return seq;
        }
    }

    /** Send {@code {t:"snapshot", seq, game, players, cards, …extra}} from the last-sent mirror. */
    public void sendSnapshot(final JsonObject extra) {
        synchronized (lock) {
            sendSnapshotLocked(extra);
        }
    }

    private void sendSnapshotLocked(final JsonObject extra) {
        if (projector == null) {
            return;
        }
        flushBatchLocked();
        final JsonObject msg = new JsonObject();
        msg.addProperty("t", "snapshot");
        msg.addProperty("seq", seq);
        final PlayerView viewer = projector.getViewer();
        if (viewer != null) {
            msg.addProperty("viewer", "p" + viewer.getId());
        }
        projector.snapshot().entrySet().forEach(e -> msg.add(e.getKey(), e.getValue()));
        if (extra != null) {
            extra.entrySet().forEach(e -> msg.add(e.getKey(), e.getValue()));
        }
        write(msg);
    }

    /**
     * Send one beat: its patch is the state change since the previous message, and its payload is built
     * with id resolution both before and after that patch.
     */
    public long beat(final String kind, final BeatBuilder builder) {
        return beat(kind, builder, true);
    }

    /**
     * @param withPatch false to leave the state change for the next beat: the engine fires its zone
     *        add/remove events just before the change-zone event, whose beat should carry the move (and
     *        resolve {@code fromId} against the ids from before it).
     */
    public long beat(final String kind, final BeatBuilder builder, final boolean withPatch) {
        synchronized (lock) {
            if (projector == null) {
                return -1;
            }
            if (isBatching()) {
                // No projection, animation, seq, serialization or pacing for intermediate actions: one diff at flush.
                batchDirty = true;
                return seq;
            }
            flushBatchLocked();
            final Map<Integer, String> beforeIds = projector.copyClientIds();
            final JsonObject patch = withPatch ? projector.diff(gameView) : null;
            final JsonObject fields = builder.build(c -> c == null ? null : beforeIds.get(c.getId()), projector::clientId, projector::takePriorId);
            final JsonObject payload = new JsonObject();
            payload.addProperty("t", "beat");
            payload.addProperty("seq", ++seq);
            payload.addProperty("kind", kind);
            if (fields != null) {
                fields.entrySet().forEach(e -> payload.add(e.getKey(), e.getValue()));
            }
            if (patch != null) {
                payload.add("patch", patch);
            }
            write(payload);
            final BeatListener l = beatListener;
            if (l != null) {
                l.beatSent(seq, kind);
            }
            return seq;
        }
    }

    /** Send a {@code settle} patch if anything visible changed without an event (reveals, unfreezes). */
    public void settle() {
        synchronized (lock) {
            settleLocked();
        }
    }

    private void settleLocked() {
        if (projector == null) {
            return;
        }
        if (isBatching()) {
            batchDirty = true;
            return;
        }
        flushBatchLocked();
        settleNowLocked();
    }

    private void settleNowLocked() {
        final JsonObject patch = projector.diff(gameView);
        if (patch == null) {
            return;
        }
        final JsonObject msg = new JsonObject();
        msg.addProperty("t", "settle");
        msg.addProperty("seq", ++seq);
        msg.add("patch", patch);
        write(msg);
    }

    /** Once a loop is over, deliver its batched state before notices (unordered) can say it ended. */
    public void flushBatch() {
        synchronized (lock) {
            if (!isBatching()) {
                flushBatchLocked();
            }
        }
    }

    /** Send everything a loop changed as one settle; its moves were never announced, so no beat may claim them. */
    private void flushBatchLocked() {
        if (!batchDirty || projector == null) {
            return;
        }
        batchDirty = false;
        settleNowLocked();
        projector.forgetPriorIds();
    }

    /**
     * Settle, then send a seq-numbered message ({@code prompt}, {@code promptUpdate}, {@code promptClear}).
     * {@code afterSeq} runs under the lock once the seq is assigned (for registry bookkeeping).
     */
    public long sendOrdered(final JsonObject msg, final Consumer<Long> afterSeq) {
        synchronized (lock) {
            // An unrecorded decision, game over or prompt must see all preceding changes, even during a loop.
            flushBatchLocked();
            if (projector != null) {
                settleNowLocked();
            }
            msg.addProperty("seq", ++seq);
            write(msg);
            if (afterSeq != null) {
                afterSeq.accept(seq);
            }
            return seq;
        }
    }

    /** Send a message outside the seq order (notices, rpc results, welcome). */
    public void sendUnordered(final JsonObject msg) {
        synchronized (lock) {
            write(msg);
        }
    }

    private void write(final JsonObject msg) {
        final String json = GSON.toJson(msg);
        final Writer rec = recorder;
        if (rec != null) {
            try {
                rec.write(json);
                rec.write('\n');
                rec.flush();
            } catch (final IOException e) {
                BridgeLog.error("Recorder write failed; recording stopped", e);
                recorder = null;
            }
        }
        final Consumer<String> s = sink;
        if (s != null) {
            s.accept(json);
        }
        if (BridgeLog.isDebug()) {
            BridgeLog.debug("-> " + (json.length() > 400 ? json.substring(0, 400) + "…" : json));
        }
    }

    public static Gson gson() {
        return GSON;
    }
}

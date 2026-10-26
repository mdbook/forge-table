package forge.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameStage;
import forge.game.GameState;
import forge.game.event.GameEventPlayerPriority;
import forge.game.phase.PhaseType;

/**
 * Saves the game in progress to {@code --checkpoint FILE}, so that a new sidecar started with {@code --resume} can
 * pick it up after a restart or an idle pause. A checkpoint is Forge's own board-state text ({@link GameState}, the
 * puzzle format) plus the match's settings, taken whenever a player gets priority with the stack empty in a step
 * that has no combat to rebuild. Resuming rewinds to that point: the start of the step, give or take what was played
 * in it. The format can't hold everything ("until end of turn" effects, delayed triggers, one-shot control changes):
 * those are lost on resume.
 *
 * <p>The decks are saved beside the file ({@code deck0.dck}, {@code deck1.dck}, by seat) when a match starts, so a
 * resume never depends on a deck folder that may have changed since. The file goes when the game ends.
 * Board states are built on the game's thread (where the event arrives); files are written on one thread of
 * their own, in order, each replaced atomically.
 */
final class Checkpointer {

    static final int VERSION = 1;

    /** Steps where priority with an empty stack is a safe place to resume from (no attackers or blockers to rebuild). */
    private static final Set<PhaseType> SAFE = EnumSet.of(PhaseType.UPKEEP, PhaseType.DRAW, PhaseType.MAIN1,
            PhaseType.COMBAT_BEGIN, PhaseType.MAIN2, PhaseType.END_OF_TURN);

    private final Path file;
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        final Thread t = new Thread(r, "checkpoint");
        t.setDaemon(true);
        return t;
    });
    private final Map<Game, Boolean> watched = Collections.synchronizedMap(new WeakHashMap<>());
    /** The running match's settings (null between matches): every checkpoint carries them. */
    private volatile JsonObject match;
    /** The last board saved, so an unchanged board isn't written again. */
    private volatile String last;
    private volatile boolean warned;

    Checkpointer(final Path file) {
        this.file = file;
    }

    Path file() { return file; }

    /** A match starts with these settings and decks (by seat). */
    void begin(final JsonObject settings, final Deck... decks) {
        match = settings.deepCopy();
        last = null;
        io.execute(() -> {
            for (int i = 0; i < decks.length; i++) {
                DeckSerializer.writeDeck(decks[i], deckFile(file, i).toFile());
            }
        });
    }

    /** Checkpoint {@code g} from now on (once per game, however many seats see it). */
    void watch(final Game g) {
        if (watched.putIfAbsent(g, Boolean.TRUE) == null) {
            g.subscribeToEvents(new Tap(g));
        }
    }

    /** The game ended or was left: nothing to resume. */
    void clear() {
        last = null;
        io.execute(() -> {
            try {
                Files.deleteIfExists(file);
            } catch (final IOException e) {
                BridgeLog.error("could not remove the checkpoint " + file, e);
            }
        });
    }

    /** Waits for the writes queued so far (tests, and a graceful stop). */
    void flush() {
        try {
            io.submit(() -> { }).get();
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (final java.util.concurrent.ExecutionException e) {
            // the no-op can't fail
        }
    }

    private void save(final Game g, final PhaseType phase) {
        final JsonObject settings = match;
        if (settings == null || !SAFE.contains(phase) || g.isGameOver() || g.getAge() != GameStage.Play || !g.getStack().isEmpty()) {
            return;
        }
        final String board;
        try {
            final GameState gs = new GameState();
            gs.initFromGame(g);
            board = gs.toString();
        } catch (final RuntimeException e) {
            if (!warned) {
                warned = true;
                BridgeLog.error("could not checkpoint the game", e);
            }
            return;
        }
        if (board.equals(last)) {
            return;
        }
        last = board;
        final JsonObject c = settings.deepCopy();
        c.addProperty("v", VERSION);
        c.addProperty("turn", g.getPhaseHandler().getTurn());
        c.addProperty("phase", phase.name());
        c.addProperty("at", System.currentTimeMillis());
        c.addProperty("state", board);
        final String text = Outboxes.toJson(c);
        io.execute(() -> {
            try {
                write(file, text);
            } catch (final IOException e) {
                last = null; // written again at the next chance, changed or not
                BridgeLog.error("could not write the checkpoint " + file, e);
            }
        });
    }

    /** Replaces {@code f} with {@code text} in one step: a reader sees the old file or the new one, never half. */
    static void write(final Path f, final String text) throws IOException {
        final Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
        Files.writeString(tmp, text, StandardCharsets.UTF_8);
        Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    /**
     * Moves aside a checkpoint that can't be resumed (to {@code <file>.bad}), so the game isn't paused again with it
     * and the folder keeps it for a look.
     */
    void discard() {
        try {
            Files.move(file, file.resolveSibling(file.getFileName() + ".bad"), StandardCopyOption.REPLACE_EXISTING);
        } catch (final IOException e) {
            BridgeLog.error("could not move aside the checkpoint " + file, e);
        }
    }

    /** A checkpoint file, or an IllegalArgumentException saying why it can't be resumed. */
    static JsonObject read(final Path f) {
        final JsonObject c;
        try {
            c = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (final IOException | RuntimeException e) {
            throw new IllegalArgumentException("Cannot read checkpoint " + f + ": " + e.getMessage());
        }
        if (!c.has("v") || c.get("v").getAsInt() != VERSION || !c.has("state")) {
            throw new IllegalArgumentException("Checkpoint " + f + " is not a version " + VERSION + " checkpoint");
        }
        return c;
    }

    /** The board-state lines of a checkpoint ({@link GameState#parse(List)}). */
    static List<String> stateLines(final JsonObject c) {
        return Arrays.asList(c.get("state").getAsString().split("\n"));
    }

    /** Seat {@code seat}'s deck as saved beside checkpoint {@code f}. */
    static Deck deck(final Path f, final int seat) {
        final Deck d = DeckSerializer.fromFile(deckFile(f, seat).toFile());
        if (d == null) {
            throw new IllegalArgumentException("Checkpoint " + f + " has no deck for seat " + seat);
        }
        return d;
    }

    static Path deckFile(final Path f, final int seat) {
        return f.resolveSibling("deck" + seat + ".dck");
    }

    /** Subscribed to one game; the event doesn't say which game it is from. */
    private final class Tap {
        private final Game game;

        Tap(final Game game) {
            this.game = game;
        }

        @Subscribe
        public void priority(final GameEventPlayerPriority e) {
            save(game, e.phase());
        }
    }
}

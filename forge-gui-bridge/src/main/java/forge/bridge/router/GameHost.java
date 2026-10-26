package forge.bridge.router;

import java.util.List;

import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.FullHttpRequest;

/**
 * Where the router's games run. The router owns
 * identity, ownership, caps and the lobby; a host only runs games and carries their traffic. Today's host is
 * {@link ChildProcessHost} (one sidecar JVM per game); an in-process host can replace it without touching the
 * router.
 */
public interface GameHost {

    enum Status {
        /** The game's process is booting. */
        STARTING,
        /** Up, no match started yet (the player is on the start screen). */
        READY,
        PLAYING,
        /** The match ended; the game is closed after a grace period with nobody connected, unless a new one starts. */
        OVER,
        /** The game died on its own. It stays listed until its owner ends it, or for a grace period. */
        CRASHED,
        /** Ended, its process not yet gone. It still counts against both caps until it has exited. */
        STOPPING,
        /**
         * Saved and stopped (idle, crashed, or the router restarted): no process, so it counts against its owner's
         * games but not the server's. {@link GameHost#resume} picks it up in a new process.
         */
        PAUSED
    }

    /**
     * One game as the lobby sees it. {@code owner} is opaque to the host. {@code progress} is how far a
     * {@link Status#STARTING} game has got, or null (any other status, or a host that can't tell).
     */
    record Game(String id, String owner, Status status, long created, String error, Progress progress, String format, Table table) {
        public Game(final String id, final String owner, final Status status, final long created, final String error, final Progress progress,
                final String format) {
            this(id, owner, status, created, error, progress, format, null);
        }

        public Game(final String id, final String owner, final Status status, final long created, final String error) {
            this(id, owner, status, created, error, null, null);
        }

        public Game(final String id, final String owner, final Status status, final long created, final String error, final Progress progress) {
            this(id, owner, status, created, error, progress, null);
        }
    }

    /**
     * A dealt game's table for the lobby's game card: the turn, whose turn it is (a seat, -1 for nobody's)
     * and each seat's life, deck name and key card (the art standing for the deck; either may be null).
     */
    record Table(int turn, int active, java.util.List<Seat> seats) {
        public record Seat(int life, String deck, String key) { }

        /** The game's {@code /status} {@code table}; null when it has none or it doesn't parse. */
        static Table parse(final com.google.gson.JsonElement e) {
            try {
                if (e == null || !e.isJsonObject()) {
                    return null;
                }
                final com.google.gson.JsonObject o = e.getAsJsonObject();
                final java.util.List<Seat> seats = new java.util.ArrayList<>();
                for (final com.google.gson.JsonElement se : o.getAsJsonArray("seats")) {
                    final com.google.gson.JsonObject so = se.getAsJsonObject();
                    seats.add(new Seat(so.get("life").getAsInt(), str(so, "deck"), str(so, "key")));
                }
                return new Table(o.get("turn").getAsInt(), o.get("active").getAsInt(), java.util.List.copyOf(seats));
            } catch (final RuntimeException ex) {
                return null;
            }
        }

        static String str(final com.google.gson.JsonObject o, final String k) {
            return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : null;
        }
    }

    /**
     * A game that ended in game {@code game}: its number there ({@code n}: a rematch is the next one) and per seat (0 the
     * owner, 1 the AI or whoever joined) the deck and "won", "lost" or "draw". A host may report the same one again.
     */
    record Finished(String game, int n, List<FinishedSeat> seats) {
        public record FinishedSeat(String deck, String r, boolean conceded) { }

        /** The child's {@code /status} {@code results}, skipping anything malformed. */
        static List<Finished> parse(final String game, final com.google.gson.JsonElement e) {
            final List<Finished> out = new java.util.ArrayList<>();
            if (e == null || !e.isJsonArray()) {
                return out;
            }
            for (final com.google.gson.JsonElement re : e.getAsJsonArray()) {
                try {
                    final com.google.gson.JsonObject o = re.getAsJsonObject();
                    final List<FinishedSeat> seats = new java.util.ArrayList<>();
                    for (final com.google.gson.JsonElement se : o.getAsJsonArray("seats")) {
                        final com.google.gson.JsonObject so = se.getAsJsonObject();
                        final String r = so.get("r").getAsString();
                        if (!"won".equals(r) && !"lost".equals(r) && !"draw".equals(r)) {
                            throw new IllegalArgumentException(r);
                        }
                        seats.add(new FinishedSeat(Table.str(so, "deck"), r, so.has("conceded") && so.get("conceded").getAsBoolean()));
                    }
                    out.add(new Finished(game, o.get("g").getAsInt(), List.copyOf(seats)));
                } catch (final RuntimeException ex) {
                    // one bad entry doesn't hide the rest
                }
            }
            return out;
        }
    }

    /** Tell {@code l} each game a host's games report finished (see {@link Finished}); a host that can't tell never calls it. */
    default void onFinished(final java.util.function.Consumer<Finished> l) {
    }

    /** A starting game's boot: a stage name, the lobby's label for it, and the progress bar's overall percent. */
    record Progress(String stage, String label, int pct) { }

    /**
     * Reserve a game and start it in the background. Returns at once with {@link Status#STARTING}; the game
     * is in {@link #list()} from then on, so callers can count it against caps immediately.
     *
     * @param deck    the deck preselected on the start screen, or null
     * @param oppDeck the opponent's deck, or null
     * @param ai      the AI profile, or null for the game's default
     */
    Game create(String owner, String deck, String oppDeck, String ai);

    /**
     * Same, but tell the child to upload its training trajectory (the mtg-ai Neural seat) to this URL once the
     * game ends, or null not to. Ignored by a host that never trains (the default forwards to {@link #create}).
     */
    default Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl) {
        return create(owner, deck, oppDeck, ai);
    }

    /** Same, in a format ({@code forge.bridge.Formats}: "brawl", "standard", or null for Constructed). */
    default Game create(final String owner, final String deck, final String oppDeck, final String ai, final String neuralUploadUrl,
            final String format) {
        if (format != null) {
            throw new UnsupportedOperationException("this host plays Constructed only");
        }
        return create(owner, deck, oppDeck, ai, neuralUploadUrl);
    }

    /**
     * The owner turned training upload off: none of their games' trajectories not yet sent may be sent. False when
     * that could not be made to stick (the caller must not report success).
     */
    default boolean withdrawUpload(final String owner) {
        return true;
    }

    /** Withdraw upload for every owner but these (the router's startup reconcile with its saved choices). */
    default void retainUploadOnly(final java.util.Set<String> owners) {
    }

    /** Who consents right now; a game re-checks its owner here as it spawns, so a withdrawal mid-create holds. */
    default void uploadConsent(final java.util.function.Predicate<String> consents) {
    }

    /**
     * Carry one request for game {@code id} (path relative to the game, e.g. {@code /ws}, {@code /img/card/x},
     * {@code /}): an HTTP request is answered, a WebSocket upgrade takes over the channel. The caller has
     * already checked who may see this game.
     */
    void attach(String id, ChannelHandlerContext ctx, FullHttpRequest req, String path);

    List<Game> list();

    /** The game, or null when there is none with this id. */
    Game status(String id);

    /** Stop the game; it is {@link Status#STOPPING} until its process has exited, then forgotten. Unknown ids are ignored. */
    void end(String id);

    /** {@link #end(String)}, with the reason for the log ("ended by admin …", "server update …"). */
    default void end(final String id, final String reason) {
        end(id);
    }

    /** Whether a browser has the game open right now. */
    default boolean connected(final String id) {
        return false;
    }

    /** Whether a browser has seat {@code seat} (0 or 1) of the game open right now. */
    default boolean connected(final String id, final int seat) {
        return seat == 0 && connected(id);
    }

    /** When a browser last had the game open, or it came up (epoch ms); 0 when the host can't tell. */
    default long lastSeen(final String id) {
        return 0;
    }

    /**
     * Send a message (a JSON text frame from {@code message}, asked afresh each time) to every browser that has a
     * game open, and to each one that opens a game from now on.
     */
    default void announce(final java.util.function.Supplier<String> message) {
    }

    /** Stop every game (router shutdown). */
    void close();

    /** Starts a {@link Status#PAUSED} game again from its save; null when it isn't (or is no longer) paused. */
    default Game resume(final String id) {
        return null;
    }

    /** Keeps the router's own facts about a game (who sits where) with it, so they outlive a router restart. */
    default void remember(final String id, final com.google.gson.JsonObject facts) {
    }

    /** What {@link #remember} kept for the game, or null. */
    default com.google.gson.JsonObject remembered(final String id) {
        return null;
    }

    /** The AI profile a game was created with (it outlives a router restart), or null. */
    default String ai(final String id) {
        return null;
    }

    // ---------------------------------------------------------------- two people

    /**
     * A game between two people: {@code owner} sits at seat 0 with {@code deck}; seat 1 is filled by
     * {@link #seatDeck}. Nothing of it is ever captured for training, whatever anyone's upload choice.
     */
    default Game createPvp(final String owner, final String deck) {
        throw new UnsupportedOperationException("this host runs no games between two people");
    }

    /** {@link #createPvp(String, String)} in a format (null: Constructed). */
    default Game createPvp(final String owner, final String deck, final String format) {
        if (format != null) {
            throw new UnsupportedOperationException("this host plays Constructed only");
        }
        return createPvp(owner, deck);
    }

    /**
     * Give seat 1 of pvp game {@code id} the deck named {@code name}, from the shared deck folders or {@code user}'s own
     * (null: someone without folders, e.g. a guest: shared decks only). Only that one deck reaches the game. False when
     * there is no such deck (or no such game).
     */
    default boolean seatDeck(final String id, final String user, final String name) {
        return false;
    }

    /** The deck names {@code user} (null: shared decks only) can play, as a game's start screen would list them. */
    default List<String> decks(final String user) {
        return List.of();
    }

    /** {@link #decks(String)} for a game in {@code format}: Brawl adds the shared Brawl decks. */
    default List<String> decks(final String user, final String format) {
        return decks(user);
    }

    /**
     * What the lobby's deck gallery shows of each of {@link #decks(String, String)} (by the same names): a deck that can't
     * be read is left out. Read from the same file a game would load by that name.
     */
    default java.util.Map<String, DeckSummary> deckSummaries(final String user, final String format) {
        return java.util.Map.of();
    }

    /** Whether {@link #deckSummaries} judges Standard (Forge's res/ could be read for it). */
    default boolean standardChecked() {
        return false;
    }

    /**
     * Deck {@code name}'s cards by section ({@link DeckSummary#sections}), from the same file a game would load for
     * {@code user} in {@code format}; null when there is no such deck or it can't be read.
     */
    default java.util.Map<String, java.util.Map<String, Integer>> deckCards(final String user, final String format, final String name) {
        return null;
    }

    /** Card {@code name}'s group, mana value and cost from the games' card scripts; null when unknown. */
    default CardScripts.Info cardInfo(final String name) {
        return null;
    }

    /** Seat {@code seat} of a pvp game concedes. Completes false when no match is in progress there. */
    default java.util.concurrent.CompletableFuture<Boolean> concede(final String id, final int seat) {
        return java.util.concurrent.CompletableFuture.completedFuture(false);
    }

    /**
     * {@link #attach(String, ChannelHandlerContext, FullHttpRequest, String)} for the member at {@code seat}: a WebSocket's
     * {@code hello} is stamped with that seat and {@code name}, whatever the browser put there.
     */
    default void attach(final String id, final ChannelHandlerContext ctx, final FullHttpRequest req, final String path, final int seat,
            final String name) {
        attach(id, ctx, req, path);
    }
}

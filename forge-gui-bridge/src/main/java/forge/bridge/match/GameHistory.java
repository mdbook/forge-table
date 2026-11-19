package forge.bridge.match;

import java.util.ArrayList;
import java.util.List;
import java.util.Observable;
import java.util.Observer;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.bridge.proj.Outbox;
import forge.game.Game;
import forge.game.GameLog;
import forge.game.GameLogEntry;
import forge.game.card.CardView;
import forge.game.phase.PhaseHandler;
import forge.game.player.Player;
import forge.game.player.PlayerView;

/**
 * One game's Forge log for a seat's history panel ({@code {t:"log", game, from, entries}}). Each entry is stamped
 * with the turn, step and active player it was written in, which Forge's log doesn't keep. Forge shows this same log
 * to every seat in its own network play (morph casts are masked there), so nothing here is private to one player.
 * All state is guarded by the outbox lock, the same lock the game thread's beats take.
 */
final class GameHistory implements Observer {
    /** ponytail: a cap, not a ring; a game past it stops adding lines. Raise it if real games get near it. */
    static final int MAX_ENTRIES = 10_000;
    /** Forge's card ids after a name ("Candy Trail (42)", "Face-down card (H3)"): engine ids, meaningless to a player. */
    private static final Pattern CARD_ID = Pattern.compile(" \\(H?\\d+\\)");

    private final Outbox outbox;
    private final Game game;
    private final List<JsonObject> entries = new ArrayList<>();
    /** Forge log entries looked at so far (the ones past the cap included). */
    private int seen;

    GameHistory(final Outbox outbox, final Game game) {
        this.outbox = outbox;
        this.game = game;
    }

    /** Start listening; entries from before (the mulligans) are taken now, stamped with the turn they're read in. */
    void watch() {
        final GameLog log = game.getGameLog();
        log.addObserver(this);
        update(log, null);
    }

    Game game() { return game; }

    /** Runs on the game thread as each line is written: stamp it and send the new lines. */
    @Override
    public void update(final Observable observable, final Object ignored) {
        synchronized (outbox.lock()) {
            final List<GameLogEntry> all = ((GameLog) observable).getAllEntries();
            final int from = entries.size();
            while (seen < all.size()) {
                final GameLogEntry e = all.get(seen++);
                if (entries.size() < MAX_ENTRIES) {
                    entries.add(stamp(e));
                }
            }
            if (entries.size() > from) {
                send(from);
            }
        }
    }

    /** The whole history so far, after a snapshot (a new game or a reconnect): the client starts its list over. */
    void sendAll() {
        synchronized (outbox.lock()) {
            send(0);
        }
    }

    private void send(final int from) {
        final JsonArray a = new JsonArray();
        for (int i = from; i < entries.size(); i++) {
            a.add(entries.get(i));
        }
        final JsonObject msg = new JsonObject();
        msg.addProperty("t", "log");
        msg.addProperty("game", game.getId());
        msg.addProperty("from", from);
        msg.add("entries", a);
        outbox.sendUnordered(msg);
    }

    private JsonObject stamp(final GameLogEntry e) {
        final JsonObject o = new JsonObject();
        final PhaseHandler ph = game.getPhaseHandler();
        o.addProperty("turn", ph.getTurn());
        if (ph.getPhase() != null) {
            o.addProperty("phase", ph.getPhase().name());
        }
        if (ph.getPlayerTurn() != null) {
            o.addProperty("active", "p" + ph.getPlayerTurn().getId());
        }
        o.addProperty("kind", kind(e.type().name()));
        final String text = CARD_ID.matcher(e.message() == null ? "" : e.message()).replaceAll("");
        o.addProperty("text", text);
        final CardView card = e.sourceCard();
        final PlayerView by = card != null ? card.getController() : null;
        final String who = by != null ? "p" + by.getId() : speaker(text);
        if (who != null) {
            o.addProperty("player", who);
        }
        // Only a name the line already shows: a face-down card's source must not name it.
        if (card != null && card.getName() != null && !card.getName().isEmpty() && text.contains(card.getName())) {
            o.addProperty("card", card.getName());
        }
        return o;
    }

    /** The player a line starts with ("Alphu loses 3 life."), for lines with no source card. */
    private String speaker(final String text) {
        String best = null;
        int bestLen = 0;
        for (final Player p : game.getRegisteredPlayers()) {
            final String n = p.getName();
            if (n != null && n.length() > bestLen && text.startsWith(n)) {
                best = "p" + p.getId();
                bestLen = n.length();
            }
        }
        return best;
    }

    /** {@code STACK_ADD} to {@code stackAdd}: the wire's camelCase. */
    static String kind(final String type) {
        final StringBuilder sb = new StringBuilder();
        boolean up = false;
        for (final char c : type.toLowerCase(java.util.Locale.ROOT).toCharArray()) {
            if (c == '_') {
                up = true;
            } else {
                sb.append(up ? Character.toUpperCase(c) : c);
                up = false;
            }
        }
        return sb.toString();
    }
}

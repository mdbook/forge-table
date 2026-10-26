package forge.bridge.router;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;

/**
 * Every finished game's result, for the lobby's records ("you're 3–2", a deck's W-L, "last played"): an append-only
 * JSONL file in the router's data folder, one line per game, read back at startup. Past {@link #MAX_BYTES} it rolls
 * over to {@code <file>.1} (the one before that is dropped), so it holds the last several thousand games. A line that
 * doesn't parse is skipped. A game is recorded once, by its id (the router's game id and the game's number in it), so
 * a rematch is a game of its own and a result reported twice counts once.
 *
 * <p>A seat's {@code user} is a login, null for the AI and for a guest (whose name is never stored); records are only
 * ever read for the login asking.
 */
final class Results {

    /** One seat of a finished game: who (a login, or null), the name shown then, the deck, and won / lost / draw. */
    record Seat(String user, String name, String deck, String r, boolean conceded) {
        boolean won() {
            return "won".equals(r);
        }

        boolean lost() {
            return "lost".equals(r);
        }
    }

    /** A finished game: {@code id} = game id + ":" + its number there, {@code mode} "ai" or "pvp", format null for Constructed. */
    record Result(String id, long t, String mode, String format, List<Seat> seats) { }

    /** Wins, losses (draws aside) and when the last game was. */
    record Stat(int w, int l, long last) {
        Stat add(final Seat s, final long t) {
            return new Stat(w + (s.won() ? 1 : 0), l + (s.lost() ? 1 : 0), Math.max(last, t));
        }
    }

    /** Someone the asker played: their login, the name they had in the latest game, and the asker's record against them. */
    record Opp(String user, String name, Stat stat) { }

    /** Roll over past this size (a line is ~250 bytes: about 16,000 games a file). */
    static final long MAX_BYTES = 4L * 1024 * 1024;

    private final Path file;
    private final long maxBytes;
    private final List<Result> all = new ArrayList<>();
    private final Set<String> ids = new HashSet<>();
    /** How many of {@link #all} came from the rolled-over file (dropped from memory at the next roll-over). */
    private int inOld;
    private long size;

    Results(final Path file) {
        this(file, MAX_BYTES);
    }

    Results(final Path file, final long maxBytes) {
        this.file = file;
        this.maxBytes = maxBytes;
        inOld = load(old());
        load(file);
        try {
            size = Files.isRegularFile(file) ? Files.size(file) : 0;
        } catch (final IOException e) {
            size = 0;
        }
        try {
            if (size > 0 && lastByte(file) != '\n') {
                // a write cut short (a crash, a full disk): end its line, so the next result doesn't join it
                Files.write(file, new byte[] {'\n'}, StandardOpenOption.APPEND);
                size++;
            }
        } catch (final IOException e) {
            BridgeLog.warn("could not end the last line of " + file + ": " + e); // size stays the file's real size
        }
    }

    private static int lastByte(final Path f) throws IOException {
        try (java.nio.channels.SeekableByteChannel c = Files.newByteChannel(f)) {
            final java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(1);
            c.position(c.size() - 1).read(b);
            return b.get(0);
        }
    }

    private Path old() {
        return file.resolveSibling(file.getFileName() + ".1");
    }

    /** The results in {@code f} (none when it is missing or unreadable), skipping lines that don't parse; how many. */
    private int load(final Path f) {
        if (!Files.isRegularFile(f)) {
            return 0;
        }
        int n = 0;
        try {
            for (final String line : Files.readAllLines(f, StandardCharsets.UTF_8)) {
                final Result r = parse(line);
                if (r != null && ids.add(r.id())) {
                    all.add(r);
                    n++;
                }
            }
        } catch (final IOException | RuntimeException e) {
            BridgeLog.warn("could not read " + f + ": " + e);
        }
        return n;
    }

    /** Record a game; false when it was already recorded (or isn't a game). Saved at once; kept in memory if the disk fails. */
    synchronized boolean add(final Result r) {
        if (r == null || r.id() == null || r.seats().isEmpty() || !ids.add(r.id())) {
            return false;
        }
        all.add(r);
        final byte[] line = (toJson(r) + "\n").getBytes(StandardCharsets.UTF_8);
        try {
            Files.createDirectories(file.getParent());
            if (size + line.length > maxBytes && size > 0) {
                Files.move(file, old(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                // What was in the old .1 is gone from disk: forget it here too (the last game stays, it's in the new file).
                final List<Result> keep = new ArrayList<>(all.subList(inOld, all.size()));
                all.subList(0, inOld).forEach(x -> ids.remove(x.id()));
                all.clear();
                all.addAll(keep);
                inOld = all.size() - 1;
                size = 0;
            }
            Files.write(file, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            size += line.length;
        } catch (final IOException e) {
            BridgeLog.warn("could not save a result to " + file + ": " + e);
        }
        return true;
    }

    /** {@code user}'s record with each deck they played (by deck name). */
    synchronized Map<String, Stat> decks(final String user) {
        final Map<String, Stat> m = new LinkedHashMap<>();
        if (user == null) {
            return m;
        }
        for (final Result r : all) {
            for (final Seat s : r.seats()) {
                if (user.equals(s.user()) && s.deck() != null) {
                    m.merge(s.deck(), new Stat(0, 0, 0).add(s, r.t()), (a, b) -> new Stat(a.w() + b.w(), a.l() + b.l(), Math.max(a.last(), b.last())));
                }
            }
        }
        return m;
    }

    /** The people {@code user} played (games between two signed-in people) since {@code since}, by login: their record against each. */
    synchronized Map<String, Opp> opponents(final String user, final long since) {
        final Map<String, Opp> m = new LinkedHashMap<>();
        if (user == null) {
            return m;
        }
        for (final Result r : all) {
            if (r.t() < since || r.seats().size() != 2) {
                continue;
            }
            for (int i = 0; i < 2; i++) {
                final Seat me = r.seats().get(i);
                final Seat them = r.seats().get(1 - i);
                if (user.equals(me.user()) && them.user() != null && !user.equals(them.user())) {
                    final Opp prev = m.get(them.user());
                    final Stat st = (prev == null ? new Stat(0, 0, 0) : prev.stat()).add(me, r.t());
                    // The name from their latest game together (results are in time order).
                    m.put(them.user(), new Opp(them.user(), them.name() != null ? them.name() : prev != null ? prev.name() : them.user(), st));
                }
            }
        }
        return m;
    }

    synchronized int size() {
        return all.size();
    }

    static String toJson(final Result r) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", r.id());
        o.addProperty("t", r.t());
        o.addProperty("mode", r.mode());
        if (r.format() != null) {
            o.addProperty("format", r.format());
        }
        final JsonArray seats = new JsonArray();
        for (final Seat s : r.seats()) {
            final JsonObject j = new JsonObject();
            if (s.user() != null) {
                j.addProperty("user", s.user());
            }
            if (s.name() != null) {
                j.addProperty("name", s.name());
            }
            if (s.deck() != null) {
                j.addProperty("deck", s.deck());
            }
            j.addProperty("r", s.r());
            if (s.conceded()) {
                j.addProperty("conceded", true);
            }
            seats.add(j);
        }
        o.add("seats", seats);
        return o.toString();
    }

    /** A line of the file, or null when it isn't one. */
    static Result parse(final String line) {
        try {
            if (line == null || line.isBlank()) {
                return null;
            }
            final JsonObject o = JsonParser.parseString(line).getAsJsonObject();
            final List<Seat> seats = new ArrayList<>();
            for (final JsonElement e : o.getAsJsonArray("seats")) {
                final JsonObject j = e.getAsJsonObject();
                final String res = str(j, "r");
                if (!"won".equals(res) && !"lost".equals(res) && !"draw".equals(res)) {
                    return null;
                }
                seats.add(new Seat(str(j, "user"), str(j, "name"), str(j, "deck"), res, j.has("conceded") && j.get("conceded").getAsBoolean()));
            }
            final String id = str(o, "id");
            return id == null || seats.isEmpty() ? null : new Result(id, o.get("t").getAsLong(), str(o, "mode"), str(o, "format"), List.copyOf(seats));
        } catch (final RuntimeException e) {
            return null;
        }
    }

    private static String str(final JsonObject o, final String k) {
        return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : null;
    }
}

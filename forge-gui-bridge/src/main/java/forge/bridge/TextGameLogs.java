package forge.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Observable;
import java.util.Observer;
import java.util.WeakHashMap;
import java.util.stream.Stream;

import forge.game.Game;
import forge.game.GameLog;
import forge.game.GameLogEntry;

/** Opt-in, operator-only Forge text logs, independent of the Neural plugin and its upload consent/queue. */
final class TextGameLogs {
    private static final String SUFFIX = ".game.log";
    private static final byte[] TRUNCATED = "[log truncated at byte limit]\n".getBytes(StandardCharsets.UTF_8);

    private final Path dir;
    private final String id;
    private final int keep;
    private final long maxBytes;
    private final Map<Game, Boolean> watched = Collections.synchronizedMap(new WeakHashMap<>());

    TextGameLogs(final Path dir, final String id, final int keep, final long maxBytes) {
        if (keep < 1 || maxBytes < 1024) {
            throw new IllegalArgumentException("game-log-keep must be positive and game-log-max-bytes at least 1024");
        }
        this.dir = dir;
        this.id = id.replaceAll("[^a-zA-Z0-9_-]", "_");
        this.keep = keep;
        this.maxBytes = maxBytes;
    }

    /** Once per engine game, including rematches and pvp (where both seats attach the same game). */
    void watch(final Game game) {
        if (watched.putIfAbsent(game, Boolean.TRUE) != null) {
            return;
        }
        try {
            final GameLog log = game.getGameLog();
            final Capture capture = capture("g" + game.getId());
            log.addObserver(capture);
            capture.update(log, null); // include entries from before the first view attached
        } catch (final IOException | RuntimeException e) {
            BridgeLog.warn("could not start text game log: " + e);
        }
    }

    /** Create before pruning so even simultaneous sidecar starts prune against the new files. */
    Capture capture(final String game) throws IOException {
        Files.createDirectories(dir);
        final Path file = Files.createTempFile(dir, id + "-" + game + "-", SUFFIX);
        final Capture capture = new Capture(file);
        capture.append(("Forge Table " + id + " " + game + " " + Instant.now() + "\n").getBytes(StandardCharsets.UTF_8));
        prune();
        return capture;
    }

    /** Only our files, never trajectories or other operator files. Retention includes games still in progress. */
    private void prune() throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            final List<Path> logs = files.filter(p -> p.getFileName().toString().endsWith(SUFFIX)
                    && Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS))
                    .sorted(Comparator.comparingLong(TextGameLogs::modified).reversed()).toList();
            for (int i = keep; i < logs.size(); i++) {
                Files.deleteIfExists(logs.get(i));
            }
        }
    }

    private static long modified(final Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis();
        } catch (final IOException e) {
            return 0; // another sidecar may already have pruned it
        }
    }

    /** Each notification is appended and closed immediately: an abandoned/crashed game still has a log. */
    final class Capture implements Observer {
        private final Path file;
        private int entries;
        private long bytes;
        private boolean stopped;

        Capture(final Path file) {
            this.file = file;
        }

        Path file() { return file; }

        @Override
        public synchronized void update(final Observable observable, final Object ignored) {
            try {
                if (!stopped) {
                    final List<GameLogEntry> all = ((GameLog) observable).getAllEntries();
                    while (entries < all.size() && !stopped) {
                        append((all.get(entries++).toString() + "\n").getBytes(StandardCharsets.UTF_8));
                    }
                }
            } catch (final IOException | RuntimeException e) {
                stopped = true;
                BridgeLog.warn("could not append text game log " + file + ": " + e);
            }
            if (stopped) {
                observable.deleteObserver(this);
            }
        }

        private void append(final byte[] text) throws IOException {
            if (bytes + text.length + TRUNCATED.length > maxBytes) {
                Files.write(file, TRUNCATED, StandardOpenOption.APPEND);
                stopped = true;
            } else {
                // No CREATE: retention may have deleted an older, still-running game's log. Never recreate it.
                Files.write(file, text, StandardOpenOption.APPEND);
                bytes += text.length;
            }
        }
    }
}

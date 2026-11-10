package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.stream.Stream;

import org.testng.annotations.Test;

import forge.game.GameLog;
import forge.game.GameLogEntryType;

public class TextGameLogsTest {
    @Test
    public void logsExistingAndLiveEntriesOnceInChronologicalOrder() throws Exception {
        final Path dir = Files.createTempDirectory("text-game-log");
        final TextGameLogs logs = new TextGameLogs(dir, "router-game", 2, 4096);
        final GameLog log = new GameLog();
        log.add(GameLogEntryType.TURN, "turn one");
        final TextGameLogs.Capture capture = logs.capture("g1");
        log.addObserver(capture);
        capture.update(log, null);
        log.add(GameLogEntryType.STACK_RESOLVE, "Candy Trail resolved");
        capture.update(log, null); // a repeated notification is not a repeated entry
        final String text = Files.readString(capture.file());
        assertTrue(capture.file().getFileName().toString().startsWith("router-game-g1-"));
        assertTrue(text.indexOf("turn one") < text.indexOf("Candy Trail resolved"));
        assertEquals(text.indexOf("Candy Trail resolved"), text.lastIndexOf("Candy Trail resolved"));
    }

    @Test
    public void capsBytesAndDetachesInsteadOfGrowingForever() throws Exception {
        final TextGameLogs logs = new TextGameLogs(Files.createTempDirectory("text-game-log-limit"), "limit", 2, 1024);
        final GameLog log = new GameLog();
        final TextGameLogs.Capture capture = logs.capture("g1");
        log.addObserver(capture);
        for (int i = 0; i < 100; i++) {
            log.add(GameLogEntryType.TURN, "\u00e9".repeat(100));
        }
        assertTrue(Files.size(capture.file()) <= 1024, "limit is UTF-8 bytes, not characters");
        assertTrue(Files.readString(capture.file()).endsWith("[log truncated at byte limit]\n"));
        assertEquals(log.countObservers(), 0);
    }

    @Test
    public void retentionSpansRestartsAndDoesNotTouchTrajectories() throws Exception {
        final Path dir = Files.createTempDirectory("text-game-log-retain");
        final TextGameLogs logs = new TextGameLogs(dir, "game", 1, 4096);
        final TextGameLogs.Capture first = logs.capture("g1");
        final GameLog log = new GameLog();
        log.addObserver(first);
        Files.setLastModifiedTime(first.file(), FileTime.fromMillis(1));
        final Path trajectory = dir.resolve("game.mtgt");
        Files.writeString(trajectory, "trajectory");
        final Path other = dir.resolve("operator.txt");
        Files.writeString(other, "keep");
        final Path second = new TextGameLogs(dir, "game", 1, 4096).capture("g2").file();
        assertFalse(Files.exists(first.file()));
        assertTrue(Files.exists(second));
        assertTrue(Files.exists(trajectory));
        assertTrue(Files.exists(other));
        log.add(GameLogEntryType.TURN, "the old game is still playing");
        assertFalse(Files.exists(first.file()), "an active but pruned log must not be recreated");
        assertEquals(log.countObservers(), 0, "retention cannot accumulate active writers");
    }

    @Test
    public void aWriteFailureDoesNotInterruptTheGame() throws Exception {
        final TextGameLogs logs = new TextGameLogs(Files.createTempDirectory("text-game-log-fail"), "game", 2, 4096);
        final TextGameLogs.Capture capture = logs.capture("g1");
        final GameLog log = new GameLog();
        log.addObserver(capture);
        Files.delete(capture.file());
        log.add(GameLogEntryType.TURN, "continues despite missing file");
        assertEquals(log.getAllEntries().size(), 1);
        assertEquals(log.countObservers(), 0);
    }

    @Test
    public void settingsDefaultOffAndRejectUnboundedRetention() {
        final BridgeApp.Options defaults = Main.parse(new String[0]);
        assertEquals(defaults.gameLogDir, null);
        assertEquals(defaults.gameLogKeep, 200);
        assertEquals(defaults.gameLogMaxBytes, 4 * 1024 * 1024L);
        final BridgeApp.Options parsed = Main.parse(new String[] {"--game-log-dir", "logs", "--game-log-keep", "3",
                "--game-log-max-bytes", "8192"});
        assertEquals(parsed.gameLogDir, "logs");
        assertEquals(parsed.gameLogKeep, 3);
        assertEquals(parsed.gameLogMaxBytes, 8192L);
        expectThrows(IllegalArgumentException.class, () -> new TextGameLogs(Path.of("unused"), "game", 0, 4096));
        expectThrows(IllegalArgumentException.class, () -> new TextGameLogs(Path.of("unused"), "game", 1, 0));
    }

    @Test
    public void attachesToTheRealGameOnceAndKeepsTheLogAfterItEnds() throws Exception {
        final Path dir = Files.createTempDirectory("text-game-log-wiring");
        final BridgeApp.Options options = TableTestEnv.options();
        options.gameLogDir = dir.toString();
        options.gameLogId = "lobby-game";
        try (AutoPassTest.Game g = new AutoPassTest.Game(Main.boot(options), AutoPassTest.Game.defaultParams("loop-retriever.txt"), false)) {
            g.awaitPriority();
            final forge.game.Game game = g.sidecar().app.match().getGame();
            game.getGameLog().add(GameLogEntryType.TURN, "wiring marker");
            final List<Path> files;
            try (Stream<Path> paths = Files.list(dir)) {
                files = paths.toList();
            }
            assertEquals(files.size(), 1);
            assertTrue(files.get(0).getFileName().toString().startsWith("lobby-game-g"));
            assertTrue(Files.readString(files.get(0)).contains("wiring marker"), "written while still playing");
        }
        try (Stream<Path> paths = Files.list(dir)) {
            assertEquals(paths.count(), 1L, "ending a game does not discard its diagnostic log");
        }
    }
}

package forge.bridge.router;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.Test;

/** The lobby's boot progress: child lines parsed, bands in order, the bar never backwards, labels the router's own. */
public class StartProgressTest {

    private final AtomicLong now = new AtomicLong(1_000_000);

    private StartProgress fresh() {
        return new StartProgress(now::get);
    }

    @Test
    public void bandsCoverTheBarInOrder() {
        int at = 0;
        for (final StartProgress.Band b : StartProgress.BANDS) {
            assertEquals(b.from(), at, b.stage() + " starts where the previous band ended");
            assertTrue(b.to() > b.from(), b.stage());
            at = b.to();
        }
        assertTrue(at < 100, "a starting game never shows 100 %");
        assertEquals(StartProgress.BANDS.get(0).stage(), "java");
    }

    @Test
    public void javaUntilTheChildSpeaks() {
        final GameHost.Progress p = fresh().view();
        assertEquals(p.stage(), "java");
        assertEquals(p.label(), "Starting Java");
        assertEquals(p.pct(), 0);
    }

    @Test
    public void linesMoveThroughTheBands() {
        final StartProgress s = fresh();
        assertTrue(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":0}"));
        assertEquals(s.view().stage(), "cards");
        assertEquals(s.view().pct(), 5);
        assertTrue(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":50}"));
        assertEquals(s.view().pct(), 35); // 5 + 60 * 50 %
        assertEquals(s.view().label(), "Loading card database");
        assertTrue(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"ai\",\"pct\":0}"));
        assertEquals(s.view().stage(), "ai");
        assertEquals(s.view().label(), "Preparing the AI opponent");
        assertEquals(s.view().pct(), 65);
        assertTrue(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"table\",\"pct\":100}"));
        assertEquals(s.view().pct(), 99);
        assertEquals(s.view().label(), "Setting the table");
    }

    @Test
    public void neverBackwards() {
        final StartProgress s = fresh();
        s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"ai\",\"pct\":40}");
        final int high = s.view().pct();
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":99}"), "an earlier stage is ignored");
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"ai\",\"pct\":10}"), "a lower percent is ignored");
        assertEquals(s.view().stage(), "ai");
        assertEquals(s.view().pct(), high);

        // The creep moves the bar on a silent stage; a later real percent below it doesn't pull it back.
        final StartProgress t = fresh();
        t.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":0}");
        int last = t.view().pct();
        for (int i = 0; i < 40; i++) {
            now.addAndGet(500);
            final int p = t.view().pct();
            assertTrue(p >= last, "bar went back from " + last + " to " + p);
            last = p;
        }
        assertTrue(last > 5 && last < 65, "creep stays inside its band: " + last);
        t.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":10}");
        assertEquals(t.view().pct(), last);
    }

    @Test
    public void junkIsIgnored() {
        final StartProgress s = fresh();
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"<img src=x>\",\"pct\":50}"), "unknown stage");
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"java\",\"pct\":50}"), "the router's own stage");
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"pct\":50}"));
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":[\"cards\"],\"pct\":50}"));
        assertFalse(s.accept("FORGE_TABLE_PROGRESS not json"));
        assertFalse(s.accept("FORGE_TABLE_PROGRESS [1,2]"));
        assertFalse(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":50,\"pad\":\"" + "x".repeat(300) + "\"}"), "overlong");
        assertFalse(s.accept("Read cards: 33980 files"));
        assertEquals(s.view().stage(), "java");
        assertEquals(s.view().pct(), 0);

        assertTrue(s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":\"lots\",\"label\":\"Hacked\"}"), "a bad percent counts as 0");
        assertEquals(s.view().pct(), 5);
        s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":1e9}");
        assertEquals(s.view().pct(), 65, "clamped to the band");
    }

    @Test
    public void labelsComeFromTheAllowlist() {
        final Set<String> labels = new HashSet<>();
        for (final StartProgress.Band b : StartProgress.BANDS) {
            labels.add(b.label());
        }
        final StartProgress s = fresh();
        for (final String stage : new String[] {"cards", "bogus", "ai", "table"}) {
            s.accept("FORGE_TABLE_PROGRESS {\"stage\":\"" + stage + "\",\"pct\":5,\"label\":\"<b>pwned</b>\"}");
            assertTrue(labels.contains(s.view().label()), s.view().label());
        }
    }
}

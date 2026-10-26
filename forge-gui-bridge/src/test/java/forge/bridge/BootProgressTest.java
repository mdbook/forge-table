package forge.bridge;

import static org.testng.Assert.assertEquals;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

/** The sidecar's boot progress lines: stage order, the throttle, and the card readers' share of the cards stage. */
public class BootProgressTest {

    private final AtomicLong now = new AtomicLong();
    private ByteArrayOutputStream bytes;
    private BootProgress p;

    @BeforeMethod
    public void fresh() {
        now.set(0);
        bytes = new ByteArrayOutputStream();
        p = new BootProgress(new PrintStream(bytes, true, StandardCharsets.UTF_8), now::get);
    }

    private List<String> lines() {
        return bytes.toString(StandardCharsets.UTF_8).lines().toList();
    }

    @Test
    public void stagesForwardOnlyAndThrottled() {
        p.stage("cards");
        p.pct(10);           // within 250 ms of the stage line: held back
        now.addAndGet(100);
        p.pct(20);           // still held back
        now.addAndGet(200);
        p.pct(30);           // printed
        p.pct(25);           // lower: ignored
        p.stage("ai");       // a stage change is printed at once
        p.stage("cards");    // backwards: ignored
        p.stage("table");
        assertEquals(lines(), List.of(
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":0}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":30}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"ai\",\"pct\":0}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"table\",\"pct\":0}"));
    }

    @Test
    public void cardReadersFillTheCardsStage() {
        p.stage("cards");
        now.addAndGet(1000);
        p.setMaximum(25);
        p.setValue(0);
        p.setValue(25);      // main card folder done: 80 %
        now.addAndGet(1000);
        p.setMaximum(8);
        p.setValue(0);       // token folder
        p.setValue(4);
        now.addAndGet(1000);
        p.setValue(8);
        assertEquals(lines(), List.of(
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":0}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":80}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":90}",
                "FORGE_TABLE_PROGRESS {\"stage\":\"cards\",\"pct\":100}"));
    }

    @Test
    public void quietWithoutAStream() {
        final BootProgress quiet = new BootProgress(null, now::get);
        quiet.stage("cards");
        quiet.pct(50);
        quiet.stage("table");
    }
}

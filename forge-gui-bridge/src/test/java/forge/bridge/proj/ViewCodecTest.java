package forge.bridge.proj;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;

import com.google.gson.JsonObject;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import forge.bridge.TableTestEnv;

import forge.trackable.TrackableProperty;

/** Every TrackableProperty is either deliberately server-only or has a JSON encoding. */
public class ViewCodecTest {

    /** Engine enums (e.g. GameType) localize their names at class init, so Forge must be booted first. */
    @BeforeClass
    public void boot() throws Exception {
        TableTestEnv.start().stop();
    }

    @Test
    public void everySentPropertyHasAnEncoding() {
        for (final TrackableProperty p : TrackableProperty.values()) {
            if (ViewCodec.isEncodable(p) && !ViewCodec.PLAYER_ZONES.contains(p)) {
                // Throws for a TrackableType the codec does not know: add an encoding (and a TS type).
                assertTrue(!ViewCodec.tsType(p).isEmpty(), p.name());
            }
        }
    }

    @Test
    public void jsonKeysAreUnique() {
        final Set<String> keys = new HashSet<>();
        for (final TrackableProperty p : TrackableProperty.values()) {
            assertTrue(keys.add(ViewCodec.key(p)), "duplicate key " + ViewCodec.key(p));
        }
        assertEquals(ViewCodec.key(TrackableProperty.SA_IsSpell), "saIsSpell");
        assertEquals(ViewCodec.key(TrackableProperty.Tapped), "tapped");
    }

    /** Eluge (star/star) and Tarmogoyf (star/1+star) print no number: flagged, so the client always shows the chip ("Eluge no show power"). */
    @Test
    public void nonNumericPrintedPtIsFlaggedAsVarying() {
        for (final String name : new String[] {"Eluge, the Shoreless Sea", "Tarmogoyf"}) {
            final JsonObject out = new JsonObject();
            ViewCodec.printedPt(name, out);
            assertEquals(out.get("printedPtVaries").getAsBoolean(), true, name);
            assertTrue(!out.has("printedPower") && !out.has("printedToughness"), name);
        }
        final JsonObject bears = new JsonObject();
        ViewCodec.printedPt("Grizzly Bears", bears);
        assertEquals(bears.get("printedPower").getAsInt(), 2);
        assertTrue(!bears.has("printedPtVaries"));
        final JsonObject forest = new JsonObject();
        ViewCodec.printedPt("Forest", forest);
        assertTrue(!forest.has("printedPtVaries"), "a land has no P/T at all");
    }

    /** Tokens have no card rules, so a buffed Germ showed its art's 0/0 with no P/T chip. */
    @Test
    public void tokensGetTheirPrintedPtFromTheTokenScripts() {
        assertEquals(ViewCodec.tokenPrintedPt("Phyrexian Germ Token"), new int[] {0, 0});
        assertEquals(ViewCodec.tokenPrintedPt("Phyrexian Germ"), new int[] {0, 0});
        // 1/1 and 2/2 Soldier scripts exist: ambiguous, so the client keeps inferring.
        assertNull(ViewCodec.tokenPrintedPt("Soldier Token"));
        assertNull(ViewCodec.tokenPrintedPt("No Such Token"));
    }
}

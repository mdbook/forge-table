package forge.bridge.proto;

import static org.testng.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import forge.bridge.TableTestEnv;

/**
 * The committed TypeScript protocol types match the engine's TrackableProperty. Regenerate
 * with {@code -Dforge.codegen.write=true}.
 */
public class ProtocolCodegenTest {

    /** Engine enums (e.g. GameType) localize their names at class init, so Forge must be booted first. */
    @BeforeClass
    public void boot() throws Exception {
        TableTestEnv.start().stop();
    }

    @Test
    public void generatedTypesAreCurrent() throws Exception {
        final Path web = Path.of(System.getProperty("forge.bridge.web", "../forge-gui-web/"));
        if (Boolean.getBoolean("forge.codegen.write")) {
            Codegen.write(web);
        }
        final Path file = web.resolve(Codegen.RELATIVE_PATH);
        final String committed = Files.exists(file) ? Files.readString(file, StandardCharsets.UTF_8) : "";
        assertEquals(committed, Codegen.generate(),
                file + " is stale: run mvn -pl forge-gui-bridge test -Dtest=ProtocolCodegenTest -Dforge.codegen.write=true");
    }
}

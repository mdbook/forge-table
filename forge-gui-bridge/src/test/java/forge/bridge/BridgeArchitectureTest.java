package forge.bridge;

import static org.testng.Assert.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.testng.annotations.Test;

/**
 * The sidecar stays Swing-free and independent of the legacy desktop client, like
 * mtg-ai's NoForgeGuiTest: no javax.swing, no java.awt except java.awt.image, nothing from forge-gui-desktop.
 */
public class BridgeArchitectureTest {

    private static final Pattern IMPORT = Pattern.compile("^import\\s+(static\\s+)?([\\w.]+)", Pattern.MULTILINE);
    // Top-level packages that only exist in forge-gui-desktop.
    private static final List<String> DESKTOP = List.of("forge.screens.", "forge.toolbox.", "forge.view.", "forge.GuiDesktop",
            "forge.Singletons", "forge.control.", "forge.menus.", "forge.gui.framework.", "forge.itemmanager.", "forge.ImageCache");

    @Test
    public void noSwingAwtOrDesktopImports() throws IOException {
        final Path src = Path.of("src/main/java");
        final List<String> bad = new ArrayList<>();
        try (Stream<Path> files = Files.walk(src)) {
            for (final Path f : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".java"))::iterator) {
                final Matcher m = IMPORT.matcher(Files.readString(f));
                while (m.find()) {
                    final String imp = m.group(2);
                    final boolean awt = imp.startsWith("java.awt.") && !imp.startsWith("java.awt.image.");
                    final boolean desktop = DESKTOP.stream().anyMatch(imp::startsWith);
                    if (imp.startsWith("javax.swing") || awt || desktop) {
                        bad.add(src.relativize(f) + ": " + imp);
                    }
                }
            }
        }
        assertTrue(bad.isEmpty(), "forbidden imports: " + bad);
    }

    @Test
    public void desktopModuleIsNotOnTheClasspath() {
        assertTrue(!System.getProperty("java.class.path").contains("forge-gui-desktop"), "forge-gui-desktop leaked onto the classpath");
    }
}

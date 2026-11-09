package forge.bridge;

import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.testng.annotations.Test;

/** Safety and release-layout contracts for the documented first-run paths. */
public class SetupFilesTest {
    @Test
    public void defaultComposeUsesAccountsBehindTls() throws IOException {
        final String compose = Files.readString(Path.of("docker/compose.yaml"));
        final String router = compose.substring(compose.indexOf("  forge-table:\n"), compose.indexOf("  caddy:\n"));
        assertTrue(router.contains("FT_AUTH: users"));
        assertTrue(router.contains("FT_REAL_IP_HEADER: X-Real-IP"));
        assertTrue(router.contains("FT_MAX_MATCHES: \"1\""));
        assertTrue(router.contains("forge-table-data:/data"));
        assertFalse(router.contains("ports:"), "only the TLS proxy may publish ports");
        assertFalse(router.contains("FT_TRUST_PROXY_HEADER"), "accounts do not trust a user header");
        assertFalse(compose.contains("FT_INSECURE_COOKIES"), "keep secure session cookies");
        assertFalse(compose.contains("network_mode:"), "the default must work without host networking");
        assertFalse(compose.contains("  oauth2-proxy:\n"), "no external login provider needed");
        assertTrue(compose.contains("${FT_DOMAIN:?"), "require the user's domain before starting");
        assertTrue(compose.contains("./Caddyfile:/etc/caddy/Caddyfile:ro"));
        assertTrue(compose.contains("ghcr.io/mdbook/forge-table:edge"),
                "default image must be the published one, not a local build name");
    }

    @Test
    public void proxyOverwritesTheClientAddress() throws IOException {
        final String caddy = Files.readString(Path.of("docker/Caddyfile"));
        assertTrue(caddy.contains("{$FT_DOMAIN} {"));
        assertTrue(caddy.contains("@private path /healthz /admin/*"));
        assertTrue(caddy.contains("respond @private 404"));
        assertTrue(caddy.contains("reverse_proxy forge-table:8790"));
        assertTrue(caddy.contains("header_up X-Real-IP {remote_host}"), "do not trust a client-sent address");
    }

    @Test
    public void routerLaunchersArePackagedWithTheReleaseLayout() throws IOException {
        final String packaging = Files.readString(Path.of("package.sh"));
        for (final String extension : new String[] {"sh", "cmd"}) {
            final String name = "launch-router." + extension;
            final String launcher = Files.readString(Path.of("dist", name));
            assertTrue(launcher.contains("-cp \"lib/*\" forge.bridge.Main --router --port 8790 --data user/router"));
            assertTrue(launcher.contains("--assets . --web web --decks decks"));
            assertTrue(launcher.contains("-Xmx1536m -Xss8m"));
            assertTrue(launcher.contains("-Dforge.table.ignoreStdin=true"));
            for (final String module : new String[] {"java.base/java.lang", "java.base/java.util",
                    "java.base/java.lang.reflect", "java.base/java.text", "java.desktop/javax.imageio.spi"}) {
                assertTrue(launcher.contains("--add-opens " + module + "=ALL-UNNAMED"), module + " in " + name);
            }
            assertTrue(packaging.contains("$HERE/dist/" + name), name + " must be included in the zip");
        }
        assertTrue(packaging.contains("chmod +x \"$S/launch-router.sh\""));
        assertTrue(Files.readString(Path.of("dist/launch-router.sh")).contains("\"$@\""));
        assertTrue(Files.readString(Path.of("dist/launch-router.cmd")).contains("%*"));
    }
}

package forge.bridge.router;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;

/**
 * Each user's own choice on "send my games to train the AI" (unset: the channel's default applies),
 * persisted as one small JSON file so it survives a router restart or deploy.
 */
final class UploadPrefs {
    private final Path file;
    private final Map<String, Boolean> prefs = new ConcurrentHashMap<>();
    /** The file exists but couldn't be read: nobody's choice is known, so nobody consents and nothing overwrites it. */
    private volatile boolean unreadable;

    UploadPrefs(final Path file) {
        this.file = file;
        if (Files.isRegularFile(file)) {
            try {
                final JsonObject j = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
                for (final String user : j.keySet()) {
                    prefs.put(user, j.get(user).getAsBoolean());
                }
            } catch (final IOException | RuntimeException e) {
                unreadable = true;
                prefs.clear();
                BridgeLog.error("unreadable " + file + ": nobody uploads until it is fixed or removed", e);
            }
        }
    }

    /** The user's own choice, or null: they haven't set one (use the channel's default). */
    Boolean get(final String user) {
        return prefs.get(user);
    }

    boolean unreadable() {
        return unreadable;
    }

    /** Every user's own choice. */
    Map<String, Boolean> all() {
        return Map.copyOf(prefs);
    }

    /** Set and persist at once (a user toggling this is rare; a synchronous write keeps it simple). False: not saved. */
    synchronized boolean set(final String user, final boolean on) {
        if (unreadable) {
            return false;
        }
        prefs.put(user, on);
        final JsonObject j = new JsonObject();
        prefs.forEach(j::addProperty);
        try {
            Files.createDirectories(file.getParent());
            final Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.writeString(tmp, j.toString(), StandardCharsets.UTF_8);
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (final IOException e) {
            BridgeLog.warn("could not save " + file + ": " + e);
            return false;
        }
    }
}

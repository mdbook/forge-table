package forge.bridge;

import com.google.gson.JsonObject;

import forge.bridge.proj.Outbox;

/** JSON helpers shared by messages sent outside a match's {@link Outbox}. */
final class Outboxes {
    private Outboxes() { }

    static String toJson(final JsonObject o) {
        return Outbox.gson().toJson(o);
    }
}

package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;

/** The decks a Neural model was trained on: read from latest.json, a fallback for older models, only decks we have. */
public class NeuralStatusTest {

    private static Path model(final String name, final String latest) throws Exception {
        final Path dir = Path.of("target", "neural-status-test", name).toAbsolutePath();
        Files.createDirectories(dir);
        Files.deleteIfExists(dir.resolve("latest.json"));
        if (latest != null) {
            Files.writeString(dir.resolve("latest.json"), latest);
        }
        return dir;
    }

    @Test
    public void readsDecksStrongestFirst() throws Exception {
        final Path dir = model("listed", "{\"version\":7751,\"file\":\"policy-007751.onnx\",\"decks\":[\"jund-wildfire\",\"tron.dck\",\" \",\"JUND-wildfire\",3]}");
        assertEquals(NeuralStatus.trainedDecks(dir), List.of("jund-wildfire", "tron"));
    }

    @Test
    public void olderModelsFallBack() throws Exception {
        assertEquals(NeuralStatus.trainedDecks(model("old", "{\"version\":7751,\"file\":\"policy-007751.onnx\"}")), NeuralStatus.DEFAULT_DECKS);
        assertEquals(NeuralStatus.trainedDecks(model("empty", "{\"decks\":[]}")), NeuralStatus.DEFAULT_DECKS);
        assertEquals(NeuralStatus.trainedDecks(model("wrong", "{\"decks\":\"tron\"}")), NeuralStatus.DEFAULT_DECKS);
        assertEquals(NeuralStatus.trainedDecks(model("junk", "not json")), NeuralStatus.DEFAULT_DECKS);
        assertEquals(NeuralStatus.trainedDecks(model("none", null)), NeuralStatus.DEFAULT_DECKS);
        assertEquals(NeuralStatus.DEFAULT_DECKS, List.of());
    }

    @Test
    public void onlyDecksThatExist() {
        final NeuralStatus n = new NeuralStatus(true, null, List.of("mono-red-madness", "gone", "grixis-affinity"));
        final List<String> have = List.of("elves", "Grixis-Affinity", "mono-red-madness", "tron");
        assertEquals(n.decksIn(have), List.of("mono-red-madness", "Grixis-Affinity"));
        final JsonObject j = n.toJson(have, false);
        assertEquals(j.get("decks").toString(), "[\"mono-red-madness\",\"Grixis-Affinity\"]");
        assertEquals(new NeuralStatus(false, "no model", List.of("gone")).toJson(have, false).toString(), "{\"ok\":false,\"label\":\"" + NeuralStatus.LABEL + "\",\"reason\":\"no model\",\"decks\":[]}");
        assertEquals(new NeuralStatus(false, NeuralStatus.NO_PLUGIN, List.of()).toJson(have, false).get("plugin").getAsBoolean(), false);
        assertNull(j.get("plugin"));
    }

    @Test
    public void labelFromPropertyThenEnvThenModel() throws Exception {
        assertEquals(NeuralStatus.label(null, null, null), "Neural");
        assertEquals(NeuralStatus.label(" ", "", " "), "Neural");
        assertEquals(NeuralStatus.label(null, " Lyra ", "Ada"), "Lyra");
        assertEquals(NeuralStatus.label("Ada", "Lyra", "Bo"), "Ada");
        assertEquals(NeuralStatus.label(null, null, "Lyra"), "Lyra");
        assertEquals(NeuralStatus.modelName(model("named", "{\"version\":58625,\"name\":\"Lyra\"}")), "Lyra");
        assertNull(NeuralStatus.modelName(model("unnamed", "{\"version\":58625}")));
        assertNull(NeuralStatus.modelName(model("nameless", null)));
        assertNull(NeuralStatus.modelName(model("garbled", "not json")));
    }

    static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d};
    static final byte[] WEBP = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'E', 'B', 'P', 'V', 'P', '8', ' '};
    static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2};

    private static Path file(final Path dir, final String name, final byte[] bytes) throws Exception {
        Files.createDirectories(dir);
        return Files.write(dir.resolve(name), bytes);
    }

    @Test
    public void avatarTypedByItsBytes() {
        assertEquals(NeuralStatus.avatarType(PNG), "image/png");
        assertEquals(NeuralStatus.avatarType(WEBP), "image/webp");
        assertEquals(NeuralStatus.avatarType(JPEG), "image/jpeg");
        assertNull(NeuralStatus.avatarType("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".getBytes()));
        assertNull(NeuralStatus.avatarType(new byte[] {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'A', 'V', 'E'}));
        assertNull(NeuralStatus.avatarType(new byte[] {(byte) 0x89, 'P'}));
        assertNull(NeuralStatus.avatarType(new byte[0]));
    }

    /** The avatar: the property's file, else the env's, else avatar.png / avatar.webp in the model folder, else none. */
    @Test
    public void avatarFromPropertyThenEnvThenModelFolder() throws Exception {
        final Path root = Path.of("target", "neural-status-test", "avatar").toAbsolutePath();
        final Path prop = file(root, "prop.jpg", JPEG);
        final Path env = file(root, "env.webp", WEBP);
        final Path dir = root.resolve("model");
        Files.createDirectories(dir);
        Files.deleteIfExists(dir.resolve("avatar.png"));
        Files.deleteIfExists(dir.resolve("avatar.webp"));
        assertNull(NeuralStatus.avatar(null, " ", dir), "nothing set, nothing in the model folder");
        assertEquals(NeuralStatus.avatar(prop.toString(), env.toString(), dir), JPEG);
        assertEquals(NeuralStatus.avatar(null, " " + env + " ", dir), WEBP);
        file(dir, "avatar.webp", WEBP);
        assertEquals(NeuralStatus.avatar(null, null, dir), WEBP);
        file(dir, "avatar.png", PNG);
        assertEquals(NeuralStatus.avatar(null, null, dir), PNG, "png first");
        assertNull(NeuralStatus.avatar(root.resolve("missing.png").toString(), null, dir), "a path that is set is the only one tried");
        assertNull(NeuralStatus.avatar(root.toString(), null, dir), "a folder is no picture");
    }

    @Test
    public void avatarMustBeASmallImage() throws Exception {
        final Path root = Path.of("target", "neural-status-test", "avatar-bad").toAbsolutePath();
        final Path dir = root.resolve("model");
        Files.createDirectories(dir);
        Files.deleteIfExists(dir.resolve("avatar.webp"));
        final Path svg = file(root, "a.png", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>".getBytes());
        assertNull(NeuralStatus.avatar(svg.toString(), null, dir), "not a PNG, WebP or JPEG whatever its name");
        file(dir, "avatar.png", "not a picture".getBytes());
        assertNull(NeuralStatus.avatar(null, null, dir));
        final byte[] big = new byte[(int) NeuralStatus.AVATAR_MAX + 1];
        System.arraycopy(PNG, 0, big, 0, PNG.length);
        final Path huge = file(root, "huge.png", big);
        assertNull(NeuralStatus.avatar(huge.toString(), null, dir), "over the cap");
        final byte[] max = java.util.Arrays.copyOf(big, (int) NeuralStatus.AVATAR_MAX);
        assertEquals(NeuralStatus.avatar(file(root, "max.png", max).toString(), null, dir), max, "at the cap");
        // A file that changes is read again.
        final Path swap = file(root, "swap.png", "nope".getBytes());
        assertNull(NeuralStatus.avatar(swap.toString(), null, dir));
        Files.write(swap, PNG);
        assertEquals(NeuralStatus.avatar(swap.toString(), null, dir), PNG);
    }

    /** The welcome says when there is a picture, so the client only asks for one that exists. */
    @Test
    public void welcomeSaysWhenThereIsAnAvatar() throws Exception {
        final NeuralStatus n = new NeuralStatus(true, null, List.of());
        assertNull(n.toJson(List.of(), false).get("avatar"), "the test JVM has none");
        final Path png = file(Path.of("target", "neural-status-test", "avatar-json").toAbsolutePath(), "picture.png", PNG);
        System.setProperty("forge.table.neuralAvatar", png.toString());
        try {
            assertTrue(n.toJson(List.of(), false).get("avatar").getAsBoolean());
        } finally {
            System.clearProperty("forge.table.neuralAvatar");
        }
        assertNull(n.toJson(List.of(), false).get("avatar"));
    }

    /** {@code avatar_card}: a card name, or Name|SET; anything that isn't a plain string is none. */
    @Test
    public void avatarCardFromLatestJson() throws Exception {
        assertEquals(NeuralStatus.avatarCard(model("card", "{\"name\":\"Lyra\",\"avatar_card\":\" Lyra Dawnbringer \"}")), "Lyra Dawnbringer");
        final String printing = NeuralStatus.avatarCard(model("card-set", "{\"avatar_card\":\"Lyra Dawnbringer|DOM\"}"));
        assertEquals(printing, "Lyra Dawnbringer|DOM");
        assertEquals(NeuralStatus.avatarCardName(printing), "Lyra Dawnbringer");
        assertEquals(NeuralStatus.avatarCardName("Lyra Dawnbringer"), "Lyra Dawnbringer");
        assertEquals(NeuralStatus.avatarCardKey(printing), "c:Lyra Dawnbringer|DOM", "the key a game asks /img/crop/ with");
        assertNull(NeuralStatus.avatarCard(model("card-none", "{\"version\":1}")));
        assertNull(NeuralStatus.avatarCard(model("card-blank", "{\"avatar_card\":\"  \"}")));
        assertNull(NeuralStatus.avatarCard(model("card-bar", "{\"avatar_card\":\"|DOM\"}")));
        assertNull(NeuralStatus.avatarCard(model("card-num", "{\"avatar_card\":7}")));
        assertNull(NeuralStatus.avatarCard(model("card-dots", "{\"avatar_card\":\"../x\"}")));
        assertNull(NeuralStatus.avatarCard(model("card-ctl", "{\"avatar_card\":\"a\\nb\"}")));
        assertNull(NeuralStatus.avatarCard(model("card-long", "{\"avatar_card\":\"" + "x".repeat(201) + "\"}")));
        assertNull(NeuralStatus.avatarCard(model("card-junk", "not json")));
        assertNull(NeuralStatus.avatarCard(model("card-missing", null)));
    }

    /** The setting (property, then env) beats latest.json; a bad setting is none, not a fallback to the file. */
    @Test
    public void avatarCardSettingFirst() throws Exception {
        final Path dir = model("card-setting", "{\"avatar_card\":\"Serra Angel\"}");
        assertEquals(NeuralStatus.avatarCard("Lyra Dawnbringer|DOM", "Ada", dir), "Lyra Dawnbringer|DOM");
        assertEquals(NeuralStatus.avatarCard(" ", " Lyra Dawnbringer ", dir), "Lyra Dawnbringer");
        assertEquals(NeuralStatus.avatarCard(null, "", dir), "Serra Angel");
        assertNull(NeuralStatus.avatarCard("../x", null, dir));
    }

    /** A file beats avatar_card; avatar_card shows only with card art on, and the welcome says so. */
    @Test
    public void avatarCardIsTheLastFallbackAndNeedsCardArt() throws Exception {
        final Path dir = model("card-order", "{\"avatar_card\":\"Lyra Dawnbringer|DOM\"}");
        Files.deleteIfExists(dir.resolve("avatar.png"));
        Files.deleteIfExists(dir.resolve("avatar.webp"));
        final String old = System.getProperty("mtgai.neural.dir");
        System.setProperty("mtgai.neural.dir", dir.toString());
        try {
            final NeuralStatus n = new NeuralStatus(true, null, List.of());
            assertNull(NeuralStatus.avatar(null, null, dir), "the card's art is fetched by the servers, not read here");
            assertTrue(NeuralStatus.hasAvatar(true));
            assertTrue(n.toJson(List.of(), true).get("avatar").getAsBoolean());
            assertFalse(NeuralStatus.hasAvatar(false), "card art off: the monogram");
            assertNull(n.toJson(List.of(), false).get("avatar"));
            // A file in the model folder wins even with card art off.
            file(dir, "avatar.png", PNG);
            assertEquals(NeuralStatus.avatar(null, null, dir), PNG);
            assertTrue(NeuralStatus.hasAvatar(false));
            assertTrue(n.toJson(List.of(), false).get("avatar").getAsBoolean());
        } finally {
            if (old == null) {
                System.clearProperty("mtgai.neural.dir");
            } else {
                System.setProperty("mtgai.neural.dir", old);
            }
        }
    }
}

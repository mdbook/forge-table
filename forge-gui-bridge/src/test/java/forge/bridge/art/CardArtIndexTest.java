package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertNull;

import java.nio.file.Path;

import org.testng.annotations.Test;

/** The built map's file name carries the picking-rules version, so maps made by older rules are rebuilt once. */
public class CardArtIndexTest {
    @Test
    public void builtMapIsVersionedInItsFileName() {
        final Path cache = Path.of("/cache/table");
        assertEquals(CardArtIndex.builtFile(cache), cache.resolve("card_images.v" + CardArtIndex.FORMAT + ".json"));
        // the unversioned name is format 1's: it must never be read as current
        assertNotEquals(CardArtIndex.builtFile(cache), cache.resolve("card_images.json"));
    }

    @Test
    public void cropUrlIsTheScanUrlUnderArtCrop() {
        assertEquals(CardArtService.cropUrl("https://cards.scryfall.io/normal/front/a/b/abc.jpg?1700", false),
                "https://cards.scryfall.io/art_crop/front/a/b/abc.jpg?1700");
        assertEquals(CardArtService.cropUrl("https://cards.scryfall.io/normal/front/a/b/abc.jpg?1700", true),
                "https://cards.scryfall.io/art_crop/back/a/b/abc.jpg?1700");
        // nothing to derive it from: no crop (the caller then falls back to the deck's printing)
        assertNull(CardArtService.cropUrl("https://example.org/pic.jpg", false));
        assertNull(CardArtService.cropUrl("https://cards.scryfall.io/normal/back/a/b/abc.jpg", true));
        assertNull(CardArtService.cropUrl(null, false));
    }

    @Test
    public void artistsFileSitsNextToTheMap() {
        final Path cache = Path.of("/cache/table");
        assertEquals(CardArtIndex.builtArtistsFile(cache), cache.resolve("card_artists.v" + CardArtIndex.FORMAT + ".json"));
    }
}

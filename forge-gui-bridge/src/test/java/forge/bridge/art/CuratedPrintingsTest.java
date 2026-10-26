package forge.bridge.art;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;

import java.io.InputStreamReader;
import java.io.Reader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import org.testng.annotations.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The picker started as a port of mtg's build_image_map.py (the base constants, the front-face indexing); tests
 * marked "newest" cover what Forge Table added: modern frames and the newest-release tie-break.
 */
public class CuratedPrintingsTest {

    private static JsonObject card(final String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static String printing(final String name, final String url, final String extra) {
        return "{\"name\":\"" + name + "\",\"layout\":\"normal\",\"image_uris\":{\"normal\":\"" + url + "\"}" + extra + "}";
    }

    private static Map<String, String> pick(final List<String> printings) throws Exception {
        final CuratedPrintings p = new CuratedPrintings();
        p.readAll(new StringReader(String.join("\n", printings))); // JSONL
        return p.result();
    }

    @Test
    public void scoreConstants() {
        // plain English black-bordered high-res paper printing: 1000 + 20 + 10 + 5
        assertEquals(CuratedPrintings.score(card("{\"lang\":\"en\",\"border_color\":\"black\",\"highres_image\":true}")), Integer.valueOf(1035));
        // nothing set at all: only the non-digital nudge
        assertEquals(CuratedPrintings.score(card("{}")), Integer.valueOf(5));
        assertEquals(CuratedPrintings.score(card("{\"digital\":true}")), Integer.valueOf(-200));
        assertEquals(CuratedPrintings.score(card("{\"set_type\":\"funny\"}")), Integer.valueOf(-995));
        assertEquals(CuratedPrintings.score(card("{\"oversized\":true}")), Integer.valueOf(-995));
        assertEquals(CuratedPrintings.score(card("{\"promo\":true}")), Integer.valueOf(-195));
        // both UB signals stack, as in the reference
        assertEquals(CuratedPrintings.score(card("{\"promo_types\":[\"universesbeyond\"],\"security_stamp\":\"triangle\"}")), Integer.valueOf(-9995));
        // one special frame effect or several: -100 once
        assertEquals(CuratedPrintings.score(card("{\"frame_effects\":[\"showcase\",\"extendedart\"]}")), Integer.valueOf(-95));
        assertEquals(CuratedPrintings.score(card("{\"frame_effects\":[\"legendary\"]}")), Integer.valueOf(5));
        assertEquals(CuratedPrintings.score(card("{\"full_art\":true,\"border_color\":\"borderless\"}")), Integer.valueOf(-195));
        for (final String layout : CuratedPrintings.SKIP_LAYOUTS) {
            assertNull(CuratedPrintings.score(card("{\"layout\":\"" + layout + "\",\"lang\":\"en\"}")), layout);
        }
    }

    @Test
    public void englishBeatsEverythingElseAndUbOnlyWinsWhenAlone() throws Exception {
        final Map<String, String> m = pick(List.of(
                printing("Bolt", "ja", ",\"lang\":\"ja\",\"border_color\":\"black\",\"highres_image\":true"),
                printing("Bolt", "en-promo", ",\"lang\":\"en\",\"promo\":true"),
                printing("Cam", "ub-only", ",\"lang\":\"en\",\"promo_types\":[\"universesbeyond\"]"),
                printing("Hacker", "ub", ",\"lang\":\"en\",\"security_stamp\":\"triangle\",\"border_color\":\"black\""),
                printing("Hacker", "in-universe-showcase", ",\"lang\":\"en\",\"frame_effects\":[\"showcase\"]")));
        assertEquals(m.get("Bolt"), "en-promo");
        assertEquals(m.get("Cam"), "ub-only");
        assertEquals(m.get("Hacker"), "in-universe-showcase");
    }

    @Test
    public void tiesKeepTheFirstPrinting() throws Exception {
        final String clean = ",\"lang\":\"en\",\"border_color\":\"black\",\"highres_image\":true";
        final Map<String, String> m = pick(List.of(
                printing("Island", "first", clean),
                printing("Island", "second", clean),
                printing("Island", "worse", ",\"lang\":\"en\"")));
        assertEquals(m.get("Island"), "first");
    }

    @Test
    public void doubleFacedCardsUseTheFirstFaceAndIndexTheFrontName() throws Exception {
        final String dfc = "{\"name\":\"Delver of Secrets // Insectile Aberration\",\"layout\":\"transform\",\"lang\":\"en\","
                + "\"card_faces\":[{\"image_uris\":{\"normal\":\"https://cards.scryfall.io/normal/front/a/b/x.jpg\"}},"
                + "{\"image_uris\":{\"normal\":\"https://cards.scryfall.io/normal/back/a/b/x.jpg\"}}]}";
        final Map<String, String> m = pick(List.of(dfc));
        assertEquals(m.get("Delver of Secrets // Insectile Aberration"), "https://cards.scryfall.io/normal/front/a/b/x.jpg");
        assertEquals(m.get("Delver of Secrets"), "https://cards.scryfall.io/normal/front/a/b/x.jpg");
        assertFalse(m.containsKey("Insectile Aberration"));
    }

    @Test
    public void imagelessAndNonCardPrintingsAreSkipped() throws Exception {
        final Map<String, String> m = pick(List.of(
                "{\"name\":\"No Image\",\"layout\":\"normal\",\"lang\":\"en\"}",
                "{\"name\":\"Goblin\",\"layout\":\"token\",\"lang\":\"en\",\"image_uris\":{\"normal\":\"tok\"}}",
                "{\"name\":\"\",\"layout\":\"normal\",\"image_uris\":{\"normal\":\"blank\"}}"));
        assertEquals(m.size(), 0);
    }

    @Test
    public void jsonArrayAndJsonLinesReadTheSame() throws Exception {
        final List<String> ps = List.of(
                printing("A", "a1", ",\"lang\":\"en\""),
                printing("A", "a2", ",\"lang\":\"en\",\"border_color\":\"black\""),
                printing("B", "b1", ""));
        final CuratedPrintings arr = new CuratedPrintings();
        arr.readAll(new StringReader("[\n" + String.join(",\n", ps) + "\n]"));
        assertEquals(arr.result(), pick(ps));
        assertEquals(arr.result().get("A"), "a2");
        assertEquals(arr.printingsSeen(), 3);
    }

    // ---------------------------------------------------------------- newest-printing rules (Forge Table additions)

    private static final String CLEAN = ",\"lang\":\"en\",\"border_color\":\"black\",\"highres_image\":true,\"frame\":\"2015\"";

    @Test
    public void newestAdditionsScore() {
        // 1035 base + 50 modern frame
        assertEquals(CuratedPrintings.score(card("{\"lang\":\"en\",\"border_color\":\"black\",\"highres_image\":true,\"frame\":\"2015\"}")), Integer.valueOf(1085));
        assertEquals(CuratedPrintings.score(card("{\"frame\":\"future\"}")), Integer.valueOf(55));
        assertEquals(CuratedPrintings.score(card("{\"frame\":\"2003\"}")), Integer.valueOf(5));
        assertEquals(CuratedPrintings.score(card("{\"set_type\":\"box\"}")), Integer.valueOf(-145)); // Secret Lair
        assertEquals(CuratedPrintings.score(card("{\"image_status\":\"placeholder\"}")), Integer.valueOf(-995));
        assertEquals(CuratedPrintings.score(card("{\"image_status\":\"missing\"}")), Integer.valueOf(-995));
        assertEquals(CuratedPrintings.score(card("{\"image_status\":\"lowres\"}")), Integer.valueOf(-45));
        assertEquals(CuratedPrintings.score(card("{\"image_status\":\"highres_scan\"}")), Integer.valueOf(5));
        assertEquals(CuratedPrintings.score(card("{\"textless\":true}")), Integer.valueOf(-295));
        assertEquals(CuratedPrintings.score(card("{\"security_stamp\":\"acorn\"}")), Integer.valueOf(-995));
        assertEquals(CuratedPrintings.score(card("{\"promo_types\":[\"playtest\"]}")), Integer.valueOf(-995));
        // a preview: released after "today"
        assertEquals(CuratedPrintings.score(card("{\"released_at\":\"2026-11-09\"}"), "2026-10-11"), Integer.valueOf(-145));
        assertEquals(CuratedPrintings.score(card("{\"released_at\":\"2026-10-11\"}"), "2026-10-11"), Integer.valueOf(5));
    }

    @Test
    public void newestEquallyCleanPrintingWins() throws Exception {
        final Map<String, String> m = pick(List.of(
                printing("Bolt", "old", CLEAN + ",\"released_at\":\"1993-08-05\""),
                printing("Bolt", "newest", CLEAN + ",\"released_at\":\"2024-02-09\""),
                printing("Bolt", "middle", CLEAN + ",\"released_at\":\"2011-07-15\""),
                printing("Bolt", "same-day-later-in-file", CLEAN + ",\"released_at\":\"2024-02-09\"")));
        assertEquals(m.get("Bolt"), "newest"); // equal score and date: first seen stays
    }

    @Test
    public void cleanerBeatsNewer() throws Exception {
        final Map<String, String> m = pick(List.of(
                printing("Bolt", "plain-2019", CLEAN + ",\"released_at\":\"2019-01-01\""),
                printing("Bolt", "showcase-2025", CLEAN + ",\"released_at\":\"2025-01-01\",\"frame_effects\":[\"showcase\"]"),
                printing("Bolt", "promo-2025", CLEAN + ",\"released_at\":\"2025-02-01\",\"promo\":true"),
                printing("Bolt", "digital-2025", CLEAN + ",\"released_at\":\"2025-03-01\",\"digital\":true"),
                printing("Bolt", "lowres-2025", CLEAN + ",\"released_at\":\"2025-04-01\",\"image_status\":\"lowres\"")));
        assertEquals(m.get("Bolt"), "plain-2019");
    }

    @Test
    public void modernFrameBeatsAnOlderFrameEvenWhenOlder() throws Exception {
        final String oldFrame = ",\"lang\":\"en\",\"border_color\":\"black\",\"highres_image\":true,\"frame\":\"1997\"";
        final Map<String, String> m = pick(List.of(
                printing("Elf", "retro-2023", oldFrame + ",\"released_at\":\"2023-01-01\""),
                printing("Elf", "modern-2018", CLEAN + ",\"released_at\":\"2018-01-01\"")));
        assertEquals(m.get("Elf"), "modern-2018");
    }

    @Test
    public void aPreviewLosesToARealReleaseButIsUsedAlone() throws Exception {
        final CuratedPrintings p = new CuratedPrintings(LocalDate.of(2026, 10, 11));
        p.readAll(new StringReader(String.join("\n", List.of(
                printing("Soon", "spoiler", CLEAN + ",\"released_at\":\"2026-11-09\""),
                printing("Soon", "out", CLEAN + ",\"released_at\":\"2026-04-24\""),
                printing("OnlySpoiled", "spoiler", CLEAN + ",\"released_at\":\"2026-11-09\"")))));
        assertEquals(p.result().get("Soon"), "out");
        assertEquals(p.result().get("OnlySpoiled"), "spoiler");
    }

    /** Recorded Scryfall searches ({@code !"name" unique:prints}, 2026-10-11), trimmed to the fields the picker reads. */
    private static Map<String, String> fixturePicks() throws Exception {
        final CuratedPrintings p = new CuratedPrintings(LocalDate.of(2026, 10, 11));
        try (Reader in = new InputStreamReader(CuratedPrintingsTest.class.getResourceAsStream("/table/scryfall-prints.json"), StandardCharsets.UTF_8)) {
            final JsonObject all = JsonParser.parseReader(in).getAsJsonObject();
            all.entrySet().forEach(e -> e.getValue().getAsJsonArray().forEach(c -> p.accept(c.getAsJsonObject())));
        }
        return p.result();
    }

    /** "set/collector" of the fixture printing that owns this image. */
    private static String printingOf(final String name, final String url) throws Exception {
        try (Reader in = new InputStreamReader(CuratedPrintingsTest.class.getResourceAsStream("/table/scryfall-prints.json"), StandardCharsets.UTF_8)) {
            for (final var c : JsonParser.parseReader(in).getAsJsonObject().get(name).getAsJsonArray()) {
                if (c.toString().contains(url)) {
                    return c.getAsJsonObject().get("set").getAsString() + "/" + c.getAsJsonObject().get("collector_number").getAsString();
                }
            }
        }
        return null;
    }

    @Test
    public void recordedLightningBoltPicksTheNewestPlainPrinting() throws Exception {
        // Not the 2026-11 The List reprint (a preview on 2026-10-11), not Secret Lair / borderless / Universes Beyond /
        // promos: the Oct 2026 commander-deck printing in the current frame.
        final String url = fixturePicks().get("Lightning Bolt");
        assertEquals(printingOf("Lightning Bolt", url), "fdc/163");
    }

    @Test
    public void recordedSerraAngelPicksTheNewestPlainPrinting() throws Exception {
        final String url = fixturePicks().get("Serra Angel");
        assertEquals(printingOf("Serra Angel", url), "fdn/740");
    }

    @Test
    public void recordedDoubleFacedAndAdventureCardsKeepTheirFrontFace() throws Exception {
        final Map<String, String> m = fixturePicks();
        for (final String name : List.of("Delver of Secrets // Insectile Aberration", "Bonecrusher Giant // Stomp")) {
            final String front = name.substring(0, name.indexOf(" // "));
            assertEquals(m.get(front), m.get(name), name);
            assertTrue(m.get(name).startsWith("https://cards.scryfall.io/"), m.get(name));
        }
        // the transforming card's image is its front face; the service swaps /front/ for /back/ to get the other side
        assertTrue(m.get("Delver of Secrets").contains("/front/"), m.get("Delver of Secrets"));
    }

    @Test
    public void artistsFollowTheWinningImage() throws Exception {
        final CuratedPrintings p = new CuratedPrintings();
        p.readAll(new StringReader(String.join("\n", List.of(
                printing("Bolt", "u/bolt1", ",\"lang\":\"en\",\"artist\":\"Christopher Moeller\""),
                printing("Bolt", "u/bolt2", ",\"lang\":\"en\",\"released_at\":\"2020-01-01\",\"artist\":\"Zo\u00eb Robinson\""),
                printing("Nameless", "u/n", ""),
                // a transform card: no top-level image or artist, each face has its own
                "{\"name\":\"Front // Back\",\"layout\":\"transform\",\"card_faces\":["
                        + "{\"name\":\"Front\",\"artist\":\"A One\",\"image_uris\":{\"normal\":\"u/f\"}},"
                        + "{\"name\":\"Back\",\"artist\":\"B Two\",\"image_uris\":{\"normal\":\"u/b\"}}]}",
                // a split card shares one image: its second face has none of its own
                "{\"name\":\"Fire // Ice\",\"layout\":\"split\",\"artist\":\"Dave Kendall\",\"image_uris\":{\"normal\":\"u/fi\"},"
                        + "\"card_faces\":[{\"name\":\"Fire\",\"artist\":\"Dave Kendall\"},{\"name\":\"Ice\",\"artist\":\"Someone Else\"}]}"))));
        final Map<String, String> a = p.artists();
        assertEquals(a.get("Bolt"), "Zo\u00eb Robinson"); // the newest of two equal printings wins, and so does its artist
        assertFalse(a.containsKey("Nameless"));
        assertEquals(a.get("Front // Back"), "A One");
        assertEquals(a.get("Front"), "A One");
        assertEquals(a.get("Front // Back" + CuratedPrintings.BACK), "B Two");
        assertEquals(a.get("Fire"), "Dave Kendall");
        assertFalse(a.containsKey("Fire" + CuratedPrintings.BACK));
    }
}

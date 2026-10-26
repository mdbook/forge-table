package forge.bridge;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.StaticData;
import forge.card.CardRules;
import forge.card.CardType;
import forge.card.ColorSet;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckRecognizer;
import forge.deck.DeckRecognizer.Token;
import forge.deck.DeckRecognizer.TokenType;
import forge.deck.DeckSection;
import forge.deck.DeckUrlLoader;
import forge.deck.io.DeckSerializer;
import forge.item.PaperCard;

/**
 * {@code rpc decks.import}: a pasted decklist (Arena, MTGO, Moxfield and Forge {@code .dck} text) or a deck link
 * (Moxfield, Archidekt, TappedOut, MTGGoldfish), parsed with Forge's own {@link DeckRecognizer} and saved as a
 * constructed deck, so Classic sees it too. Unlike Classic's link import, unknown lines don't fail the import:
 * they're reported, and the rest of the deck is kept.
 */
final class DeckImport {
    /** "4 Lightning Bolt (M10) 146", "4 Lightning Bolt [M10] 146 *F*": retried without the printing hint. */
    private static final Pattern PRINTING_HINT = Pattern.compile("^(\\s*\\d+\\s*x?\\s+.+?)\\s+[\\[(][A-Za-z0-9_]{2,7}[\\])].*$");
    private static final int MAX_TEXT = 200_000;
    /** Unknown lines that get a "did you mean" (each one scans every card name). */
    private static final int MAX_FIXES = 10;
    private static final Pattern QUANTITY = Pattern.compile("^\\d{1,4}\\s*x?\\s+");

    record Result(Deck deck, List<String> unknown, List<String> warnings) { }

    private DeckImport() { }

    static Result parse(final String text, final String fallbackName) {
        if (text.length() > MAX_TEXT) {
            throw new IllegalArgumentException("That decklist is too long");
        }
        final DeckRecognizer recognizer = new DeckRecognizer();
        recognizer.forceImportBannedAndRestrictedCards();
        final String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n");
        // Retry lines the recognizer can't place without their printing hint, section by section.
        DeckSection section = null;
        for (int i = 0; i < lines.length; i++) {
            final Token t = recognizer.recognizeLine(lines[i], section);
            if (t == null) {
                continue;
            }
            if (t.getType() == TokenType.DECK_SECTION_NAME) {
                section = DeckSection.valueOf(t.getText());
            } else if (t.getType() == TokenType.UNKNOWN_CARD) {
                final String plain = PRINTING_HINT.matcher(lines[i]).replaceFirst("$1");
                if (!plain.equals(lines[i])) {
                    final Token retry = recognizer.recognizeLine(plain, section);
                    if (retry != null && retry.isCardToken()) {
                        lines[i] = plain;
                    }
                }
            }
        }
        final Deck deck = new Deck(fallbackName);
        final List<String> unknown = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
        for (final Token t : recognizer.parseCardList(lines)) {
            final TokenType type = t.getType();
            if (type == TokenType.UNKNOWN_CARD || type == TokenType.UNSUPPORTED_CARD) {
                unknown.add(t.getText());
            } else if (type == TokenType.UNSUPPORTED_DECK_SECTION || type == TokenType.WARNING_MESSAGE) {
                warnings.add(t.getText());
            } else if (type == TokenType.DECK_NAME) {
                if (!t.getText().isBlank()) {
                    deck.setName(t.getText().trim());
                }
            } else if (t.isCardTokenForDeck()) {
                deck.getOrCreate(t.getTokenSection()).add(t.getCard(), t.getQuantity());
            }
        }
        return new Result(deck, unknown, warnings);
    }

    static Result fromUrl(final String url) {
        final DeckUrlLoader.FetchedDeck fetched;
        try {
            fetched = DeckUrlLoader.fetch(url);
        } catch (final IOException e) {
            throw new IllegalArgumentException(e.getMessage() == null ? "Couldn't load that deck link" : e.getMessage());
        }
        final Result r = parse(fetched.importText(), fetched.name());
        r.deck().setName(fetched.name());
        r.deck().setSourceUrl(fetched.sourceUrl());
        return r;
    }

    /**
     * Run the import. {@code exists} says whether a deck file name is taken in any deck folder; the saved deck gets
     * the first free one ("Name", "Name (2)", …), which is also how {@code decks.list} will name it.
     */
    static JsonObject run(final JsonObject params, final File saveDir, final Predicate<String> exists) {
        final String url = str(params, "url");
        final String text = str(params, "text");
        final String name = str(params, "name");
        final boolean dryRun = params.has("dryRun") && params.get("dryRun").getAsBoolean();
        if (url == null && text == null) {
            throw new IllegalArgumentException("Paste a decklist or a deck link first");
        }
        final Result r = url != null ? fromUrl(url) : parse(text, "Imported deck");
        final Deck deck = r.deck();
        if (name != null) {
            deck.setName(name.trim());
        }
        final int main = deck.getMain().countAll();
        final int side = deck.has(DeckSection.Sideboard) ? deck.get(DeckSection.Sideboard).countAll() : 0;
        final int commander = deck.has(DeckSection.Commander) ? deck.get(DeckSection.Commander).countAll() : 0;
        if (main + commander == 0) {
            throw new IllegalArgumentException(r.unknown().isEmpty() ? "No cards found in that list"
                    : "None of those cards are known to Forge (first unknown: " + r.unknown().get(0) + ")");
        }
        String fileName = deck.getBestFileName();
        if (fileName.startsWith(".") || fileName.startsWith("-")) {
            // Such a file would be hidden, or refused by name in router games (--names-only): don't save it at all.
            throw new IllegalArgumentException("A deck name can't start with '.' or '-'");
        }
        for (int n = 2; exists.test(fileName); n++) {
            fileName = deck.getBestFileName() + " (" + n + ")";
        }
        if (!fileName.equals(deck.getBestFileName())) {
            deck.setName(fileName);
        }
        if (!dryRun) {
            saveDir.mkdirs();
            DeckSerializer.writeDeck(deck, new File(saveDir, fileName + ".dck"));
            BridgeLog.info("Imported deck \"" + fileName + "\": " + main + " main, " + side + " side, " + r.unknown().size() + " unknown");
        }
        final JsonObject res = new JsonObject();
        res.addProperty("name", fileName);
        res.addProperty("saved", !dryRun);
        res.addProperty("main", main);
        res.addProperty("side", side);
        if (commander > 0) {
            res.addProperty("commander", commander);
        }
        res.addProperty("recognized", main + side + commander);
        res.add("unknown", toArray(r.unknown()));
        res.add("warnings", toArray(r.warnings()));
        res.add("cards", cards(deck));
        final JsonObject fixes = fixes(r.unknown());
        if (fixes.size() > 0) {
            res.add("fixes", fixes);
        }
        if (commander > 0) {
            final PaperCard lead = deck.get(DeckSection.Commander).get(0);
            res.addProperty("identity", wubrg(lead.getRules().getColorIdentity()));
            final String problem = Formats.problem("brawl", deck);
            if (problem != null) {
                // Formats.problem starts with the deck's name; the preview already shows it.
                res.addProperty("brawlProblem", problem.startsWith(deck.getName() + " ")
                        ? problem.substring(deck.getName().length() + 1) : problem);
            }
        }
        return res;
    }

    /** Every recognized card for the preview: {@code {n, name, section, type, cmc}}, section main / side / commander. */
    static JsonArray cards(final Deck deck) {
        final JsonArray out = new JsonArray();
        for (final Map.Entry<DeckSection, CardPool> sec : deck) {
            final String section = switch (sec.getKey()) {
                case Main -> "main";
                case Sideboard -> "side";
                case Commander -> "commander";
                default -> null;
            };
            if (section == null) {
                continue;
            }
            for (final Map.Entry<PaperCard, Integer> e : sec.getValue()) {
                final CardRules rules = e.getKey().getRules();
                final JsonObject c = new JsonObject();
                c.addProperty("n", e.getValue());
                c.addProperty("name", e.getKey().getName());
                c.addProperty("section", section);
                c.addProperty("type", bucket(rules.getType()));
                c.addProperty("cmc", rules.getManaCost().getCMC());
                out.add(c);
            }
        }
        return out;
    }

    /** The preview's type group: the first that applies, in the order deck lists use. */
    static String bucket(final CardType t) {
        if (t.isCreature()) {
            return "Creature";
        }
        if (t.isPlaneswalker()) {
            return "Planeswalker";
        }
        if (t.isBattle()) {
            return "Battle";
        }
        if (t.isInstant()) {
            return "Instant";
        }
        if (t.isSorcery()) {
            return "Sorcery";
        }
        if (t.isLand()) {
            return "Land";
        }
        if (t.isArtifact()) {
            return "Artifact";
        }
        if (t.isEnchantment()) {
            return "Enchantment";
        }
        return "Other";
    }

    static String wubrg(final ColorSet c) {
        return (c.hasWhite() ? "W" : "") + (c.hasBlue() ? "U" : "") + (c.hasBlack() ? "B" : "") + (c.hasRed() ? "R" : "")
                + (c.hasGreen() ? "G" : "");
    }

    /** Unknown name → the closest real card name, for the first {@link #MAX_FIXES} unknowns that have one. */
    static JsonObject fixes(final List<String> unknown) {
        final JsonObject out = new JsonObject();
        if (unknown.isEmpty()) {
            return out;
        }
        final List<String> names = new ArrayList<>();
        for (final PaperCard pc : StaticData.instance().getCommonCards().getUniqueCards()) {
            names.add(pc.getName());
        }
        for (final String u : unknown.subList(0, Math.min(unknown.size(), MAX_FIXES))) {
            final String fix = closest(u, names);
            if (fix != null) {
                out.addProperty(u, fix);
            }
        }
        return out;
    }

    /**
     * The name nearest {@code typed} by edit distance (case-insensitive), if it's near enough to be a typo: at most a
     * quarter of the typed length, and at least 1. The first listed wins a tie. Null for none.
     */
    static String closest(final String typed, final Iterable<String> names) {
        // An unknown line may still carry its quantity ("1 Lighting Bolt").
        final String a = QUANTITY.matcher(typed.toLowerCase(Locale.ROOT).strip()).replaceFirst("");
        final int limit = Math.max(1, a.length() / 4);
        String best = null;
        int bestD = limit + 1;
        for (final String n : names) {
            if (Math.abs(n.length() - a.length()) >= bestD) {
                continue;
            }
            final int d = distance(a, n.toLowerCase(Locale.ROOT), bestD);
            if (d < bestD) {
                bestD = d;
                best = n;
            }
        }
        return best;
    }

    /** Levenshtein distance, or {@code cap} once every path is at least that long. */
    static int distance(final String a, final String b, final int cap) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            int rowMin = cur[0];
            for (int j = 1; j <= b.length(); j++) {
                final int sub = prev[j - 1] + (a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1);
                cur[j] = Math.min(sub, Math.min(prev[j] + 1, cur[j - 1] + 1));
                rowMin = Math.min(rowMin, cur[j]);
            }
            if (rowMin >= cap) {
                return cap;
            }
            final int[] t = prev;
            prev = cur;
            cur = t;
        }
        return prev[b.length()];
    }

    private static JsonArray toArray(final List<String> l) {
        final JsonArray a = new JsonArray();
        l.forEach(a::add);
        return a;
    }

    private static String str(final JsonObject o, final String k) {
        if (!o.has(k) || o.get(k).isJsonNull()) {
            return null;
        }
        final String s = o.get(k).getAsString();
        return s.isBlank() ? null : s;
    }
}

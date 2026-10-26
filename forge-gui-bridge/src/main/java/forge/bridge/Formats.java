package forge.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import forge.deck.Deck;
import forge.deck.DeckFormat;
import forge.deck.DeckSection;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgeConstants;
import forge.model.FModel;

/**
 * The formats a Forge Table game is played in. No format (or "constructed") is the game as it always was: plain
 * Constructed, no deck checked. "standard" is the same game with the deck checked as Forge desktop checks Standard
 * (60 cards, four copies, Forge's Sanctioned/Standard.txt sets and banlist). "brawl" is MTG Arena's Competitive Brawl, played with Forge's Brawl variant (command
 * zone, commander tax, 25 life for two, the first mulligan free, no commander damage) and checked as Arena checks it.
 */
public final class Formats {
    public static final String BRAWL = "brawl";
    public static final String STANDARD = "standard";

    /**
     * Arena's Competitive Brawl banlist: banned in the deck and as commander. Source: the Banned and Restricted list,
     * https://magic.wizards.com/en/banned-restricted-list (read 2026-10-11, unchanged since the format's launch on
     * 2026-06-08). Not the casual Brawl queue's list.
     */
    static final List<String> COMPETITIVE_BRAWL_BANNED = List.of(
            "Ajani, Nacatl Pariah", "Lutri, the Spellchaser", "Nadu, Winged Wisdom", "Oko, Thief of Crowns",
            "Old Stickfingers", "Ragavan, Nimble Pilferer", "Rusko, Clockmaker", "Tajic, Legion's Valor",
            "Tamiyo, Inquisitive Student", "Wrenn and Six");

    private static Set<String> arenaCards;

    private Formats() {
    }

    /** {@link #BRAWL}, {@link #STANDARD}, or null for Constructed (absent, blank or "constructed"); anything else is refused. */
    public static String parse(final String s) {
        if (s == null || s.isBlank() || s.equalsIgnoreCase("constructed")) {
            return null;
        }
        if (s.equalsIgnoreCase(BRAWL)) {
            return BRAWL;
        }
        if (s.equalsIgnoreCase(STANDARD)) {
            return STANDARD;
        }
        throw new IllegalArgumentException("The format is constructed, standard or brawl.");
    }

    /** Whether {@code format} plays Forge's Brawl variant (command zone, 25 life, the shared Brawl decks). */
    public static boolean isBrawl(final String format) {
        return BRAWL.equals(format);
    }

    /**
     * Arena's Brawl card pool, by name: res/forge-table/arena-brawl-pool.txt, made from Scryfall's "brawl" legality
     * (forge-gui-bridge/deploy/arena-brawl-pool.py). Forge's own Historic list misses many Arena cards (Birds of
     * Paradise, the fetch lands, Marvel and Final Fantasy commanders…), so it can't be the pool. No rebalanced ("A-")
     * names: Arena reverted every rebalanced card to its original printing in all formats on 2026-09-22 (State of the
     * Formats, 2026-09-11); digital-only Alchemy cards stay, and are in the list.
     */
    static synchronized Set<String> arenaCards() {
        if (arenaCards == null) {
            final Path file = Path.of(ForgeConstants.RES_DIR, "forge-table", "arena-brawl-pool.txt");
            try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
                arenaCards = lines.filter(l -> !l.isBlank() && !l.startsWith("#")).collect(Collectors.toUnmodifiableSet());
            } catch (final IOException e) {
                throw new IllegalStateException("Arena card list missing: " + file, e);
            }
        }
        return arenaCards;
    }

    /** "contains the following illegal cards: A, B" for cards off Arena or on Competitive Brawl's banlist; null if none. */
    private static String poolProblem(final Deck deck) {
        final Set<String> pool = arenaCards();
        final Set<String> bad = new TreeSet<>();
        for (final Map.Entry<PaperCard, Integer> e : deck.getAllCardsInASinglePool()) {
            final String name = e.getKey().getName();
            if (!pool.contains(name) || COMPETITIVE_BRAWL_BANNED.contains(name)) {
                bad.add(name);
            }
        }
        return bad.isEmpty() ? null : "contains the following illegal cards: " + String.join(", ", bad);
    }

    /**
     * The sideboard (at most one card, {@link DeckFormat#CompetitiveBrawl}) is a companion's slot. Arena lets a companion
     * into Brawl (its banlist holds Lutri, a companion every singleton deck satisfies; no page states the rule outright).
     * Yorion never qualifies: a Brawl deck is exactly 100 cards, but Forge measures its "twenty more than the minimum"
     * against Constructed's 60 (Player's companion check reads the game type, Constructed here), so it would let it in.
     */
    private static String companionProblem(final Deck deck) {
        if (!deck.has(DeckSection.Sideboard)) {
            return null;
        }
        for (final PaperCard c : deck.get(DeckSection.Sideboard).toFlatList()) {
            if (!c.getRules().hasStartOfKeyword("Companion")) {
                return "has a sideboard card that isn't a companion: " + c.getName();
            }
            if (c.getRules().hasStartOfKeyword("Companion:Special:DeckSizePlus20")) {
                return "can't have " + c.getName() + " as companion (a Brawl deck is exactly 100 cards)";
            }
        }
        return null;
    }

    /**
     * Why {@code deck} can't be played in {@code format}, as "<deck> has …"; null when it can (always, for Constructed).
     * Standard: size and copies, then sets and bans. Brawl: shape first (100 cards with the commander, singleton, colour identity, a legal commander), then the companion,
     * then the card pool.
     */
    public static String problem(final String format, final Deck deck) {
        if (format == null) {
            return null;
        }
        String p;
        if (STANDARD.equals(format)) {
            // Forge's Constructed check reads no Commander section: a Brawl deck would pass on its 99.
            p = deck.has(DeckSection.Commander) && !deck.get(DeckSection.Commander).isEmpty() ? "has a commander (Standard has none)"
                    : DeckFormat.Constructed.getDeckConformanceProblem(deck);
            if (p == null) {
                p = FModel.getFormats().getStandard().getDeckConformanceProblem(deck);
            }
        } else {
            p = DeckFormat.CompetitiveBrawl.getDeckConformanceProblem(deck);
            if (p == null) {
                p = companionProblem(deck);
            }
            if (p == null) {
                p = poolProblem(deck);
            }
        }
        // Forge lists cards one per line ("contains the following illegal cards:\n\nA\nB"): one line here.
        return p == null ? null : deck.getName() + " " + p.trim().replaceFirst(":\\s+", ": ").replaceAll("\\s*\\n\\s*", ", ");
    }
}

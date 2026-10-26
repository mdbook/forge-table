package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.ConcurrentModificationException;
import java.util.HashSet;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import org.testng.annotations.Test;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.game.Game;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.HostedMatch;
import forge.localinstance.properties.ForgeConstants;

/**
 * A game between two people on one sidecar, each seat on its own socket with the hello the
 * router would stamp: the start-screen lobby, per-seat deck lists, that neither seat's stream ever names or identifies
 * the other's hidden cards, presence and Claim win, reconnecting, and conceding.
 */
public class PvpTest {

    private static final String SEAT1_DECK = "seat1-only";

    /** A pvp sidecar: seat 0 has the shared decks (and the user's), seat 1 the shared ones plus the deck it "joined" with. */
    private static Main.Running boot(final long claimAfterMs) throws Exception {
        return boot(claimAfterMs, null, false);
    }

    /** {@link #boot(long)}, saving to {@code checkpoint} (when not null), or picking up the game saved there. */
    private static Main.Running boot(final long claimAfterMs, final Path checkpoint, final boolean resume) throws Exception {
        final BridgeApp.Options o = TableTestEnv.options();
        o.checkpoint = checkpoint == null ? null : checkpoint.toString();
        o.resume = resume;
        o.pvp = true;
        o.oppDeck = null;
        o.claimAfterMs = claimAfterMs;
        final Path seat1 = Files.createTempDirectory("ft-seat1");
        Files.copy(TableTestEnv.decksDir().toPath().resolve("mono-blue-faeries.dck"), seat1.resolve(SEAT1_DECK + ".dck"));
        o.seat1Decks = seat1.toString();
        return Main.boot(o);
    }

    private static JsonObject deck(final String name) {
        final JsonObject p = new JsonObject();
        p.addProperty("deck", name);
        return p;
    }

    private static List<String> strings(final JsonElement arr) {
        final List<String> out = new ArrayList<>();
        arr.getAsJsonArray().forEach(e -> out.add(e.getAsString()));
        return out;
    }

    /**
     * A Brawl game between two people is Brawl whatever a seat's match.start says: {format: constructed} doesn't
     * let a 60-card deck in, an illegal deck is refused at ready, and both start at 25. A concede at once ends it cleanly.
     */
    @Test
    public void aBrawlGameStaysBrawl() throws Exception {
        final BridgeApp.Options o = TableTestEnv.options();
        o.pvp = true;
        o.oppDeck = null;
        o.format = Formats.BRAWL;
        final Path brawl = Path.of(o.assetsDir, "res", "forge-table", "brawl-decks");
        final Path seat1 = Files.createTempDirectory("ft-seat1");
        Files.copy(brawl.resolve("Elenda's Endless Vigil.dck"), seat1.resolve(SEAT1_DECK + ".dck"));
        o.seat1Decks = seat1.toString();
        final Main.Running r = Main.boot(o);
        try (PvpClient a = PvpClient.connect(r, 0, "alice"); PvpClient b = PvpClient.connect(r, 1, "bob")) {
            final JsonObject wa = a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            assertEquals(wa.get("format").getAsString(), Formats.BRAWL);
            final JsonObject constructed = deck("mono-red-madness");
            constructed.addProperty("format", "constructed");
            assertFalse(a.rpc("match.start", constructed).get("ok").getAsBoolean(), "a 60-card deck in a Brawl game");
            final JsonObject banned = deck("Clockmaker on a Budget");
            assertFalse(a.rpc("match.start", banned).get("ok").getAsBoolean(), "Rusko is banned");
            final JsonObject legal = deck("Halana & Alena - Counter the Stampede");
            legal.addProperty("format", "constructed");
            assertTrue(a.rpc("match.start", legal).get("ok").getAsBoolean());
            assertTrue(b.rpc("match.start", deck(SEAT1_DECK)).get("ok").getAsBoolean());
            a.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
            waitFor(() -> player(r, "alice") != null && player(r, "bob") != null, 60, "no players");
            assertEquals(player(r, "alice").getStartingLife(), 25);
            assertEquals(player(r, "bob").getStartingLife(), 25);
            // The lobby's game card: seats in registration order, each with its life, deck and commander.
            final JsonObject t = r.app.table();
            assertEquals(t.getAsJsonArray("seats").size(), 2);
            for (int seat = 0; seat < 2; seat++) {
                final Player p = player(r, seat == 0 ? "alice" : "bob");
                final JsonObject s = t.getAsJsonArray("seats").get(seat).getAsJsonObject();
                assertEquals(s.get("life").getAsInt(), p.getLife());
                assertEquals(s.get("deck").getAsString(), p.getRegisteredPlayer().getDeck().getName());
                assertEquals(s.get("key").getAsString(), p.getRegisteredPlayer().getDeck().getCommanders().get(0).getName(), "a commander is the key");
            }
            // Straight after the snapshot, while Forge may still be dealing: that concede used to crash the game.
            a.act("concede");
            b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
        } finally {
            r.stop();
        }
    }

    /** Both seats pick a deck; returns once both have their first snapshot. */
    private static void start(final PvpClient a, final PvpClient b) throws Exception {
        assertTrue(a.rpc("match.start", deck("mono-red-madness")).get("ok").getAsBoolean());
        assertTrue(b.rpc("match.start", deck(SEAT1_DECK)).get("ok").getAsBoolean());
        a.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
        b.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
    }

    /** Wait until the game is past its first turn (dealt, mulligans done). */
    private static void awaitTurn(final Main.Running r, final int turn) throws Exception {
        waitFor(() -> {
            final Player p = player(r, "alice");
            return p != null && p.getGame().getPhaseHandler().getTurn() >= turn;
        }, 150, "the game never reached turn " + turn);
    }

    private static Player player(final Main.Running r, final String name) {
        final HostedMatch hm = r.app.match();
        final Game g = hm == null ? null : hm.getGame();
        if (g == null) {
            return null;
        }
        for (final Player p : g.getPlayers()) {
            if (name.equals(p.getName())) {
                return p;
            }
        }
        return null;
    }

    /** The cards in a zone, copied while the game thread may be moving them. */
    private static List<Card> cards(final Player p, final ZoneType z) {
        for (int i = 0; i < 50; i++) {
            try {
                return new ArrayList<>(p.getCardsIn(z));
            } catch (final ConcurrentModificationException | NoSuchElementException | IndexOutOfBoundsException e) {
                Thread.onSpinWait();
            }
        }
        throw new IllegalStateException("zone kept changing");
    }

    /**
     * Checks every text frame one seat gets against the engine's state at that moment: no card in the other player's
     * hand or library may appear by its id ({@code "c<id>"}) or by its name, unless that card (or one of that name) has
     * been public. Both players only ever pass, keep and discard, so a hidden card only ever becomes public by being
     * discarded, and stays public.
     */
    private static final class LeakCheck {
        final Main.Running r;
        final String opponent;
        final List<String> forbidden;
        final Set<Integer> publicIds = Collections.synchronizedSet(new HashSet<>());
        final Set<String> publicNames = Collections.synchronizedSet(new HashSet<>());
        final List<String> leaks = Collections.synchronizedList(new ArrayList<>());
        volatile boolean on = true;
        volatile int checked;
        volatile int maxHidden;

        LeakCheck(final Main.Running r, final String opponent, final String... forbidden) {
            this.r = r;
            this.opponent = opponent;
            this.forbidden = List.of(forbidden);
        }

        void check(final String text) {
            if (!on) {
                return;
            }
            for (final String f : forbidden) {
                if (text.contains(f)) {
                    leaks.add("'" + f + "' in " + text.substring(0, Math.min(300, text.length())));
                }
            }
            final Player opp = player(r, opponent);
            if (opp == null) {
                return;
            }
            for (final Player p : opp.getGame().getPlayers()) {
                for (final ZoneType z : new ZoneType[] {ZoneType.Graveyard, ZoneType.Exile, ZoneType.Battlefield, ZoneType.Stack}) {
                    for (final Card c : cards(p, z)) {
                        publicIds.add(c.getId());
                        publicNames.add(c.getName());
                    }
                }
            }
            final List<Card> hidden = cards(opp, ZoneType.Hand);
            hidden.addAll(cards(opp, ZoneType.Library));
            maxHidden = Math.max(maxHidden, hidden.size());
            for (final Card c : hidden) {
                if (!publicIds.contains(c.getId()) && text.contains("\"c" + c.getId() + "\"")) {
                    leaks.add("hidden card id c" + c.getId() + " (" + c.getName() + ") in " + text.substring(0, Math.min(300, text.length())));
                }
                if (!publicNames.contains(c.getName()) && text.contains(c.getName())) {
                    leaks.add("hidden card name " + c.getName() + " in " + text.substring(0, Math.min(300, text.length())));
                }
            }
            checked++;
        }
    }

    /**
     * Start screen and hidden information: each seat lists only its own decks, gets its own defaults, sees the other
     * one's name and readiness; then a game of passing and discarding where neither stream ever carries the other's hand
     * or library, nor the other's deck. Conceding ends it for both, with the right winner.
     */
    @Test
    public void lobbyDecksAndHiddenInformation() throws Exception {
        final Main.Running r = boot(120_000);
        final Path mine = Path.of(ForgeConstants.DECK_CONSTRUCTED_DIR, "pvp-seat0-only.dck");
        Files.createDirectories(mine.getParent());
        Files.copy(TableTestEnv.decksDir().toPath().resolve("mono-red-rally.dck"), mine, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        final LeakCheck toAlice = new LeakCheck(r, "bob", "Mono-Blue Faeries", SEAT1_DECK);
        final LeakCheck toBob = new LeakCheck(r, "alice", "Mono Red Madness", "pvp-seat0-only");
        try (PvpClient a = PvpClient.connect(r, 0, "alice")) {
            a.onText(toAlice::check);
            final JsonObject wa = a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            assertEquals(wa.getAsJsonObject("defaults").get("deck").getAsString(), "mono-red-madness");
            assertFalse(wa.getAsJsonObject("defaults").has("oppDeck"));
            assertEquals(wa.getAsJsonObject("pvp").get("seat").getAsInt(), 0);
            assertEquals(wa.getAsJsonObject("pvp").get("you").getAsString(), "alice");
            try (PvpClient b = PvpClient.connect(r, 1, "bob")) {
                b.onText(toBob::check);
                final JsonObject wb = b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
                assertEquals(wb.getAsJsonObject("defaults").get("deck").getAsString(), SEAT1_DECK, "seat 1 preselects the deck it joined with");
                assertEquals(wb.getAsJsonObject("pvp").get("seat").getAsInt(), 1);
                assertEquals(wb.getAsJsonObject("pvp").get("opponent").getAsString(), "alice");
                a.await(0, m -> PvpClient.is(m, "pvp", "lobby") && "bob".equals(str(m, "opponent")), 30);
                a.await(0, m -> PvpClient.is(m, "pvp", "presence") && m.get("opponentConnected").getAsBoolean(), 30);

                // Deck lists are per seat: seat 1 never sees seat 0's own decks, nor seat 0 the deck seat 1 brought.
                final List<String> da = strings(a.rpc("decks.list", null).get("value"));
                final List<String> db = strings(b.rpc("decks.list", null).get("value"));
                assertTrue(da.contains("pvp-seat0-only") && da.contains("mono-red-madness"), "seat 0: " + da);
                assertFalse(da.contains(SEAT1_DECK), "seat 0: " + da);
                assertTrue(db.contains(SEAT1_DECK) && db.contains("mono-red-madness"), "seat 1 has the shared decks too: " + db);
                assertFalse(db.contains("pvp-seat0-only"), "seat 1: " + db);
                final JsonObject imp = new JsonObject();
                imp.addProperty("text", "4 Island");
                assertFalse(b.rpc("decks.import", imp).get("ok").getAsBoolean(), "seat 1 can't import into seat 0's folder");
                final JsonObject vsAi = deck("mono-red-madness");
                vsAi.addProperty("oppDeck", "mono-blue-faeries");
                assertFalse(a.rpc("match.start", vsAi).get("ok").getAsBoolean(), "no opponent deck against a person");
                final JsonObject theirs = deck("pvp-seat0-only");
                assertFalse(b.rpc("match.start", theirs).get("ok").getAsBoolean(), "seat 1 can't play seat 0's deck");

                // Ready: seat 1 is told seat 0 is ready, then both start; the result names only your own deck.
                final int bm = b.mark();
                final JsonObject ra = a.rpc("match.start", deck("mono-red-madness"));
                assertEquals(ra.getAsJsonObject("value").keySet(), Set.of("deck"));
                b.await(bm, m -> PvpClient.is(m, "pvp", "lobby") && m.get("oppReady").getAsBoolean() && !m.get("youReady").getAsBoolean(), 30);
                b.rpc("match.start", deck(SEAT1_DECK));
                final JsonObject sa = a.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
                final JsonObject sb = b.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
                assertNotEquals(sa.get("viewer").getAsString(), sb.get("viewer").getAsString());
                final Set<String> names = new HashSet<>();
                sa.getAsJsonObject("players").entrySet().forEach(e -> names.add(e.getValue().getAsJsonObject().get("name").getAsString()));
                assertEquals(names, Set.of("alice", "bob"), "player names on the wire are the members' names");
                assertTrue(sa.getAsJsonObject("presence").get("opponentConnected").getAsBoolean());

                // Pass and discard for a few turns; every frame is checked as it arrives.
                waitFor(() -> {
                    final Player p = player(r, "alice");
                    return p != null && p.getGame().getPhaseHandler().getTurn() >= 7;
                }, 150, "the game never reached turn 7");
                toAlice.on = false;
                toBob.on = false;
                assertTrue(a.any(m -> PvpClient.is(m, "prompt", "priority")) || b.any(m -> PvpClient.is(m, "prompt", "priority"))
                        || a.any(m -> PvpClient.is(m, "prompt", "mulligan")), "no seat was ever prompted");

                a.act("concede");
                final JsonObject oa = a.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
                final JsonObject ob = b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
                assertFalse(oa.get("won").getAsBoolean(), "the conceding seat won: " + oa);
                assertTrue(ob.get("won").getAsBoolean(), "the other seat didn't win: " + ob);
                assertEquals(ob.get("winner").getAsString(), "bob");
            }
        } finally {
            Files.deleteIfExists(mine);
            r.stop();
        }
        System.out.println("[PvpTest] frames checked: alice " + toAlice.checked + ", bob " + toBob.checked
                + "; hidden cards per side up to " + toAlice.maxHidden + "/" + toBob.maxHidden);
        assertTrue(toAlice.checked > 20 && toBob.checked > 20, "too few frames checked");
        assertTrue(toAlice.maxHidden >= 40 && toBob.maxHidden >= 40, "the hidden zones were never seen");
        assertTrue(toAlice.leaks.isEmpty(), "seat 0 saw seat 1's hidden cards:\n" + String.join("\n", toAlice.leaks));
        assertTrue(toBob.leaks.isEmpty(), "seat 1 saw seat 0's hidden cards:\n" + String.join("\n", toBob.leaks));
    }

    /**
     * Presence and Claim win: the other seat is told when one leaves, with when Claim win unlocks; claiming early
     * is refused; a seat that comes back gets a full snapshot of its own; once it has been away long enough the claim
     * ends the game, and the absent seat finds the game over (lost) when it returns.
     */
    @Test
    public void presenceReconnectAndClaimWin() throws Exception {
        final Main.Running r = boot(2_000);
        try (PvpClient a = PvpClient.connect(r, 0, "alice")) {
            PvpClient b = PvpClient.connect(r, 1, "bob");
            a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            start(a, b);
            awaitTurn(r, 2);

            int am = a.mark();
            b.close();
            final JsonObject away = a.await(am, m -> PvpClient.is(m, "pvp", "presence") && !m.get("opponentConnected").getAsBoolean(), 30);
            assertEquals(away.get("claimableAt").getAsLong(), away.get("since").getAsLong() + 2_000);
            am = a.mark();
            a.act("claimWin");
            a.await(am, m -> PvpClient.is(m, "notice", "toast") && "error".equals(str(m, "level")), 30);
            assertFalse(a.any(m -> PvpClient.is(m, "gameOver", null)), "an early claim ended the game");

            // Back: a full snapshot from its own seat, with its own prompt and asks only.
            final LeakCheck back = new LeakCheck(r, "alice", "Mono Red Madness");
            am = a.mark();
            b = PvpClient.connect(r, 1, "bob");
            b.onText(back::check);
            final JsonObject w = b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            assertTrue(w.get("match").getAsBoolean());
            assertFalse(w.has("ai"), "no AI between people");
            final JsonObject snap = b.await(0, m -> PvpClient.is(m, "snapshot", null), 30);
            final String bobViewer = snap.get("viewer").getAsString();
            assertTrue(snap.getAsJsonObject("presence").get("opponentConnected").getAsBoolean());
            if (snap.has("prompt") && snap.getAsJsonObject("prompt").has("seat")) {
                assertEquals(snap.getAsJsonObject("prompt").get("seat").getAsString(), bobViewer, "someone else's prompt");
            }
            final JsonObject here = a.await(am, m -> PvpClient.is(m, "pvp", "presence") && m.get("opponentConnected").getAsBoolean(), 30);
            assertFalse(here.has("claimableAt"));
            assertTrue(back.leaks.isEmpty(), "the reconnect snapshot carried seat 0's hidden cards:\n" + String.join("\n", back.leaks));
            back.on = false;

            // Gone for good: after the wait the claim ends the game for both.
            am = a.mark();
            b.close();
            a.await(am, m -> PvpClient.is(m, "pvp", "presence") && !m.get("opponentConnected").getAsBoolean(), 30);
            Thread.sleep(2_300);
            a.act("claimWin");
            final JsonObject over = a.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            assertTrue(over.get("won").getAsBoolean(), "the claim didn't win: " + over);
            try (PvpClient again = PvpClient.connect(r, 1, "bob")) {
                // In its snapshot, or right after it when the game ended a moment ago.
                final JsonObject s = again.await(0, m -> PvpClient.is(m, "snapshot", null) && m.has("gameOver") || PvpClient.is(m, "gameOver", null), 30);
                assertFalse((s.has("gameOver") ? s.getAsJsonObject("gameOver") : s).get("won").getAsBoolean());
            }
        } finally {
            r.stop();
        }
    }

    /**
     * Only the router (holding the token) says which seat a socket is: a pvp hello without a seat is refused. The router's
     * concede endpoint needs the token and a POST; it makes that seat concede, and both get the game over. No next game
     * (CONTINUE): a pvp game is a single game.
     */
    @Test
    public void seatsComeFromTheRouterAndTheRouterCanConcede() throws Exception {
        final Main.Running r = boot(120_000);
        final HttpClient http = HttpClient.newHttpClient();
        final String base = "http://127.0.0.1:" + r.port() + "/seat/concede";
        try (PvpClient a = PvpClient.connect(r, 0, "alice"); PvpClient b = PvpClient.connect(r, 1, "bob");
                PvpClient nobody = PvpClient.connect(r, null, "mallory")) {
            waitFor(() -> nobody.closeCode == 4001, 30, "a hello without a seat was accepted");
            a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            final HttpResponse<String> early = http.send(HttpRequest.newBuilder(URI.create(base + "?seat=1")).header("Cookie", "ft=" + r.token)
                    .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(early.body(), "{\"conceded\":false}", "nothing to concede before the match");
            start(a, b);
            awaitTurn(r, 2);
            assertEquals(http.send(HttpRequest.newBuilder(URI.create(base + "?seat=1")).POST(HttpRequest.BodyPublishers.noBody()).build(),
                    HttpResponse.BodyHandlers.ofString()).statusCode(), 401);
            assertEquals(http.send(HttpRequest.newBuilder(URI.create(base + "?seat=1")).header("Cookie", "ft=" + r.token).GET().build(),
                    HttpResponse.BodyHandlers.ofString()).statusCode(), 405);
            assertEquals(http.send(HttpRequest.newBuilder(URI.create(base + "?seat=2")).header("Cookie", "ft=" + r.token)
                    .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString()).statusCode(), 400);
            final HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(base + "?seat=1")).header("Cookie", "ft=" + r.token)
                    .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(res.body(), "{\"conceded\":true}");
            final JsonObject ob = b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            final JsonObject oa = a.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            assertFalse(ob.get("won").getAsBoolean());
            assertTrue(oa.get("won").getAsBoolean());
            assertEquals(oa.get("winner").getAsString(), "alice");

            final int am = a.mark();
            final JsonObject again = new JsonObject();
            again.addProperty("t", "act");
            again.addProperty("kind", "nextGame");
            again.addProperty("decision", "CONTINUE");
            a.send(again);
            a.await(am, m -> PvpClient.is(m, "notice", "toast") && str(m, "message").contains("single game"), 30);
        } finally {
            r.stop();
        }
    }

    /**
     * A saved game between two people picks up only once both are back: the first one back waits on a "resuming" start
     * screen (no deck to pick), then both get the board from the save, names and decks as they were.
     */
    @Test
    public void aSavedGameWaitsForBothThenGoesOn() throws Exception {
        final Path saved = Files.createTempDirectory("ft-pvp-saved").resolve("checkpoint.json");
        final Path again = Files.createTempDirectory("ft-pvp-again").resolve("checkpoint.json");
        final Main.Running r = boot(120_000, saved, false);
        try (PvpClient a = PvpClient.connect(r, 0, "alice"); PvpClient b = PvpClient.connect(r, 1, "bob")) {
            a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            start(a, b);
            awaitTurn(r, 2);
            r.app.flushCheckpoint();
            final JsonObject c = Checkpointer.read(saved);
            assertTrue(c.get("pvp").getAsBoolean());
            assertEquals(strings(c.get("names")), List.of("alice", "bob"));
            Files.copy(saved, again);
            Files.copy(Checkpointer.deckFile(saved, 0), Checkpointer.deckFile(again, 0));
            Files.copy(Checkpointer.deckFile(saved, 1), Checkpointer.deckFile(again, 1));
            a.act("concede");
            b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
        } finally {
            r.stop();
        }

        final Main.Running r2 = boot(120_000, again, true);
        try (PvpClient a = PvpClient.connect(r2, 0, "alice")) {
            final JsonObject lobby = a.await(0, m -> PvpClient.is(m, "pvp", "lobby"), 30);
            assertTrue(lobby.has("resuming") && lobby.get("resuming").getAsBoolean(), lobby.toString());
            final JsonObject refused = a.rpc("match.start", deck("mono-red-madness"));
            assertFalse(refused.get("ok").getAsBoolean(), "a saved game has no deck to pick");
            Thread.sleep(500);
            assertFalse(a.any(m -> PvpClient.is(m, "snapshot", null)), "it waits for the other player");
            try (PvpClient b = PvpClient.connect(r2, 1, "bob")) {
                a.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
                b.await(0, m -> PvpClient.is(m, "snapshot", null), 60);
                awaitTurn(r2, 2); // dealt from the save, not a new game at turn 1
                assertTrue(player(r2, "bob") != null, "bob sits where he sat");
                a.act("concede");
                b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            }
        } finally {
            r2.stop();
        }
    }

    /** A mid-game nextGame QUIT doesn't end the match for both without a winner: it is that seat conceding. */
    @Test
    public void quitMidGameIsAConcession() throws Exception {
        final Main.Running r = boot(120_000);
        try (PvpClient a = PvpClient.connect(r, 0, "alice"); PvpClient b = PvpClient.connect(r, 1, "bob")) {
            a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            start(a, b);
            awaitTurn(r, 2);
            final JsonObject quit = new JsonObject();
            quit.addProperty("t", "act");
            quit.addProperty("kind", "nextGame");
            quit.addProperty("decision", "QUIT");
            b.send(quit);
            final JsonObject ob = b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            final JsonObject oa = a.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            assertFalse(ob.get("won").getAsBoolean());
            assertTrue(oa.get("won").getAsBoolean());
            assertEquals(oa.get("winner").getAsString(), "alice");
        } finally {
            r.stop();
        }
    }

    /**
     * Rematch: after a game, one seat's nextGame NEW puts both back on the start screen (lobby with rematch, decks
     * cleared); the other seat is told it was asked, either may change deck, and the next game starts once both are
     * ready again. A seat that then leaves is reported to the other, whose rematch and Ready are refused.
     */
    @Test
    public void rematchWithADeckChangeThenLeave() throws Exception {
        final Main.Running r = boot(120_000);
        try (PvpClient a = PvpClient.connect(r, 0, "alice"); PvpClient b = PvpClient.connect(r, 1, "bob")) {
            a.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            b.await(0, m -> PvpClient.is(m, "welcome", null), 30);
            start(a, b);
            final HostedMatch first = r.app.match();
            a.act("concede");
            a.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            b.await(0, m -> PvpClient.is(m, "gameOver", null), 60);

            int ma = a.mark();
            int mb = b.mark();
            a.send(nextGame("NEW"));
            final JsonObject asked = b.await(mb, m -> PvpClient.is(m, "pvp", "lobby"), 30);
            assertTrue(asked.get("rematch").getAsBoolean());
            assertTrue(asked.get("oppRematch").getAsBoolean(), "bob is told alice asked");
            assertFalse(asked.get("youReady").getAsBoolean());
            final JsonObject mine = a.await(ma, m -> PvpClient.is(m, "pvp", "lobby"), 30);
            assertTrue(mine.get("rematch").getAsBoolean());
            assertFalse(mine.has("oppRematch"), "bob hasn't said yes yet");
            waitFor(() -> r.app.match() == null, 30, "the finished match never ended");
            assertEquals(r.app.state(), "over");

            // Alice changes deck; Bob says yes with Ready on his start screen; the next game starts with the new deck.
            ma = a.mark();
            mb = b.mark();
            assertTrue(a.rpc("match.start", deck("mono-blue-faeries")).get("ok").getAsBoolean());
            assertTrue(b.rpc("match.start", deck(SEAT1_DECK)).get("ok").getAsBoolean());
            a.await(ma, m -> PvpClient.is(m, "snapshot", null), 60);
            b.await(mb, m -> PvpClient.is(m, "snapshot", null), 60);
            waitFor(() -> r.app.match() != null && r.app.match() != first && player(r, "alice") != null, 60, "no second game");
            assertTrue(player(r, "alice").getRegisteredPlayer().getDeck().getName().toLowerCase().contains("faerie"),
                    "alice plays the deck she changed to: " + player(r, "alice").getRegisteredPlayer().getDeck().getName());

            // The second game ends; Bob leaves; Alice is told and can't get a rematch or ready up.
            b.act("concede");
            a.await(ma, m -> PvpClient.is(m, "gameOver", null), 60);
            b.await(mb, m -> PvpClient.is(m, "gameOver", null), 60);
            ma = a.mark();
            b.send(nextGame("QUIT"));
            final JsonObject left = a.await(ma, m -> PvpClient.is(m, "pvp", "lobby") && m.has("oppLeft"), 30);
            assertTrue(left.get("oppLeft").getAsBoolean());
            ma = a.mark();
            a.send(nextGame("NEW"));
            a.await(ma, m -> PvpClient.is(m, "notice", "toast") && str(m, "message").contains("has left"), 30);
            assertFalse(a.rpc("match.start", deck("mono-red-madness")).get("ok").getAsBoolean(), "no game after bob left");

            // Both games are in /status's results for the router's records: seat by seat, who won and who conceded.
            final com.google.gson.JsonArray results = r.app.results();
            assertEquals(results.size(), 2, results.toString());
            final com.google.gson.JsonArray g1 = results.get(0).getAsJsonObject().getAsJsonArray("seats");
            final com.google.gson.JsonArray g2 = results.get(1).getAsJsonObject().getAsJsonArray("seats");
            assertEquals(str(g1.get(0).getAsJsonObject(), "r"), "lost");
            assertTrue(g1.get(0).getAsJsonObject().get("conceded").getAsBoolean(), "alice conceded the first");
            assertEquals(str(g1.get(1).getAsJsonObject(), "r"), "won");
            assertEquals(str(g2.get(0).getAsJsonObject(), "r"), "won");
            assertEquals(str(g2.get(1).getAsJsonObject(), "r"), "lost");
            assertTrue(str(g2.get(0).getAsJsonObject(), "deck").toLowerCase().contains("faerie"), g2.toString());
            assertNotEquals(results.get(0).getAsJsonObject().get("g").getAsInt(), results.get(1).getAsJsonObject().get("g").getAsInt());
        } finally {
            r.stop();
        }
    }

    private static JsonObject nextGame(final String decision) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", "nextGame");
        a.addProperty("decision", decision);
        return a;
    }

    /** Two seats playing at random to the end through the full protocol: no client-side redaction violations on either. */
    @Test
    public void twoPeoplePlayAFullGame() throws Exception {
        final Main.Running r = boot(120_000);
        try {
            final ScriptedClient a = new ScriptedClient(r.port(), r.token, 21L, false, 120)
                    .helloExtra("seat", new JsonPrimitive(0)).helloExtra("name", new JsonPrimitive("alice"));
            final ScriptedClient b = new ScriptedClient(r.port(), r.token, 22L, false, 120)
                    .helloExtra("seat", new JsonPrimitive(1)).helloExtra("name", new JsonPrimitive("bob"));
            final CompletableFuture<ScriptedClient.Result> fa = CompletableFuture.supplyAsync(() -> play(a, deck("mono-red-madness")));
            final CompletableFuture<ScriptedClient.Result> fb = CompletableFuture.supplyAsync(() -> play(b, deck(SEAT1_DECK)));
            final ScriptedClient.Result ra = fa.get();
            final ScriptedClient.Result rb = fb.get();
            System.out.println("[PvpTest] alice " + ra + "\n[PvpTest] bob " + rb);
            assertTrue(ra.violations.stream().allMatch(v -> v.startsWith(ScriptedClient.NULL_FROM_ID_DRAW)), "alice: " + ra.violations);
            assertTrue(rb.violations.stream().allMatch(v -> v.startsWith(ScriptedClient.NULL_FROM_ID_DRAW)), "bob: " + rb.violations);
            assertTrue(ra.gameOver && rb.gameOver);
            assertNotEquals(ra.won, rb.won, "exactly one seat wins");
            assertEquals(ra.winner, rb.winner);
            assertTrue(ra.acts > 0 && rb.acts > 0, "a seat never acted");
        } finally {
            r.stop();
        }
    }

    private static ScriptedClient.Result play(final ScriptedClient c, final JsonObject params) {
        try {
            return c.play(params, Duration.ofSeconds(240));
        } catch (final Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String str(final JsonObject m, final String key) {
        return m.has(key) && !m.get(key).isJsonNull() ? m.get(key).getAsString() : "";
    }

    interface Check {
        boolean ok() throws Exception;
    }

    private static void waitFor(final Check c, final int seconds, final String what) throws Exception {
        final long until = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < until) {
            if (c.ok()) {
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError(what);
    }
}

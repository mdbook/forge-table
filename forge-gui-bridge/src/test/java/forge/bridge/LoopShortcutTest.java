package forge.bridge;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertSame;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.fail;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.testng.annotations.Test;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.bridge.match.BridgeGuiGame;
import forge.bridge.match.TableSession;
import forge.game.Game;
import forge.game.event.GameEventPlayerLivesChanged;
import forge.game.player.Player;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputConfirm;
import forge.gui.FThreads;
import forge.player.PlayerControllerHuman;
import forge.player.RecordActionsMacroSystem;

/**
 * The loop shortcut: act {@code loop record} remembers what the player does (Forge's macro recorder), {@code loop
 * done} repeats it. The acceptance case is the Myr Retriever loop: sacrifice a Retriever to Ashnod's Altar, return
 * the other one, cast it with the mana; Zulaport Cutthroat drains 1 a loop.
 */
public class LoopShortcutTest {

    /** Cancel is queued before the first playback action: the same Input/pid/body must be shown again. */
    @Test
    public void cancellingBeforeTheFirstActionRestoresTheUnchangedPrompt() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("loop-retriever.txt", false)) {
            final JsonObject p = g.awaitPriority();
            g.autoKeep = false;
            loop(g, "record", 0);
            g.awaitAutoPass(m -> "recording".equals(loopState(m)));
            playOneLoop(g, p);
            final PlayerControllerHuman controller = (PlayerControllerHuman) g.sidecar().app.match().getGame()
                    .getPlayers().stream().filter(pl -> pl.getController() instanceof PlayerControllerHuman)
                    .findFirst().orElseThrow().getController();
            final TableSession table = ((BridgeGuiGame) controller.getGui()).table();
            final RecordActionsMacroSystem macro = (RecordActionsMacroSystem) controller.macros();
            // Keep the recording, but remove its progress text so cancelling cannot change the prompt body.
            FThreads.invokeInEdtLater(() -> {
                macro.finishRecording();
                macro.cancelPlayback();
            });
            g.awaitPrompt(m -> !m.get("message").getAsString().contains("Macro"));
            final JsonObject before = g.prompt;
            final Input input = controller.getInputQueue().getInput();

            // Both controls enter the UI queue before repeat() can enqueue its first playback action.
            FThreads.invokeInEdtLater(() -> {
                table.onClientMessage(loopMessage("repeat", 3));
                table.onClientMessage(loopMessage("cancel", 0));
            });
            g.awaitAutoPass(m -> "playing".equals(loopState(m)));
            g.await(m -> PvpClient.is(m, "promptClear", null));
            g.awaitPrompt(m -> "priority".equals(m.get("kind").getAsString())
                    && before.get("pid").equals(m.get("pid")));
            assertEquals(g.prompt.get("message"), before.get("message"));
            assertSame(controller.getInputQueue().getInput(), input, "no playback action should have run");
            final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
            assertEquals(life(g, opp), 19, "cancelled before any repeat");
            g.awaitAutoPass(m -> loopState(m) == null);
        }
    }

    /** An accepted shortcut only waives Bob's priority, not his optional Soul's Attendant trigger. */
    @Test
    public void anOpponentConfirmationIsShownDuringPlayback() throws Exception {
        final Main.Running r = bootPvp("loop-opponent-confirm.txt");
        try (PvpClient bob = PvpClient.connect(r, 1, "bob");
                AutoPassTest.Game alice = new AutoPassTest.Game(r, null, false, 0, "alice")) {
            final JsonObject p = alice.awaitPriority();
            alice.autoKeep = false;
            loop(alice, "record", 0);
            alice.awaitAutoPass(m -> "recording".equals(loopState(m)));
            playOneLoop(alice, p);
            assertEquals(lifeOf(r, "bob"), 20, "Bob accepted his optional life gain while recording");

            bob.passive = false;
            final int offerMark = bob.mark();
            loop(alice, "done", 3);
            final long offer = awaitOffer(alice, bob, offerMark, 3);
            final int mark = bob.mark();
            answer(bob, offer, true, 0);
            final JsonObject confirm = bob.await(mark, m -> PvpClient.is(m, "prompt", "confirm"), 5);
            final PlayerControllerHuman owner = (PlayerControllerHuman) r.app.match().getGame().getPlayers().stream()
                    .filter(pl -> "alice".equals(pl.getName())).findFirst().orElseThrow().getController();
            assertTrue(owner.macros().isReplaying(), "the decision must arrive before playback stops");
            final JsonObject settled = bob.await(mark, m -> PvpClient.is(m, "settle", null)
                    && m.getAsJsonObject("patch").has("players")
                    && m.getAsJsonObject("patch").getAsJsonObject("players").entrySet().stream()
                            .anyMatch(e -> e.getValue().getAsJsonObject().get("life").getAsInt() == 19), 5);
            assertTrue(settled.get("seq").getAsLong() < confirm.get("seq").getAsLong(),
                    "the accumulated drain must be delivered before the decision");

            loop(alice, "cancel", 0);
            alice.awaitAutoPass(m -> loopState(m) == null);
            final PlayerControllerHuman opponent = (PlayerControllerHuman) r.app.match().getGame().getPlayers().stream()
                    .filter(pl -> "bob".equals(pl.getName())).findFirst().orElseThrow().getController();
            assertTrue(opponent.getInputQueue().getInput() instanceof InputConfirm, "only Bob can answer his decision");
            bob.send(act(confirm, "cancel", null, null));
            alice.awaitPriority();
            assertEquals(lifeOf(r, "bob"), 19, "Bob declined the optional gain");
            alice.send(concedeAct());
            bob.await(mark, m -> PvpClient.is(m, "gameOver", null), 60);
        } finally {
            r.stop();
        }
    }

    /** Ticket 1526: no client acts/replies/acks during playback, at normal animation speed, including delivery. */
    @Test
    public void aHundredIterationsArriveWithinFiveSeconds() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("loop-retriever-100.txt", false)) {
            final JsonObject p = g.awaitPriority();
            g.autoKeep = false;
            final String opp = "p0".equals(g.viewer) ? "p1" : "p0";
            loop(g, "record", 0);
            g.awaitAutoPass(m -> "recording".equals(loopState(m)));
            playOneLoop(g, p);
            assertEquals(life(g, opp), 999);
            final JsonObject speed = new JsonObject();
            speed.addProperty("t", "act");
            speed.addProperty("kind", "speed");
            speed.addProperty("value", 1);
            g.send(speed);

            final long start = System.nanoTime();
            loop(g, "done", 100);
            g.awaitAutoPass(m -> "playing".equals(loopState(m)));
            final int[] beats = {0};
            g.await(m -> {
                if ("beat".equals(m.get("t").getAsString())) {
                    beats[0]++;
                }
                return "prompt".equals(m.get("t").getAsString()) && "priority".equals(m.get("kind").getAsString())
                        && life(g, opp) == 899 && g.stackSize() == 0;
            });
            final long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            System.out.println("[LoopShortcutTest] 100 repeats took " + elapsedMs + " ms");
            assertTrue(elapsedMs <= 5000, "100 repeats took " + elapsedMs + " ms");
            assertTrue(beats[0] < 20, "intermediate actions were animated: " + beats[0] + " beats");
            assertEquals(life(g, g.viewer), 121);
            assertEquals(count(g, "Myr Retriever", "Battlefield"), 1);
            assertEquals(count(g, "Myr Retriever", "Graveyard"), 1);
            g.awaitAutoPass(m -> loopState(m) == null);
        }
    }

    @Test
    public void aRecordedLoopRepeatsAgainstTheAi() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("loop-retriever.txt", false)) {
            try {
                final JsonObject p = g.awaitPriority();
                g.autoKeep = false;
                final String opp = "p0".equals(g.viewer) ? "p1" : "p0";

                loop(g, "record", 0);
                g.awaitAutoPass(m -> "recording".equals(loopState(m)));
                playOneLoop(g, p);
                assertEquals(life(g, opp), 19, "the loop played by hand drains 1");

                // Against the AI there's no one to ask: it runs at once, three more times.
                loop(g, "done", 3);
                g.awaitAutoPass(m -> "playing".equals(loopState(m)));
                g.await(m -> life(g, opp) == 16);
                g.awaitAutoPass(m -> loopState(m) == null);
                assertEquals(count(g, "Myr Retriever", "Battlefield"), 1, "one Retriever is back on the battlefield");
                assertEquals(count(g, "Myr Retriever", "Graveyard"), 1, "and one is in the graveyard");
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        }
    }

    /**
     * Between two people the loop is offered first (rule 732.2). Bob says he'd respond: nothing runs. Offered again,
     * a late answer to the first offer can't accept it; he accepts only the first 2 of 5: it runs twice, his priority
     * passes without a prompt while it does, and he's asked again once it's over.
     */
    @Test
    public void aLoopIsOfferedToAPersonFirst() throws Exception {
        final Main.Running r = bootPvp();
        try (PvpClient bob = PvpClient.connect(r, 1, "bob");
                AutoPassTest.Game alice = new AutoPassTest.Game(r, null, false, 0, "alice")) {
            try {
                startLoop(r, alice, bob);
                loop(alice, "done", 5);
                final long first = awaitOffer(alice, bob, 0, 5);
                answer(bob, first, false, 0);
                alice.await(m -> "notice".equals(m.get("t").getAsString()) && "toast".equals(m.get("kind").getAsString()));
                alice.awaitAutoPass(m -> loopState(m) == null);
                assertEquals(lifeOf(r, "bob"), 19, "declined: nothing ran");

                loop(alice, "repeat", 5);
                final long second = awaitOffer(alice, bob, bob.mark(), 5);
                assertTrue(second != first, "a new offer gets a new id");
                final int mark = bob.mark();
                bob.passive = false; // from here on a priority prompt for bob would stall the loop
                answer(bob, first, true, 0);
                awaitStale(bob, mark, "stale loop offer");
                answer(bob, second, true, 2);
                waitForLife(r, "bob", 17);
                alice.awaitAutoPass(m -> loopState(m) == null);
                Thread.sleep(500);
                assertEquals(lifeOf(r, "bob"), 17, "it stopped after the 2 bob accepted");
                assertTrue(bob.await(mark, m -> PvpClient.is(m, "notice", "autoPass") && m.has("opponentLoop")
                        && "playing".equals(m.getAsJsonObject("opponentLoop").get("state").getAsString()), 5) != null);
                assertFalse(bob.anyFrom(mark, m -> PvpClient.is(m, "prompt", "priority")), "bob was asked for priority during the loop");
                assertPriorityComesBack(alice, bob);
                alice.send(concedeAct());
                bob.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        } finally {
            r.stop();
        }
    }

    /**
     * An offer is dropped once the game moves past it (Alice plays on by hand), and a late answer to it is refused.
     * A loop Alice stops partway gives Bob his priority back.
     */
    @Test
    public void aCancelledLoopGivesPriorityBack() throws Exception {
        final Main.Running r = bootPvp();
        try (PvpClient bob = PvpClient.connect(r, 1, "bob");
                AutoPassTest.Game alice = new AutoPassTest.Game(r, null, false, 0, "alice")) {
            try {
                startLoop(r, alice, bob);
                loop(alice, "done", 50);
                final long dropped = awaitOffer(alice, bob, 0, 50);
                int mark = bob.mark();
                playOneLoop(alice, alice.prompt);
                waitForLife(r, "bob", 18);
                alice.awaitAutoPass(m -> loopState(m) == null);
                bob.await(mark, m -> PvpClient.is(m, "notice", "autoPass") && !m.has("opponentLoop"), 10);
                mark = bob.mark();
                answer(bob, dropped, true, 0);
                awaitStale(bob, mark, "no loop to answer");
                Thread.sleep(500);
                assertEquals(lifeOf(r, "bob"), 18, "the dropped offer didn't run");

                loop(alice, "repeat", 50);
                final long offer = awaitOffer(alice, bob, bob.mark(), 50);
                bob.passive = false;
                mark = bob.mark();
                try (LoopPause pause = new LoopPause(r, "bob", 16)) {
                    answer(bob, offer, true, 0);
                    pause.await();
                    assertFalse(bob.anyFrom(mark, m -> PvpClient.is(m, "prompt", "priority")), "bob was asked for priority during the loop");
                    // Hold the engine at an event, not an animation delay: fast playback must still accept Cancel.
                    bob.passive = true;
                    mark = bob.mark();
                    loop(alice, "cancel", 0);
                    alice.awaitAutoPass(m -> loopState(m) == null);
                }
                // Finish the step it stopped in (a drain or two may still resolve), then nothing more happens.
                drive(alice, null, true);
                final int stoppedAt = lifeOf(r, "bob");
                Thread.sleep(1000);
                assertEquals(lifeOf(r, "bob"), stoppedAt, "the loop stopped when Alice cancelled it");
                assertTrue(stoppedAt > 0, "it stopped long before 50");
                assertPriorityComesBack(alice, bob);
                assertTrue(bob.anyFrom(mark, m -> PvpClient.is(m, "prompt", "priority")), "bob is asked for priority after the cancel");
                alice.send(concedeAct());
                bob.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        } finally {
            r.stop();
        }
    }

    /** Bob concedes while Alice's loop is playing: the game ends for both and the loop stops with it. */
    @Test
    public void aConcedeMidLoopEndsTheGame() throws Exception {
        final Main.Running r = bootPvp();
        try (PvpClient bob = PvpClient.connect(r, 1, "bob");
                AutoPassTest.Game alice = new AutoPassTest.Game(r, null, false, 0, "alice")) {
            try {
                startLoop(r, alice, bob);
                loop(alice, "done", 50);
                final long offer = awaitOffer(alice, bob, 0, 50);
                bob.passive = false;
                try (LoopPause pause = new LoopPause(r, "bob", 17)) {
                    answer(bob, offer, true, 0);
                    pause.await();
                    bob.send(concedeAct());
                    final long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    final Player player = r.app.match().getGame().getPlayers().stream()
                            .filter(pl -> "bob".equals(pl.getName())).findFirst().orElseThrow();
                    while (player.getOutcome() == null && System.nanoTime() < until) {
                        Thread.sleep(10);
                    }
                    assertTrue(player.getOutcome() != null, "concede was not handled during playback");
                }
                bob.await(0, m -> PvpClient.is(m, "gameOver", null), 60);
                alice.await(m -> "gameOver".equals(m.get("t").getAsString()));
                final int over = lifeOf(r, "bob");
                Thread.sleep(1000);
                assertEquals(lifeOf(r, "bob"), over, "the loop stopped with the game");
            } catch (final AssertionError e) {
                ConcedeTest.dumpThreads();
                throw e;
            }
        } finally {
            r.stop();
        }
    }

    /** Deterministic mid-loop control tests: never depend on catching a 50 ms animation/polling window. */
    public static final class LoopPause implements AutoCloseable {
        private final String player;
        private final int life;
        private final CountDownLatch reached = new CountDownLatch(1);
        private final CountDownLatch resume = new CountDownLatch(1);

        LoopPause(final Main.Running r, final String player, final int life) {
            this.player = player;
            this.life = life;
            r.app.match().getGame().subscribeToEvents(this);
        }

        @Subscribe
        public void receive(final GameEventPlayerLivesChanged event) throws InterruptedException {
            if (player.equals(event.player().getName()) && event.newLives() == life) {
                reached.countDown();
                assertTrue(resume.await(10, TimeUnit.SECONDS), "mid-loop control timed out");
            }
        }

        void await() throws InterruptedException {
            assertTrue(reached.await(30, TimeUnit.SECONDS), "loop did not reach the pause point");
        }

        @Override
        public void close() {
            resume.countDown();
        }
    }

    /** A game between alice and bob, resumed at the Retriever fixture on alice's main phase. */
    private static Main.Running bootPvp() throws Exception {
        return bootPvp("loop-retriever.txt");
    }

    private static Main.Running bootPvp(final String state) throws Exception {
        // Forge's model is booted once per JVM, and writing the save below needs it.
        TableTestEnv.start().stop();
        final Path dir = Files.createTempDirectory("ft-loop-pvp");
        final Path checkpoint = dir.resolve("checkpoint.json");
        final JsonObject c = new JsonObject();
        c.addProperty("v", Checkpointer.VERSION);
        c.addProperty("pvp", true);
        final JsonArray names = new JsonArray();
        names.add("alice");
        names.add("bob");
        c.add("names", names);
        c.addProperty("turn", 3);
        c.addProperty("phase", "MAIN1");
        c.addProperty("state", Files.readString(Path.of(LoopShortcutTest.class.getClassLoader().getResource("table/states/" + state).toURI())));
        Files.writeString(checkpoint, c.toString());
        final Path deck = TableTestEnv.decksDir().toPath().resolve("mono-red-madness.dck");
        Files.copy(deck, Checkpointer.deckFile(checkpoint, 0));
        Files.copy(deck, Checkpointer.deckFile(checkpoint, 1));

        final BridgeApp.Options o = TableTestEnv.options();
        o.pvp = true;
        o.oppDeck = null;
        o.checkpoint = checkpoint.toString();
        o.resume = true;
        o.claimAfterMs = 120_000;
        return Main.boot(o);
    }

    /**
     * Bob turns auto-skip off, so every priority he gets is a prompt he has to answer (he passes them himself while
     * passive). Alice records the loop and plays it once by hand.
     */
    private static void startLoop(final Main.Running r, final AutoPassTest.Game alice, final PvpClient bob) throws InterruptedException {
        final JsonObject skip = new JsonObject();
        skip.addProperty("t", "act");
        skip.addProperty("kind", "autoSkip");
        skip.addProperty("on", false);
        bob.send(skip);
        final JsonObject p = alice.awaitPriority();
        alice.autoKeep = false;
        loop(alice, "record", 0);
        alice.awaitAutoPass(m -> "recording".equals(loopState(m)));
        playOneLoop(alice, p);
        waitForLife(r, "bob", 19);
    }

    /** Waits for alice's offer to reach bob (from message {@code from}) and returns its id. */
    private static long awaitOffer(final AutoPassTest.Game alice, final PvpClient bob, final int from, final int times) throws InterruptedException {
        alice.awaitAutoPass(m -> "offered".equals(loopState(m)));
        final JsonObject offer = bob.await(from, m -> PvpClient.is(m, "notice", "autoPass") && m.has("opponentLoop")
                && "offered".equals(m.getAsJsonObject("opponentLoop").get("state").getAsString()), 30).getAsJsonObject("opponentLoop");
        assertEquals(offer.get("times").getAsInt(), times);
        return offer.get("offerId").getAsLong();
    }

    private static void awaitStale(final PvpClient c, final int from, final String reason) throws InterruptedException {
        c.await(from, m -> PvpClient.is(m, "notice", "stale") && reason.equals(m.get("reason").getAsString()), 10);
    }

    /** Alice passes to the end of the turn: bob, auto-skip off and not passing for himself, is asked for priority again. */
    private static void assertPriorityComesBack(final AutoPassTest.Game alice, final PvpClient bob) throws InterruptedException {
        final int mark = bob.mark();
        alice.yieldEndOfTurn();
        bob.await(mark, m -> PvpClient.is(m, "prompt", "priority"), 30);
    }

    private static void answer(final PvpClient c, final long offerId, final boolean accept, final int stopAfter) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", "loopAnswer");
        a.addProperty("offerId", offerId);
        a.addProperty("accept", accept);
        if (stopAfter > 0) {
            a.addProperty("stopAfter", stopAfter);
        }
        c.send(a);
    }

    private static JsonObject concedeAct() {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", "concede");
        return a;
    }

    private static int lifeOf(final Main.Running r, final String name) {
        final HostedMatch hm = r.app.match();
        final Game g = hm == null ? null : hm.getGame();
        if (g != null) {
            for (final Player pl : g.getPlayers()) {
                if (name.equals(pl.getName())) {
                    return pl.getLife();
                }
            }
        }
        return -1;
    }

    private static void waitForLife(final Main.Running r, final String name, final int life) throws InterruptedException {
        final long until = System.currentTimeMillis() + 60_000;
        while (lifeOf(r, name) != life) {
            if (System.currentTimeMillis() > until) {
                fail(name + " never got to " + life + " (at " + lifeOf(r, name) + ")");
            }
            Thread.sleep(100);
        }
    }

    @Test
    public void aLoopCountOutOfRangeIsRefused() throws Exception {
        try (AutoPassTest.Game g = new AutoPassTest.Game("loop-retriever.txt", false)) {
            g.awaitPriority();
            loop(g, "record", 0);
            g.awaitAutoPass(m -> "recording".equals(loopState(m)));
            loop(g, "done", 1000);
            g.await(m -> "notice".equals(m.get("t").getAsString()) && "stale".equals(m.get("kind").getAsString())
                    && "loop count out of range".equals(m.get("reason").getAsString()));
            // Still recording; cancel drops it.
            loop(g, "cancel", 0);
            g.awaitAutoPass(m -> loopState(m) == null);
        }
    }

    /**
     * One pass of the loop, by hand: sacrifice the Retriever on the battlefield to the Altar, target the one in the
     * graveyard with its trigger, let everything resolve, cast the returned one and let it resolve.
     */
    static void playOneLoop(final AutoPassTest.Game g, final JsonObject priority) throws InterruptedException {
        g.send(act(priority, "card", "card", cardIn(g, "Ashnod's Altar", "Battlefield")));
        drive(g, null, false);
    }

    /**
     * Answers the loop's prompts, starting with {@code first} (null: the next one), until priority comes with an empty
     * stack after the Retriever was cast ({@code cast} true: as soon as the stack is empty).
     */
    static void drive(final AutoPassTest.Game g, final JsonObject first, final boolean castAlready) throws InterruptedException {
        boolean cast = castAlready;
        JsonObject next = first;
        while (true) {
            final JsonObject m = next != null ? next
                    : g.await(x -> "ask".equals(x.get("t").getAsString()) || "prompt".equals(x.get("t").getAsString()));
            next = null;
            if ("ask".equals(m.get("t").getAsString())) {
                if (!"order".equals(m.get("kind").getAsString())) {
                    fail("unexpected ask " + m);
                }
                final JsonObject r = new JsonObject();
                final JsonArray order = new JsonArray();
                for (int i = 0; i < m.get("max").getAsInt(); i++) {
                    order.add(i);
                }
                r.add("order", order);
                reply(g, m, r);
                continue;
            }
            switch (m.get("kind").getAsString()) {
                case "waiting" -> { }
                case "selectEntities" -> g.send(act(m, "card", "card", cardIn(g, "Myr Retriever", "Battlefield")));
                case "chooseTargets" -> g.send(act(m, "card", "card", cardIn(g, "Myr Retriever", "Graveyard")));
                case "payMana" -> g.send(act(m, "ok", null, null));
                case "priority" -> {
                    if (g.stackSize() > 0) {
                        g.send(act(m, "ok", null, null));
                    } else if (!cast) {
                        cast = true;
                        g.send(act(m, "card", "card", cardIn(g, "Myr Retriever", "Hand")));
                    } else {
                        return;
                    }
                }
                default -> fail("unexpected prompt " + m);
            }
        }
    }

    static void loop(final AutoPassTest.Game g, final String op, final int times) {
        g.send(loopMessage(op, times));
    }

    private static JsonObject loopMessage(final String op, final int times) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("kind", "loop");
        a.addProperty("op", op);
        if (times != 0) {
            a.addProperty("times", times);
        }
        return a;
    }

    static String loopState(final JsonObject autoPass) {
        return autoPass.has("loop") ? autoPass.getAsJsonObject("loop").get("state").getAsString() : null;
    }

    static String cardIn(final AutoPassTest.Game g, final String name, final String zone) {
        return g.cards.entrySet().stream()
                .filter(e -> e.getValue().has("zone") && zone.equals(e.getValue().get("zone").getAsString()) && e.getValue().has("state")
                        && name.equals(e.getValue().getAsJsonObject("state").get("name").getAsString()))
                .map(Map.Entry::getKey).findFirst().orElseThrow(() -> new AssertionError("no " + name + " in " + zone));
    }

    static long count(final AutoPassTest.Game g, final String name, final String zone) {
        return g.cards.values().stream()
                .filter(c -> c.has("zone") && zone.equals(c.get("zone").getAsString()) && c.has("state")
                        && name.equals(c.getAsJsonObject("state").get("name").getAsString()))
                .count();
    }

    static int life(final AutoPassTest.Game g, final String player) {
        return g.players.has(player) ? g.players.getAsJsonObject(player).get("life").getAsInt() : -1;
    }

    private static void reply(final AutoPassTest.Game g, final JsonObject ask, final JsonObject value) {
        final JsonObject r = new JsonObject();
        r.addProperty("t", "reply");
        r.addProperty("id", ask.get("id").getAsString());
        r.add("value", value);
        g.send(r);
    }

    static JsonObject act(final JsonObject prompt, final String kind, final String key, final String value) {
        final JsonObject a = new JsonObject();
        a.addProperty("t", "act");
        a.addProperty("pid", prompt.get("pid").getAsLong());
        a.addProperty("kind", kind);
        if (key != null) {
            a.addProperty(key, value);
        }
        return a;
    }
}

package forge.bridge.match;

import java.util.ArrayList;
import java.util.Collections;
import java.util.ConcurrentModificationException;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Supplier;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import forge.bridge.BridgeGuiBase;
import forge.bridge.BridgeLog;
import forge.bridge.proj.Outbox;
import forge.bridge.proj.ViewProjector;
import forge.card.MagicColor;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameOutcome;
import forge.game.GameView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.PlayerView;
import forge.game.trigger.WrappedAbility;
import forge.gamemodes.match.NextGameDecision;
import forge.gamemodes.match.YieldController;
import forge.gamemodes.match.YieldUpdate;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputAttack;
import forge.gamemodes.match.input.InputBlock;
import forge.gamemodes.match.input.InputConfirm;
import forge.gamemodes.match.input.InputLockUI;
import forge.gamemodes.match.input.InputQueue;
import forge.gamemodes.match.input.InputSynchronized;
import forge.gui.FThreads;
import forge.interfaces.IGameController;
import forge.localinstance.properties.ForgePreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.AutoYieldStore;
import forge.player.PlayerControllerHuman;
import forge.player.RecordActionsMacroSystem;

/**
 * One viewer's seat at one match: the {@link BridgeGuiGame}, its {@link Outbox}, {@link PromptService} and
 * {@link Pacer}, and the client connection currently attached to them.
 *
 * <p><b>Prompt ids.</b> An observer on each local player's {@code InputQueue} assigns a new {@code pid}
 * whenever the Input on top of the queue changes. Observers fire in reverse registration order, so this
 * one runs before {@code InputProxy.update}. Every Input-scoped act carries the pid it was made against
 * and is dropped (with a {@code stale} notice) unless that pid is still the one on screen and no blocking
 * prompt is open, so a delayed or double click can never land on an Input the user hasn't seen.
 *
 * <p><b>Auto-pass</b> (the chips beside the phase strip) is Forge's own machinery, not a rules check of ours.
 * <em>Auto-skip</em> is {@code YIELD_AUTO_PASS_NO_ACTIONS}, set as a per-controller override so Classic's
 * global preference is untouched: at each priority {@code PlayerControllerHuman.chooseSpellAbilityToPlay}
 * scans for anything castable, playable or activatable (mana abilities excluded; the same scan that feeds the
 * playable glow) and passes without raising a prompt when there is nothing. <em>Pass until end of turn</em> is
 * {@code YieldController}'s end-of-turn yield; Forge clears it at cleanup and on its interrupts (an opponent's
 * spell or ability, attackers coming at you; {@code YIELD_INTERRUPT_*}). <em>Auto-resolve</em> is
 * {@code YIELD_AUTO_RESOLVE_OWN}, per controller the same way: priority is passed while the top of the stack is
 * the player's own. <em>Always yes / always no</em> for an optional trigger is Forge's Auto-Yield trigger decision.
 * All of them are reported to the client as {@code notice{autoPass}} whenever they change.
 */
public final class TableSession {

    private final BridgeGuiBase base;
    private final Outbox outbox = new Outbox();
    private final Pacer pacer = new Pacer();
    private final PromptService prompts = new PromptService(outbox);
    private final BridgeGuiGame gui;
    private final Map<Game, EventTap> taps = Collections.synchronizedMap(new WeakHashMap<>());
    private final Set<InputQueue> observedQueues = Collections.synchronizedSet(Collections.newSetFromMap(new IdentityHashMap<>()));

    private volatile PlayerControllerHuman seatController;
    private volatile PlayerView seat;

    // pid bookkeeping (pidLock)
    private final Object pidLock = new Object();
    private long pidCounter;
    private long currentPid;
    private Input currentQueueInput;

    // last prompt sent (outbox lock)
    private long lastSentPid;
    private JsonObject lastPrompt;
    private boolean lastPromptCleared = true;

    private volatile JsonObject gameOver;
    private volatile Runnable onMatchEnded;
    private volatile Consumer<Game> onGameFinished;
    private volatile Consumer<Game> onGameAttached;
    private volatile Supplier<JsonObject> presence;

    /** The client's auto-skip toggle (hello {@code client.autoSkip}, absent = on; act {@code autoSkip}). */
    private volatile boolean autoSkip = true;
    /** Auto-resolve (act {@code autoResolve}, off until turned on): pass whenever the top of the stack is mine. */
    private volatile boolean autoResolve;
    /** Cards the player snoozed (act {@code snooze}): auto-skip doesn't count them as something to do. */
    private final Set<String> snoozed = Collections.synchronizedSet(new java.util.LinkedHashSet<>());
    /** Auto-pass state last notified (bridge-ui); null forces the next flush to send it. */
    private JsonObject lastAutoPass;

    /** A game between two people: the other seat's session, which loop shortcuts are offered to. Null against the AI. */
    private volatile TableSession peer;
    /** A recorded loop I offered to repeat this many more times (rule 732.2), waiting on the opponent; 0 = none. */
    private volatile int loopOffer;
    /** The pid the offer was made at: once my prompt moves on, the offer no longer describes the game and is dropped. */
    private volatile long loopOfferPid;
    /** Names each offer, so an answer the opponent sent to an earlier offer can't accept a later one. */
    private volatile long loopOfferId;
    /** My offered loop was accepted and is playing: the opponent's priority passes until it stops. */
    private volatile boolean loopRunning;
    /** Most repeats one loop asks for, so a typo can't run all night. */
    static final int MAX_LOOP_TIMES = 999;

    public TableSession(final BridgeGuiBase base) {
        this.base = base;
        // Seats share this process: Forge's per-install auto-decision file would hand one seat's answers to the other.
        YieldController.disallowInstallMode();
        this.gui = new BridgeGuiGame(this);
        pacer.setPromptOutstanding(this::isPromptOutstanding);
        outbox.setBeatListener(pacer::beatSent);
    }

    /** A game between two people: each seat's session knows the other's (loop shortcuts are offered across). */
    public void pairWith(final TableSession other) {
        this.peer = other;
        other.peer = this;
    }

    public BridgeGuiGame gui() { return gui; }
    public Outbox outbox() { return outbox; }
    public PromptService prompts() { return prompts; }
    public Pacer pacer() { return pacer; }
    public PlayerView seat() { return seat; }

    public void setOnMatchEnded(final Runnable r) {
        this.onMatchEnded = r;
    }

    /** Told each game this table saw end, with the game (both seats of a pvp game tell it: the listener dedupes). */
    public void setOnGameFinished(final Consumer<Game> r) {
        this.onGameFinished = r;
    }

    /** Told each game this table starts showing, once, before its first priority (the checkpointer subscribes then). */
    public void setOnGameAttached(final Consumer<Game> r) {
        this.onGameAttached = r;
    }

    /**
     * A game between two people: what this seat's snapshots say about the other one ({@code presence}, see
     * {@code BridgeApp}). Read under the outbox lock, so it must not take other locks.
     */
    public void setPresence(final Supplier<JsonObject> presence) {
        this.presence = presence;
    }

    // ---------------------------------------------------------------- engine side

    /** Subscribe the event tap to {@code gv}'s game, at most once per Game. */
    void attachGame(final GameView gv) {
        final Game game = gv.getGame();
        if (game == null) {
            return;
        }
        synchronized (taps) {
            if (!taps.containsKey(game)) {
                final EventTap tap = new EventTap(outbox, pacer);
                game.subscribeToEvents(tap);
                taps.put(game, tap);
                final Consumer<Game> attached = onGameAttached;
                if (attached != null) {
                    attached.accept(game);
                }
            }
        }
    }

    void openView(final GameView gv, final PlayerView viewer) {
        this.seat = viewer;
        this.gameOver = null;
        // A new game (rematch, next game of the match) reuses this session but restarts card ids: snoozes from the
        // last game would land on the new game's cards. The snapshot below tells the client they're gone.
        snoozed.clear();
        // Auto-resolve is for one game too. The new game's controllers may already be installed with it on.
        if (autoResolve) {
            autoResolve = false;
            base.invokeInEdtLater(this::applyAutoResolve);
        }
        // A loop belongs to the game it was recorded in (its macro lives on the old controller).
        loopOffer = 0;
        if (loopRunning) {
            loopRunning = false;
            passPeer(null);
        }
        synchronized (outbox.lock()) {
            lastSentPid = 0;
            lastPrompt = null;
            lastPromptCleared = true;
            outbox.bind(gv, viewer, resumeExtras());
        }
    }

    /** Install the pid observer and the per-controller auto-pass delay overrides. */
    void installController(final IGameController controller, final boolean original) {
        if (!(controller instanceof PlayerControllerHuman pch)) {
            return;
        }
        if (original) {
            seatController = pch;
        }
        final InputQueue queue = pch.getInputQueue();
        if (observedQueues.add(queue)) {
            queue.addObserver((o, arg) -> onQueueChanged(queue));
        }
        // The Pacer replaces PCH's own 200/400 ms auto-pass sleeps. Overrides live on this controller's
        // YieldController only; global preferences are untouched. Re-applied for every new controller.
        pch.getYieldController().apply(new YieldUpdate.SetYieldPref(FPref.YIELD_SKIP_PHASE_DELAY, "true"));
        pch.getYieldController().apply(new YieldUpdate.SetYieldPref(FPref.YIELD_SKIP_RESOLVE_DELAY, "true"));
        // Table always shows what's playable (the prompt's "weak" set, drawn as a soft glow); Classic's pref stays as is.
        pch.getYieldController().apply(new YieldUpdate.SetYieldPref(FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, "true"));
        // Pass turn ends on an opponent's spell or attack, never on a trigger (Table has no setting for it; Classic's stays as is).
        pch.getYieldController().apply(new YieldUpdate.SetYieldPref(FPref.YIELD_INTERRUPT_ON_TRIGGERS, "false"));
        // Auto-skip follows the client's toggle, also per controller.
        pch.getYieldController().apply(autoSkipPref());
        pch.getYieldController().apply(autoResolvePref());
        // Forge makes the macro system on first use; make it here, so network threads only ever read it.
        pch.macros();
    }

    private YieldUpdate autoSkipPref() {
        return new YieldUpdate.SetYieldPref(FPref.YIELD_AUTO_PASS_NO_ACTIONS, String.valueOf(autoSkip));
    }

    private YieldUpdate autoResolvePref() {
        return new YieldUpdate.SetYieldPref(FPref.YIELD_AUTO_RESOLVE_OWN, String.valueOf(autoResolve));
    }

    /** Every human controller of this seat: the originals and the one in control now (mind control). */
    private List<PlayerControllerHuman> humanControllers() {
        final List<PlayerControllerHuman> out = new ArrayList<>();
        for (final IGameController c : gui.getOriginalGameControllers()) {
            if (c instanceof PlayerControllerHuman pch && !out.contains(pch)) {
                out.add(pch);
            }
        }
        if (gui.getGameController() instanceof PlayerControllerHuman pch && !out.contains(pch)) {
            out.add(pch);
        }
        return out;
    }

    /** {@code {autoSkip, untilEndOfTurn, snoozed, autoResolve, answers}}, as sent in {@code notice{autoPass}} and the snapshot. */
    JsonObject describeAutoPass() {
        boolean eot = false;
        for (final PlayerControllerHuman pch : humanControllers()) {
            eot |= pch.getYieldController().autoPassUntilEndOfTurn();
        }
        final JsonObject o = new JsonObject();
        o.addProperty("autoSkip", autoSkip);
        o.addProperty("untilEndOfTurn", eot);
        final JsonArray sn = new JsonArray();
        synchronized (snoozed) {
            snoozed.forEach(sn::add);
        }
        o.add("snoozed", sn);
        o.addProperty("autoResolve", autoResolve);
        o.add("answers", describeAnswers());
        final JsonObject loop = describeLoop();
        if (loop != null) {
            o.add("loop", loop);
        }
        final TableSession p = peer;
        final JsonObject theirs = p == null ? null : p.describeLoop();
        if (theirs != null && ("offered".equals(theirs.get("state").getAsString()) || p.loopRunning)) {
            o.add("opponentLoop", theirs);
        }
        return o;
    }

    // ---------------------------------------------------------------- loop shortcut (rule 732.2)

    /** The seat's macro recorder: Forge desktop's "record actions, repeat N times". */
    private RecordActionsMacroSystem loopMacro() {
        final PlayerControllerHuman pch = seatController;
        return pch != null && pch.macros() instanceof RecordActionsMacroSystem m ? m : null;
    }

    /** {@code {state: recording | offered | playing, steps, times, iteration, of}}, or null with no loop going. */
    private JsonObject describeLoop() {
        final RecordActionsMacroSystem m = loopMacro();
        if (m == null) {
            return null;
        }
        final JsonObject o = new JsonObject();
        if (m.isRecording()) {
            o.addProperty("state", "recording");
            o.addProperty("steps", m.getRecordedSteps());
        } else if (m.isReplaying()) {
            o.addProperty("state", "playing");
            o.addProperty("iteration", m.getRepeatIteration());
            o.addProperty("of", m.getRepeatIterations());
        } else if (loopOffer > 0) {
            o.addProperty("state", "offered");
            o.addProperty("steps", m.getRecordedSteps());
            o.addProperty("times", loopOffer);
            o.addProperty("offerId", loopOfferId);
        } else {
            return null;
        }
        return o;
    }

    /**
     * Act {@code loop} (bridge-ui). {@code record} starts recording what the player does; {@code done} stops and
     * asks to repeat it {@code times} more times, {@code repeat} asks again for the last recording; {@code cancel}
     * drops a recording, an offer or a loop that's playing. Against the AI a repeat starts at once; against a
     * person it's offered to them first. Returns why it was refused, or null.
     */
    private String loopAct(final String op, final int times) {
        final RecordActionsMacroSystem m = loopMacro();
        if (m == null || gameOver != null) {
            return "no game";
        }
        switch (op) {
            case "record" -> {
                if (m.isReplaying() || loopOffer > 0) {
                    return "a loop is going";
                }
                m.startRecording();
            }
            case "cancel" -> {
                loopOffer = 0;
                m.cancelCurrentMacro();
            }
            case "done", "repeat" -> {
                if (times < 1 || times > MAX_LOOP_TIMES) {
                    return "loop count out of range";
                }
                if ("done".equals(op) && !m.finishRecording()) {
                    return "not recording";
                }
                if (m.isRecording() || m.isReplaying() || loopOffer > 0) {
                    return "a loop is going";
                }
                if (!m.hasRememberedActions()) {
                    return "nothing recorded";
                }
                if (peer == null) {
                    if (!m.repeat(times)) {
                        return "nothing recorded";
                    }
                } else {
                    loopOfferPid = queuePid();
                    loopOfferId++;
                    loopOffer = times;
                }
            }
            default -> {
                return "bad loop op";
            }
        }
        lastAutoPass = null;
        return null;
    }

    /**
     * The opponent's answer to my offer (bridge-ui, their act {@code loopAnswer}): accept, optionally naming the
     * repeat to stop after, or decline (they want to respond, so I play it out by hand). {@code offerId} must name the
     * offer standing now: an answer to one that was dropped or replaced is refused. Returns why it was refused.
     */
    String answerLoop(final long offerId, final boolean accept, final int stopAfter) {
        final int times = loopOffer;
        if (times <= 0) {
            return "no loop to answer";
        }
        if (offerId != loopOfferId) {
            return "stale loop offer";
        }
        loopOffer = 0;
        lastAutoPass = null;
        final RecordActionsMacroSystem m = loopMacro();
        if (!accept) {
            toast("info", "Loop", "Your opponent wants to respond, so play this one out by hand.");
            return null;
        }
        final int n = stopAfter >= 1 && stopAfter < times ? stopAfter : times;
        if (m == null || !m.repeat(n)) {
            return "nothing recorded";
        }
        loopRunning = true;
        passPeer(m);
        if (n < times) {
            toast("info", "Loop", "Your opponent accepted " + n + " of " + times + " and gets priority after that.");
        }
        return null;
    }

    /**
     * While my accepted loop plays on {@code m}, the opponent's priority passes (their other choices still ask); null
     * stops it. It also stops by itself the moment {@code m} stops replaying, before {@link #checkLoop} catches up.
     */
    private void passPeer(final RecordActionsMacroSystem m) {
        final TableSession p = peer;
        if (p == null) {
            return;
        }
        for (final PlayerControllerHuman pch : p.humanControllers()) {
            pch.setPassPriorityWhile(m == null ? null : () -> loopRunning && m.isReplaying());
        }
        p.lastAutoPass = null;
    }

    /** After each bridge-ui task: end the opponent's passing when my loop stops, drop an offer the game moved past. */
    private void checkLoop() {
        if (loopRunning) {
            final RecordActionsMacroSystem m = loopMacro();
            if (m == null || !m.isReplaying()) {
                loopRunning = false;
                passPeer(null);
                lastAutoPass = null;
            }
        }
        if (loopOffer > 0 && queuePid() != loopOfferPid) {
            loopOffer = 0;
            lastAutoPass = null;
        }
    }

    /** The pid of the Input on top of the seat's queue (it changes whenever a new Input comes up). */
    private long queuePid() {
        synchronized (pidLock) {
            return currentPid;
        }
    }

    /**
     * The optional triggers this seat answers without asking: Forge's own "always yes / always no" store (its
     * Auto-Yield trigger decisions), kept per player in the scope Forge's Auto-decision mode sets (by default per
     * ability, for the match). Sorted, so the notice only changes when an answer does.
     */
    private JsonArray describeAnswers() {
        final java.util.TreeMap<String, String> sorted = readAnswers();
        final JsonArray out = new JsonArray();
        sorted.forEach((key, decision) -> {
            final JsonObject a = new JsonObject();
            a.addProperty("key", key);
            a.addProperty("decision", decision);
            out.add(a);
        });
        return out;
    }

    /**
     * The seat's stored answers, copied. Forge keeps them in a plain HashMap the EDT writes, and this also runs on
     * network threads (a reconnect's snapshot), so reads and the bridge's writes share {@link #answersLock}; the
     * retry covers Forge clearing the store at game end.
     */
    private java.util.TreeMap<String, String> readAnswers() {
        final PlayerControllerHuman pch = seatController;
        for (int attempt = 0; ; attempt++) {
            final java.util.TreeMap<String, String> sorted = new java.util.TreeMap<>();
            if (pch == null) {
                return sorted;
            }
            try {
                synchronized (answersLock) {
                    for (final Map.Entry<String, AutoYieldStore.TriggerDecision> e : pch.getYieldController().getAutoTriggers()) {
                        if (e.getValue() != AutoYieldStore.TriggerDecision.ASK) {
                            sorted.put(e.getKey(), e.getValue() == AutoYieldStore.TriggerDecision.ACCEPT ? "accept" : "decline");
                        }
                    }
                }
                return sorted;
            } catch (final java.util.ConcurrentModificationException e) {
                if (attempt >= 2) {
                    return sorted;
                }
            }
        }
    }

    /** Longest trigger key accepted from a client; Forge's are a card name and a rules sentence. */
    private static final int MAX_TRIGGER_KEY = 2000;
    /** Most answers one seat keeps; a new one past this is refused (a game rarely has more than a handful). */
    static final int MAX_TRIGGER_ANSWERS = 200;
    private final Object answersLock = new Object();

    /**
     * Always answer this optional trigger (bridge-ui): Forge's {@code setTriggerDecision}, which also answers its
     * prompt if that trigger is the one being asked about now. {@code ask} takes the answer back.
     * Returns false when the seat already keeps {@link #MAX_TRIGGER_ANSWERS} and this would add one.
     */
    private boolean setTriggerAnswer(final String key, final AutoYieldStore.TriggerDecision decision) {
        final PlayerControllerHuman original = seatController;
        if (original == null) {
            return true;
        }
        final boolean abilityScope = original.getYieldController().isAbilityScope();
        if (decision != AutoYieldStore.TriggerDecision.ASK) {
            final java.util.TreeMap<String, String> have = readAnswers();
            final String stored = abilityScope ? AutoYieldStore.abilitySuffix(key) : key;
            if (have.size() >= MAX_TRIGGER_ANSWERS && !have.containsKey(stored)) {
                return false;
            }
        }
        synchronized (answersLock) {
            // The store is the seat's; the open prompt may be on the controller in charge now (mind control).
            for (final PlayerControllerHuman pch : humanControllers()) {
                pch.setTriggerDecision(key, decision, abilityScope);
            }
        }
        lastAutoPass = null;
        return true;
    }

    private static AutoYieldStore.TriggerDecision triggerDecision(final String s) {
        return switch (s) {
            case "accept" -> AutoYieldStore.TriggerDecision.ACCEPT;
            case "decline" -> AutoYieldStore.TriggerDecision.DECLINE;
            case "ask" -> AutoYieldStore.TriggerDecision.ASK;
            default -> null;
        };
    }

    /** Record a snooze (network thread); {@link #applySnoozed} then hands it to Forge. */
    void setSnoozed(final String clientId, final boolean on) {
        if (on) {
            snoozed.add(clientId);
        } else {
            snoozed.remove(clientId);
        }
    }

    /** Hand Forge the snoozed cards (by engine id) and tell the client, highlights included. Cards that left the game drop out. */
    private void applySnoozed() {
        final Set<Integer> ids = new java.util.HashSet<>();
        synchronized (snoozed) {
            snoozed.removeIf(id -> card(id) == null);
            for (final String id : snoozed) {
                ids.add(card(id).getId());
            }
        }
        for (final PlayerControllerHuman pch : humanControllers()) {
            forge.ai.AvailableActions.setSnoozed(pch.getPlayer(), ids);
            // The playable highlights were scanned when priority began: a card that just woke (or dozed off) changes them.
            pch.refreshActionableCards();
        }
        flushAutoPass();
    }

    /** Send the auto-pass state if it changed (bridge-ui). Forge flips the yield on the game thread too. */
    private void flushAutoPass() {
        final JsonObject state = describeAutoPass();
        if (state.equals(lastAutoPass)) {
            return;
        }
        lastAutoPass = state;
        notice("autoPass", state);
    }

    /** Push the auto-skip toggle to every controller (bridge-ui). Turning it on while sitting at a priority
     *  prompt with nothing to do passes at once, as Classic's toggle does. */
    private void applyAutoSkip() {
        final YieldUpdate u = autoSkipPref();
        for (final PlayerControllerHuman pch : humanControllers()) {
            pch.applyYieldUpdate(u);
        }
        lastAutoPass = null;
    }

    /** Push the auto-resolve toggle to every controller (bridge-ui). Turning it on with my own spell on top passes at once. */
    private void applyAutoResolve() {
        final YieldUpdate u = autoResolvePref();
        for (final PlayerControllerHuman pch : humanControllers()) {
            pch.applyYieldUpdate(u);
        }
        lastAutoPass = null;
    }

    /** Start or stop passing until end of turn (bridge-ui): Forge's End Turn yield and its cancel. */
    private void setPassUntilEndOfTurn(final boolean on) {
        if (on) {
            final IGameController c = gui.getGameController() != null ? gui.getGameController() : seatController;
            if (c instanceof PlayerControllerHuman pch && pch.getLocalPlayerView() != null) {
                // Passes a priority prompt that's on screen right away.
                YieldController.endTurn(pch, pch.getLocalPlayerView());
            }
        } else {
            for (final PlayerControllerHuman pch : humanControllers()) {
                pch.getYieldController().clearActiveYieldAndDispatch();
            }
        }
        lastAutoPass = null;
    }

    private void passUntilStackEmpty() {
        final IGameController c = gui.getGameController() != null ? gui.getGameController() : seatController;
        if (c instanceof PlayerControllerHuman pch && pch.getLocalPlayerView() != null) {
            pch.sendYieldUpdate(new YieldUpdate.StackYield(pch.getLocalPlayerView(), true, true));
        }
        lastAutoPass = null;
    }

    private void onQueueChanged(final InputQueue queue) {
        final Input top = queue.getInput();
        synchronized (pidLock) {
            if (pidCounter == 0 || top != currentQueueInput) {
                currentQueueInput = top;
                currentPid = ++pidCounter;
            }
        }
    }

    /**
     * The current pid if the Input being shown is the one the observer last saw, else {@code -1} (the queue
     * has moved on and {@code InputProxy} hasn't caught up yet).
     */
    long consistentPid() {
        final PlayerControllerHuman pch = seatController;
        if (pch == null) {
            return -1;
        }
        final Input shown = pch.getInputProxy().getInput();
        synchronized (pidLock) {
            final boolean same = shown == currentQueueInput
                    || (currentQueueInput == null && (shown == null || shown instanceof InputLockUI));
            return same ? currentPid : -1;
        }
    }

    /** The Input InputProxy is currently showing (null before the seat has a controller). */
    Input shownInput() {
        final PlayerControllerHuman pch = seatController;
        return pch == null ? null : pch.getInputProxy().getInput();
    }

    /** pid to tag a blocking prompt with: the shown Input's pid when raised from an Input handler. */
    long spawningPid() {
        if (!FThreads.isGuiThread()) {
            return 0;
        }
        return Math.max(0, consistentPid());
    }

    private boolean isPromptOutstanding() {
        if (prompts.hasOutstanding()) {
            return true;
        }
        final PlayerControllerHuman pch = seatController;
        return pch != null && pch.getInputQueue().getInput() instanceof InputSynchronized;
    }

    /** Runs at the end of every bridge-ui task: send the prompt bar if it changed. */
    public void flushPrompt() {
        checkLoop();
        final PlayerControllerHuman pch = seatController;
        if (pch == null || outbox.projector() == null) {
            return;
        }
        flushAutoPass();
        final long pid = consistentPid();
        if (pid < 0) {
            return;
        }
        final Input shown = pch.getInputProxy().getInput();
        final String kind = InputDescriber.kind(shown);
        final boolean fresh = gui.messagePid() == pid;
        if (!fresh && !"waiting".equals(kind)) {
            // A new Input is up but hasn't drawn its prompt yet: take the old one off screen meanwhile.
            synchronized (outbox.lock()) {
                if (lastSentPid != pid && !lastPromptCleared) {
                    final JsonObject clear = new JsonObject();
                    clear.addProperty("t", "promptClear");
                    clear.addProperty("pid", lastSentPid);
                    outbox.sendOrdered(clear, null);
                    lastPromptCleared = true;
                }
            }
            return;
        }
        if (!gui.isPromptDirty() && pid == lastSentPid) {
            return;
        }
        final boolean canUndo = "priority".equals(kind) && pch.canUndoLastAction();
        synchronized (outbox.lock()) {
            outbox.settle();
            final ViewProjector projector = outbox.projector();
            final JsonObject body = fresh ? gui.describePrompt(projector) : blankPrompt();
            if (fresh) {
                CombatInput.describe(shown, projector.sentRefs(), body);
                // Only one way to pay what's left (OnlyWay): the client may press Auto for the player.
                if ("payMana".equals(kind) && body.getAsJsonObject("ok").get("enabled").getAsBoolean()
                        && OnlyWay.unambiguous(shown, pch.getGame())) {
                    body.addProperty("unambiguous", true);
                }
            }
            body.addProperty("kind", kind);
            body.addProperty("pid", pid);
            if (seat != null) {
                body.addProperty("seat", "p" + seat.getId());
            }
            if (canUndo) {
                body.addProperty("canUndo", true);
            }
            // "Use the triggered ability?": its Auto-Yield key, so the client can offer Always yes / Always no.
            if (fresh && shown instanceof InputConfirm ic && ic.getSpellAbility() instanceof WrappedAbility w) {
                body.addProperty("triggerKey", w.yieldKey());
            }
            if (pid == lastSentPid && body.equals(lastPrompt)) {
                gui.clearPromptDirty();
                return;
            }
            final JsonObject msg = body.deepCopy();
            msg.addProperty("t", pid == lastSentPid ? "promptUpdate" : "prompt");
            outbox.sendOrdered(msg, null);
            lastSentPid = pid;
            lastPrompt = body;
            lastPromptCleared = false;
            gui.clearPromptDirty();
        }
    }

    private static JsonObject blankPrompt() {
        final JsonObject p = new JsonObject();
        p.addProperty("message", "");
        final JsonObject off = new JsonObject();
        off.addProperty("label", "");
        off.addProperty("enabled", false);
        p.add("ok", off);
        p.add("cancel", off.deepCopy());
        p.addProperty("focusOk", false);
        p.add("selectable", new JsonArray());
        p.add("highlighted", new JsonArray());
        p.add("weak", new JsonObject());
        return p;
    }

    void gameFinished() {
        final GameView gv = outbox.gameView();
        final JsonObject msg = new JsonObject();
        msg.addProperty("t", "gameOver");
        if (gv != null) {
            if (gv.getWinningPlayerName() != null) {
                msg.addProperty("winner", gv.getWinningPlayerName());
            }
            msg.addProperty("matchOver", gv.isMatchOver());
            // GameView's count updates after finishGame; the match's outcomes already include this game.
            final int played = gv.getGame() != null ? gv.getGame().getMatch().getOutcomes().size() : gv.getNumPlayedGamesInMatch();
            msg.addProperty("gamesPlayed", Math.max(played, gv.getNumPlayedGamesInMatch()));
            msg.addProperty("gamesInMatch", gv.getNumGamesInMatch());
            if (seat != null) {
                msg.addProperty("won", won(gv));
            }
        }
        saveStops();
        final Consumer<Game> done = onGameFinished;
        if (done != null && gv != null && gv.getGame() != null) {
            try {
                done.accept(gv.getGame());
            } catch (final RuntimeException e) {
                forge.bridge.BridgeLog.error("recording the game's result", e);
            }
        }
        gameOver = msg;
        outbox.sendOrdered(msg, null);
    }

    /**
     * Whether this seat won, from the game's outcome (set before the outcome event fires). The views can lag: a concede
     * from the other thread while the tracker is frozen queues HasLost, so the loser's view could still say "not lost"
     * here. The views are the fallback for a game we don't hold.
     */
    private boolean won(final GameView gv) {
        final Game game = gv.getGame();
        final GameOutcome outcome = game == null ? null : game.getOutcome();
        final Player me = outcome == null ? null : game.getPlayer(seat.getId());
        if (me != null) {
            return outcome.isWinner(me.getRegisteredPlayer());
        }
        return !seat.getHasLost() && gv.getWinningPlayerName() != null;
    }

    void afterGameEnd() {
        prompts.cancelAll();
    }

    /** Persist the phase ladder to PHASE_HUMAN_* / PHASE_AI_*, as CMatchUI.writeMatchPreferences does. */
    private void saveStops() {
        final GameView gv = outbox.gameView();
        if (gv == null) {
            return;
        }
        final ForgePreferences prefs = FModel.getPreferences();
        final PhaseType[] phases = PhaseType.values();
        for (final PlayerView pv : gv.getPlayers()) {
            final FPref[] keys = gui.isLocalPlayer(pv) ? FPref.PHASES_HUMAN : FPref.PHASES_AI;
            for (int p = 1; p < phases.length && p - 1 < keys.length; p++) {
                prefs.setPref(keys[p - 1], gui.isStop(pv, phases[p]));
            }
        }
        prefs.save();
    }

    void notice(final String kind, final JsonObject data) {
        final JsonObject msg = data.deepCopy();
        msg.addProperty("t", "notice");
        msg.addProperty("kind", kind);
        outbox.sendUnordered(msg);
    }

    public void toast(final String level, final String title, final String message) {
        final JsonObject n = new JsonObject();
        n.addProperty("level", level);
        if (title != null) {
            n.addProperty("title", title);
        }
        n.addProperty("message", message == null ? "" : message);
        notice("toast", n);
    }

    public int askOptions(final String title, final String message, final List<String> options, final int defaultOption) {
        final JsonObject payload = new JsonObject();
        if (title != null) {
            payload.addProperty("title", title);
        }
        payload.addProperty("message", message == null ? "" : message);
        final JsonArray labels = new JsonArray();
        options.forEach(labels::add);
        payload.add("options", labels);
        payload.addProperty("default", defaultOption);
        return prompts.ask(options.size() <= 3 ? "confirm" : "options", payload, spawningPid(), reply -> {
            final int i = reply.getAsInt();
            if (i < 0 || i >= options.size()) {
                throw new PromptService.InvalidReply("Invalid option");
            }
            return i;
        }, new JsonPrimitive(defaultOption));
    }

    public String askText(final String title, final String message, final String initial, final List<String> options, final boolean numeric) {
        final JsonObject payload = new JsonObject();
        if (title != null) {
            payload.addProperty("title", title);
        }
        payload.addProperty("message", message == null ? "" : message);
        if (initial != null) {
            payload.addProperty("initial", initial);
        }
        if (options != null && !options.isEmpty()) {
            final JsonArray arr = new JsonArray();
            options.forEach(arr::add);
            payload.add("options", arr);
        }
        payload.addProperty("numeric", numeric);
        return prompts.ask("text", payload, spawningPid(), reply -> {
            if (reply == null || reply.isJsonNull()) {
                return null;
            }
            final String s = reply.getAsString();
            if (options != null && !options.isEmpty() && !options.contains(s)) {
                throw new PromptService.InvalidReply("Choose one of the listed options");
            }
            if (numeric && !s.matches("-?\\d+")) {
                throw new PromptService.InvalidReply("Enter a number");
            }
            return s;
        }, JsonNull.INSTANCE);
    }

    // ---------------------------------------------------------------- client side

    /** What a (re)connecting client needs beyond the mirror: prompt bar, open asks, stops, game over. */
    private JsonObject resumeExtras() {
        final JsonObject extra = new JsonObject();
        if (lastPrompt != null && !lastPromptCleared) {
            final JsonObject p = lastPrompt.deepCopy();
            extra.add("prompt", p);
        }
        final JsonArray asks = new JsonArray();
        prompts.outstanding().forEach(asks::add);
        extra.add("asks", asks);
        extra.add("stops", gui.describeStops());
        extra.add("autoPass", describeAutoPass());
        if (gameOver != null) {
            extra.add("gameOver", gameOver);
        }
        final Supplier<JsonObject> p = presence;
        if (p != null) {
            extra.add("presence", p.get());
        }
        return extra;
    }

    /** A client attached (or re-attached): configure pacing and send a snapshot from the mirror. */
    public void attach(final Consumer<String> sink, final JsonObject client) {
        final double speed = client != null && client.has("speed") ? client.get("speed").getAsDouble() : 1.0;
        final java.util.Map<String, Integer> costs = new java.util.HashMap<>();
        if (client != null && client.has("beatCosts")) {
            client.getAsJsonObject("beatCosts").entrySet().forEach(e -> costs.put(e.getKey(), e.getValue().getAsInt()));
        }
        pacer.configure(speed, costs);
        if (client != null && client.has("autoSkip") && client.get("autoSkip").getAsBoolean() != autoSkip) {
            autoSkip = client.get("autoSkip").getAsBoolean();
            // Before the game: installController picks it up. On a reconnect: push it to the live controllers.
            base.invokeInEdtLater(this::applyAutoSkip);
        }
        synchronized (outbox.lock()) {
            outbox.setSink(sink);
            if (outbox.projector() != null) {
                outbox.sendSnapshot(resumeExtras());
            }
        }
        pacer.setAttached(true);
    }

    public void detach(final Consumer<String> sink) {
        synchronized (outbox.lock()) {
            outbox.setSink(null);
        }
        pacer.setAttached(false);
    }

    /** Handle a client message for this match. Runs on the network thread. */
    public void onClientMessage(final JsonObject msg) {
        final String t = msg.has("t") ? msg.get("t").getAsString() : "";
        switch (t) {
            case "ack" -> pacer.ack(msg.get("playedSeq").getAsLong(), msg.has("hidden") && msg.get("hidden").getAsBoolean());
            case "reply" -> {
                final String id = msg.get("id").getAsString();
                if (!prompts.reply(id, msg.get("value"))) {
                    staleNotice(msg, "no such prompt");
                }
            }
            case "act" -> onAct(msg);
            default -> BridgeLog.warn("Unknown match message type: " + t);
        }
    }

    private void onAct(final JsonObject act) {
        final String kind = act.has("kind") ? act.get("kind").getAsString() : "";
        switch (kind) {
            case "concede" -> concede();
            case "nextGame" -> {
                final NextGameDecision d = NextGameDecision.valueOf(act.get("decision").getAsString());
                base.invokeInEdtLater(() -> {
                    for (final IGameController c : gui.getOriginalGameControllers()) {
                        c.nextGameDecision(d);
                    }
                    if (d == NextGameDecision.QUIT) {
                        prompts.cancelAll();
                        final Runnable r = onMatchEnded;
                        if (r != null) {
                            r.run();
                        }
                    }
                });
            }
            case "skipAnim" -> pacer.skipAll();
            case "speed" -> pacer.setSpeed(act.get("value").getAsDouble());
            case "phaseStop" -> base.invokeInEdtLater(() -> togglePhaseStop(act));
            case "autoSkip" -> {
                autoSkip = act.get("on").getAsBoolean();
                base.invokeInEdtLater(this::applyAutoSkip);
            }
            case "autoResolve" -> {
                autoResolve = act.get("on").getAsBoolean();
                base.invokeInEdtLater(this::applyAutoResolve);
            }
            case "loop" -> {
                final String op = act.has("op") && act.get("op").isJsonPrimitive() ? act.get("op").getAsString() : "";
                final int times = intField(act, "times");
                base.invokeInEdtLater(() -> {
                    final String why = loopAct(op, times);
                    if (why != null) {
                        staleNotice(act, why);
                    }
                });
            }
            case "loopAnswer" -> {
                final boolean accept = act.has("accept") && act.get("accept").isJsonPrimitive() && act.get("accept").getAsBoolean();
                final int stopAfter = intField(act, "stopAfter");
                final long offerId = act.has("offerId") && act.get("offerId").isJsonPrimitive() ? act.get("offerId").getAsLong() : -1;
                base.invokeInEdtLater(() -> {
                    final TableSession p = peer;
                    final String why = p == null ? "no loop to answer" : p.answerLoop(offerId, accept, stopAfter);
                    if (why != null) {
                        staleNotice(act, why);
                    }
                });
            }
            case "triggerAnswer" -> {
                final String key = act.has("key") && act.get("key").isJsonPrimitive() ? act.get("key").getAsString() : "";
                final AutoYieldStore.TriggerDecision d = act.has("decision") && act.get("decision").isJsonPrimitive()
                        ? triggerDecision(act.get("decision").getAsString()) : null;
                if (key.isEmpty() || key.length() > MAX_TRIGGER_KEY || d == null) {
                    staleNotice(act, "bad trigger answer");
                    return;
                }
                base.invokeInEdtLater(() -> {
                    if (!setTriggerAnswer(key, d)) {
                        staleNotice(act, "too many trigger answers");
                    }
                });
            }
            case "snooze" -> {
                setSnoozed(act.get("card").getAsString(), act.get("on").getAsBoolean());
                base.invokeInEdtLater(this::applySnoozed);
            }
            case "yield" -> {
                // yield{until: endOfTurn} starts passing; yield{clear} is its own act, never a cancel.
                final boolean clear = act.has("clear") && act.get("clear").getAsBoolean();
                final String until = act.has("until") ? act.get("until").getAsString() : "";
                if (!clear && "stackEmpty".equals(until)) {
                    // Resolve all: pass until the stack is empty; Forge's interrupts (an opponent's new spell…)
                    // stop it, as they stop pass-turn.
                    base.invokeInEdtLater(this::passUntilStackEmpty);
                    return;
                }
                if (!clear && !"endOfTurn".equals(until)) {
                    staleNotice(act, "unknown yield");
                    return;
                }
                base.invokeInEdtLater(() -> setPassUntilEndOfTurn(!clear));
            }
            default -> base.invokeInEdtLater(() -> runInputAct(act, kind));
        }
    }

    /** This seat concedes: every one of its original controllers (the act {@code concede}, or a claimed win against it). */
    public void concede() {
        prompts.cancelAll();
        base.invokeInEdtLater(() -> concedeWhenSafe(0));
    }

    /**
     * Forge's concede (PlayerControllerHuman.concede) runs the game-over check on this thread: Game.onPlayerLost
     * drops the player from the game's lists. Safe only while the game thread is parked at a human's Input (answers
     * come on this same thread, so it stays parked). While the game thread runs (dealing, drawing, auto-passing, the
     * AI thinking) that killed it with a ConcurrentModificationException and one seat never got its gameOver.
     * Then only the outcome is set, which the game thread's own state-based check acts on, and this looks again soon.
     */
    private void concedeWhenSafe(final int tries) {
        final GameView gv = outbox.gameView();
        final Game game = gv == null ? null : gv.getGame();
        if (game != null && game.isGameOver()) {
            return;
        }
        if (game == null || tries >= CONCEDE_TRIES || gameThreadParked(game)) {
            for (final IGameController c : gui.getOriginalGameControllers()) {
                c.concede();
            }
            return;
        }
        for (final IGameController c : gui.getOriginalGameControllers()) {
            if (c instanceof PlayerControllerHuman pch && pch.getPlayer() != null) {
                pch.getPlayer().concede();
            }
        }
        CompletableFuture.delayedExecutor(CONCEDE_RETRY_MS, TimeUnit.MILLISECONDS).execute(() -> base.invokeInEdtLater(() -> concedeWhenSafe(tries + 1)));
    }

    private static final int CONCEDE_TRIES = 150;
    private static final long CONCEDE_RETRY_MS = 200;

    /** Whether the game thread waits on a human's synchronous Input (any seat's). */
    private static boolean gameThreadParked(final Game game) {
        try {
            for (final Player p : new ArrayList<>(game.getRegisteredPlayers())) {
                if (p.getController() instanceof PlayerControllerHuman pch && pch.getInputQueue().getInput() instanceof InputSynchronized) {
                    return true;
                }
            }
        } catch (final ConcurrentModificationException e) {
            // The game thread is changing the players: it isn't parked.
        }
        return false;
    }

    private void togglePhaseStop(final JsonObject act) {
        final PlayerView pv = player(act.get("player").getAsString());
        if (pv == null) {
            return;
        }
        final PhaseType phase = PhaseType.valueOf(act.get("phase").getAsString());
        gui.setStop(pv, phase, act.get("stop").getAsBoolean());
        // Push to every original controller, like NetworkGuiGame.pushSkipPhaseToControllers: turning a stop
        // off while sitting at it passes priority immediately.
        for (final IGameController c : gui.getOriginalGameControllers()) {
            c.applyYieldUpdate(new YieldUpdate.SkipPhase(pv, phase, gui.isUiSetToSkipPhase(pv, phase)));
        }
        final JsonObject n = new JsonObject();
        n.add("stops", gui.describeStops());
        notice("stops", n);
    }

    /** Input-scoped acts, on bridge-ui. */
    private void runInputAct(final JsonObject act, final String kind) {
        final long pid = act.has("pid") ? act.get("pid").getAsLong() : -1;
        final long current = consistentPid();
        final boolean shown;
        synchronized (outbox.lock()) {
            shown = pid == lastSentPid && !lastPromptCleared;
        }
        if (pid != current || !shown || prompts.hasOutstanding()) {
            staleNotice(act, "stale pid");
            return;
        }
        final IGameController c = gui.getGameController();
        if (c == null) {
            staleNotice(act, "no controller");
            return;
        }
        switch (kind) {
            case "ok" -> c.selectButtonOk();
            case "cancel" -> c.selectButtonCancel();
            case "card" -> {
                final CardView cv = card(act.get("card").getAsString());
                if (cv == null) {
                    staleNotice(act, "unknown card");
                    return;
                }
                c.selectCard(cv, null, null);
            }
            case "player" -> {
                final PlayerView pv = player(act.get("player").getAsString());
                if (pv == null) {
                    staleNotice(act, "unknown player");
                    return;
                }
                c.selectPlayer(pv, null);
            }
            case "mana" -> c.useMana(MagicColor.fromName(act.get("color").getAsString()));
            case "alphaStrike" -> c.alphaStrike();
            case "undo" -> c.undoLastAction();
            case "block", "unblock", "attack" -> runCombatAct(act, kind, c);
            default -> staleNotice(act, "unknown act " + kind);
        }
    }

    /** {@code block}, {@code unblock}, {@code attack}: Forge's own clicks, in one bridge-ui task. */
    private void runCombatAct(final JsonObject act, final String kind, final IGameController c) {
        if (!(c instanceof PlayerControllerHuman pch)) {
            staleNotice(act, "no controller");
            return;
        }
        final Input in = pch.getInputProxy().getInput();
        final boolean blocking = !"attack".equals(kind);
        if (blocking ? !(in instanceof InputBlock) : !(in instanceof InputAttack)) {
            staleNotice(act, blocking ? "not declaring blockers" : "not declaring attackers");
            return;
        }
        final Card first = engineCard(pch, act, blocking ? "blocker" : "attacker");
        if (first == null) {
            staleNotice(act, "unknown card");
            return;
        }
        final CombatInput.Outcome out;
        switch (kind) {
            case "block" -> {
                final Card attacker = engineCard(pch, act, "attacker");
                if (attacker == null) {
                    staleNotice(act, "unknown card");
                    return;
                }
                out = CombatInput.block(pch, (InputBlock) in, first, attacker);
            }
            case "unblock" -> out = CombatInput.unblock(pch, (InputBlock) in, first);
            default -> {
                final String ref = act.has("defender") ? act.get("defender").getAsString() : "";
                final GameEntity defender;
                if (ref.startsWith("p")) {
                    final PlayerView pv = player(ref);
                    defender = pv == null ? null : pch.getGame().getPlayer(pv);
                } else {
                    defender = engineCard(pch, act, "defender");
                }
                if (defender == null) {
                    staleNotice(act, "unknown defender");
                    return;
                }
                out = CombatInput.attack(pch, (InputAttack) in, first, defender);
            }
        }
        if (out.refused() != null) {
            staleNotice(act, out.refused());
        } else if (out.illegal()) {
            gui.flashIncorrectAction();
        }
    }

    private Card engineCard(final PlayerControllerHuman pch, final JsonObject act, final String key) {
        if (!act.has(key) || !act.get(key).isJsonPrimitive()) {
            return null;
        }
        final CardView cv = card(act.get(key).getAsString());
        return cv == null ? null : pch.getCard(cv);
    }

    private CardView card(final String clientId) {
        synchronized (outbox.lock()) {
            final ViewProjector p = outbox.projector();
            return p == null || clientId.startsWith("x") ? null : p.resolve(clientId);
        }
    }

    private PlayerView player(final String ref) {
        final GameView gv = outbox.gameView();
        if (gv == null || !ref.startsWith("p")) {
            return null;
        }
        final int id;
        try {
            id = Integer.parseInt(ref.substring(1));
        } catch (final NumberFormatException e) {
            return null;
        }
        for (final PlayerView pv : gv.getPlayers()) {
            if (pv.getId() == id) {
                return pv;
            }
        }
        return null;
    }

    /** A whole-number field of a client message, or 0 when it's missing or not a number. */
    private static int intField(final JsonObject msg, final String name) {
        if (!msg.has(name) || !msg.get(name).isJsonPrimitive() || !msg.get(name).getAsJsonPrimitive().isNumber()) {
            return 0;
        }
        final double d = msg.get(name).getAsDouble();
        return d == Math.rint(d) && Math.abs(d) <= Integer.MAX_VALUE ? (int) d : 0;
    }

    private void staleNotice(final JsonObject msg, final String why) {
        final JsonObject n = new JsonObject();
        n.add("act", msg);
        n.addProperty("reason", why);
        notice("stale", n);
        BridgeLog.debug("stale: " + why + " " + msg);
    }

    /** Stop the match's prompts (session teardown). */
    public void close() {
        prompts.close();
        pacer.setAttached(false);
    }
}

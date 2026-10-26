/**
 * Wires the client together: message source → Director → (Zustand HUD store, Pixi scene), one
 * requestAnimationFrame loop for all of it, the 20 Hz ack timer, user actions, and the test hooks.
 */
import { loadManaFont } from './theme/manaFont';
import type {
  ActMsg,
  AskMsg,
  AutoPassState,
  CardId,
  ClientInfo,
  DeckImportParams,
  DeckImportResult,
  DeckProblems,
  MatchStartParams,
  MatchStartResult,
  NextGameDecision,
  NoticeMsg,
  Phase,
  PlayerId,
  PvpMsg,
  ServerMessage,
  TriggerDecision,
  WelcomeMsg,
} from '@forge-table/protocol';
import { isSequenced } from '@forge-table/protocol';
import { cardArt, cropArt } from './cards/art';
import { loadM15Fonts } from './cards/m15/fonts';
import { AimController } from './arrows/controller';
import type { Box } from './arrows/geometry';
import { ART_PREF, AUTO_SKIP_PREF, CARD_SIZE_PREF, asCardSize, type AppConfig, type ArtMode, loadArtMode, loadAutoSkip, loadPref, savePref } from './config';
import { Director, type Effects } from './director/director';
import { beatCosts } from './director/choreography';
import { AutoPay, paying } from './hud/autoPay';
import { rememberedAnswer } from './hud/autoResponses';
import { primaryLabel, type ButtonSpec, type Buttons } from './hud/primaryLabel';
import { aiCopy, defaultAi, legalDeck, setNeuralLabel } from './hud/start';
import { takeHandoff } from './lobby/newGame';
import { gameIdFromPath, rememberedDeck } from './lobby/pvp';
import { LiveConnection } from './net/connection';
import { ReplaySource } from './net/replay';
import type { MessageSource } from './net/source';
import { guestTable, imageUrl, takeToken, underRouter, wsUrl } from './net/token';
import type { PileZone } from './overlays/zoneView';
import { useUi, type Toast } from './store/uiStore';
import { CARD_SCALE, plateBox, type CardSize } from './layout/geometry';
import { isAbilityId, stackItemFor } from './layout/stack';
import { previewsOnHover, zone } from './store/model';
import { HandDragController, handClick } from './table/handDrag';
import { TableScene } from './table/scene';
import { RealClock, VirtualClock, type Clock } from './util/clock';

const ACK_INTERVAL_MS = 50;
const FRAME_MS = 16;
export const SPEEDS = [0.5, 1, 1.5, 2, 0] as const;

type FrameSub = (now: number) => void;

interface PromptWaiter {
  test: () => boolean;
  resolve: () => void;
  reject: (e: Error) => void;
  deadline: number;
}

export class Runtime {
  readonly clock: Clock;
  readonly director: Director;
  readonly scene: TableScene;
  /** Aiming: blocker-first blocks, drags, the pending arrow and the table's arrows (arrows/controller.ts). */
  readonly aim: AimController;
  /** Drag to play (and to reorder) my hand's cards (table/handDrag.ts). */
  readonly handDrag: HandDragController;
  /** Presses Auto when the bridge says a cost can only be paid one way (hud/autoPay.ts). */
  private readonly autoPay: AutoPay;
  /** Whether the HUD's prompt is the auto-paid one shown as waiting (re-pushed when that times out). */
  private autoPayHidden = false;
  source!: MessageSource;
  /** Tests: the acts sent (a replay's source drops them). */
  private sentActs: ActMsg[] = [];
  private frameSubs = new Set<FrameSub>();
  private lastVersion = -1;
  private lastBacklogPush = -Infinity;
  private toastSeq = 0;
  private waiters: PromptWaiter[] = [];
  private lastClick: { card: CardId; at: number } | null = null;
  private autoAnswered = new Set<string>();
  private raf = 0;
  private ackTimer = 0;
  private perfSamples: number[] = [];
  private lastRealFrame = 0;
  /** Alt is down: the hover preview shows for hand cards too. */
  private altHeld = false;
  /** Shift is down: a card cast now pays by hand (no auto-pay for it). */
  private shiftHeld = false;
  /** The last card act was sent with Shift held: its payment isn't auto-paid. */
  private payByHand = false;
  /** Where the sidecar serves the Neural AI's picture (asked for only when the welcome says it has one). */
  neuralAvatarUrl: string | null = null;

  constructor(readonly config: AppConfig) {
    this.clock = config.test ? new VirtualClock(0) : new RealClock();
    const prefersReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const storedSpeed = Number(loadPref('speed') ?? '1');
    const speed = config.speed ?? (config.test ? 1 : Number.isFinite(storedSpeed) ? storedSpeed : 1);
    this.director = new Director({ clock: this.clock, speed, reducedMotion: config.reducedMotion ?? (config.test ? false : prefersReduced) });
    const fx = loadPref('effects');
    if (!config.test && (fx === 'lite' || fx === 'off')) this.director.effects = fx;
    this.scene = new TableScene(
      this.director,
      {
        onCardClick: (id, pointerType) => this.clickCard(id, pointerType),
        onHover: (id) => this.hover(id),
        onPileClick: (player, zone) => this.openZone(player, zone),
        onCardDown: (id, x, y) => {
          this.aim.cardDown(id, x, y);
          this.handDrag.cardDown(id, x, y);
        },
        onCardSnooze: (id) => {
          // The right-click that put a carried card back is not a snooze; an ability on the stack can't be snoozed.
          if (!this.handDrag.swallowSnooze() && !isAbilityId(id)) this.toggleSnooze(id);
        },
        onCardLongPress: (id) => {
          const card = this.previewOf(id);
          if (!this.handDrag.dragging && card) useUi.setState({ pinned: card, preview: null });
        },
        onTableDown: () => {
          if (useUi.getState().pinned) useUi.setState({ pinned: null });
        },
        onHandDismiss: () => useUi.setState({ handUp: false, handFocus: null }),
      },
      cardArt,
      cropArt,
    );
    this.aim = new AimController({
      model: () => this.director.shown,
      viewer: () => this.director.viewer,
      prompt: () => this.director.prompt,
      inputLive: () => this.inputLive,
      send: (act) => this.inputAct(act),
      toTable: (x, y) => this.scene.toTable(x, y),
      cardAt: (p) => this.scene.cardAt(p),
      visible: (id) => !!this.scene.poseOf(id),
      hovered: () => this.scene.hovered,
      canvas: () => (this.scene.app.renderer ? (this.scene.app.canvas as HTMLCanvasElement) : null),
      onDropPlates: (players) => useUi.setState({ dropPlates: players }),
      onPicked: (card) => useUi.setState({ aimPicked: card }),
    });
    this.handDrag = new HandDragController({
      model: () => this.director.shown,
      viewer: () => this.director.viewer,
      prompt: () => this.director.prompt,
      inputLive: () => this.inputLive,
      toTable: (x, y) => this.scene.toTable(x, y),
      spritePose: (id) => this.scene.spritePose(id),
      geo: () => this.scene.geo,
      handX: () =>
        [...this.scene.layout().cards.values()]
          .filter((c) => c.region === 'hand')
          .sort((a, b) => a.x - b.x)
          .map((c) => ({ id: c.id, x: c.x })),
      altIds: () => this.scene.altCards.map((a) => a.id),
      onHandOrder: (order) => useUi.setState({ handOrder: order }),
      calm: () => this.director.calm,
      now: () => this.clock.now(),
      // Picked up: a raised touch hand goes down behind it, previews go away.
      onLift: () => {
        const ui = useUi.getState();
        if (ui.handUp || ui.handFocus || ui.preview || ui.pinned) useUi.setState({ handUp: false, handFocus: null, preview: null, pinned: null });
      },
      play: (id) => this.playFromHand(id),
      blocked: () => this.visibleAsks().length > 0,
    });
    this.autoPay = new AutoPay({
      enabled: () => !this.payByHand,
      now: () => this.clock.now(),
      press: () => this.inputAct({ kind: 'ok' }),
    });
    const cardSize = config.cards ?? (config.test ? 'M' : (asCardSize(loadPref(CARD_SIZE_PREF)) ?? 'M'));
    this.scene.setCardScale(CARD_SCALE[cardSize]);
    // Real card art: never under ?test=1, ?replay=… or ?art=0 (deterministic runs stay procedural).
    const artMode = loadArtMode();
    cardArt.setEnabled(config.artAllowed && artMode === 'scryfall');
    cropArt.setEnabled(config.artAllowed && artMode === 'frame');
    useUi.setState({
      speed: this.director.speed,
      cardSize,
      reducedMotion: this.director.reducedMotion,
      effects: this.director.effects,
      test: config.test,
      artMode,
      artAllowed: config.artAllowed,
      autoPass: { autoSkip: loadAutoSkip(), untilEndOfTurn: false },
    });
  }

  // ------------------------------------------------------------------------------------- lifecycle

  async start(host: HTMLElement): Promise<void> {
    await loadFonts();
    await this.scene.init(host, { resolution: this.config.test ? 1 : Math.min(2, window.devicePixelRatio || 1), test: this.config.test });
    this.aim.attach(window);
    this.handDrag.attach(window);
    const onResize = () => this.scene.resize(host.clientWidth, host.clientHeight);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', (e) => (this.setAlt(e.altKey), (this.shiftHeld = e.shiftKey)));
    window.addEventListener('keyup', (e) => (this.setAlt(e.altKey), (this.shiftHeld = e.shiftKey)));
    window.addEventListener('blur', () => (this.setAlt(false), (this.shiftHeld = false)));
    document.addEventListener('visibilitychange', () => {
      // Returning from a hidden tab: the server ran unpaced meanwhile; collapse the backlog.
      if (!document.hidden && this.director.busy) this.director.collapse();
    });

    if (this.config.replay) {
      const replay = new ReplaySource(this.config.replay, {
        clock: this.clock,
        isIdle: () => !this.director.busy,
        speed: () => this.director.speed,
        backlogMs: () => this.director.backlogMs(),
      });
      this.source = replay;
      replay.start((m) => this.onMessage(m), (s) => useUi.setState({ status: s }));
      await replay.load();
    } else {
      // Behind the multi-game router with a proxy login there is no token: the router knows the player.
      const token = takeToken() ?? (underRouter() ? '' : null);
      if (token === null) {
        useUi.setState({ status: 'closed' });
        this.toast('error', 'No session token', 'Open Forge Table from the link the server printed (it ends in #t=…).');
        this.frame();
        return;
      }
      cardArt.setUrl((key) => imageUrl(key, token));
      cropArt.setUrl((key) => imageUrl(key, token, window.location, 'crop'));
      this.neuralAvatarUrl = imageUrl('neural', token, window.location, 'avatar');
      this.source = new LiveConnection({ url: wsUrl(), token, client: () => this.clientInfo() });
      this.source.start((m) => this.onMessage(m), (s) => useUi.setState({ status: s }));
      this.ackTimer = window.setInterval(() => {
        this.source.ack(this.director.playedSeq, this.director.backlogMs(), document.hidden);
      }, ACK_INTERVAL_MS);
    }
    this.installTestHooks();
    this.frame();
    if (!this.config.test) this.loop();
  }

  clientInfo(): ClientInfo {
    return {
      speed: this.director.speed,
      reducedMotion: this.director.reducedMotion,
      beatCosts: beatCosts(),
      autoSkip: useUi.getState().autoPass.autoSkip,
    };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.config.perf) {
      const t = performance.now();
      if (this.lastRealFrame) this.perfSamples.push(t - this.lastRealFrame);
      this.lastRealFrame = t;
      if (this.perfSamples.length > 3600) this.perfSamples.shift();
    }
    this.frame();
  };

  /** One frame: feed a replay, advance the playhead, sync the HUD, draw the table (unless `render` is false). */
  frame(render = true): void {
    const now = this.clock.now();
    this.source?.pump?.();
    // The table plays itself while I pass the turn, or auto-skip runs the opponent's turn: routine steps go fast.
    const ap = useUi.getState().autoPass;
    this.director.fast = ap.untilEndOfTurn || (ap.autoSkip && this.director.shown.game.playerTurn !== this.director.viewer);
    this.director.update(now);
    const d = this.director;
    if (d.version !== this.lastVersion) this.autoPay.update(d.prompt, this.inputLive);
    const autoPayHidden = this.autoPay.hides(d.prompt);
    if (d.version !== this.lastVersion || autoPayHidden !== this.autoPayHidden) {
      this.lastVersion = d.version;
      this.autoPayHidden = autoPayHidden;
      this.autoAnswerAbility();
      useUi.setState({
        version: d.version,
        viewer: d.viewer,
        shown: d.shown,
        prompt: autoPayHidden && d.prompt ? paying(d.prompt) : d.prompt,
        mull: d.mull,
        asks: this.visibleAsks(),
        gameOver: d.gameOver,
        stops: d.stops,
      });
    }
    if (now - this.lastBacklogPush > 250) {
      this.lastBacklogPush = now;
      const b = Math.round(d.backlogMs(now) / 100) * 100;
      if (b !== useUi.getState().backlogMs) useUi.setState({ backlogMs: b });
    }
    const toasts = useUi.getState().toasts;
    if (toasts.some((t) => t.until <= now)) useUi.setState({ toasts: toasts.filter((t) => t.until > now) });
    const aim = this.aim.frame();
    const drag = this.handDrag.frame();
    this.plates.clear();
    const ui = useUi.getState();
    this.scene.frame(now, { prompt: d.prompt, blocked: this.visibleAsks().length > 0, arrows: aim.arrows, focus: aim.focus, plateBox: this.plateBox, handOrder: ui.handOrder, snoozed: ui.autoPass.snoozed, handUp: ui.handUp, handFocus: ui.handFocus, drag, drops: this.handDrag.takeDrops() }, render);
    for (const sub of this.frameSubs) sub(now);
    this.checkWaiters(now);
  }

  onFrame(sub: FrameSub): () => void {
    this.frameSubs.add(sub);
    return () => this.frameSubs.delete(sub);
  }

  // ------------------------------------------------------------------------------------- messages

  private onMessage(m: ServerMessage): void {
    if (isSequenced(m)) {
      this.director.receive(m);
      return;
    }
    switch (m.t) {
      case 'welcome':
        // Another game process than before (a saved game resumed after a restart): its seqs start over.
        if ((useUi.getState().welcome?.session ?? m.session) !== m.session) this.director.reset();
        setNeuralLabel(m.neural?.label);
        // A fresh welcome (first connect or a reconnect) restarts presence; the server resends it after the snapshot.
        useUi.setState({ welcome: m, inMatch: m.match, matchAi: m.match ? (m.ai ?? null) : null, pvp: m.pvp ? { lobby: m.pvp, presence: null } : null });
        if (!m.match && this.source.kind === 'live') void (m.pvp ? this.preparePvpStart(m) : this.prepareStart(m));
        return;
      case 'pvp':
        this.onPvp(m);
        return;
      case 'snapshot':
        this.director.snapshot(m);
        // A PvP seat's snapshot carries the opponent's presence (the attach snapshot after a reconnect too).
        if (m.presence) this.onPvp({ t: 'pvp', kind: 'presence', ...m.presence });
        useUi.setState((s) => ({ inMatch: true, zoneView: null, autoPass: m.autoPass ?? { ...s.autoPass, untilEndOfTurn: false } }));
        const keys = Object.values(m.cards).map((c) => c.state?.imageKey);
        cardArt.prefetch(keys);
        cropArt.prefetch(keys);
        return;
      case 'notice':
        this.onNotice(m);
        return;
    }
  }

  /** `pvp` messages: the start screen's lobby (who is here, who is ready) and the opponent's presence. */
  private onPvp(m: PvpMsg): void {
    useUi.setState((s) => {
      const seat = s.pvp?.lobby.seat ?? 0;
      if (m.kind === 'lobby') {
        const { t: _t, kind: _k, ...fields } = m;
        return { pvp: { presence: s.pvp?.presence ?? null, lobby: { seat, ...fields } } };
      }
      if (m.kind === 'presence') {
        const lobby = s.pvp?.lobby ?? { seat, you: '', opponent: null, oppReady: false, youReady: false };
        const presence = { opponentConnected: m.opponentConnected, since: m.since, ...(m.claimableAt !== undefined ? { claimableAt: m.claimableAt } : {}) };
        return { pvp: { lobby, presence } };
      }
      return {};
    });
  }

  private onNotice(n: NoticeMsg): void {
    switch (n.kind) {
      case 'toast': {
        const t = n as { level?: string; title?: string; message?: string };
        // The bridge names the AIs by profile ("Neural opponent unavailable"); the UI uses their labels (aiLabel).
        this.toast(t.level === 'error' ? 'error' : 'info', t.title && aiCopy(t.title), aiCopy(t.message ?? ''));
        return;
      }
      case 'stale':
      case 'flash':
        useUi.setState((s) => ({ flash: s.flash + 1 }));
        return;
      case 'zones': {
        const z = n as { show?: Array<{ player?: string; zone?: string }>; hide?: boolean };
        // Shown anew: up again even if the last one was put away, and it covers any big preview (it goes).
        const show = z.hide ? null : (z.show ?? null);
        useUi.setState(show ? { zoneStrip: show, zoneStripDismissed: false, pinned: null, preview: null } : { zoneStrip: null });
        return;
      }
      case 'stops':
        this.director.setStops((n as { stops: Record<string, Phase[]> }).stops);
        return;
      case 'autoPass': {
        const a = n as unknown as AutoPassState;
        useUi.setState({
          autoPass: {
            autoSkip: !!a.autoSkip,
            untilEndOfTurn: !!a.untilEndOfTurn,
            snoozed: a.snoozed ?? [],
            autoResolve: !!a.autoResolve,
            answers: a.answers ?? [],
            ...(a.loop ? { loop: a.loop } : {}),
            ...(a.opponentLoop ? { opponentLoop: a.opponentLoop } : {}),
          },
        });
        return;
      }
      case 'clipboard': {
        const text = (n as { text?: string }).text;
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
        return;
      }
      case 'restart': {
        const secs = Number((n as { seconds?: unknown }).seconds);
        if (Number.isFinite(secs)) useUi.setState({ restartAt: Date.now() + Math.max(0, secs) * 1000 });
        return;
      }
      case 'openUrl': {
        const url = (n as { url?: string }).url;
        if (url && /^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
        return;
      }
      default:
        return; // alert and future kinds: nothing to show yet
    }
  }

  toast(level: 'info' | 'error', title: string | undefined, message: string): void {
    const t: Toast = { id: ++this.toastSeq, level, message, until: this.clock.now() + (level === 'error' ? 7000 : 4500) };
    if (title) t.title = title;
    useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  }

  dismissToast(id: number): void {
    useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  // ------------------------------------------------------------------------------------- start screen

  private async prepareStart(welcome: WelcomeMsg): Promise<void> {
    const defaults = welcome.defaults;
    if (this.config.autostart) {
      void this.startMatch({});
      return;
    }
    try {
      const [decks, profiles, problems] = await Promise.all([
        this.source.rpc<string[]>('decks.list'),
        this.source.rpc<string[]>('ai.profiles'),
        this.deckProblems(welcome),
      ]);
      const ais = profiles;
      // Neural is the default opponent when the sidecar can run it (welcome.defaults.ai says which). In Brawl it is
      // offered but not preselected: it plays Brawl untrained.
      const preferred = welcome.format ? 'Default' : defaults.ai;
      const start = { ...useUi.getState().start, decks, ais, ai: defaultAi(ais, preferred, welcome.neural), problems };
      if (welcome.format) {
        // Brawl: a deck that can be played in it; the opponent's is a random shared Brawl deck unless picked.
        start.deck = legalDeck(defaults.deck, decks, problems);
        start.oppDeck = legalDeck(defaults.oppDeck, decks, problems) === defaults.oppDeck ? defaults.oppDeck : undefined;
      } else {
        if (defaults.deck) start.deck = defaults.deck;
        else if (decks[0]) start.deck = decks[0];
        if (defaults.oppDeck) start.oppDeck = defaults.oppDeck;
        else if (start.deck) start.oppDeck = start.deck;
      }
      // The lobby's New game: start with its picks now (the screen is a loader meanwhile); if the game
      // refuses them the full start screen is already filled in. Its Import opens deck import instead.
      const gid = gameIdFromPath(window.location.pathname);
      const handoff = gid ? takeHandoff(gid) : null;
      if (handoff?.import) start.importFirst = true;
      if (handoff?.start) {
        const p = handoff.start;
        if (p.deck) start.deck = p.deck;
        if (p.ai) start.ai = p.ai;
        if (p.oppDeck) start.oppDeck = p.oppDeck;
        start.auto = handoff.line ?? 'Shuffling up';
        start.starting = true;
      }
      useUi.setState({ start });
      if (handoff?.start) void this.startMatch(handoff.start);
    } catch (e) {
      useUi.setState((s) => ({ start: { ...s.start, error: String((e as Error).message) } }));
    }
  }

  /**
   * A PvP game's start screen: my decks only (the server scopes `decks.list` to my seat), and the deck picked in the
   * lobby is sent as soon as the page is up, which marks me ready. A deck the seat doesn't have is not sent.
   * A rematch (or a reload while one is set up) preselects the deck I last played and waits for Ready: keep it or change it.
   */
  private async preparePvpStart(welcome: WelcomeMsg, rematch = !!welcome.pvp?.rematch): Promise<void> {
    try {
      const [decks, problems] = await Promise.all([this.source.rpc<string[]>('decks.list'), this.deckProblems(welcome)]);
      const gid = gameIdFromPath(window.location.pathname);
      // The deck picked in the lobby (this tab's memory), else the one the server already holds for this seat (defaults.deck).
      const lastPlayed = rematch ? useUi.getState().start.sent : undefined;
      const want = lastPlayed ?? (gid ? rememberedDeck(gid) : null) ?? welcome.defaults.deck ?? null;
      const deck = welcome.format ? legalDeck(want ?? undefined, decks, problems) : want && decks.includes(want) ? want : decks[0];
      const { sent: _sent, ...rest } = useUi.getState().start;
      const start = { ...rest, decks, ais: [] as string[], problems, starting: false };
      if (deck) start.deck = deck;
      useUi.setState({ start });
      if (!rematch && want && deck === want && !welcome.pvp?.youReady) void this.startMatch({ deck });
    } catch (e) {
      useUi.setState((s) => ({ start: { ...s.start, error: String((e as Error).message) } }));
    }
  }

  /** A format game's illegal decks (`decks.problems`); nothing to ask in Constructed. */
  private deckProblems(welcome: WelcomeMsg): Promise<DeckProblems | undefined> {
    return welcome.format ? this.source.rpc<DeckProblems>('decks.problems', { format: welcome.format }) : Promise.resolve(undefined);
  }

  async startMatch(params: MatchStartParams): Promise<void> {
    useUi.setState((s) => ({ start: { ...s.start, starting: true } }));
    try {
      const started = await this.source.rpc<MatchStartResult | undefined>('match.start', params as Record<string, unknown>);
      useUi.setState({ matchAi: started?.ai ?? null });
      // PvP: this only marks me ready; the match starts when both are (the screen follows the server's lobby pushes).
      if (useUi.getState().pvp) useUi.setState((s) => ({ start: { ...s.start, starting: false, ...(params.deck ? { sent: params.deck } : {}) } }));
    } catch (e) {
      this.toast('error', 'Could not start the match', (e as Error).message);
      useUi.setState((s) => ({ start: { ...s.start, starting: false, auto: undefined } }));
    }
  }

  /**
   * Import a deck (`decks.import`). A dry run only parses. A real import refreshes the deck list and
   * selects the new deck as the player's; the caller shows failures (the promise rejects with the
   * server's message).
   */
  async importDeck(params: DeckImportParams): Promise<DeckImportResult> {
    const result = await this.source.rpc<DeckImportResult>('decks.import', params as Record<string, unknown>);
    if (!params.dryRun && result.saved) {
      const welcome = useUi.getState().welcome;
      const [decks, problems] = await Promise.all([this.source.rpc<string[]>('decks.list'), welcome ? this.deckProblems(welcome) : undefined]);
      const list = decks.includes(result.name) ? decks : [...decks, result.name];
      useUi.setState((s) => ({ start: { ...s.start, decks: list, deck: result.name, problems } }));
    }
    return result;
  }

  /** Card faces: Scryfall scans from the sidecar, our frame around its art crops, or procedural (saved per viewer). */
  setArtMode(mode: ArtMode): void {
    savePref(ART_PREF, mode);
    cardArt.setEnabled(this.config.artAllowed && mode === 'scryfall');
    cropArt.setEnabled(this.config.artAllowed && mode === 'frame');
    useUi.setState({ artMode: mode });
  }

  // ------------------------------------------------------------------------------------- actions

  /** The buttons for the prompt at the playhead (same function the HUD renders with). */
  buttons(): Buttons {
    const d = this.director;
    const p = d.prompt;
    return primaryLabel(p?.kind ?? null, p ? { ok: p.ok, cancel: p.cancel, canUndo: !!p.canUndo, selectable: p.selectable } : null, {
      game: d.shown.game,
      viewer: d.viewer,
      cards: d.shown.cards,
      myBattlefield: zone(d.shown, d.viewer, 'battlefield'),
      myStops: d.stops[d.viewer] ?? [],
    });
  }

  /** Input is live: a real prompt is on screen and no blocking overlay covers it. */
  get inputLive(): boolean {
    const p = this.director.prompt;
    return !!p && p.kind !== 'waiting' && this.visibleAsks().length === 0 && !this.director.gameOver;
  }

  /**
   * Asks the player sees. A lone ability menu that follows the player's own click is answered for them
   * (see autoAnswerAbility) and never drawn; replays treat every lone ability menu that way, since the
   * recording client answered them.
   */
  visibleAsks(): AskMsg[] {
    return this.director.asks.filter((a) => !this.autoAnswered.has(a.id) && !(this.source?.kind === 'replay' && isLoneAbility(a)));
  }

  private inputAct(body: Record<string, unknown> & { kind: string }): void {
    const p = this.director.prompt;
    if (!p || !this.inputLive) return;
    const act = { t: 'act', pid: p.pid, ...body } as ActMsg;
    if (body.kind === 'card') this.payByHand = this.shiftHeld;
    if (this.config.test) this.sentActs.push(act);
    this.source.act(act);
    if (body.kind !== 'card' && useUi.getState().handUp) useUi.setState({ handUp: false, handFocus: null });
  }

  press(spec: ButtonSpec | null): void {
    if (!spec || !spec.enabled || !spec.action) return;
    // "Always answer this way" on a may-trigger: Forge stores the answer and answers this prompt with it.
    const remember = rememberedAnswer(this.director.prompt, useUi.getState().rememberAnswer, spec.action);
    if (remember) {
      useUi.setState({ rememberAnswer: null });
      this.setTriggerAnswer(remember.key, remember.decision);
      return;
    }
    this.inputAct({ kind: spec.action });
  }

  primary(): void {
    this.press(this.buttons().primary);
  }

  secondary(): void {
    const b = this.buttons();
    this.press(b.secondary ?? b.endTurn);
  }

  clickCard(id: CardId, pointerType = 'mouse'): void {
    // The tap that ends a hand card's drag is not a click.
    if (this.handDrag.dragging) return;
    // An ability card on the stack (layout/stack.ts) is no card to act on: a click reads its source.
    if (isAbilityId(id)) {
      const card = this.previewOf(id);
      if (card) useUi.setState({ pinned: card, preview: null });
      return;
    }
    const inHand = (this.director.shown.players[this.director.viewer]?.zones?.hand ?? []).includes(id);
    // A castable card in the strip beside the hand (table/altZone.ts) is played like a hand card: carried by a click,
    // dragged up to cast; a touch tap pins its preview (the strip is already whole, there is no hand to raise).
    if (!inHand && this.scene.altCards.some((a) => a.id === id)) {
      const p = this.director.prompt;
      if (!this.inputLive || p?.kind === 'priority') {
        if (pointerType === 'mouse') return this.handDrag.pickUp(id);
        useUi.setState({ pinned: id, preview: null });
        return;
      }
    }
    if (inHand) {
      // Drag to play: a tap on a hand card reads it (raise the hand, bring the card forward, pin its
      // preview); a mouse click picks it up to carry, the next click lets go (table/handDrag.ts). Prompts that
      // choose hand cards (discard, tuck, convoke, targets…) still take the click as a pick.
      const ui = useUi.getState();
      const p = this.director.prompt;
      const playPath = !this.inputLive || p?.kind === 'priority';
      const k = handClick({ touch: this.scene.touch, raised: this.scene.handRaised, handUp: ui.handUp, focus: ui.handFocus, card: id, playPath });
      // A pen or a touch screen on a fine-pointer device keeps the old click (pin the preview).
      switch (k === 'carry' && pointerType !== 'mouse' ? 'pin' : k) {
        case 'raise':
          return useUi.setState({ handUp: true, handFocus: id });
        case 'focus':
          return useUi.setState({ handFocus: id });
        case 'carry':
          return this.handDrag.pickUp(id);
        case 'pin':
          if (!id.startsWith('x')) useUi.setState({ pinned: id, preview: null });
          return;
        case 'select':
          break;
      }
    }
    if (id.startsWith('x') || !this.inputLive) return;
    this.lastClick = { card: id, at: this.clock.now() };
    // Blocker-first blocking and drags decide for themselves (arrows/interaction.ts).
    if (this.aim.tap(id)) return;
    this.inputAct({ kind: 'card', card: id });
  }

  /** Play a card from my hand (dropped over the table): the same `card` act a click sent. */
  playFromHand(id: CardId): void {
    if (id.startsWith('x') || !this.inputLive) return;
    this.lastClick = { card: id, at: this.clock.now() };
    this.inputAct({ kind: 'card', card: id });
    // The hand goes back down; the card's preview goes with it.
    useUi.setState({ handUp: false, handFocus: null, pinned: null, preview: null });
  }

  /** The pointer is over a stack item in the HUD's list (its targets get arrows), or left it (null). */
  hoverStack(id: string | null): void {
    this.aim.hoverStack = id;
  }

  /** Plate boxes measured this frame. */
  private plates = new Map<PlayerId, Box | null>();

  /**
   * A player's avatar disc in table units, for arrows: the DOM disc's measured rect (it follows the HUD scale and
   * the window size), else the plate's, else its nominal place (geometry.ts plateBox).
   */
  private plateBox = (player: PlayerId): Box | null => {
    if (this.plates.has(player)) return this.plates.get(player)!;
    let box: Box | null = null;
    const el = typeof document !== 'undefined' ? (document.querySelector<HTMLElement>(`.plate[data-player="${player}"] .plate-avatar`) ?? document.querySelector<HTMLElement>(`.plate[data-player="${player}"]`)) : null;
    const r = el?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      const a = this.scene.toTable(r.left, r.top);
      const b = this.scene.toTable(r.right, r.bottom);
      box = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, hw: (b.x - a.x) / 2, hh: (b.y - a.y) / 2 };
    } else if (this.director.shown.players[player]) {
      box = plateBox(player === this.director.viewer, this.scene.geo);
    }
    this.plates.set(player, box);
    return box;
  };

  clickPlayer(player: PlayerId): void {
    if (!this.inputLive) return;
    this.inputAct({ kind: 'player', player });
  }

  hover(id: CardId | null): void {
    if (this.config.test && id !== null) {
      // Hover lifts are real UI, but tests drive the mouse only for clicks; keep goldens stable.
      this.scene.setHover(null);
      return;
    }
    this.scene.setHover(id);
    this.showPreview();
  }

  /** The card a preview shows for a sprite: an ability card on the stack shows its source (when it is a known card). */
  private previewOf(id: CardId): CardId | null {
    if (!isAbilityId(id)) return id;
    const src = stackItemFor(this.director.shown, id)?.source;
    return src && this.director.shown.cards[src]?.state ? src : null;
  }

  /** The hover preview for the hovered card, unless it is in my hand and already enlarged there (Alt forces it). */
  private showPreview(): void {
    const hovered = this.scene.hovered;
    const id = hovered ? this.previewOf(hovered) : null;
    const d = this.director;
    const on = !!id && !this.handDrag.dragging && previewsOnHover(d.shown, d.viewer, id, { alt: this.altHeld, handRaised: this.scene.handRaised });
    useUi.setState({ preview: on && !useUi.getState().pinned ? id : null });
  }

  private setAlt(held: boolean): void {
    if (held === this.altHeld) return;
    this.altHeld = held;
    if (this.scene.hovered && !this.config.test) this.showPreview();
  }

  reply(ask: AskMsg, value: unknown): void {
    this.source.reply({ t: 'reply', id: ask.id, value });
  }

  togglePhaseStop(player: PlayerId, phase: Phase): void {
    const cur = this.director.stops[player] ?? [];
    const stop = !cur.includes(phase);
    // Optimistic: the server confirms with notice{stops}.
    this.director.setStops({ ...this.director.stops, [player]: stop ? [...cur, phase] : cur.filter((p) => p !== phase) });
    this.source.act({ t: 'act', kind: 'phaseStop', player, phase, stop });
  }

  /**
   * Auto-skip: the bridge passes every priority where I can do nothing but tap for mana. Saved per
   * viewer and sent with every hello, so it holds across reloads and matches.
   */
  setAutoSkip(on: boolean): void {
    savePref(AUTO_SKIP_PREF, on ? '1' : '0');
    useUi.setState((s) => ({ autoPass: { ...s.autoPass, autoSkip: on } }));
    this.source.act({ t: 'act', kind: 'autoSkip', on });
  }

  /** Snooze a card (right-click / long-press): auto-skip stops counting it as something to do. The bridge confirms. */
  toggleSnooze(card: CardId): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    const snoozed = useUi.getState().autoPass.snoozed ?? [];
    const on = !snoozed.includes(card);
    useUi.setState((s) => ({ autoPass: { ...s.autoPass, snoozed: on ? [...snoozed, card] : snoozed.filter((c) => c !== card) } }));
    this.source.act({ t: 'act', kind: 'snooze', card, on });
  }

  toggleAutoSkip(): void {
    this.setAutoSkip(!useUi.getState().autoPass.autoSkip);
  }

  /** Auto-resolve my own spells and abilities: the bridge passes while the top of the stack is mine. For this match, not saved. */
  toggleAutoResolve(): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    const on = !useUi.getState().autoPass.autoResolve;
    useUi.setState((s) => ({ autoPass: { ...s.autoPass, autoResolve: on } }));
    this.source.act({ t: 'act', kind: 'autoResolve', on });
  }

  /**
   * Always answer an optional trigger this way (Forge's Auto-Yield), or `ask` again. Answering the trigger on screen
   * answers its prompt too; the bridge confirms with notice{autoPass}.
   */
  setTriggerAnswer(key: string, decision: TriggerDecision | 'ask'): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    this.source.act({ t: 'act', kind: 'triggerAnswer', key, decision });
  }

  /**
   * Loop shortcut (hud/loop.ts): record what I do, then repeat it `times` more times. Against a person the repeat
   * is offered to them first. The bridge confirms with notice{autoPass}.
   */
  loopShortcut(op: 'record' | 'done' | 'repeat' | 'cancel', times?: number): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    this.source.act(times === undefined ? { t: 'act', kind: 'loop', op } : { t: 'act', kind: 'loop', op, times });
  }

  /** Answer the opponent's offer `offerId`: accept all of it, only the first `stopAfter` repeats, or (false) respond instead. */
  answerLoop(offerId: number, accept: boolean, stopAfter?: number): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    this.source.act(
      stopAfter === undefined
        ? { t: 'act', kind: 'loopAnswer', offerId, accept }
        : { t: 'act', kind: 'loopAnswer', offerId, accept, stopAfter },
    );
  }

  /**
   * Pass priority until end of turn (Forge's End Turn yield), or stop passing. The bridge confirms with
   * notice{autoPass}; Forge ends it at cleanup, or early when the opponent casts something or attacks me.
   */
  setPassToEndOfTurn(on: boolean): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    useUi.setState((s) => ({ autoPass: { ...s.autoPass, untilEndOfTurn: on } }));
    this.source.act(on ? { t: 'act', kind: 'yield', until: 'endOfTurn' } : { t: 'act', kind: 'yield', clear: true });
  }

  /** Resolve all: pass priority until the stack is empty; Forge stops if the opponent adds something. */
  resolveAll(): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    this.source.act({ t: 'act', kind: 'yield', until: 'stackEmpty' });
  }

  togglePassToEndOfTurn(): void {
    this.setPassToEndOfTurn(!useUi.getState().autoPass.untilEndOfTurn);
  }

  /** Open the graveyard / exile viewer on a pile (mine or the opponent's). The prompt stays as it is. */
  openZone(player: PlayerId, zone: PileZone): void {
    if (!useUi.getState().inMatch || this.director.gameOver) return;
    this.hover(null);
    useUi.setState({ zoneView: { player, zone } });
  }

  closeZone(): void {
    if (useUi.getState().zoneView) useUi.setState({ zoneView: null });
  }

  nextGame(decision: NextGameDecision): void {
    this.closeZone();
    this.source.act({ t: 'act', kind: 'nextGame', decision });
    // PvP: leaving goes back to the lobby (a guest has none: a thank-you page); the other player is told I left.
    if (decision === 'QUIT' && useUi.getState().pvp && underRouter()) {
      window.location.assign(guestTable() ? '/g/bye' : '/');
      return;
    }
    // PvP Rematch: back to this table's start screen with the deck I played picked; the next game starts once we
    // are both ready again. The other player sees that I asked until they say yes.
    if (decision === 'NEW' && useUi.getState().pvp) {
      this.director.reset();
      useUi.setState((s) => ({ inMatch: false, gameOver: null, zoneStrip: null, start: { ...s.start, starting: false, auto: undefined } }));
      const w = useUi.getState().welcome;
      if (w && this.source.kind === 'live') void this.preparePvpStart(w, true);
      return;
    }
    if (decision === 'QUIT') {
      this.director.reset();
      useUi.setState((s) => ({ inMatch: false, gameOver: null, zoneStrip: null, start: { ...s.start, starting: false } }));
      const w = useUi.getState().welcome;
      if (w && this.source.kind === 'live') void this.prepareStart(w);
    } else if (decision === 'NEW') {
      // Rematch: the bridge may open a brand-new table session (a re-rolled random deck) whose seq starts
      // again at 1, or reuse this one and just keep counting up. Either way openView() rebinds and sends a fresh
      // snapshot for the new game, so resetting here is safe for both and required for the former (otherwise the
      // stale lastSeq high-water mark survives and the new session's early frames are dropped as "already played").
      this.director.reset();
    }
  }

  concede(): void {
    this.source.act({ t: 'act', kind: 'concede' });
  }

  /** PvP: the opponent has been gone long enough; they concede. The server ignores it before then (and says so). */
  claimWin(): void {
    const act: ActMsg = { t: 'act', kind: 'claimWin' };
    if (this.config.test) this.sentActs.push(act);
    this.source.act(act);
  }

  skip(): void {
    this.director.collapse();
    this.source.act({ t: 'act', kind: 'skipAnim' });
  }

  setSpeed(v: number): void {
    this.director.speed = v;
    savePref('speed', String(v));
    useUi.setState({ speed: v });
    this.source.act({ t: 'act', kind: 'speed', value: v });
  }

  setEffects(v: Effects): void {
    this.director.effects = v;
    savePref('effects', v);
    useUi.setState({ effects: v });
  }

  setCardSize(v: CardSize): void {
    this.scene.setCardScale(CARD_SCALE[v]);
    savePref(CARD_SIZE_PREF, v);
    useUi.setState({ cardSize: v });
  }

  /**
   * Forge's legacy UI plays a lone ability straight away when the player clicked its card
   * (CMatchUI.getAbilityToPlay). The bridge always asks, so answer that one-item menu for the player when it
   * follows their own click on that card.
   */
  private autoAnswerAbility(): void {
    const top = this.director.asks[this.director.asks.length - 1];
    if (!top || top.kind !== 'ability' || this.autoAnswered.has(top.id) || top.error || !isLoneAbility(top)) return;
    const click = this.lastClick;
    if (!click || top.card !== click.card) return;
    this.autoAnswered.add(top.id);
    this.reply(top, [top.items[0]!.idx]);
  }

  // ------------------------------------------------------------------------------------- test hooks

  private checkWaiters(now: number): void {
    if (this.waiters.length === 0) return;
    this.waiters = this.waiters.filter((w) => {
      if (w.test()) {
        w.resolve();
        return false;
      }
      if (now > w.deadline) {
        w.reject(new Error('timed out waiting'));
        return false;
      }
      return true;
    });
  }

  /** Resolve when `test` holds. Virtual clock: steps frames synchronously; real clock: waits on frames. */
  runUntil(test: () => boolean, opts: { maxMs?: number; settle?: boolean } = {}): Promise<void> {
    const max = opts.maxMs ?? 180_000;
    if (this.clock instanceof VirtualClock) {
      const vc = this.clock;
      const end = vc.now() + max;
      while (!test()) {
        if (vc.now() > end) {
          this.scene.render();
          return Promise.reject(new Error(`runUntil: condition not met within ${max} ms (virtual)`));
        }
        vc.advance(FRAME_MS);
        this.frame(false);
      }
      if (opts.settle) this.settle();
      this.scene.render();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ test, resolve, reject, deadline: this.clock.now() + max });
    });
  }

  /** Virtual clock: finish in-flight motion without starting anything new. */
  settle(maxMs = 3000): void {
    if (!(this.clock instanceof VirtualClock)) return;
    this.director.hold = true;
    let t = 0;
    while ((this.director.isAnimating() || this.scene.moving || t < 200) && t < maxMs) {
      this.clock.advance(FRAME_MS);
      this.frame(false);
      t += FRAME_MS;
    }
    this.director.hold = false;
    this.scene.endFx();
    this.scene.render();
  }

  advance(ms: number): void {
    if (!(this.clock instanceof VirtualClock)) throw new Error('advance() needs ?test=1');
    let left = ms;
    while (left > 0) {
      const step = Math.min(FRAME_MS, left);
      this.clock.advance(step);
      left -= step;
      this.frame(left <= 0);
    }
  }

  private installTestHooks(): void {
    const rt = this;
    const promptIs = (kind: string) => () => {
      const p = rt.director.prompt;
      return !!p && p.kind === kind && rt.visibleAsks().length === 0;
    };
    const api = {
      advance: (ms: number) => rt.advance(ms),
      now: () => rt.clock.now(),
      state: () => rt.debugState(),
      waitForPrompt: (kind: string, opts?: { maxMs?: number; settle?: boolean }) => rt.runUntil(promptIs(kind), { settle: true, ...opts }),
      waitForAsk: (opts?: { maxMs?: number }) => rt.runUntil(() => rt.visibleAsks().length > 0, { settle: true, ...opts }),
      waitForGameOver: (opts?: { maxMs?: number }) => rt.runUntil(() => !!rt.director.gameOver, { settle: true, ...opts }),
      runUntil: (fn: (s: ReturnType<Runtime['debugState']>) => boolean, opts?: { maxMs?: number; settle?: boolean }) =>
        rt.runUntil(() => fn(rt.debugState()), opts),
      settle: (ms?: number) => rt.settle(ms),
      get playhead() {
        return rt.director.playedSeq;
      },
      skip: () => rt.skip(),
      buttons: () => rt.buttons(),
      /** A point on the visible part of a card: hand cards hang off the bottom edge, so aim above it. */
      cardCenter: (id: string) => {
        const p = rt.scene.poseOf(id);
        if (!p) return null;
        const top = p.y - p.h / 2;
        const bottom = Math.min(p.y + p.h / 2, rt.scene.geo.H - 4);
        return rt.scene.screenPoint(p.x, Math.min(p.y, (top + bottom) / 2));
      },
      sprites: () => rt.scene.debugSprites(),
      /** Arrows on the table (keys like attack:c1, block:c2:c1, target:c3:p1, pending:block:c2). */
      arrows: () => rt.scene.arrowKeys,
      /** Client-side aiming: the blocker picked and the card being dragged. */
      aim: () => ({ selected: rt.aim.selected, dragging: rt.aim.dragging }),
      /** The hand card being dragged (drag to play), and the acts sent so far (?test=1 only). */
      handDrag: () => rt.handDrag.dragging,
      acts: () => rt.sentActs.map((a) => ({ ...a })),
      /** Replays have no sidecar to list decks: give the start screen some. */
      seedStart: (decks: string[], deck: string) => useUi.setState((s) => ({ start: { ...s.start, decks, deck } })),
      /** Replays: stop (true) or resume feeding recorded messages, to interact with a prompt at leisure. */
      pause: (on: boolean) => {
        if (rt.source.kind === 'replay') (rt.source as ReplaySource).paused = on;
      },
      /**
       * Framed art mode on (or off again) in a replay, whose crops the test serves at /img/crop/<imageKey>. Resolves once
       * the M15 fonts are in, so the faces drawn from then on are the M15 ones.
       */
      framed: (on: boolean): Promise<void> => {
        cropArt.setEnabled(on);
        useUi.setState({ artMode: on ? 'frame' : 'procedural' });
        return on ? loadM15Fonts() : Promise.resolve();
      },
      /** Draw a frame without moving the clock (after a click or a pointer move in test mode). */
      redraw: () => rt.frame(),
      /** Show a card's hover preview (test mode turns pointer hover off to keep goldens stable). */
      preview: (id: string | null) => useUi.setState({ preview: id }),
      perf: () => [...rt.perfSamples],
      replayDone: () => rt.source.kind === 'replay' && (rt.source as ReplaySource).done && !rt.director.busy,
    };
    (window as unknown as { __table: typeof api }).__table = api;
  }

  debugState() {
    const d = this.director;
    const g = d.shown.game;
    const players: Record<string, { life: number; hand: number; library: number; battlefield: string[]; graveyard: number }> = {};
    for (const [id, p] of Object.entries(d.shown.players)) {
      players[id] = {
        life: p.life,
        hand: p.zones.hand?.length ?? 0,
        library: p.zones.library?.length ?? 0,
        battlefield: p.zones.battlefield ?? [],
        graveyard: p.zones.graveyard?.length ?? 0,
      };
    }
    const lands = (pid: string) => (d.shown.players[pid]?.zones.battlefield ?? []).filter((id) => d.shown.cards[id]?.state?.type?.core?.includes('Land')).length;
    return {
      now: this.clock.now(),
      playhead: d.playedSeq,
      lastSeq: d.lastSeq,
      busy: d.busy,
      backlogMs: d.backlogMs(),
      viewer: d.viewer,
      turn: g.turn ?? 0,
      phase: g.phase ?? null,
      playerTurn: g.playerTurn ?? null,
      stack: g.stack.length,
      attackers: (g.combat ?? []).length,
      gameOver: d.gameOver ? { won: d.gameOver.won, winner: d.gameOver.winner ?? null, matchOver: d.gameOver.matchOver } : null,
      prompt: d.prompt ? { kind: d.prompt.kind, pid: d.prompt.pid, message: d.prompt.message, ok: d.prompt.ok, cancel: d.prompt.cancel, selectable: d.prompt.selectable } : null,
      asks: this.visibleAsks().map((a) => ({ id: a.id, kind: a.kind })),
      players,
      landsOf: Object.fromEntries(Object.keys(d.shown.players).map((p) => [p, lands(p)])),
      inMatch: useUi.getState().inMatch,
      pvp: useUi.getState().pvp,
      zoneView: useUi.getState().zoneView,
      weak: d.prompt?.weak ?? {},
      /** The castable cards in the strip beside my hand (table/altZone.ts). */
      alt: this.scene.altCards.map((a) => ({ id: a.id, label: a.label, cost: a.cost ?? null })),
    };
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.ackTimer);
    this.source?.close();
  }
}

/** A one-item ability menu (Forge's legacy UI plays it without asking). */
export function isLoneAbility(a: AskMsg): boolean {
  return a.kind === 'ability' && a.items.length === 1 && a.items[0]!.enabled !== false;
}

/** Fonts must be ready before any canvas text is painted (card faces are cached as textures). */
async function loadFonts(): Promise<void> {
  if (!document.fonts) return;
  // Load every unicode-range subset, not just the one a sample string touches: a glyph from a subset that
  // is still loading would be painted in a fallback font and cached in a card texture.
  const faces: FontFace[] = [];
  document.fonts.forEach((f) => {
    if (/Inter Variable|Barlow Condensed/.test(f.family)) faces.push(f);
  });
  await Promise.all([...faces.map((f) => f.load().catch(() => undefined)), loadManaFont()]);
  await document.fonts.ready;
}

let current: Runtime | null = null;
export function setRuntime(rt: Runtime): void {
  current = rt;
}
export function runtime(): Runtime {
  if (!current) throw new Error('runtime not started');
  return current;
}

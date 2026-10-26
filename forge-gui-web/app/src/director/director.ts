/**
 * The Director: turns the server's ordered message stream into what is on screen.
 *
 * - `received` is authoritative: every snapshot / beat / settle patch is applied to it on arrival.
 * - `shown` is the scene at the playhead. Sequenced messages queue in seq order; each beat is
 *   choreographed into a Timeline whose patch applies to `shown` at `applyAt`, and the next message may
 *   start once the beat's `lead` has elapsed. Prompts, asks and the game-over panel are gated the same
 *   way, so nothing is shown before the events that led to it have played.
 * - Catch-up: a backlog over 3 s (at the current speed) is time-compressed so it plays in 1.5 s; over
 *   10 s (or on resume, return from a hidden tab, or Skip), everything collapses at once and the table
 *   crossfades for 150 ms.
 * - Deterministic: all time comes from the injected Clock.
 */
import type {
  AskMsg,
  BeatMsg,
  GameModel,
  GameOverMsg,
  PlayerId,
  PromptBody,
  SequencedMessage,
  SnapshotMsg,
  StopTable,
  ZoneRef,
} from '@forge-table/protocol';
import type { Clock } from '../util/clock';
import { seatOf, type MullCount } from '../hud/mulligan';
import { applyPatch, emptyModel, isLand, modelOf } from '../store/model';
import { DUR, STAGGER, lethalHit, nominalLead, shakeFor, timelineFor, type Timeline, type Track } from './choreography';

/** Backlog thresholds (ms of play time at the current speed). */
export const COMPRESS_OVER_MS = 3000;
/** Impactful beat kinds play at this pace (below 1 = slower than their 1x duration; "impactful things slower"). */
export const IMPACT_PACE = 0.7;
const IMPACT = new Set(['etb', 'dies', 'damage', 'life', 'exile', 'bounce']);
export const COMPRESS_TARGET_MS = 1500;
export const COLLAPSE_OVER_MS = 10000;

/** A track scheduled on the absolute clock. */
export type ScheduledTrack = Track & { id: number; at: number; seq: number };

interface Queued {
  msg: SequencedMessage;
  arrivedAt: number;
}

interface Active {
  msg: SequencedMessage;
  start: number;
  end: number;
  applyAt: number;
  applied: boolean;
}

export interface DirectorOptions {
  clock: Clock;
  speed?: number;
  reducedMotion?: boolean;
}

export type Effects = 'full' | 'lite' | 'off';

export class Director {
  readonly clock: Clock;
  /** Motion speed multiplier; 0 = Instant. */
  speed: number;
  reducedMotion: boolean;
  /** The effects setting (overhaul): `lite` drops particles, shake and flash; `off` also plays cards reduced. */
  effects: Effects = 'full';

  /** Cards play their reduced variants (crossfades, still numbers). */
  get calm(): boolean {
    return this.reducedMotion || this.effects === 'off';
  }

  /** Particles, camera shake, the hurt flash, breathing arrows. */
  get fx(): boolean {
    return !this.calm && this.effects === 'full';
  }

  viewer: PlayerId = 'p0';
  received: GameModel = emptyModel();
  shown: GameModel = emptyModel();
  /** The prompt bar at the playhead. */
  prompt: PromptBody | null = null;
  /** Blocking prompts at the playhead, bottom to top. */
  asks: AskMsg[] = [];
  /** The viewer's mulligans this game and who goes first (the mulligan banner): one more per new mulligan prompt. */
  mull: MullCount = { count: 0, seat: null };
  private mullPids = new Set<number>();
  gameOver: GameOverMsg | null = null;
  /** Phase stops (not sequenced: applied as they arrive). */
  stops: StopTable = {};

  /** Highest seq received. */
  lastSeq = 0;
  /** Highest seq whose step (and every step before it) has finished playing. */
  playedSeq = 0;
  /** A camera shake (big damage, as in MTGA): when it starts, how hard (0..1), and whether it is a kill's (longer). */
  shake: { at: number; mag: number; lethal?: boolean } | null = null;
  /** The last killing blow (choreography lethalHit): when it lands and on whom; the scene flashes for it. */
  lethal: { at: number; player?: PlayerId; card?: string } | null = null;
  /** When I last took damage: the screen edges flash red. */
  hurtAt = -Infinity;
  /** The table is playing itself (passing the turn, or auto-skip on the opponent's turn): routine steps run fast. */
  fast = false;
  /** Between a reset (the player left) and the next match's snapshot. */
  private awaitingSnapshot = false;
  /** Bumped whenever anything the HUD shows changes. */
  version = 0;
  /** Clock time of the last collapse (the table crossfades for 150 ms after it). */
  collapsedAt = -Infinity;
  /** Hold: finish what is playing, start nothing new (tests settle on a stable frame). */
  hold = false;

  /** Tracks started so far that may still be running, oldest first. */
  tracks: ScheduledTrack[] = [];
  private trackIds = 0;

  private queue: Queued[] = [];
  private active: Active[] = [];
  private nextStartAt = -Infinity;
  private compression = 1;
  /** Compression holds until this seq has started (the backlog it was computed for). */
  private compressThrough = 0;
  /** Origin of a `toStack` beat that could not name its card (resolved by the next stack patch). */
  private pendingStackFrom: ZoneRef | null = null;
  /** Targets the resolving stack items already hit (choreography impactFor); emptied with the stack. */
  private impacted = new Set<string>();
  /** The card the last tap beat tapped (mana sparks start there). */
  private lastTap: string | null = null;

  constructor(opts: DirectorOptions) {
    this.clock = opts.clock;
    this.speed = opts.speed ?? 1;
    this.reducedMotion = opts.reducedMotion ?? false;
  }

  // ------------------------------------------------------------------------------------- input

  /**
   * Forge asks "keep?" again after each mulligan (a new prompt id; a promptUpdate keeps it), so every keep prompt
   * after the first is one more mulligan. A snapshot mid-mulligan starts the count again (ponytail: a reconnect
   * between mulligans undercounts; the bridge would have to send the count to fix that).
   */
  private countMulligan(p: PromptBody): void {
    if (p.kind !== 'mulligan' || (p.seat && p.seat !== this.viewer) || this.mullPids.has(p.pid)) return;
    if (this.mullPids.size > 0) this.mull = { ...this.mull, count: this.mull.count + 1 };
    this.mullPids.add(p.pid);
    this.mull = { ...this.mull, seat: seatOf(p.message) ?? this.mull.seat };
  }

  /** A full state from the server: replaces both stores and everything gated on the playhead. */
  snapshot(msg: SnapshotMsg): void {
    const model = modelOf(msg.game, msg.players, msg.cards);
    this.awaitingSnapshot = false;
    this.viewer = msg.viewer;
    this.received = model;
    this.shown = model;
    this.prompt = msg.prompt ?? null;
    this.asks = [...(msg.asks ?? [])];
    this.mull = { count: 0, seat: null };
    this.mullPids.clear();
    if (this.prompt) this.countMulligan(this.prompt);
    this.gameOver = msg.gameOver ?? null;
    this.stops = msg.stops ?? {};
    this.queue = this.queue.filter((q) => q.msg.seq > msg.seq);
    this.active = [];
    this.tracks = [];
    this.lastSeq = Math.max(this.lastSeq, msg.seq);
    this.playedSeq = msg.seq;
    this.nextStartAt = this.clock.now();
    this.collapsedAt = this.clock.now();
    this.version++;
  }

  /**
   * Forget the match (the player left): empty stores, nothing queued. The next match is a new session whose seq
   * starts again at 1, so the old seqs are forgotten too and nothing is taken until its snapshot (otherwise the new
   * match's first steps count as already played and are dropped: the game then waits on an ask never shown).
   */
  reset(): void {
    this.awaitingSnapshot = true;
    this.lastSeq = 0;
    this.compressThrough = 0;
    this.received = emptyModel();
    this.shown = this.received;
    this.prompt = null;
    this.asks = [];
    this.mull = { count: 0, seat: null };
    this.mullPids.clear();
    this.gameOver = null;
    this.queue = [];
    this.active = [];
    this.tracks = [];
    this.pendingStackFrom = null;
    this.impacted.clear();
    this.playedSeq = 0;
    this.collapsedAt = this.clock.now();
    this.version++;
  }

  /** A sequenced message: patch `received` now, queue it for the playhead. */
  receive(msg: SequencedMessage): void {
    if (this.awaitingSnapshot) return; // the left match's tail
    if (msg.seq <= this.playedSeq && this.queue.length === 0 && this.active.length === 0) {
      return; // already covered by a snapshot
    }
    if ((msg.t === 'beat' || msg.t === 'settle') && msg.patch) {
      this.received = applyPatch(this.received, msg.patch);
    }
    this.lastSeq = Math.max(this.lastSeq, msg.seq);
    this.queue.push({ msg, arrivedAt: this.clock.now() });
  }

  setStops(stops: StopTable): void {
    this.stops = stops;
    this.version++;
  }

  // ------------------------------------------------------------------------------------- playback

  /** Speed-scaled duration factor (0 at Instant). */
  private get rate(): number {
    return this.speed > 0 ? 1 / this.speed : 0;
  }

  /** Play time still queued or running, in ms at the current speed. */
  backlogMs(now = this.clock.now()): number {
    let ms = 0;
    for (const a of this.active) ms = Math.max(ms, a.end - now);
    let queued = 0;
    for (const q of this.queue) queued += this.leadOf(q.msg) * this.rate;
    return Math.max(0, ms) + queued;
  }

  private leadOf(msg: SequencedMessage): number {
    return msg.t === 'beat' ? nominalLead(msg.kind) : 0;
  }

  /** Advance the playhead to `now`: start due steps, apply due patches, retire finished steps. */
  update(now = this.clock.now()): void {
    if (!this.hold && this.queue.length > 0 && this.backlogMs(now) > COLLAPSE_OVER_MS) {
      this.collapse();
      return;
    }
    while (!this.hold && this.queue.length > 0) {
      const head = this.queue[0]!;
      const start = Math.max(this.nextStartAt, head.arrivedAt);
      if (start > now) break;
      this.queue.shift();
      this.startStep(head.msg, start, now);
    }
    for (const a of this.active) {
      if (!a.applied && a.applyAt <= now) this.applyStep(a);
    }
    this.retire(now);
  }

  private startStep(msg: SequencedMessage, start: number, now: number): void {
    if (msg.t !== 'beat') {
      // Settles, prompts, asks and the game-over panel are instant.
      const a: Active = { msg, start, end: start, applyAt: start, applied: false };
      this.applyStep(a);
      this.active.push(a);
      this.nextStartAt = start;
      return;
    }
    // Time compression: once the backlog passes 3 s, everything queued at that moment plays at the factor
    // that fits it into 1.5 s; beats that arrive later are judged afresh when their turn comes.
    if (msg.seq > this.compressThrough) {
      const backlog = this.backlogMs(now) + nominalLead(msg.kind) * this.rate;
      if (backlog > COMPRESS_OVER_MS) {
        this.compression = backlog / COMPRESS_TARGET_MS;
        this.compressThrough = this.queue.length > 0 ? this.queue[this.queue.length - 1]!.msg.seq : msg.seq;
      } else {
        this.compression = 1;
      }
    }
    const f = this.rate / this.compression / this.pace(msg);
    if (!this.shown.game.stack?.length) this.impacted.clear();
    const tl: Timeline = timelineFor(msg, {
      reducedMotion: this.calm,
      fx: this.fx,
      viewer: this.viewer,
      before: this.shown,
      pendingStackFrom: this.pendingStackFrom,
      impacted: this.impacted,
      lastTap: this.lastTap,
    });
    if (msg.kind === 'tap' && typeof msg.card === 'string') this.lastTap = msg.card;
    if (msg.kind === 'damage' && this.fx && typeof msg.amount === 'number') {
      // The hit lands when a lunge makes contact, or when a spell's bolt arrives; the shake runs through the hit-stop.
      // Trample: the player is hit when the streak through the blocker arrives.
      const lunge = tl.tracks.find((t) => t.type === 'lunge');
      const tramples = tl.tracks.find((t) => t.type === 'keyword' && t.fx === 'trample');
      const hit = start + (tramples ? tramples.start + tramples.dur : lunge ? lunge.start + lunge.contact * lunge.dur : tl.tracks[0]?.type === 'impact' ? tl.tracks[0].dur : 0) * f;
      const player = typeof msg.card !== 'string' && typeof msg.target === 'string' && this.shown.players[msg.target] ? msg.target : null;
      const card = typeof msg.card === 'string' ? msg.card : null;
      const lethal = lethalHit(msg, this.shown);
      const mag = player || card ? shakeFor(msg.amount, !!player, !!lethal) : 0;
      if (mag > 0) this.shake = { at: hit, mag, ...(lethal ? { lethal: true } : {}) };
      if (lethal) this.lethal = { at: hit, ...(player ? { player } : card ? { card } : {}) };
      if (player === this.viewer) this.hurtAt = hit;
    }
    // A big creature lands with a thud: a light shake as its flight ends.
    const lands = msg.kind === 'etb' && typeof msg.card === 'string' ? (msg.patch?.cards?.[msg.card] ?? this.shown.cards[msg.card]) : undefined;
    if (lands && this.fx && (lands.state?.power ?? 0) >= 5) this.shake = { at: start + tl.duration * f, mag: 0.3 };
    if (msg.kind === 'toStack' && typeof msg.card !== 'string') this.pendingStackFrom = msg.from ?? null;
    else if (tl.tracks.some((t) => t.type === 'flight' && t.to?.zone === 'Stack')) this.pendingStackFrom = null;
    // Consecutive taps / tokens / mills stagger instead of queueing back to back.
    const next = this.queue[0]?.msg;
    let lead = tl.lead;
    const stagger = STAGGER[msg.kind];
    if (stagger !== undefined && next?.t === 'beat' && STAGGER[next.kind] === stagger) lead = Math.min(lead, stagger);
    const a: Active = { msg, start, end: start + tl.duration * f, applyAt: start + tl.applyAt * f, applied: false };
    for (const t of tl.tracks) {
      const scheduled = { ...t, start: t.start * f, dur: t.dur * f, id: ++this.trackIds, at: start + t.start * f, seq: msg.seq };
      this.tracks.push(scheduled as ScheduledTrack);
    }
    this.active.push(a);
    this.nextStartAt = start + lead * f;
    if (a.applyAt <= now) this.applyStep(a);
  }

  /**
   * How much faster than 1x this beat plays (timing by action). Routine steps (untap, mana taps, land drops) are
   * always a little quicker; while the table plays itself (`fast`: passing the turn, or auto-skip on the opponent's
   * turn) they run 3x, but anything that concerns me plays at full length: the opponent's spells, damage or life
   * loss on my side, and deaths.
   */
  private pace(msg: BeatMsg): number {
    const cards = this.shown.cards;
    const mine = (id: unknown) => typeof id === 'string' && cards[id]?.controller === this.viewer;
    const land = typeof msg.card === 'string' && isLand(cards[msg.card]);
    const routine = msg.kind === 'untap' ? 1.5 : msg.kind === 'tap' ? 1.2 : msg.kind === 'etb' && land ? 1.5 : 1;
    // Impactful steps take longer everywhere: spells, creatures arriving, deaths, damage, life, exile, bounce.
    if (IMPACT.has(msg.kind) && !(msg.kind === 'etb' && land)) return IMPACT_PACE;
    if (!this.fast) return routine;
    const concernsMe =
      (msg.kind === 'damage' && (msg.target === this.viewer || mine(msg.card))) ||
      (msg.kind === 'life' && msg.player === this.viewer) ||
      ((msg.kind === 'toStack' || msg.kind === 'cast' || msg.kind === 'activate') &&
        (typeof msg.card === 'string' ? !mine(msg.card) : msg.from?.player !== this.viewer)) ||
      msg.kind === 'dies';
    return concernsMe ? 1 : 3;
  }

  private applyStep(a: Active): void {
    a.applied = true;
    const m = a.msg;
    switch (m.t) {
      case 'beat':
      case 'settle':
        if (m.patch) this.shown = applyPatch(this.shown, m.patch);
        break;
      case 'prompt':
      case 'promptUpdate': {
        const { t: _t, seq: _s, ...body } = m;
        this.prompt = body;
        this.countMulligan(body);
        break;
      }
      case 'promptClear':
        if (this.prompt && this.prompt.pid === m.pid) this.prompt = null;
        break;
      case 'ask':
        this.asks = [...this.asks.filter((x) => x.id !== m.id), m];
        break;
      case 'askClear':
        this.asks = this.asks.filter((x) => x.id !== m.id);
        break;
      case 'gameOver':
        this.gameOver = m;
        break;
    }
    this.version++;
  }

  private retire(now: number): void {
    // playedSeq: every step up to it has ended. Steps start in seq order, so scan the active list in order.
    let i = 0;
    while (i < this.active.length) {
      const a = this.active[i]!;
      if (a.end <= now && a.applied) {
        this.active.splice(i, 1);
        continue;
      }
      i++;
    }
    const oldestActive = this.active.length > 0 ? Math.min(...this.active.map((a) => a.msg.seq)) : Infinity;
    const oldestQueued = this.queue.length > 0 ? this.queue[0]!.msg.seq : Infinity;
    const firstUnplayed = Math.min(oldestActive, oldestQueued);
    this.playedSeq = firstUnplayed === Infinity ? this.lastSeq : Math.max(this.playedSeq, firstUnplayed - 1);
    // Drop tracks that have finished (keep a short tail for fades that outlive their step).
    if (this.tracks.length > 0) {
      this.tracks = this.tracks.filter((t) => t.at + t.dur + DUR.crossfade > now);
    }
  }

  /**
   * Collapse: apply everything queued at once and finish all motion. The table crossfades
   * from the old layout for 150 ms (`collapsedAt`).
   */
  collapse(): void {
    const now = this.clock.now();
    for (const a of this.active) if (!a.applied) this.applyStep(a);
    for (const q of this.queue) {
      const a: Active = { msg: q.msg, start: now, end: now, applyAt: now, applied: false };
      this.applyStep(a);
    }
    this.queue = [];
    this.active = [];
    this.tracks = [];
    this.nextStartAt = now;
    this.compression = 1;
    this.compressThrough = 0;
    this.playedSeq = this.lastSeq;
    this.collapsedAt = now;
    this.version++;
  }

  /**
   * The player clicked through a presented spell (scene.ts): if beat `seq` is the one holding
   * the playhead, the next step may start now instead of when its lead runs out. Its patch has applied already.
   */
  release(seq: number, now = this.clock.now()): void {
    const last = this.active[this.active.length - 1];
    if (last?.msg.seq === seq && last.applied && this.nextStartAt > now) this.nextStartAt = now;
  }

  /** Whether any step is still playing or queued. */
  get busy(): boolean {
    return this.queue.length > 0 || this.active.length > 0;
  }

  /** Whether motion is in flight (tracks running) at `now`. */
  isAnimating(now = this.clock.now()): boolean {
    return this.active.some((a) => a.end > now) || this.tracks.some((t) => t.at + t.dur > now);
  }

  /** The current compression factor (1 = real time). */
  get timeCompression(): number {
    return this.compression;
  }

  /** The life total a plate should display at `now` (rolls between values during a life beat). */
  displayLife(player: PlayerId, now = this.clock.now()): number {
    const base = this.shown.players[player]?.life ?? 0;
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i]!;
      if (t.type !== 'roll' || t.player !== player) continue;
      if (now < t.at) return t.from;
      if (t.dur <= 0 || now >= t.at + t.dur) return base;
      const k = (now - t.at) / t.dur;
      return Math.round(t.from + (t.to - t.from) * k);
    }
    return base;
  }

  /** The beat or prompt seq currently at the playhead. */
  get playhead(): number {
    return this.playedSeq;
  }

  /** Recent beats (for diagnostics). */
  static isBeat(m: SequencedMessage): m is BeatMsg {
    return m.t === 'beat';
  }
}

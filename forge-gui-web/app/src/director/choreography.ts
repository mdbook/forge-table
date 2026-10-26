/**
 * Per-beat choreographers.
 *
 * Each beat kind maps to a Timeline at 1x speed: how long it runs, how long the next beat waits (its
 * `lead`, the Pacer cost declared in `hello.beatCosts`), the point at which its patch applies to the
 * shown store, and tracks the table plays on card sprites and plates. Durations are in ms at 1x; the
 * Director scales them by speed and catch-up compression.
 *
 * Kinds not listed are instant: their patch applies the moment the playhead reaches them.
 */
import type { BeatMsg, CardId, GameModel, PlayerId, ZoneRef } from '@forge-table/protocol';
import { blockerMap } from '../arrows/specs';
import { hasKeyword } from '../store/model';
import { KW, deathtouchHit, firstStrikeHit, lifelinkTo, shrugsOff, trampleOver } from './keywords';
import { stackExit, stackExitOf, type StackExit } from '../layout/stack';

/** A card flies from where it was (its sprite, or the `from` zone's anchor) to its new layout slot. */
export interface FlightTrack {
  type: 'flight';
  card: CardId;
  /** The id the card had before the beat (e.g. the hidden library slot a drawn card left). */
  fromId?: CardId;
  from?: ZoneRef;
  to?: ZoneRef;
  start: number;
  dur: number;
  /** Arc lift as a fraction of the flight distance. */
  arc: number;
  /** Peak tilt in degrees. */
  tilt: number;
  /** Settle 1.06 → 1 on the snappy spring at the end (ETB). */
  settle: boolean;
  /** Reduced motion: no path, fade in at the destination instead. */
  crossfade: boolean;
  /** The opponent's spell: shown big in the centre for a beat on its way to the stack (MTGA). */
  present?: boolean;
  /** A death: the card smoulders and chars in place for the first part, then flies to the graveyard. */
  burn?: boolean;
  /**
   * A card leaving the stack (layout/stack.ts stackExit): it pulses as it resolves, then lands on
   * the battlefield, arcs to its graveyard or fades to exile; a countered one shatters.
   */
  stackExit?: StackExit;
  /** A ninjutsu / sneak swap: the card enters the battlefield from the hand already attacking (the scene flares it in). */
  swap?: boolean;
}

/** Re-target a card's pose (tap/untap) with a specific duration and overshoot easing. */
export interface RetargetTrack {
  type: 'retarget';
  card: CardId;
  start: number;
  dur: number;
  overshoot: boolean;
  /**
   * Combat (MTGA juice): an attacker charging forward or a blocker stepping out leans this many degrees at the
   * peak of its slide (toward the table's centre line), lifts a little and lands with a softer give than a tap.
   */
  lean?: number;
  /** A flyer's charge arcs higher (keywords: "flying"). */
  fly?: boolean;
  /** A vigilant attacker stays untapped: a small glint as it is declared. */
  glint?: boolean;
  /** An untap: my permanents' sweeps ripple left to right (keywords.ts rippleDelay). */
  untap?: boolean;
}

/** A floating number at a card or a player plate (damage). */
export interface PopTrack {
  type: 'pop';
  card?: CardId;
  player?: PlayerId;
  text: string;
  /** `counter`: a P/T change or a counter, smaller and gold. */
  tone: 'damage' | 'heal' | 'counter';
  start: number;
  dur: number;
  /** Reduced motion: a static number. */
  still: boolean;
  /** A lethal hit: a bigger number that punches in. */
  big?: boolean;
  /** A P/T change: green when it went up, red when down (gold when mixed). */
  trend?: 'up' | 'down';
}

/** A life total rolls from one value to another on a plate. */
export interface RollTrack {
  type: 'roll';
  player: PlayerId;
  from: number;
  to: number;
  start: number;
  dur: number;
}

/** A token appears: fade and scale in at its slot. */
export interface AppearTrack {
  type: 'appear';
  card: CardId;
  start: number;
  dur: number;
}

/** Combat contact (overhaul): the source lunges at what it hits and back; a hit card jolts. */
export interface LungeTrack {
  type: 'lunge';
  card: CardId;
  /** What it lunges at: a card, or a player's plate. */
  atCard?: CardId;
  atPlayer?: PlayerId;
  /** The card that takes the hit (jolts once the lunge lands). */
  hit?: CardId;
  start: number;
  dur: number;
  /**
   * Hit-stop (MTGA juice): the share of `dur` at which the source makes contact, and at which it lets go. In
   * between both cards freeze at the point of impact (the hit card shudders); fractions, so speed scaling keeps them.
   */
  contact: number;
  release: number;
  /** The hit kills (see lethalHit): a longer freeze and a slow-motion return. */
  lethal?: boolean;
}

/** A spell or ability hits its target (overhaul): a bolt in its colours flies from the source, bursts on arrival. */
export interface ImpactTrack {
  type: 'impact';
  /** The source card (on the stack for a spell, on the battlefield for an ability). */
  card: CardId;
  atCard?: CardId;
  atPlayer?: PlayerId;
  /** WUBRG letters ('' = colourless). */
  colors: string;
  start: number;
  /** The bolt's travel; the burst plays on after it (scene). */
  dur: number;
}

/** A spell that fizzles (or is countered) dissolves on the stack before it drifts to the graveyard. */
export interface FizzleTrack {
  type: 'fizzle';
  card: CardId;
  start: number;
  dur: number;
}

/** Mana made: sparks in its colours fly from the permanent just tapped to its controller's plate. Decorative (no lead). */
export interface SparksTrack {
  type: 'sparks';
  card: CardId;
  player: PlayerId;
  /** WUBRG / C letters. */
  colors: string;
  start: number;
  dur: number;
}

/**
 * A keyword moment at a hit (keywords.ts; drawn by table/keywordFx.ts). Decorative, except trample's streak, which
 * the life beat after it waits for (the player's chip lands when the streak arrives).
 * - `trample`: the hit punches through `from` (the blockers) and a streak runs on to player `to`.
 * - `venom`: deathtouch, a venom-green flash on `card`; it withers instead of charring if it dies.
 * - `slash`: a first-strike blow, a quick slash across `card` / `player`.
 * - `shield`: an indestructible creature shrugs off a would-be kill, a shield shimmer on `card`.
 * - `lifelink`: motes from the damage point (`card` / `player`) to the life shield of `to`.
 * - `pulse`: a P/T change, the card swells and settles.
 */
export interface KeywordTrack {
  type: 'keyword';
  fx: 'trample' | 'venom' | 'slash' | 'shield' | 'lifelink' | 'pulse';
  card?: CardId;
  player?: PlayerId;
  from?: CardId[];
  to?: PlayerId;
  start: number;
  dur: number;
  /** Reduced motion: a still mark that fades, no travel. */
  still?: boolean;
}

export type Track = FlightTrack | RetargetTrack | PopTrack | RollTrack | AppearTrack | LungeTrack | ImpactTrack | FizzleTrack | SparksTrack | KeywordTrack;

export interface Timeline {
  /** Total running time of every track. */
  duration: number;
  /** Time until the next beat may start (≤ duration lets beats overlap). */
  lead: number;
  /** Time at which the beat's patch applies to `shown`. */
  applyAt: number;
  tracks: Track[];
}

/** Choreography constants at 1x (ms). Exported for tests and for `beatCosts`. */
export const DUR = {
  draw: 420,
  toStack: 300,
  etb: 360,
  token: 240,
  tokenStagger: 40,
  tap: 180,
  tapStagger: 40,
  dies: 400,
  discard: 360,
  mill: 280,
  millStagger: 60,
  /** Cards drawn in a row overlap by this much (an opening 7 shouldn't take ~3 s). */
  drawStagger: 90,
  exile: 400,
  bounce: 360,
  toHand: 360,
  toGraveyard: 360,
  toLibrary: 300,
  move: 300,
  life: 400,
  damagePop: 600,
  damageLead: 300,
  /** A lunge: in to contact, then back (the freeze between them is extra). */
  lungeIn: 112,
  lungeOut: 208,
  /** Hit-stop at contact: both cards freeze this long (a kill freezes longer, and the return plays slower). */
  hitStop: 70,
  hitStopLethal: 130,
  lethalSlow: 1.6,
  /** Declared attackers charge forward; blockers step out to meet their attacker. */
  charge: 240,
  blockStep: 260,
  /** A dying creature chars in place this long before it flies to the graveyard. */
  burn: 380,
  /** An opponent's spell: to the centre, held big, then to the stack. */
  present: 1400,
  /** A spell's bolt flying to its target; the effect beat waits for it. */
  impact: 260,
  fizzle: 420,
  sparks: 520,
  /** Keyword moments (keywords.ts): trample's streak from the blocker to the player (the chip waits for it). */
  trample: 240,
  venom: 520,
  slash: 260,
  shield: 560,
  lifelink: 560,
  pulse: 300,
  crossfade: 150,
  reducedFade: 200,
} as const;

/** Beat kinds whose consecutive repeats overlap (stagger) instead of playing back to back. */
export const STAGGER: Record<string, number> = {
  tap: DUR.tapStagger,
  untap: DUR.tapStagger,
  token: DUR.tokenStagger,
  mill: DUR.millStagger,
  draw: DUR.drawStagger,
};

/** Zone-change kinds that fly a card, and their flight times. */
const FLIGHTS: Record<string, { dur: number; arc: number; tilt: number; settle?: boolean }> = {
  draw: { dur: DUR.draw, arc: 0.18, tilt: 6 },
  toStack: { dur: DUR.toStack, arc: 0.16, tilt: 3 },
  etb: { dur: DUR.etb, arc: 0.06, tilt: 2, settle: true },
  dies: { dur: DUR.dies, arc: 0.12, tilt: 4 },
  discard: { dur: DUR.discard, arc: 0.16, tilt: 5 },
  mill: { dur: DUR.mill, arc: 0.12, tilt: 4 },
  exile: { dur: DUR.exile, arc: 0.1, tilt: 3 },
  bounce: { dur: DUR.bounce, arc: 0.16, tilt: 5 },
  toHand: { dur: DUR.toHand, arc: 0.14, tilt: 4 },
  toGraveyard: { dur: DUR.toGraveyard, arc: 0.12, tilt: 4 },
  toLibrary: { dur: DUR.toLibrary, arc: 0.12, tilt: 4 },
  move: { dur: DUR.move, arc: 0.08, tilt: 2 },
};

/**
 * The cost of each beat kind at 1x, sent as `hello.client.beatCosts`. It is the beat's `lead`, the time
 * it holds the playhead, so the server's Pacer models exactly what this client plays. Kinds this client
 * plays instantly are declared as 0, overriding the Pacer's defaults.
 */
export function beatCosts(): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const [kind, f] of Object.entries(FLIGHTS)) costs[kind] = f.dur;
  costs.token = DUR.token;
  costs.tap = DUR.tap;
  costs.untap = DUR.tap;
  costs.life = DUR.life;
  costs.damage = DUR.damageLead;
  costs.dies = DUR.burn + DUR.dies;
  for (const k of INSTANT_KINDS) costs[k] = 0;
  // ponytail: the impact delays the effect beat, not the resolve, but one resolve follows each targeted effect.
  costs.resolve = DUR.impact;
  costs.fizzle = DUR.fizzle;
  return costs;
}

/** Kinds the Pacer has a non-zero default for but this client plays instantly. */
const INSTANT_KINDS = [
  'cast', 'activate', 'attack', 'block', 'turn', 'phase', 'counters', 'attach',
  'shuffle', 'priority', 'stats', 'log', 'combatChanged', 'combatEnded', 'removeFromStack', 'poison',
];

export interface ChoreoContext {
  reducedMotion: boolean;
  /** Particles and other flourishes (the effects setting); undefined = on. */
  fx?: boolean;
  /** Whose table this is: the opponent's spells are presented (see FlightTrack.present). */
  viewer?: PlayerId;
  /** The shown model just before this beat's patch applies. */
  before?: GameModel;
  /** `from` of a preceding `toStack` beat that could not name its card (see inferStackFlights). */
  pendingStackFrom?: ZoneRef | null;
  /** Targets of the resolving stack item already hit (`item:target`), so each is hit once; the Director owns it. */
  impacted?: Set<string>;
  /** The card the last `tap` beat tapped (the likely mana source of a following `manaPool`). */
  lastTap?: CardId | null;
}

const MANA_LETTER: Record<string, string> = { WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C' };

const INSTANT: Timeline = { duration: 0, lead: 0, applyAt: 0, tracks: [] };

/** The 1x timeline for one beat. */
export function choreograph(beat: BeatMsg, ctx: ChoreoContext): Timeline {
  const kind = beat.kind;
  const flight = FLIGHTS[kind];
  if (flight && typeof beat.card === 'string') {
    const t: FlightTrack = {
      type: 'flight',
      card: beat.card,
      start: 0,
      dur: ctx.reducedMotion ? DUR.reducedFade : flight.dur,
      arc: flight.arc,
      tilt: flight.tilt,
      settle: !!flight.settle && !ctx.reducedMotion,
      crossfade: ctx.reducedMotion,
    };
    if (typeof beat.fromId === 'string') t.fromId = beat.fromId;
    if (beat.from) t.from = beat.from;
    if (beat.to) t.to = beat.to;
    // Off the stack: resolved, or countered (inferStackExits for moves no beat flies); a fizzle's dissolve overrides it.
    const exit = ctx.reducedMotion ? null : stackExitOf(beat, ctx.before);
    if (exit && exit !== 'bounce') t.stackExit = exit;
    if (kind === 'etb' && ctx.before?.cards[beat.card]?.zone === 'Hand' && beat.patch?.cards?.[beat.card]?.attacking) t.swap = true;
    if (kind === 'dies' && !ctx.reducedMotion) {
      t.burn = true;
      t.dur = DUR.burn + flight.dur;
      return { duration: t.dur, lead: t.dur, applyAt: 0, tracks: [t] };
    }
    if (kind === 'toStack' && presents(beat.from, ctx)) {
      t.present = true;
      t.dur = DUR.present;
      return { duration: t.dur, lead: DUR.present, applyAt: 0, tracks: [t] };
    }
    return { duration: t.dur, lead: flight.dur, applyAt: 0, tracks: [t] };
  }
  switch (kind) {
    case 'token': {
      if (typeof beat.card !== 'string') return INSTANT;
      const dur = ctx.reducedMotion ? DUR.reducedFade : DUR.token;
      return { duration: dur, lead: DUR.token, applyAt: 0, tracks: [{ type: 'appear', card: beat.card, start: 0, dur }] };
    }
    case 'tap':
    case 'untap': {
      if (typeof beat.card !== 'string') return { ...INSTANT, lead: DUR.tap, duration: DUR.tap };
      const dur = ctx.reducedMotion ? 0 : DUR.tap;
      return {
        duration: DUR.tap,
        lead: DUR.tap,
        applyAt: 0,
        // Both turn with a slight overshoot (snappier); an untap also lights my permanents in a ripple (scene).
        tracks: [{ type: 'retarget', card: beat.card, start: 0, dur, overshoot: true, ...(kind === 'untap' ? { untap: true } : {}) }],
      };
    }
    case 'life': {
      const player = beat.player;
      const from = beat.oldLives;
      const to = beat.newLives;
      if (typeof player !== 'string' || typeof from !== 'number' || typeof to !== 'number') {
        return { duration: DUR.life, lead: DUR.life, applyAt: 0, tracks: [] };
      }
      const dur = ctx.reducedMotion ? 0 : DUR.life;
      return { duration: DUR.life, lead: DUR.life, applyAt: 0, tracks: [{ type: 'roll', player, from, to, start: 0, dur }] };
    }
    case 'damage': {
      const amount = typeof beat.amount === 'number' ? beat.amount : 0;
      const lethal = !!lethalHit(beat, ctx.before);
      const pop: PopTrack = {
        type: 'pop',
        text: `-${amount}`,
        tone: 'damage',
        start: 0,
        dur: DUR.damagePop,
        still: ctx.reducedMotion,
      };
      if (lethal && !ctx.reducedMotion) pop.big = true;
      if (typeof beat.card === 'string') pop.card = beat.card;
      else if (typeof beat.target === 'string') pop.player = beat.target;
      else return { duration: 0, lead: DUR.damageLead, applyAt: 0, tracks: [] };
      // A player's loss shows as the life chip on their plate when the life beat that follows plays (Plates.tsx), so
      // no pop there and no wait: the life beat starts as the hit lands. Infect has no life beat: it keeps its pop.
      const chip = !!pop.player && beat.infect !== true;
      // Trample: Forge sends the life beat only after every blocker's hit, so the number pops on the plate as the
      // streak arrives (the chip follows with the life beat).
      const tramples = trampleOver(beat, ctx.before);
      const pops = chip && !tramples ? [] : [pop];
      // A creature on the battlefield dealing it (combat, fight): it lunges at what it hits and freezes there for a
      // beat (hit-stop); the pop lands at contact. A kill freezes longer and comes back in slow motion.
      const src = typeof beat.source === 'string' ? beat.source : null;
      // Trample (keywords.ts): the attacker hits the blocker it goes through, and a streak carries on to the player.
      if (src && !ctx.reducedMotion && ctx.before?.cards[src]?.zone === 'Battlefield') {
        const hold = lethal ? DUR.hitStopLethal : DUR.hitStop;
        const back = DUR.lungeOut * (lethal ? DUR.lethalSlow : 1);
        const dur = DUR.lungeIn + hold + back;
        const lunge: LungeTrack = { type: 'lunge', card: src, start: 0, dur, contact: DUR.lungeIn / dur, release: (DUR.lungeIn + hold) / dur };
        if (lethal) lunge.lethal = true;
        if (pop.card) {
          lunge.atCard = pop.card;
          lunge.hit = pop.card;
        } else if (tramples) {
          lunge.atCard = tramples.through[0]!;
          lunge.hit = tramples.through[0]!;
        } else lunge.atPlayer = pop.player;
        // The next beat waits for trample's streak to arrive; its number pops there.
        const arrive = tramples ? DUR.lungeIn + DUR.trample : 0;
        pop.start = tramples ? arrive : DUR.lungeIn;
        const freed = DUR.lungeIn + hold;
        const kw = keywordTracks(beat, ctx, DUR.lungeIn);
        return {
          duration: Math.max(dur, pops.length ? pop.start + DUR.damagePop : 0, ...kw.map((t) => t.start + t.dur)),
          lead: Math.max(chip ? freed : freed + DUR.damageLead, arrive),
          applyAt: DUR.lungeIn,
          tracks: [lunge, ...pops, ...kw],
        };
      }
      const kw = keywordTracks(beat, ctx, 0);
      if (kw.length > 0) {
        const end = Math.max(...kw.map((t) => t.start + t.dur));
        return { duration: Math.max(end, pops.length ? DUR.damagePop : 0), lead: chip ? 0 : DUR.damageLead, applyAt: 0, tracks: [...pops, ...kw] };
      }
      return chip ? INSTANT : { duration: DUR.damagePop, lead: DUR.damageLead, applyAt: 0, tracks: pops };
    }
    case 'manaPool': {
      const src = ctx.lastTap;
      const player = beat.player;
      if (ctx.reducedMotion || ctx.fx === false || beat.mode !== 'Added' || !src || typeof player !== 'string' || ctx.before?.cards[src]?.controller !== player) return INSTANT;
      const colors = (Array.isArray(beat.colors) ? beat.colors : []).map((c) => MANA_LETTER[String(c)] ?? '').join('') || 'C';
      return { duration: DUR.sparks, lead: 0, applyAt: 0, tracks: [{ type: 'sparks', card: src, player, colors, start: 0, dur: DUR.sparks }] };
    }
    case 'counters': {
      // P/T counters show through their `stats` beat (Forge fires it first); this pops the rest (loyalty, charge, …).
      const type = typeof beat.type === 'string' ? beat.type : '';
      const delta = Number(beat.newValue ?? 0) - Number(beat.oldValue ?? 0);
      if (typeof beat.card !== 'string' || !delta || !type || /^[+-]\d+\/[+-]\d+$/.test(type)) return INSTANT;
      const pop: PopTrack = { type: 'pop', card: beat.card, text: `${delta > 0 ? '+' : '−'}${Math.abs(delta)} ${type}`, tone: 'counter', start: 0, dur: DUR.damagePop, still: ctx.reducedMotion };
      return { duration: DUR.damagePop, lead: 0, applyAt: 0, tracks: [pop] };
    }
    case 'stats': {
      // A creature's power / toughness changed on the battlefield (a pump, counters, an anthem): "+2/+2" at the card.
      const tracks: Track[] = [];
      if (beat.transform === true) return INSTANT; // a transformed face is a new card, not a pump
      for (const id of Array.isArray(beat.cards) ? beat.cards : []) {
        const was = typeof id === 'string' ? ctx.before?.cards[id] : undefined;
        const now = typeof id === 'string' ? beat.patch?.cards?.[id] : undefined;
        if (!was || !now || was.zone !== 'Battlefield' || now.zone !== 'Battlefield') continue;
        const dp = (now.state?.power ?? 0) - (was.state?.power ?? 0);
        const dt = (now.state?.toughness ?? 0) - (was.state?.toughness ?? 0);
        if (!dp && !dt) continue;
        const sig = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);
        const pop: PopTrack = { type: 'pop', card: id as CardId, text: `${sig(dp)}/${sig(dt)}`, tone: 'counter', start: 0, dur: DUR.damagePop, still: ctx.reducedMotion };
        const trend = ptTrend(dp, dt);
        if (trend) pop.trend = trend;
        tracks.push(pop);
        // The card swells and settles with it (a pump pulse); reduced motion keeps the number only.
        if (!ctx.reducedMotion) tracks.push({ type: 'keyword', fx: 'pulse', card: id as CardId, start: 0, dur: DUR.pulse });
      }
      return tracks.length ? { duration: DUR.damagePop, lead: 0, applyAt: 0, tracks } : INSTANT;
    }
    case 'fizzle': {
      const host = (beat.spell as { host?: unknown } | undefined)?.host;
      if (typeof host !== 'string' || ctx.reducedMotion) return INSTANT;
      return { duration: DUR.fizzle, lead: DUR.fizzle, applyAt: 0, tracks: [{ type: 'fizzle', card: host, start: 0, dur: DUR.fizzle }] };
    }
    default:
      return INSTANT;
  }
}

/** A P/T change's colour: up when nothing went down, down when nothing went up, none (gold) when mixed. */
export function ptTrend(dp: number, dt: number): 'up' | 'down' | undefined {
  if (dp >= 0 && dt >= 0 && dp + dt > 0) return 'up';
  if (dp <= 0 && dt <= 0 && dp + dt < 0) return 'down';
  return undefined;
}

/**
 * The keyword moments of a damage beat (keywords.ts), starting at `at` (the moment the hit lands). Trample's streak
 * and the hit marks (venom, slash, shield) also play under reduced motion and Effects Off, as still marks that fade;
 * lifelink's motes are particles, so full effects only (the gain chip says it otherwise).
 */
export function keywordTracks(beat: BeatMsg, ctx: ChoreoContext, at: number): KeywordTrack[] {
  const before = ctx.before;
  if (beat.kind !== 'damage' || !before) return [];
  const still = ctx.reducedMotion;
  const out: KeywordTrack[] = [];
  const where: Pick<KeywordTrack, 'card' | 'player'> = typeof beat.card === 'string' ? { card: beat.card } : typeof beat.target === 'string' ? { player: beat.target } : {};
  const tramples = trampleOver(beat, before);
  if (tramples) out.push({ type: 'keyword', fx: 'trample', from: tramples.through, to: tramples.player, start: at, dur: still ? DUR.reducedFade * 1.5 : DUR.trample, ...(still ? { still } : {}) });
  const venom = deathtouchHit(beat, before);
  if (venom) out.push({ type: 'keyword', fx: 'venom', card: venom, start: at, dur: DUR.venom, ...(still ? { still } : {}) });
  const shield = shrugsOff(beat, before);
  if (shield) out.push({ type: 'keyword', fx: 'shield', card: shield, start: at, dur: DUR.shield, ...(still ? { still } : {}) });
  if (firstStrikeHit(beat, before) && (where.card || where.player)) out.push({ type: 'keyword', fx: 'slash', ...where, start: at, dur: DUR.slash, ...(still ? { still } : {}) });
  const gain = lifelinkTo(beat, before);
  // From where the damage lands; a trampling lifelinker's from the player it reached.
  if (gain && ctx.fx !== false && !still && (where.card || where.player)) out.push({ type: 'keyword', fx: 'lifelink', ...where, to: gain, start: at + (tramples ? DUR.trample : 0), dur: DUR.lifelink });
  return out;
}

/**
 * The resolving item hits its target. Forge sends the effect (damage, dies, bounce, tap…) before `resolve`, so the
 * bolt goes on the first beat that touches one of the top stack item's targets.
 */
export function impactFor(beat: BeatMsg, ctx: ChoreoContext): ImpactTrack | null {
  const top = ctx.before?.game.stack?.[0];
  if (ctx.reducedMotion || ctx.fx === false || !top?.source || !ctx.before) return null;
  const targets = top.targets ?? [];
  const card = [beat.card, beat.fromId].find((c): c is string => typeof c === 'string' && targets.includes(c));
  const player = card ? undefined : [beat.target, beat.player].find((p): p is string => typeof p === 'string' && targets.includes(p) && !!ctx.before!.players[p]);
  if (!card && !player) return null;
  const key = `${top.id}:${card ?? player}`;
  if (ctx.impacted?.has(key)) return null;
  ctx.impacted?.add(key);
  const t: ImpactTrack = { type: 'impact', card: top.source, colors: ctx.before.cards[top.source]?.state?.colors ?? '', start: 0, dur: DUR.impact };
  if (card) t.atCard = card;
  else t.atPlayer = player!;
  return t;
}

/**
 * The sidecar's `toStack` beat cannot name the card: the projector only discovers stack cards through
 * stack items, which the engine adds after the zone change. The card first appears in the patch of the
 * following `cast` beat. This infers the hand → stack flight there: any card a patch moves onto the Stack
 * (and that no track already flies) flies from the pending `toStack` origin (or its controller's hand).
 */
export function inferStackFlights(beat: BeatMsg, ctx: ChoreoContext, already: Track[]): FlightTrack[] {
  const cards = beat.patch?.cards;
  if (!cards) return [];
  const out: FlightTrack[] = [];
  for (const [id, c] of Object.entries(cards)) {
    if (!c || c.zone !== 'Stack') continue;
    if (ctx.before?.cards[id]?.zone === 'Stack') continue;
    if (already.some((t) => t.type === 'flight' && t.card === id)) continue;
    const from: ZoneRef = ctx.pendingStackFrom ?? (c.controller ? { player: c.controller, zone: 'Hand' } : { zone: 'Hand' });
    const present = presents(from, ctx);
    out.push({
      ...(present ? { present: true } : {}),
      type: 'flight',
      card: id,
      from,
      to: { zone: 'Stack' },
      start: 0,
      dur: ctx.reducedMotion ? DUR.reducedFade : present ? DUR.present : DUR.toStack,
      arc: FLIGHTS.toStack!.arc,
      tilt: FLIGHTS.toStack!.tilt,
      settle: false,
      crossfade: ctx.reducedMotion,
    });
  }
  return out;
}

/** The 1x timeline for a beat including inferred stack flights. */
export function timelineFor(beat: BeatMsg, ctx: ChoreoContext): Timeline {
  let tl = choreograph(beat, ctx);
  const impact = impactFor(beat, ctx);
  if (impact) {
    // Everything the beat does waits for the bolt to land.
    const d = impact.dur;
    // An ability's source fires the bolt instead of lunging (a pinger); combat never has a stack item.
    const rest = tl.tracks.filter((t) => !(t.type === 'lunge' && t.card === impact.card)).map((t) => ({ ...t, start: t.start + d }));
    tl = { duration: tl.duration + d, lead: tl.lead + d, applyAt: tl.applyAt + d, tracks: [impact, ...rest] };
  }
  const steps = combatSteps(beat, ctx);
  if (steps.length > 0) {
    const stepped = new Set(steps.map((t) => t.card));
    tl = { ...tl, tracks: [...tl.tracks.filter((t) => !(t.type === 'retarget' && stepped.has(t.card))), ...steps] };
  }
  const exits = inferStackExits(beat, ctx, tl.tracks);
  if (exits.length > 0) tl = { ...tl, duration: Math.max(tl.duration, DUR.toGraveyard), tracks: [...tl.tracks, ...exits] };
  const inferred = inferStackFlights(beat, ctx, tl.tracks);
  if (inferred.length === 0) return tl;
  const fly = Math.max(...inferred.map((t) => t.dur));
  return {
    duration: Math.max(tl.duration, fly),
    lead: Math.max(tl.lead, fly),
    applyAt: 0,
    tracks: [...tl.tracks, ...inferred],
  };
}

/** An opponent's spell from their hand (not mine, not with reduced motion) is presented on its way to the stack. */
function presents(from: ZoneRef | undefined, ctx: ChoreoContext): boolean {
  return !ctx.reducedMotion && !!ctx.viewer && !!from?.player && from.player !== ctx.viewer && from.zone === 'Hand';
}

/**
 * Whether a damage beat kills what it hits, judged on the model just before it: a player whose life it takes to 0, or
 * a creature whose marked damage it takes to its toughness (any damage from a deathtouch source). Indestructible
 * creatures survive. 'player' / 'creature', or null. Infect counts poison, not life: never lethal here.
 */
export function lethalHit(beat: BeatMsg, before: GameModel | undefined): 'player' | 'creature' | null {
  const amount = typeof beat.amount === 'number' ? beat.amount : 0;
  if (!before || amount <= 0 || beat.infect === true) return null;
  if (typeof beat.card === 'string') {
    const c = before.cards[beat.card];
    const toughness = c?.state?.toughness;
    if (!c || c.zone !== 'Battlefield' || typeof toughness !== 'number' || toughness <= 0) return null;
    const has = (id: unknown, kw: string) => typeof id === 'string' && !!before.cards[id]?.state?.keywords?.some((k) => k.title === kw);
    if (has(beat.card, 'Indestructible')) return null;
    return (c.damage ?? 0) + amount >= toughness || has(beat.source, 'Deathtouch') ? 'creature' : null;
  }
  const p = typeof beat.target === 'string' ? before.players[beat.target] : undefined;
  return p && p.life - amount <= 0 ? 'player' : null;
}

/**
 * How hard an opponent's spell lands on the stack from its presentation (batch 11: the stack louder), on the
 * shake scale (shakeFor; a big creature landing is 0.3): a light thud, harder the more it costs, from 0.2 for a
 * one-drop to the 0.4 cap at seven. Effects Full only (the scene's thud).
 */
export function stackThud(manaValue: number): number {
  return Math.min(0.4, 0.17 + 0.033 * Math.max(0, manaValue));
}

/**
 * How hard the camera shakes for a hit (0..1 of the scene's peak offset; scaled by damage, as in MTGA): 1 damage
 * to a player is a tremor, 10 is the full shake; a creature takes half as much, and a creature hit under 2 shakes
 * nothing. A kill is always big: a player's death the full shake, a creature's at least 0.55.
 */
export function shakeFor(amount: number, toPlayer: boolean, lethal: boolean): number {
  if (amount <= 0) return 0;
  const base = Math.min(1, 0.12 + 0.088 * amount) * (toPlayer ? 1 : 0.5);
  if (lethal) return toPlayer ? 1 : Math.max(base, 0.55);
  return toPlayer || base >= 0.15 ? base : 0;
}

/**
 * Combat steps (MTGA juice). Whatever beat's patch declares an attacker (Forge sends it on a tap, the attack
 * beat or a combatChanged) or puts a blocker in front of its attacker (planned or locked), the card charges / steps
 * there instead of the plain reflow: a decisive slide with a slight lean and a small give at the end. Decorative:
 * the layout already moves them, this only shapes how; it replaces a tap's own retarget on the same card. Reduced
 * motion snaps them.
 */
export function combatSteps(beat: BeatMsg, ctx: ChoreoContext): RetargetTrack[] {
  const before = ctx.before;
  const cards = beat.patch?.cards;
  if (!before) return [];
  const out: RetargetTrack[] = [];
  const add = (card: CardId, dur: number, lean: number, extra: Pick<RetargetTrack, 'fly' | 'glint'> = {}) => {
    if (out.some((t) => t.card === card)) return;
    out.push(ctx.reducedMotion ? { type: 'retarget', card, start: 0, dur: 0, overshoot: false } : { type: 'retarget', card, start: 0, dur, overshoot: true, lean, ...extra });
  };
  for (const [id, c] of Object.entries(cards ?? {})) {
    if (!c?.attacking || c.zone !== 'Battlefield' || before.cards[id]?.attacking) continue;
    // A flyer arcs higher on its charge; a vigilant attacker (still untapped) glints as it goes.
    const extra: Pick<RetargetTrack, 'fly' | 'glint'> = {};
    if (hasKeyword(c, KW.flying)) extra.fly = true;
    if (hasKeyword(c, KW.vigilance) && !c.tapped) extra.glint = true;
    add(id, DUR.charge, 3, extra);
  }
  const game = beat.patch?.game;
  if (game) {
    const was = blockerMap(before.game.combat);
    for (const id of blockerMap(game.combat).keys()) if (!was.has(id)) add(id, DUR.blockStep, 2);
  }
  return out;
}

/**
 * A resolved (or countered) instant or sorcery leaving the stack (MTGA). When no beat flies it (Forge often moves it
 * in the patch of a `stats` or `zone` beat), it still gets its stack exit (layout/stack.ts stackExit). Decorative: no
 * lead. A fizzled spell has its own dissolve (scene) and keeps a plain flight.
 */
export function inferStackExits(beat: BeatMsg, ctx: ChoreoContext, already: Track[]): FlightTrack[] {
  const cards = beat.patch?.cards;
  if (!cards || ctx.reducedMotion) return [];
  const out: FlightTrack[] = [];
  for (const [id, c] of Object.entries(cards)) {
    if (!c || (c.zone !== 'Graveyard' && c.zone !== 'Exile') || ctx.before?.cards[id]?.zone !== 'Stack') continue;
    if (already.some((t) => t.type === 'flight' && t.card === id)) continue;
    const owner = c.owner ?? c.controller;
    const to: ZoneRef = owner ? { player: owner, zone: c.zone } : { zone: c.zone };
    const exit = stackExit(id, { zone: 'Stack' }, to, ctx.before) ?? 'resolve';
    out.push({ type: 'flight', card: id, from: { zone: 'Stack' }, to, start: 0, dur: DUR.toGraveyard, arc: 0.12, tilt: 4, settle: false, crossfade: false, stackExit: exit });
  }
  return out;
}

/** The nominal lead of a beat kind at 1x (used for backlog estimates before it is choreographed). */
export function nominalLead(kind: string): number {
  if (kind === 'dies') return DUR.burn + DUR.dies;
  const f = FLIGHTS[kind];
  if (f) return f.dur;
  switch (kind) {
    case 'token':
      return DUR.token;
    case 'tap':
    case 'untap':
      return DUR.tap;
    case 'life':
      return DUR.life;
    case 'damage':
      return DUR.damageLead;
    default:
      return 0;
  }
}

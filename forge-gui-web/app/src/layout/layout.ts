/**
 * Static 1v1 table layout: a pure function from the shown model to a pose per visible card,
 * plus pile and zone anchors. Overflowing rows shrink toward the minimum card size,
 * then overlap; they never break.
 */
import type { Card, CardId, GameModel, PlayerId, ZoneRef } from '@forge-table/protocol';
import { isCreature, isLand, opponentOf } from '../store/model';
import { blockersOf } from '../arrows/specs';
import { ATTACK_STEP, GAP, OPP_FAN_W, cardWidth, geometry, TABLE_W, type Geometry } from './geometry';
import { ABILITY_SCALE, stackCascade, stackEntries } from './stack';
import { hasCommanders } from '../table/commander';

export { ATTACK_STEP };
const G0 = geometry();

export type Region =
  | 'hand'
  | 'alt'
  | 'oppHand'
  | 'myBack'
  | 'myFront'
  | 'oppFront'
  | 'oppBack'
  | 'stack'
  | 'graveyard'
  | 'exile'
  | 'library'
  | 'command';

export interface Pose {
  x: number;
  y: number;
  /** Card height in tu (width follows the 63:88 aspect). */
  h: number;
  /** Radians. */
  rot: number;
  faceUp: boolean;
}

export interface CardPose extends Pose {
  id: CardId;
  z: number;
  region: Region;
  owner: PlayerId;
  /** Lift above the table, in tu (drives the shadow). */
  lift: number;
  /** Identical permanents stacked under this one (shown as a ×N badge); absent for a lone card. */
  count?: number;
  /** A copy stacked under the top card of a group (its badges and sickness Z's are the top card's). */
  under?: boolean;
  /** On the stack: 0 = the front (newest) item, and its brightness (older items are darker; layout/stack.ts). */
  depth?: number;
  shade?: number;
}

export interface PileInfo {
  player: PlayerId;
  zone: 'library' | 'graveyard' | 'exile' | 'command';
  count: number;
  x: number;
  y: number;
  h: number;
  /** Card shown on top of the pile (face-up piles only). */
  topId?: CardId;
  mine: boolean;
}

export interface Layout {
  cards: Map<CardId, CardPose>;
  piles: PileInfo[];
  stackActive: boolean;
  /** The front of the stack zone: a card, or an ability card's virtual id (layout/stack.ts abilityId). */
  stackTop: CardId | undefined;
  /** Stack entries beyond the cascade's depth (not drawn), and the deepest drawn one (it carries the "+N"). */
  stackHidden: number;
  stackDeepest: CardId | undefined;
  /** Where a card enters from / leaves to when it has no sprite / slot of its own. */
  anchor(ref: ZoneRef | undefined): Pose;
}

export interface LayoutInput {
  model: GameModel;
  viewer: PlayerId;
  /** Card under the pointer: a hand card lifts and its neighbours part. */
  hover?: CardId | null;
  /** Mulligan-style prompts: the whole hand is raised for inspection. */
  raiseHand?: boolean;
  /** Touch: a raised hand is a fan of big cards on my half of the table (touchFan), this one in front. */
  touchHand?: { focus: CardId | null };
  /** World width in tu (geometry.ts worldSize); 1920 by default. */
  worldW?: number;
  /** World height in tu; 1080 by default, taller in portrait (geometry.ts worldSize). */
  worldH?: number;
  /** Card-size multiplier (geometry.ts CARD_SCALE); 1 (M) by default. */
  cardScale?: number;
  /** HUD tu per CSS unit, max(s, 0.9) / s; 1 by default. */
  hudK?: number;
  /** A battlefield card picked up by the player (a blocker being aimed): it lifts toward the centre. */
  lifted?: CardId | null;
  /** The order the player dragged their hand into (client-side); cards it doesn't list follow in server order. */
  handOrder?: readonly CardId[];
  /** A hand card dragged out over the table (table/handDrag.ts): the fan closes up without it. */
  dragOut?: CardId | null;
  /** My castable cards waiting outside the hand (table/altZone.ts), in order: the strip beside the hand. */
  alt?: readonly CardId[];
  /** Per-card UI state that keeps otherwise identical permanents apart (selectable, picked, snoozed, playable). */
  marks?: ReadonlyMap<CardId, string>;
}

/** Attachments tuck behind their host, offset this fraction of its height toward the centre line. */
export const ATTACH_OFFSET = 0.22;
/** The battlefield rows' common centre line (x) for a horizontal budget; ROW_AXIS is the 1920 one. */
export const rowAxis = (X: Geometry['X']): number => (X.rowStart + X.rowEnd) / 2;
export const ROW_AXIS = rowAxis(G0.X);

const ROT_90 = Math.PI / 2;
const DEG = Math.PI / 180;

/** Whether the viewer sees this card's face. */
export function isFaceUp(id: CardId, card: Card | undefined): boolean {
  if (id.startsWith('x')) return false;
  if (id.startsWith('f')) return false;
  return !!card?.state;
}

// ------------------------------------------------------------------------------------------ rows

export interface RowUnit {
  id: CardId;
  tapped: boolean;
  /** Extra space before this unit (segment break between creatures and support). */
  breakBefore?: boolean;
  /** Identical permanents stacked under this one (groupUnits). */
  more?: CardId[];
}

/**
 * Cards stacked under the top one peek out this far to the right (tu each), at most GROUP_SHOWN steps (four layers
 * in all; the ×N badge carries the rest). At 7 tu the copy behind read as a dark sliver; with the edge rim
 * (cardSprite.ts setRim) each layer's lit edge shows.
 */
export const GROUP_STEP = 12;
const GROUP_SHOWN = 3;
const groupPeek = (u: RowUnit) => Math.min(u.more?.length ?? 0, GROUP_SHOWN) * GROUP_STEP;

/**
 * Identical permanents share one slot (QA: forty lands ran off the table): same name and art, token or not,
 * tapped, sick, P/T, counters, damage, controller and UI marks. A card in combat, carrying attachments, face down,
 * or in `apart` stands alone; any change splits it out on the next model.
 */
export function groupUnits(units: RowUnit[], cards: Record<CardId, Card | undefined>, marks: ReadonlyMap<CardId, string> | undefined, apart: ReadonlySet<CardId>): RowUnit[] {
  const out: RowUnit[] = [];
  const byKey = new Map<string, RowUnit>();
  for (const u of units) {
    const c = cards[u.id];
    const lone = !c || c.attacking || c.blocking || c.facedown || c.phasedOut || (c.attachedCards?.length ?? 0) > 0 || apart.has(u.id);
    const s = c?.state;
    const key = lone ? '' : [s?.name, s?.imageKey, c.token, c.tapped, c.sickness, s?.power, s?.toughness, s?.loyalty, JSON.stringify(c.counters ?? {}), c.damage ?? 0, c.controller, marks?.get(u.id) ?? ''].join('|');
    const top = key ? byKey.get(key) : undefined;
    if (top) (top.more ??= []).push(u.id);
    else {
      const unit = { ...u };
      if (key) byKey.set(key, unit);
      out.push(unit);
    }
  }
  return out;
}

export interface RowResult {
  /** Centre x of each unit, in input order. */
  xs: number[];
  /** Card height used for the whole row. */
  h: number;
  /** Whether units overlap (shrinking alone could not fit them). */
  overlapped: boolean;
}

const SEGMENT_GAP = GAP * 3;

/**
 * Lay a row of units into [xMin, xMax], centred on `centre` (default: the middle of the range) and slid
 * just far enough to stay inside the range. Tapped units take a slot as wide as the card is tall; a group's slot
 * also holds the cards peeking out to the right (xs are the top card's centres).
 * Overflow: shrink toward `minH`; if it still does not fit, overlap evenly (at least the remaining room).
 */
export function layoutRow(units: RowUnit[], xMin: number, xMax: number, natH: number, minH: number, centre?: number): RowResult {
  const n = units.length;
  if (n === 0) return { xs: [], h: natH, overlapped: false };
  const avail = xMax - xMin;
  const coef = units.reduce((s, u) => s + (u.tapped ? 1 : cardWidth(1)), 0);
  const breaks = units.filter((u, i) => i > 0 && u.breakBefore).length * SEGMENT_GAP;
  const peeks = units.map(groupPeek);
  const fixed = GAP * (n - 1) + breaks + peeks.reduce((s, w) => s + w, 0);
  let h = natH;
  if (coef * h + fixed > avail) h = Math.max(minH, (avail - fixed) / coef);
  const cardW = units.map((u) => (u.tapped ? h : cardWidth(h)));
  const slots = cardW.map((w, i) => w + peeks[i]!);
  const total = slots.reduce((s, w) => s + w, 0);
  let gap = GAP;
  let overlapped = false;
  if (total + fixed > avail + 0.01) {
    // Overlap: distribute the remaining room (negative gaps). Breaks collapse first.
    gap = n > 1 ? (avail - total) / (n - 1) : 0;
    overlapped = true;
  }
  const breakGap = overlapped ? 0 : SEGMENT_GAP;
  const width = total + gap * (n - 1) + (overlapped ? 0 : breaks);
  const mid = centre ?? (xMin + xMax) / 2;
  let x = Math.max(xMin, Math.min(xMax - width, mid - width / 2));
  const xs: number[] = [];
  units.forEach((u, i) => {
    if (i > 0) x += gap + (u.breakBefore ? breakGap : 0);
    xs.push(x + cardW[i]! / 2);
    x += slots[i]!;
  });
  return { xs, h, overlapped };
}

// ------------------------------------------------------------------------------------------ blocks

export interface PackItem {
  /** Slot width. */
  w: number;
  /** Desired centre x. */
  x: number;
  /** How strongly it holds its desired x (a blocker in front of its attacker holds hard). */
  weight: number;
}

/**
 * Centres for a row of items in this order, each as close to its desired x as it can be (weighted least
 * squares) with `gap` between neighbours and the row inside [xMin, xMax]: isotonic regression by pool-adjacent-
 * violators on x − (offset from the first item). Null when the items can't fit side by side.
 */
export function packRow(items: PackItem[], xMin: number, xMax: number, gap = GAP): number[] | null {
  const n = items.length;
  if (n === 0) return [];
  const off: number[] = [0];
  for (let i = 1; i < n; i++) off.push(off[i - 1]! + (items[i - 1]!.w + items[i]!.w) / 2 + gap);
  const lo = xMin + items[0]!.w / 2;
  const hi = xMax - items[n - 1]!.w / 2 - off[n - 1]!;
  if (lo > hi + 1e-6) return null;
  const pools: Array<{ sum: number; weight: number; count: number }> = [];
  for (let i = 0; i < n; i++) {
    const w = Math.max(1e-6, items[i]!.weight);
    pools.push({ sum: (items[i]!.x - off[i]!) * w, weight: w, count: 1 });
    while (pools.length > 1) {
      const b = pools[pools.length - 1]!;
      const a = pools[pools.length - 2]!;
      if (a.sum / a.weight <= b.sum / b.weight) break;
      pools.pop();
      a.sum += b.sum;
      a.weight += b.weight;
      a.count += b.count;
    }
  }
  const xs: number[] = [];
  for (const p of pools) {
    const v = Math.min(hi, Math.max(lo, p.sum / p.weight));
    for (let k = 0; k < p.count; k++) xs.push(v + off[xs.length]!);
  }
  return xs;
}

/** How far packRow moves items from where they want to be (weighted squares); Infinity when they don't fit. */
function packCost(items: PackItem[], xMin: number, xMax: number): number {
  const xs = packRow(items, xMin, xMax);
  if (!xs) return Infinity;
  return items.reduce((s, it, i) => s + it.weight * (xs[i]! - it.x) ** 2, 0);
}

/** A blocker's place in front of its attacker: which attacker, and its index among that attacker's blockers. */
export interface BlockSlot {
  attacker: CardId;
  index: number;
  count: number;
}

export function blockGroups(model: GameModel): Map<CardId, BlockSlot> {
  const out = new Map<CardId, BlockSlot>();
  for (const band of model.game.combat ?? []) {
    const bs = blockersOf(band).filter((b) => model.cards[b]?.zone === 'Battlefield' && !out.has(b));
    bs.forEach((b, index) => out.set(b, { attacker: band.attacker, index, count: bs.length }));
  }
  return out;
}

/** Tilt between neighbouring blockers fanned in front of one attacker. */
const BLOCK_FAN_DEG = 3;
// Side by side at the row's own gap (packRow keeps at least GAP between any two cards).
const BLOCK_FAN_GAP = GAP;

interface FrontRow {
  units: RowUnit[];
  xMin: number;
  xMax: number;
  h: number;
  z0: number;
}

/**
 * An attacker with several blockers takes a slot as wide as its fanned blockers, so neighbouring blocks don't
 * collide: its row spreads (packRow, order kept) only as far as it must. A row with no room stays as it is.
 */
function widenAttackers(f: FrontRow, blocks: Map<CardId, BlockSlot>, cards: Map<CardId, CardPose>, xMin: number): void {
  const fan = new Map<CardId, number>();
  for (const s of blocks.values()) fan.set(s.attacker, Math.max(fan.get(s.attacker) ?? 0, s.count));
  const w = cardWidth(f.h);
  if (!f.units.some((u) => (fan.get(u.id) ?? 0) > 1)) return;
  const items = f.units.map((u) => {
    const n = fan.get(u.id) ?? 0;
    const slot = u.tapped ? f.h : w;
    return { w: n > 1 ? Math.max(slot, n * w + (n - 1) * BLOCK_FAN_GAP) : slot, x: cards.get(u.id)!.x, weight: 1 };
  });
  const xs = packRow(items, xMin, f.xMax);
  if (!xs) return;
  f.units.forEach((u, i) => cards.set(u.id, { ...cards.get(u.id)!, x: xs[i]! }));
}

/**
 * Blockers move to sit directly in front of the attacker they block (several fanned side by side), and the rest
 * of their front row moves only as far as it must to make room (packRow). A row too full to make room keeps
 * its other cards where they were and lets the blockers overlap them.
 */
function alignBlockers(f: FrontRow, blocks: Map<CardId, BlockSlot>, cards: Map<CardId, CardPose>, xMin: number): void {
  const step = cardWidth(f.h) + BLOCK_FAN_GAP;
  const all = f.units
    .map((u, order) => {
      const pose = cards.get(u.id)!;
      const w = u.tapped ? f.h : cardWidth(f.h);
      const slot = blocks.get(u.id);
      const ap = slot ? cards.get(slot.attacker) : undefined;
      if (slot && ap && ap.owner !== pose.owner) {
        return { pose, w, x: ap.x + (slot.index - (slot.count - 1) / 2) * step, weight: 1e6, order, slot };
      }
      return { pose, w, x: pose.x, weight: 1, order, slot: undefined };
    });
  if (!all.some((it) => it.slot)) return;
  // Blockers in x order; each other card goes into whichever gap (keeping their own order) moves things least.
  const items = all.filter((it) => it.slot).sort((a, b) => a.x - b.x);
  let from = 0;
  for (const it of all) {
    if (it.slot) continue;
    let best = -1;
    let bestCost = Infinity;
    for (let i = from; i <= items.length; i++) {
      const trial = [...items.slice(0, i), it, ...items.slice(i)];
      const cost = packCost(trial, xMin, f.xMax);
      if (cost < bestCost - 1e-6) {
        bestCost = cost;
        best = i;
      }
    }
    if (best < 0) best = Math.max(from, items.findIndex((x) => x.x > it.x) < 0 ? items.length : items.findIndex((x) => x.x > it.x));
    items.splice(best, 0, it);
    from = best + 1;
  }
  const xs = packRow(items, xMin, f.xMax);
  items.forEach((it, i) => {
    if (!xs && !it.slot) return;
    const fan = it.slot ? (it.slot.index - (it.slot.count - 1) / 2) * BLOCK_FAN_DEG * DEG : 0;
    const toward = it.pose.region === 'myFront' ? 1 : -1;
    cards.set(it.pose.id, {
      ...it.pose,
      x: xs ? xs[i]! : it.x,
      // Fanned blockers dip slightly at the edges, like cards held in a hand.
      y: it.slot ? it.pose.y + toward * Math.abs(fan) * 40 : it.pose.y,
      rot: it.pose.rot + (it.slot ? (it.pose.region === 'myFront' ? fan : -fan) : 0),
      z: f.z0 + i * 2 + (it.slot ? 1 : 0),
      lift: it.slot ? 4 : it.pose.lift,
    });
  });
}

// ------------------------------------------------------------------------------------------ hand fan

export interface FanSlot {
  x: number;
  y: number;
  rot: number;
}

/**
 * My hand: an arc centred in handMin–handMax. The step between cards grows with the real free
 * span between my plate and the prompt bar, not a fixed cap, up to the point cards sit fully side by side (card
 * width: no point spreading further apart, so a small hand stays centred and compact). `reserve` (tu) is the width
 * the alt-zone strip takes off the right end of that span (altReserve): the fan narrows and re-centres.
 */
export function handFan(n: number, hoverIndex = -1, scale = 1, g: Geometry = G0, reserve = 0): FanSlot[] {
  const { X, SIZE, HAND } = g;
  const w = cardWidth(SIZE.hand * scale);
  const free = Math.max(0, X.handMax - reserve - X.handMin - 2 * HAND.fanHalf);
  const centre = X.handCentre - reserve / 2;
  const step = n > 1 ? Math.min(w, free / (n - 1)) : 0;
  const degStep = n > 1 ? Math.min(HAND.stepDeg, HAND.maxFanDeg / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const out: FanSlot[] = [];
  for (let i = 0; i < n; i++) {
    const dx = (i - mid) * step;
    let x = centre + dx;
    if (hoverIndex >= 0 && i !== hoverIndex) x += i < hoverIndex ? -HAND.neighbourPart : HAND.neighbourPart;
    out.push({ x, y: HAND.y + dx * dx * HAND.arc, rot: (i - mid) * degStep * DEG * (scale > 1 ? 0.5 : 1) });
  }
  return out;
}

/** The width (tu) the alt-zone strip takes off the hand's span for `n` cards, gap included; 0 with none. */
export function altReserve(n: number, g: Geometry = G0): number {
  if (n <= 0) return 0;
  const { ALT } = g;
  const w = cardWidth(ALT.h);
  return Math.min(ALT.maxW, w + (n - 1) * w * ALT.step) + 2 * GAP + ALT.clear;
}

/** How far apart (tu) neighbouring strip cards sit: a share of a card's width, less when many crowd the strip's cap. */
export function altStep(n: number, g: Geometry = G0): number {
  if (n <= 1) return 0;
  const w = cardWidth(g.ALT.h);
  return Math.min(w * g.ALT.step, (altReserve(n, g) - 2 * GAP - g.ALT.clear - w) / (n - 1));
}

/**
 * The alt-zone strip beside my hand (MTGA: cards playable from the graveyard / exile sit next to the hand): `n` smaller
 * cards at the right end of the hand's span, shown whole, in a shallow fan; the hovered one lifts and its neighbours part.
 */
export function altFan(n: number, hoverIndex = -1, g: Geometry = G0): Array<FanSlot & { h: number }> {
  const { X, ALT, H } = g;
  const w = cardWidth(ALT.h);
  const span = altReserve(n, g) - 2 * GAP - ALT.clear;
  const step = altStep(n, g);
  const x0 = X.handMax - GAP - ALT.clear - span + w / 2 + Math.max(0, span - w - (n - 1) * step) / 2;
  const degStep = n > 1 ? Math.min(1, ALT.maxFanDeg / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const out: Array<FanSlot & { h: number }> = [];
  for (let i = 0; i < n; i++) {
    const hovered = i === hoverIndex;
    const h = hovered ? ALT.h * ALT.hoverScale : ALT.h;
    let x = x0 + i * step;
    if (hoverIndex >= 0 && !hovered) x += i < hoverIndex ? -ALT.neighbourPart : ALT.neighbourPart;
    // Flat: every card's top edge is level, so a chip above it is never covered by the card beside it.
    out.push({ x, y: hovered ? H - 10 - h / 2 : H - ALT.bottomGap - h / 2, rot: hovered ? 0 : (i - mid) * degStep * DEG, h });
  }
  return out;
}

/**
 * The raised hand on a touch screen: one fan of big cards across my half of the table, overlapping; the
 * focused card (the last one tapped) comes forward, larger and on top, to be read. Cards: height h, bottom on `bottom`.
 */
export function touchFan(n: number, focus: number, x0: number, x1: number, bottom: number, h: number): { x: number; y: number; h: number; rot: number }[] {
  const w = cardWidth(h);
  const step = n > 1 ? Math.min(w * 0.9, Math.max(0, x1 - x0 - w) / (n - 1)) : 0;
  const degStep = n > 1 ? Math.min(2, 16 / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const out: { x: number; y: number; h: number; rot: number }[] = [];
  for (let i = 0; i < n; i++) {
    const dx = (i - mid) * step;
    const fh = i === focus ? h * 1.15 : h;
    out.push({ x: (x0 + x1) / 2 + dx, y: bottom - fh / 2 - (i === focus ? h * 0.08 : Math.abs(i - mid) * h * 0.012), h: fh, rot: i === focus ? 0 : (i - mid) * degStep * DEG });
  }
  return out;
}

/** Tilt per card in the opponent's fan (kept low so the outer cards clear the status line above). */
const OPP_FAN_DEG = 1.5;

/** How far (in card heights) a Partner's second commander sits below the first on the opponent's command pile. */
const PARTNER_STEP = 0.2;

/** The opponent's hand: a compact, mirrored fan of card backs along the top edge. */
export function oppFan(n: number, g: Geometry = G0): FanSlot[] {
  const { X, SIZE, HAND, ROW_Y } = g;
  const w = cardWidth(SIZE.oppHand);
  // Within OPP_FAN_W, right of their plate.
  const step = n > 1 ? Math.min(w * 0.55, (OPP_FAN_W - w) / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  // A big hand stays a shallow fan: the ends rise and tilt no more than seven cards' would (QA: twenty ran
  // off the top-left corner).
  const deg = mid > 0 ? Math.min(OPP_FAN_DEG, (3 * OPP_FAN_DEG) / mid) : 0;
  const arc = HAND.arc * 0.6 * Math.min(1, (3 * w * 0.55) ** 2 / Math.max(1, (mid * step) ** 2));
  const out: FanSlot[] = [];
  for (let i = 0; i < n; i++) {
    const dx = (i - mid) * step;
    out.push({ x: X.oppHandX - dx, y: ROW_Y.oppHand - dx * dx * arc, rot: -(i - mid) * deg * DEG });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ table

function attachHost(card: Card, cards: Record<CardId, Card>): CardId | undefined {
  const host = card.entityAttachedTo;
  return typeof host === 'string' && cards[host]?.zone === 'Battlefield' ? host : undefined;
}

/** The hand in the player's order: the cards `order` lists, in its order, then the rest (new draws) as dealt. */
export function orderHand(hand: readonly CardId[], order: readonly CardId[]): CardId[] {
  const inHand = new Set(hand);
  const kept = order.filter((id) => inHand.has(id));
  const listed = new Set(kept);
  return [...kept, ...hand.filter((id) => !listed.has(id))];
}

export function computeLayout(input: LayoutInput): Layout {
  const { model, viewer } = input;
  const worldW = input.worldW ?? TABLE_W;
  const g = geometry(worldW, input.cardScale ?? 1, input.hudK ?? 1, input.worldH, hasCommanders(model));
  const { X, SIZE, ROW_Y, HAND, ALT, PILES, PILES_X, COMMAND, TUCK, H } = g;
  const ROW_AXIS = rowAxis(X);
  const opp = opponentOf(model, viewer);
  const cards = new Map<CardId, CardPose>();
  const piles: PileInfo[] = [];
  const entries = stackEntries(model);
  const stackActive = entries.length > 0;

  // Battlefield rows.
  const sides: Array<{ player: PlayerId | undefined; mine: boolean }> = [
    { player: viewer, mine: true },
    { player: opp, mine: false },
  ];
  const attached: Array<[CardId, CardId, PlayerId]> = [];
  const fronts: FrontRow[] = [];
  const blocks = blockGroups(model);
  const apart = new Set<CardId>([...blocks.keys(), ...(model.game.combat ?? []).map((b) => b.attacker)]);
  if (input.lifted) apart.add(input.lifted);
  const group = (units: RowUnit[]) => groupUnits(units, model.cards, input.marks, apart);
  for (const { player, mine } of sides) {
    if (!player) continue;
    const bf = model.players[player]?.zones?.battlefield ?? [];
    const back: RowUnit[] = [];
    const creatures: RowUnit[] = [];
    const support: RowUnit[] = [];
    for (const id of bf) {
      const c = model.cards[id];
      if (c) {
        const host = attachHost(c, model.cards);
        if (host) {
          attached.push([id, host, player]);
          continue;
        }
      }
      const unit: RowUnit = { id, tapped: !!c?.tapped };
      if (isCreature(c)) creatures.push(unit);
      else if (isLand(c)) back.push(unit);
      else support.push(unit);
    }
    const grouped = { creatures: group(creatures), support: group(support), back: group(back) };
    if (grouped.support.length > 0 && grouped.creatures.length > 0) grouped.support[0]!.breakBefore = true;
    const front = [...grouped.creatures, ...grouped.support];
    const frontEnd = stackActive ? X.rowEndWithStack : X.rowEnd;
    const backEnd = mine ? X.myBackRowEnd : X.oppBackRowEnd;
    const frontRow = place(front, mine ? 'myFront' : 'oppFront', mine ? ROW_Y.myFront : ROW_Y.oppFront, X.frontRowStart, frontEnd, ROW_AXIS, player, 200);
    fronts.push({ units: front, xMin: X.frontRowStart, xMax: frontEnd, h: frontRow.h, z0: 200 });
    // Lands are out of the way (MTGA): smaller (SIZE.land), packed from the left edge toward the piles at the
    // row's right end. A tucked back row shrinks by the tuck, away from the front row.
    const backY = mine ? ROW_Y.myBack + TUCK / 2 : ROW_Y.oppBack - TUCK / 2;
    place(grouped.back, mine ? 'myBack' : 'oppBack', backY, X.rowStart, backEnd, X.rowStart, player, 100, SIZE.land - TUCK);
  }

  /** Lay a row into [xMin, xMax] around `centre` (front rows: the table's axis; lands: left-aligned at xMin). */
  function place(units: RowUnit[], region: Region, y: number, xMin: number, xMax: number, centre: number, owner: PlayerId, z0: number, h = SIZE.battlefield) {
    // A row cut short (stack, prompt bar, phase strip) slides along only once it must.
    const row = layoutRow(units, xMin, xMax, h, (SIZE.battlefieldMin * h) / SIZE.battlefield, centre);
    units.forEach((u, i) => {
      const c = model.cards[u.id];
      const step = c?.attacking ? row.h * ATTACK_STEP * (region === 'myFront' ? -1 : region === 'oppFront' ? 1 : 0) : 0;
      cards.set(u.id, {
        id: u.id,
        x: row.xs[i]!,
        y: y + step,
        h: row.h,
        rot: u.tapped ? ROT_90 : 0,
        faceUp: isFaceUp(u.id, c),
        z: z0 + i * 2,
        region,
        owner,
        lift: 0,
        ...(u.more ? { count: u.more.length + 1 } : {}),
      });
      u.more?.forEach((id, k) => {
        const d = Math.min(k + 1, GROUP_SHOWN) * GROUP_STEP;
        cards.set(id, { ...cards.get(u.id)!, id, x: row.xs[i]! + d, faceUp: isFaceUp(id, model.cards[id]), z: z0 + i * 2 - (k + 1) * 0.05, count: undefined, under: true });
      });
    });
    return row;
  }

  // Blockers leave their row to sit in front of the attacker they block; the rest of the row makes room.
  if (blocks.size > 0) {
    for (const f of fronts) widenAttackers(f, blocks, cards, f.xMin);
    for (const f of fronts) alignBlockers(f, blocks, cards, f.xMin);
  }

  // A card picked up to aim (a blocker) draws above its neighbours; the pick ring lifts it (cardSprite.ts
  // PICK_LIFT). It stays in its row: the centre gap is no wider than an attacker's step.
  const lifted = input.lifted ? cards.get(input.lifted) : undefined;
  if (lifted && (lifted.region === 'myFront' || lifted.region === 'oppFront')) cards.set(lifted.id, { ...lifted, z: lifted.z + 300 });

  // Attachments tuck behind their host, offset 22% toward the owner's side of the table. Several fan out, each
  // peeking a little less (at least its name bar) so every one shows (QA: eight auras showed one).
  const perHost = new Map<CardId, number>();
  for (const [, host] of attached) perHost.set(host, (perHost.get(host) ?? 0) + 1);
  const seen = new Map<CardId, number>();
  for (const [id, host, player] of attached) {
    const hp = cards.get(host);
    if (!hp) continue;
    const mine = player === viewer;
    const k = seen.get(host) ?? 0;
    seen.set(host, k + 1);
    const step = Math.max(0.105, Math.min(ATTACH_OFFSET, 0.48 / perHost.get(host)!));
    cards.set(id, {
      ...hp,
      id,
      y: hp.y + (mine ? -1 : 1) * hp.h * step * (k + 1),
      rot: model.cards[id]?.tapped ? ROT_90 : 0,
      faceUp: isFaceUp(id, model.cards[id]),
      z: hp.z - 1 - k * 0.01,
    });
  }

  // My hand.
  const dealt = orderHand(model.players[viewer]?.zones?.hand ?? [], input.handOrder ?? []);
  const altIds = (input.alt ?? []).filter((id) => !dealt.includes(id));
  const out = input.dragOut && dealt.includes(input.dragOut) ? input.dragOut : null;
  const altOut = input.dragOut && altIds.includes(input.dragOut) ? input.dragOut : null;
  const hand = out ? dealt.filter((id) => id !== out) : dealt;
  // The card dragged out keeps a pose in my hand (the scene draws it at the pointer); dropped back, it eases in.
  if (out) cards.set(out, { id: out, x: X.handCentre, y: HAND.y, h: SIZE.hand, rot: 0, faceUp: isFaceUp(out, model.cards[out]), z: 950, region: 'hand', owner: viewer, lift: 6 });
  const raised = !!input.raiseHand;
  const hoverIndex = input.hover && !raised ? hand.indexOf(input.hover) : -1;
  const raisedH = SIZE.hand * HAND.raisedScale;
  const raisedLift = HAND.y - (H - HAND.raisedBottomGap - raisedH / 2);
  if (raised && input.touchHand) {
    const { BAND, W } = g;
    const x0 = Math.max(16, X.handMin);
    const x1 = Math.min(W - 16, X.handMax);
    // As big as a third of the width (in a fan they overlap), no taller than my half of the table allows.
    const h = Math.min(SIZE.preview, (x1 - x0) / 3 / cardWidth(1), (BAND.myBack[1] - 56 - (BAND.centre[0] + BAND.centre[1]) / 2) / 1.3);
    const focus = input.touchHand.focus ? hand.indexOf(input.touchHand.focus) : -1;
    // Its bottom clears the End Turn button above my strip.
    touchFan(hand.length, focus, x0, x1, BAND.myBack[1] - 56, h).forEach((slot, i) => {
      const id = hand[i]!;
      cards.set(id, { id, x: slot.x, y: slot.y, h: slot.h, rot: slot.rot, faceUp: isFaceUp(id, model.cards[id]), z: i === focus ? 900 : 600 + i, region: 'hand', owner: viewer, lift: i === focus ? 24 : 12 });
    });
  } else {
    handFan(hand.length, hoverIndex, raised ? HAND.raisedScale : 1, g, raised ? 0 : altReserve(altIds.length, g)).forEach((slot, i) => {
      const id = hand[i]!;
      const hovered = i === hoverIndex;
      cards.set(id, {
        id,
        x: slot.x,
        y: raised ? slot.y - raisedLift : hovered ? HAND.hoverY : slot.y,
        h: raised ? raisedH : hovered ? SIZE.hand * SIZE.handHoverScale : SIZE.hand,
        rot: hovered ? 0 : slot.rot,
        faceUp: isFaceUp(id, model.cards[id]),
        z: hovered ? 900 : 600 + i,
        region: 'hand',
        owner: viewer,
        lift: hovered ? 24 : 6,
      });
    });
  }

  // The alt-zone strip beside the hand: castable graveyard / exile / command-zone cards, and my Brawl commander while it
  // waits in the command zone, castable or not (table/altZone.ts). A raised hand
  // (touch, mulligan) leaves them where they are; one being dragged out over the table closes its gap.
  {
    const shownAlt = altOut ? altIds.filter((id) => id !== altOut) : altIds;
    const altHover = input.hover && !raised ? shownAlt.indexOf(input.hover) : -1;
    if (altOut) cards.set(altOut, { id: altOut, x: X.handMax, y: H - ALT.bottomGap - ALT.h / 2, h: ALT.h, rot: 0, faceUp: isFaceUp(altOut, model.cards[altOut]), z: 950, region: 'alt', owner: viewer, lift: 6 });
    altFan(shownAlt.length, altHover, g).forEach((slot, i) => {
      const id = shownAlt[i]!;
      const hovered = i === altHover;
      cards.set(id, { id, x: slot.x, y: slot.y, h: slot.h, rot: slot.rot, faceUp: isFaceUp(id, model.cards[id]), z: hovered ? 900 : 620 + i, region: 'alt', owner: model.cards[id]?.owner ?? viewer, lift: hovered ? 20 : 6 });
    });
  }

  // Opponent's hand (card backs, or revealed cards).
  if (opp) {
    const oh = model.players[opp]?.zones?.hand ?? [];
    oppFan(oh.length, g).forEach((slot, i) => {
      const id = oh[i]!;
      cards.set(id, {
        id,
        x: slot.x,
        y: slot.y,
        h: SIZE.oppHand,
        rot: slot.rot,
        faceUp: isFaceUp(id, model.cards[id]),
        z: 560 + i,
        region: 'oppHand',
        owner: opp,
        lift: 4,
      });
    });
  }

  // The stack zone (layout/stack.ts): newest in front and largest, older items up and to the left, smaller and darker,
  // to the cascade's depth. An ability card is a little smaller than a card, hanging from the same top edge.
  const cascade = stackCascade(entries.length, g);
  cascade.slots.forEach((slot, i) => {
    const e = entries[i]!;
    const h = e.ability ? slot.h * ABILITY_SCALE : slot.h;
    cards.set(e.id, {
      id: e.id,
      x: slot.x,
      y: slot.y - (slot.h - h) / 2,
      h,
      rot: 0,
      faceUp: e.ability || isFaceUp(e.id, model.cards[e.id]),
      z: 480 - i * 2,
      region: 'stack',
      owner: e.controller ?? viewer,
      lift: i === 0 ? 20 : 12,
      depth: slot.depth,
      shade: slot.shade,
    });
  });

  // Piles (the right-hand end of each back row). Library: a stack of backs; graveyard and exile show their top
  // card. Exile only shows while it holds something (its slot stays reserved: anchor, myBackRowEnd).
  for (const { player, mine } of sides) {
    if (!player) continue;
    const zs = model.players[player]?.zones ?? {};
    const ys = mine ? PILES.mine : PILES.opp;
    const library: PileInfo = { player, zone: 'library', count: zs.library?.length ?? 0, x: PILES_X.library, y: ys.library, h: SIZE.pile, mine };
    // A known top card (revealed and put back, a "play with the top revealed" effect) lies face up on the pile
    // (the server only identifies library cards the viewer may see; zones list a library from the top down).
    const libTop = zs.library?.[0];
    if (libTop && !libTop.startsWith('x') && model.cards[libTop] && !cards.has(libTop)) {
      library.topId = libTop;
      cards.set(libTop, { id: libTop, x: PILES_X.library, y: ys.library, h: SIZE.pile, rot: 0, faceUp: isFaceUp(libTop, model.cards[libTop]), z: 50, region: 'library', owner: player, lift: 2 });
    }
    piles.push(library);
    for (const zone of ['graveyard', 'exile'] as const) {
      const list = zs[zone] ?? [];
      if (zone === 'exile' && list.length === 0) continue;
      // The pile shows its newest card that has no pose of its own (a castable one waits in the alt-zone strip instead).
      const top = [...list].reverse().find((id) => !cards.has(id));
      const pile: PileInfo = { player, zone, count: list.length, x: PILES_X[zone], y: ys[zone], h: SIZE.pile, mine };
      if (top) {
        pile.topId = top;
        cards.set(top, {
          id: top,
          x: PILES_X[zone],
          y: ys[zone],
          h: zone === 'exile' ? SIZE.pile * 0.8 : SIZE.pile,
          rot: 0,
          faceUp: isFaceUp(top, model.cards[top]),
          z: 50,
          region: zone,
          owner: player,
          lift: 2,
        });
      }
      piles.push(pile);
    }
    // Brawl: the opponent's command zone beside their plate shows their commander while it waits there (a
    // castable one waits in the alt-zone strip instead; mine always does); emblems and the like stay off the table.
    // Partners: the second cascades down over the first, whose name and cost stay readable above it.
    const cmd = mine ? null : COMMAND?.opp;
    const commanders = model.players[player]?.commander ?? [];
    if (cmd && commanders.length > 0) {
      const waiting = (zs.command ?? []).filter((id) => commanders.includes(id));
      const shown = waiting.filter((id) => !cards.has(id));
      const pile: PileInfo = { player, zone: 'command', count: waiting.length, x: cmd.x, y: cmd.y, h: COMMAND!.h, mine };
      if (shown.length > 0) pile.topId = shown[shown.length - 1];
      shown.forEach((id, i) => {
        const y = cmd.y + i * COMMAND!.h * PARTNER_STEP;
        cards.set(id, { id, x: cmd.x, y, h: COMMAND!.h, rot: 0, faceUp: isFaceUp(id, model.cards[id]), z: 50 + i, region: 'command', owner: player, lift: 2 });
      });
      piles.push(pile);
    }
  }

  const anchor = (ref: ZoneRef | undefined): Pose => {
    const mine = ref?.player === viewer;
    const ys = mine ? PILES.mine : PILES.opp;
    switch (ref?.zone) {
      case 'Library':
        return { x: PILES_X.library, y: ys.library, h: SIZE.pile, rot: 0, faceUp: false };
      case 'Graveyard':
        return { x: PILES_X.graveyard, y: ys.graveyard, h: SIZE.pile, rot: 0, faceUp: true };
      case 'Exile':
        return { x: PILES_X.exile, y: ys.exile, h: SIZE.pile * 0.8, rot: 0, faceUp: true };
      case 'Command': {
        // Mine waits in the alt-zone strip (its right end); the opponent's, in their pile.
        if (COMMAND && mine) return { x: X.handMax - GAP - ALT.clear - cardWidth(ALT.h) / 2, y: H - ALT.bottomGap - ALT.h / 2, h: ALT.h, rot: 0, faceUp: true };
        if (COMMAND) return { x: COMMAND.opp.x, y: COMMAND.opp.y, h: COMMAND.h, rot: 0, faceUp: true };
        return { x: worldW / 2, y: H / 2, h: SIZE.battlefield, rot: 0, faceUp: false };
      }
      case 'Hand':
        return mine
          ? { x: X.handCentre, y: HAND.y, h: SIZE.hand, rot: 0, faceUp: true }
          : { x: X.oppHandX, y: ROW_Y.oppHand, h: SIZE.oppHand, rot: 0, faceUp: false };
      case 'Stack':
        return { x: X.stackX, y: X.stackBottom - SIZE.stackTop / 2, h: SIZE.stackTop, rot: 0, faceUp: true };
      case 'Battlefield':
        return { x: ROW_AXIS, y: mine ? ROW_Y.myFront : ROW_Y.oppFront, h: SIZE.battlefield, rot: 0, faceUp: true };
      default:
        return { x: worldW / 2, y: H / 2, h: SIZE.battlefield, rot: 0, faceUp: false };
    }
  };

  const shownStack = cascade.slots.length;
  return { cards, piles, stackActive, stackTop: entries[0]?.id, stackHidden: cascade.hidden, stackDeepest: shownStack ? entries[shownStack - 1]!.id : undefined, anchor };
}

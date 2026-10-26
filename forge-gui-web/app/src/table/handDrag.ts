/**
 * Drag-to-play ("drag-to-play not tap-to-play, makes things on mobile a lot easier too"), MTGA-style.
 *
 * Press a card in my hand and drag: it lifts out of the fan and rides the pointer 1:1 (the point grabbed stays
 * under the pointer as the card grows to its hover size), leaning into its horizontal velocity and casting a deep
 * shadow. Above the play line (a little above the hand's resting top edge) a playable card shows "release to
 * play" (ember ring and glow, a touch bigger) and the neighbours close its gap; released there it sends the same
 * `card` act a click used to, and is held where it was dropped until its flight to the stack / battlefield
 * picks it up from that pose (scene.ts startTrack flies from the sprite's current transform). A card that can't
 * be played shows muted above the line and is shaken back into its slot. Released below the line, it drops back
 * into the hand, where a sideways drag reorders it as before (client-side, uiStore.handOrder).
 *
 * Click to carry (mouse; "clicking a card shouldn't open big preview, it should drag it. clicking again
 * undrags"): a click on a hand card that doesn't move picks it up exactly as a press-drag does (same lift, lean,
 * shadow and "release to play"), but it rides the pointer with no button held. The next click lets go, with the
 * same outcome as releasing a drag (dropKind: play / shake back / back into the hand); Esc, a right-click or the
 * window losing focus put it back in the hand. Pressing and dragging still works as before. A tap on touch never
 * plays (it raises the hand, brings a card forward, pins its preview: handClick); drag up plays. Prompts where a
 * hand card is chosen (discard, mulligan tuck, convoke, targets…) keep their clicks.
 *
 * The decisions are pure functions below; HandDragController keeps the little state they need.
 */
import type { CardId, GameModel, PlayerId, PromptBody } from '@forge-table/protocol';
import { pastThreshold } from '../arrows/interaction';
import type { Pt } from '../arrows/geometry';
import type { Geometry } from '../layout/geometry';
import { clamp01 } from '../util/easing';

const DEG = Math.PI / 180;

/** The play line sits this share of a hand card's height above the hand's resting top edge. */
export const PLAY_LINE_K = 0.25;
/** A drag must also have risen this share of a hand card's height (a raised touch hand starts above the line). */
export const MIN_RISE_K = 0.25;
/** The steepest lean while dragged, and how much lean a horizontal speed of 1 tu/ms gives. */
export const TILT_MAX = 12 * DEG;
export const TILT_PER_SPEED = 8 * DEG;
/** Smoothing time constants (ms): the velocity the lean reads, the lean's own spring, the growth to drag size. */
const VX_TAU = 45;
const ROT_TAU = 70;
const GROW_TAU = 65;
/** Lift while held: the deep shadow (cardSprite.ts apply: offset lift/4, lift·0.6, alpha up to 0.75). */
export const DRAG_LIFT = 60;
/** "Release to play": the card swells this much. */
export const ARMED_SCALE = 1.06;
/** A card released to play waits this long (ms) for its flight before it goes back to the hand. */
export const HOLD_MS = 2500;

/** The play line (tu): a dragged card whose centre rises above it is out of the hand. */
export function playLine(g: Pick<Geometry, 'BAND' | 'SIZE'>): number {
  return g.BAND.hand[0] - g.SIZE.hand * PLAY_LINE_K;
}

/** The dragged card (its centre at `y`, picked up at `startY`) is out of the hand, over the table. */
export function aboveLine(y: number, startY: number, line: number, handH: number): boolean {
  return y < Math.min(line, startY - handH * MIN_RISE_K);
}

/** A hand card can be played now: my priority, input live, and the server marks it playable (prompt `weak`). */
export function playable(prompt: PromptBody | null, live: boolean, card: CardId): boolean {
  return live && prompt?.kind === 'priority' && !card.startsWith('x') && (prompt.weak?.[card] ?? 0) > 0;
}

export type DropKind = 'play' | 'reject' | 'return';

/** A pointer target that is not the table's canvas (a HUD control): a carried card is not dropped there. */
function offTable(t: EventTarget | null): boolean {
  const tag = (t as { tagName?: unknown } | null)?.tagName;
  return typeof tag === 'string' && tag !== 'CANVAS';
}

/** What letting go does: out of the hand, play it (or shake back if it can't be played); else back into the hand. */
export function dropKind(above: boolean, canPlay: boolean): DropKind {
  if (!above) return 'return';
  return canPlay ? 'play' : 'reject';
}

/**
 * What a click / tap on one of my hand cards does. `playPath`: nothing else would take the click (no prompt, or my
 * priority); otherwise the prompt chooses hand cards and the click selects as it always did.
 * - touch: a tap on the lowered hand raises it, a tap in it brings that card forward, a tap on the card in front
 *   pins its big preview (Snooze is there); drag up plays.
 * - mouse: a click picks the card up to carry it (HandDragController.pickUp); the next click lets go.
 */
export type HandClick = 'raise' | 'focus' | 'pin' | 'carry' | 'select';

export function handClick(o: { touch: boolean; raised: boolean; handUp: boolean; focus: CardId | null; card: CardId; playPath: boolean }): HandClick {
  if (o.touch && !o.raised) return 'raise';
  if (o.touch && o.handUp && o.focus !== o.card) return 'focus';
  if (!o.playPath) return 'select';
  return o.touch ? 'pin' : 'carry';
}

/** The pose physics of a dragged card: smoothed horizontal speed (tu/ms), lean (rad), height and lift (tu). */
export interface DragPhysics {
  x: number;
  t: number;
  vx: number;
  rot: number;
  h: number;
  lift: number;
}

/**
 * One frame of the drag physics for the pointer at `x` (tu) at time `now` (ms): the lean follows the smoothed
 * horizontal speed, clamped, and springs back upright when the pointer rests; the card grows toward `targetH`.
 * `calm` (reduced motion): no lean, the size and lift jump.
 */
export function stepPhysics(p: DragPhysics, x: number, now: number, targetH: number, calm: boolean): DragPhysics {
  if (calm) return { x, t: now, vx: 0, rot: 0, h: targetH, lift: DRAG_LIFT };
  const dt = Math.max(1, Math.min(50, now - p.t));
  const k = (tau: number) => 1 - Math.exp(-dt / tau);
  const vx = p.vx + ((x - p.x) / dt - p.vx) * k(VX_TAU);
  const lean = Math.max(-TILT_MAX, Math.min(TILT_MAX, vx * TILT_PER_SPEED));
  return { x, t: now, vx, rot: p.rot + (lean - p.rot) * k(ROT_TAU), h: p.h + (targetH - p.h) * k(GROW_TAU), lift: p.lift + (DRAG_LIFT - p.lift) * k(GROW_TAU) };
}

/**
 * The reject shake (motion skill: error shake 300-400 ms, 2-3 oscillations, firm, no overshoot): x offset (tu)
 * at `q` in 0..1, decaying.
 */
export function shakeOffset(q: number, amp: number): number {
  const c = clamp01(q);
  return amp * Math.sin(c * Math.PI * 5) * (1 - c);
}

/** A dragged card as the scene draws it: the transform (cardSprite.ts Transform fields) and its cue. */
export interface DragView {
  id: CardId;
  x: number;
  y: number;
  h: number;
  rot: number;
  lift: number;
  /** 'play': release to play; 'cant': above the line but not playable; 'held': released to play, waiting. */
  cue: 'none' | 'play' | 'cant' | 'held';
  /** Out of the hand: the fan closes its gap (layout.ts dragOut). */
  out: boolean;
}

export interface HandDragHost {
  model(): GameModel;
  viewer(): PlayerId;
  prompt(): PromptBody | null;
  /** A real prompt is up and nothing covers it. */
  inputLive(): boolean;
  /** Client px → table units. */
  toTable(x: number, y: number): Pt;
  /** A card's drawn pose now (centre in tu, height × scale, rotation), or null. */
  spritePose(id: CardId): { x: number; y: number; h: number; rot: number; lift: number } | null;
  /** The table's geometry now. */
  geo(): Pick<Geometry, 'BAND' | 'SIZE'>;
  /** My hand's cards and their x (table units), in the order shown. */
  handX(): { id: CardId; x: number }[];
  /** The castable cards waiting beside my hand (table/altZone.ts): dragged and played exactly like hand cards. */
  altIds(): readonly CardId[];
  /** The player dragged a hand card to a new place: the hand's order, client-side only. */
  onHandOrder(order: CardId[]): void;
  /** Reduced motion (director.calm). */
  calm(): boolean;
  now(): number;
  /** A drag started (a raised touch hand goes down; the hover preview goes away). */
  onLift?(id: CardId): void;
  /** Released to play: send the card act. */
  play(id: CardId): void;
  /** Asks cover the table (an ability menu, a cost choice): a held card goes back. */
  blocked(): boolean;
}

interface Drag {
  id: CardId;
  /** The grab point's offset from the card's centre (tu) at height h0. */
  gx: number;
  gy: number;
  h0: number;
  startY: number;
  /** The hand order before the drag (a card dropped back from over the table returns to its place). */
  order0: CardId[];
  pointer: Pt;
  phys: DragPhysics;
  above: boolean;
  /** An alt-zone card (not in the hand): the hand's order isn't touched. */
  alt: boolean;
  /**
   * Carried by a click (no button held): 'pending' until the button that picked it up comes up, then 'carry' (the
   * next button-up lets go). Undefined for a press-drag.
   */
  sticky?: 'pending' | 'carry';
}

export class HandDragController {
  private press: { id: CardId; x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private held: { view: DragView; at: number; order0: CardId[]; alt: boolean } | null = null;
  private drops: { id: CardId; kind: DropKind | 'gone' }[] = [];
  /** The pointer's last client position (a click carries the card from there). */
  private last: { x: number; y: number } | null = null;
  /** A right-click put a carried card back: its own snooze is swallowed (swallowSnooze). */
  private rightCancel = false;
  private detach: (() => void) | null = null;

  constructor(private readonly host: HandDragHost) {}

  attach(win: Window = window): void {
    const move = (e: PointerEvent) => this.move(e.clientX, e.clientY);
    const up = (e: PointerEvent) => this.release(e.clientX, e.clientY);
    const lost = () => this.cancel();
    // A carried card: a right-click puts it back (and is not a snooze); so does a click on the HUD (a button
    // there does its own thing, the card is not played under it). Esc puts it back too (and is not the table's
    // Esc = secondary button, so this listens in the capture phase and stops it there).
    const down = (e: PointerEvent) => {
      this.rightCancel = false;
      if (!this.drag?.sticky) return;
      if (e.button === 2) {
        this.rightCancel = true;
        this.cancel();
      } else if (offTable(e.target)) this.cancel();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.drag?.sticky) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', lost);
    win.addEventListener('pointerdown', down, true);
    win.addEventListener('keydown', key, true);
    win.addEventListener('blur', lost);
    this.detach = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', lost);
      win.removeEventListener('pointerdown', down, true);
      win.removeEventListener('keydown', key, true);
      win.removeEventListener('blur', lost);
    };
  }

  dispose(): void {
    this.detach?.();
  }

  /** A press on a card sprite (client px). Only my hand's cards (and the alt-zone strip's) can be dragged. */
  cardDown(id: CardId, x: number, y: number): void {
    this.last = { x, y };
    this.press = this.owns(id) && !this.held && !this.drag ? { id, x, y } : null;
  }

  /** A card of mine this controller can drag: in my hand, or in the alt-zone strip beside it. */
  private owns(id: CardId): boolean {
    const h = this.host;
    return (h.model().players[h.viewer()]?.zones?.hand ?? []).includes(id) || h.altIds().includes(id);
  }

  /**
   * A mouse click on a hand card that didn't drag (runtime clickCard, handClick 'carry'): pick it up where the
   * pointer is and carry it with no button held, until the next click lets go (release) or Esc / a right-click
   * puts it back (cancel). The click's own button-up may come before or after this (Pixi taps on it).
   */
  pickUp(id: CardId): void {
    const at = this.press ?? this.last;
    if (this.drag || this.held || !at || !this.owns(id)) return;
    const pending = !!this.press;
    this.start(id, at.x, at.y);
    // (start() set it; TS still narrows this.drag to null from the guard above.)
    const d = this.drag as Drag | null;
    if (d) d.sticky = pending ? 'pending' : 'carry';
  }

  move(x: number, y: number): void {
    this.last = { x, y };
    const pr = this.press;
    if (pr && !this.drag && pastThreshold(pr, { x, y })) this.start(pr.id, pr.x, pr.y);
    const d = this.drag;
    if (!d) return;
    d.pointer = this.host.toTable(x, y);
    const above = aboveLine(this.centreY(d), d.startY, playLine(this.host.geo()), this.host.geo().SIZE.hand);
    if (above !== d.above) {
      d.above = above;
      // Out over the table: the hand closes up in its old order; back in, it takes its place by x again.
      if (above && !d.alt) this.host.onHandOrder(d.order0.filter((c) => c !== d.id).concat(d.id));
    }
    if (!above && !d.alt) {
      // The dragged card goes where the pointer is among the others; the hand reflows as it moves.
      const others = this.host.handX().filter((c) => c.id !== d.id);
      const at = others.filter((c) => c.x < d.pointer.x).length;
      const order = others.map((c) => c.id);
      order.splice(at, 0, d.id);
      this.host.onHandOrder(order);
    }
  }

  /** The button came up anywhere (after any sprite tap). */
  release(x: number, y: number): void {
    this.move(x, y);
    this.press = null;
    const d = this.drag;
    if (!d) return;
    // The button-up of the click that picked it up: it stays on the pointer until the next one.
    if (d.sticky === 'pending') {
      d.sticky = 'carry';
      return;
    }
    this.drag = null;
    const h = this.host;
    const kind = dropKind(d.above, playable(h.prompt(), h.inputLive(), d.id));
    if (kind === 'reject' && !d.alt) h.onHandOrder(d.order0);
    if (kind === 'play') {
      this.held = { view: { ...this.view(d), cue: 'held' }, at: h.now(), order0: d.order0, alt: d.alt };
      h.play(d.id);
      return;
    }
    this.drops.push({ id: d.id, kind });
  }

  /** A hand card is being dragged or carried (its tap is not a click). */
  get dragging(): CardId | null {
    return this.drag?.id ?? null;
  }

  /** A hand card is carried by a click (no button held). */
  get carrying(): CardId | null {
    return this.drag?.sticky ? this.drag.id : null;
  }

  /** True once after a right-click put a carried card back: that right-click is not a snooze. */
  swallowSnooze(): boolean {
    const r = this.rightCancel;
    this.rightCancel = false;
    return r;
  }

  cancel(): void {
    const d = this.drag;
    this.press = null;
    this.drag = null;
    if (d) this.drops.push({ id: d.id, kind: 'return' });
  }

  /** Drops since the last frame (the scene eases each card back or shakes it). */
  takeDrops(): { id: CardId; kind: DropKind | 'gone' }[] {
    const out = this.drops;
    this.drops = [];
    return out;
  }

  /**
   * Once per frame: the dragged (or held) card's pose for the scene. A held card is let go once it has left my hand
   * (its flight has it), or goes back to the hand when an ask covers the table or nothing came of it.
   */
  frame(): DragView | null {
    const h = this.host;
    const d = this.drag;
    if (d) {
      const g = h.geo();
      const target = g.SIZE.hand * g.SIZE.handHoverScale * (d.above && playable(h.prompt(), h.inputLive(), d.id) ? ARMED_SCALE : 1);
      d.phys = stepPhysics(d.phys, d.pointer.x, h.now(), target, h.calm());
      return this.view(d);
    }
    const held = this.held;
    if (!held) return null;
    const inHand = held.alt ? h.altIds().includes(held.view.id) : (h.model().players[h.viewer()]?.zones?.hand ?? []).includes(held.view.id);
    if (!inHand || h.blocked() || h.now() - held.at > HOLD_MS) {
      this.held = null;
      // Nothing came of it (the server refused, an ask came up): back to its old place in the hand (or the strip).
      if (inHand && !held.alt) h.onHandOrder(held.order0);
      this.drops.push({ id: held.view.id, kind: inHand ? 'return' : 'gone' });
      return null;
    }
    return held.view;
  }

  /** Pick the card up, grabbed where the press was (client px): from here it rides the pointer 1:1. */
  private start(id: CardId, x: number, y: number): void {
    const h = this.host;
    const pose = h.spritePose(id);
    if (!pose) return;
    const p = h.toTable(x, y);
    const order0 = h.handX().map((c) => c.id);
    this.drag = {
      id,
      gx: pose.x - p.x,
      gy: pose.y - p.y,
      h0: pose.h,
      startY: pose.y,
      order0,
      pointer: p,
      phys: { x: p.x, t: h.now(), vx: 0, rot: pose.rot, h: pose.h, lift: pose.lift },
      above: false,
      alt: !(h.model().players[h.viewer()]?.zones?.hand ?? []).includes(id),
    };
    h.onLift?.(id);
  }

  /** The card's drawn centre (tu): the grab point stays under the pointer as the card grows. */
  private centreY(d: Drag): number {
    return d.pointer.y + d.gy * (d.phys.h / d.h0);
  }

  private view(d: Drag): DragView {
    const k = d.phys.h / d.h0;
    const can = playable(this.host.prompt(), this.host.inputLive(), d.id);
    return {
      id: d.id,
      x: d.pointer.x + d.gx * k,
      // Transform.y is drawn lift·0.35 higher (cardSprite.ts apply).
      y: d.pointer.y + d.gy * k + d.phys.lift * 0.35,
      h: d.phys.h,
      rot: d.phys.rot,
      lift: d.phys.lift,
      cue: d.above ? (can ? 'play' : 'cant') : 'none',
      out: d.above,
    };
  }
}

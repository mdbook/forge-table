/**
 * The Pixi table: one Application, a worldW×1080 tu world (worldW 1440–1920, geometry.ts
 * worldWidth) scaled by s = min(W/worldW, H/1080) and centred, driven frame by frame from the shared loop (never Pixi's own ticker).
 *
 * Each frame the scene reads the Director: new tracks start flights / retargets / pops, the layout of the
 * `shown` store gives every visible card a target pose, and sprites ease toward their targets. A sprite
 * whose card changed id across a zone move (e.g. a hidden hand slot that became a stack card) is renamed,
 * so the same physical card flies continuously.
 *
 * Real card art (cards/art.ts) arrives asynchronously: when a key becomes ready the scene swaps the face
 * texture on every live sprite showing that key, at the next frame. The sprite keeps its transform,
 * target and motion, so nothing reflows and in-flight motion carries on.
 */
import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import type { Card, CardId, PlayerId, PromptBody } from '@forge-table/protocol';
import type { Director, ScheduledTrack } from '../director/director';
import { DUR, stackThud } from '../director/choreography';
import { computeLayout, type CardPose, type Layout, type PileInfo, type Pose } from '../layout/layout';
import { CARD_SCALE, TABLE_H, TABLE_W, cardWidth, geometry, hudScale, plateCentre, worldSize, type Geometry } from '../layout/geometry';
import type { ArtLoader } from '../cards/art';
import { printedPt, ptChip } from '../cards/pt';
import { CardTextures, makeCanvas, toTexture } from '../cards/textures';
import { manaValue } from '../cards/mana';
import { backOut, clamp01, cubicBezier, easeInOut, enter, exit, lerp, snappy, standard, type Easing } from '../util/easing';
import { fonts, fx, table } from '../theme/tokens';
import { TableBackground, tableMarkings } from './background';
import { CardSprite, poseToTransform, showsRevealedBadge, type RingKind, type Transform } from './cardSprite';
import { pickBadge, picksOf, ringFor } from './selection';
import { hasKeyword, isLand, knownFace } from '../store/model';
import { KW, rippleDelay } from '../director/keywords';
import { TAIL, drawFlame, drawGlint, drawShield, drawSlash, drawTrample, drawVenom, witherTint } from './keywordFx';
import type { AmbientMode } from './cardSprite';
import { ArrowLayer } from '../arrows/arrowLayer';
import { cardBox, type Box, type End, type Pt } from '../arrows/geometry';
import { blockerMap, type ArrowEnd, type ArrowSpec } from '../arrows/specs';
import type { AimFocus } from '../arrows/controller';
import { shakeOffset, type DragView, type DropKind } from './handDrag';
import { altCastables, altHeld, swapCue, TONE_COLOR, withMyCommanders, type AltCard } from './altZone';
import { commanderCost, hasCommanders } from './commander';
import { abilityFace, abilityId, isAbilityId, stackItemFor, type StackExit } from '../layout/stack';

const REFLOW_MS = 240;
/** Prompts that show the hand raised (the mulligan). */
const RAISED_KINDS = new Set(['mulligan', 'mulliganTuck', 'startingHand']);
const HOVER_MS = 120;
const FADE_MS = DUR.crossfade;
/** Cards that can't be the end of the arrow being aimed. */
const DIM_TINT = 0x6b6b6b;
/** The smallest on-card label, in CSS px (the "Snoozed" pill on a resting phone hand card). */
const LABEL_MIN_PX = 7;
/** A snoozed card goes a cool muted blue as its frost veil settles (table/snoozeFx.ts); eased in and out with it. */
const SNOOZE_TINT = 0x9aa8c6;
const LONG_PRESS_MS = 500;
/** A card becoming castable slides from its pile into the alt-zone strip this long (ms at 1x). */
const ALT_IN_MS = 320;
/**
 * Camera shake: how long, and its peak offset in screen px at full strength (choreography shakeFor: 10 damage to a
 * player, or a kill). A kill's shake rings on longer.
 */
const SHAKE_MS = 380;
const SHAKE_LETHAL_MS = 560;
const SHAKE_PX = 9;
/** A killing blow: the screen flashes white (a player's death) or a white burst pops at the creature it kills. */
const LETHAL_FLASH_MS = 260;
/** Hit-stop: how far (tu) the hit card shudders while both cards are frozen at contact. */
const HIT_SHUDDER = 3.5;
/** Combat steps (choreography combatSteps): the landing's give, softer than a tap's. */
const STEP_GIVE = 1.15;
/**
 * The stack zone. Restack: older items step to their new depth on a small overshoot, the
 * front-most first (reduced motion: a plain quick move). An ability card springs out of its source. A card cast onto
 * the stack comes in on the emphasised ease-out and lands with this give; resolving, a card pulses in place for the
 * first PULSE_SPLIT of its exit flight; a countered one cracks for CRACK_SPLIT, then shatters into shards. A resolved
 * ability card swells and fades. The card under the pointer comes forward, STACK_HOVER bigger.
 */
const RESTACK_MS = 260;
const RESTACK_STAGGER = 40;
const RESTACK_CALM_MS = 120;
const SPRING_MS = 380;
const SPRING_POP = 1.08;
const STACK_LAND = 1.04;
const PULSE_SPLIT = 0.26;
const PULSE_SCALE = 0.08;
const CRACK_SPLIT = 0.32;
const SHARD_MS = 520;
const SHARD_GRAVITY = 1400;
const ABILITY_EXIT_MS = 220;
const STACK_HOVER = 0.1;
const STACK_HOVER_Z = 497;
/** The top of the stack while I have priority breathes: its halo and a little lift, once per this long. */
const FOCUS_MS = 1600;
/** An opponent's spell is presented: in for the first PRESENT_IN, held until PRESENT_OUT, then settled into the stack. */
const PRESENT_IN = 0.22;
const PRESENT_OUT = 0.78;
/** A click (or key) through a presented spell: it settles into the stack this fast, and the beat lets go. */
const PRESENT_SKIP_MS = 200;
const emphasized = cubicBezier(0.05, 0.7, 0.1, 1);
/** Crack lines on a countered card: a cold white. */
const CRACK = 0xe4ecff;
/** The red edge flash when I take damage. */
const HURT_MS = 450;
/** An opponent's spell is presented this tall (tu) in the centre on its way to the stack. */
const PRESENT_H = 460;
/**
 * The stack louder (batch 11). While the stack is non-empty the table's edges sink under a light warm vignette
 * (over the cards, but only at the edges: VIGNETTE_ALPHA at the corners, nothing over the middle) and an ember glow
 * pools under the stack zone; both fade in over MOOD_IN_MS and out over MOOD_OUT_MS (reduced motion: MOOD_CALM_MS).
 * While I hold priority over it, the top item sends out a ripple every FOCUS_MS, two rings a beat apart, spreading
 * RIPPLE_PAD tu past it (reduced motion / Effects Off: no ripple, its steady halo only). An opponent's spell lands from
 * its presentation with a thud: compressed to THUD_GIVE and springing back, a wide ember ring and a light camera shake
 * (choreography stackThud; Effects Lite: the give only).
 */
const MOOD_IN_MS = 240;
const MOOD_OUT_MS = 180;
const MOOD_CALM_MS = 120;
const VIGNETTE_ALPHA = 0.62;
const STACK_GLOW_ALPHA = 0.34;
const RIPPLE_PAD = 30;
const THUD_GIVE = 0.92;
const THUD_RING_MS = 520;
/** A dying card chars in place for this share of its flight. */
const BURN_SPLIT = 0.5;
/** A spell's burst at its target lasts this many times the bolt's travel. */
const BURST_K = 1.4;
/** A fizzled spell, greyed. */
const FIZZ_TINT = 0x8a93a8;
/** A hand card dragged out that can't be played: muted (table/handDrag.ts). */
const CANT_TINT = 0x7d828c;
/** My Brawl commander waiting in the strip while it can't be cast (altZone.ts idle): dimmed, still legible. */
const IDLE_TINT = 0x8c8c8c;
/** Dragged cards draw above everything on the table. */
const DRAG_Z = 5000;
/** A card dropped back into my hand eases in with a little give (a paper card landing: a few % overshoot). */
const DROP_BACK_MS = 300;
/** A card that can't be played: a firm shake where it was let go (no overshoot), then back to its slot. */
const REJECT_SHAKE_MS = 340;
const REJECT_BACK_MS = 240;
const REJECT_AMP = 14;
/** Battlefield rows: their cards get the edge rim, and flyers there hover (cardSprite.ts ambient). */
const BATTLEFIELD = new Set(['myBack', 'myFront', 'oppFront', 'oppBack']);
/** The untap ripple: sweeps spread over this many ms left to right (keywords.ts rippleDelay), each this × the untap. */
const RIPPLE_SPREAD = 260;
const RIPPLE_K = 1.7;
/** A combat step's lift at its peak (tu); a flyer's charge arcs higher (flying). */
const STEP_LIFT = 26;
const FLY_STEP_LIFT = 64;
/** A P/T change: the card swells this much at the pulse's peak. */
const PT_PULSE_SCALE = 0.07;

/** A grey tint `k` (0..1) of white: an older stack item, darker the deeper it is. */
function greyTint(k: number): number {
  const v = Math.round(255 * clamp01(k));
  return (v << 16) | (v << 8) | v;
}

/**
 * The stack mood's textures, drawn once on a canvas: `vignette`, clear over the middle and a deep warm black at the
 * edges (stretched over the screen); `glow`, a soft white pool (tinted ember, additive) that fades to nothing.
 */
const moodTextures: Partial<Record<'vignette' | 'glow', Texture>> = {};
function moodTexture(kind: 'vignette' | 'glow'): Texture {
  const done = moodTextures[kind];
  if (done) return done;
  if (typeof document === 'undefined') return Texture.EMPTY;
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  if (!ctx) return Texture.EMPTY;
  const g = kind === 'vignette' ? ctx.createRadialGradient(128, 128, 0, 128, 128, 181) : ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  if (kind === 'vignette') {
    g.addColorStop(0, 'rgba(10, 6, 4, 0)');
    g.addColorStop(0.5, 'rgba(10, 6, 4, 0)');
    g.addColorStop(0.78, 'rgba(10, 6, 4, 0.45)');
    g.addColorStop(1, 'rgba(6, 4, 3, 1)');
  } else {
    g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    g.addColorStop(0.45, 'rgba(255, 255, 255, 0.35)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return (moodTextures[kind] = toTexture(c));
}

/** `base` eased toward `to` by `k` (0..1), channel by channel. */
function blendTint(base: number, to: number, k: number): number {
  const ch = (shift: number) => Math.round(((base >> shift) & 255) + ((((to >> shift) & 255) - ((base >> shift) & 255)) * clamp01(k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Tint for a card charred `q` (0..1): white, ember orange, then soot. */
function burnTint(q: number): number {
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const [r, g, b] = q < 0.5 ? [mix(255, 255, q * 2), mix(255, 120, q * 2), mix(255, 60, q * 2)] : [mix(255, 60, (q - 0.5) * 2), mix(120, 40, (q - 0.5) * 2), mix(60, 35, (q - 0.5) * 2)];
  return (r << 16) | (g << 8) | b;
}
const SETTLE_S = 0.35;
/** The largest a card is drawn at rest on the table (a hovered hand card), in tu. */
const XL = geometry(TABLE_W, CARD_SCALE.XL).SIZE;
const MAX_CARD_H = Math.max(XL.hand * XL.handHoverScale, XL.stackTop);

type Motion =
  /** `lean`: a combat step's peak lean (radians, signed), with a little lift, at the middle of the slide. */
  | { kind: 'tween'; t0: number; dur: number; from: Transform; ease: Easing; lean?: number; fly?: boolean; pop?: number; thud?: boolean }
  | {
      kind: 'flight';
      t0: number;
      dur: number;
      from: Transform;
      arc: number;
      tilt: number;
      settle: boolean;
      startFace: boolean;
      toAnchor: Pose | null;
      /** Shown big in the centre on the way (an opponent's spell). */
      present: boolean;
      /** A death: chars in place for the first BURN_SPLIT of the flight. */
      burn: boolean;
      /** Leaving the stack (layout/stack.ts stackExit): resolve pulse, then its way out; countered: cracks, shatters. */
      exit: StackExit | null;
      /** Onto the stack: the emphasised ease-out, landing with STACK_LAND's give. */
      land: boolean;
      /** The beat it belongs to (a presented spell clicked through releases it: Director.release). */
      seq: number;
    }
  | { kind: 'fadeIn'; t0: number; dur: number }
  | { kind: 'appear'; t0: number; dur: number }
  /** Landed: the scale springs from `from` (above 1: a pop; below: a thump) back to 1. */
  | { kind: 'settle'; t0: number; from: number }
  /** Dropped over the table but not playable: shakes where it was let go, then goes back (handDrag.ts). */
  | { kind: 'reject'; t0: number; from: Transform };

interface SpriteState {
  sprite: CardSprite;
  target: CardPose | null;
  targetKey: string;
  motion: Motion | null;
  removingAt: number | null;
  retarget: { dur: number; overshoot: boolean; lean?: number; fly?: boolean } | null;
  /** Clock time the sprite was created. */
  bornAt: number;
  /** The card object its textures were last chosen for (patches replace objects, so identity = unchanged). */
  card: unknown;
  /** Dying: how charred it is now (0..1), for its tint. */
  burn?: number;
  /** Fizzled: dissolving (0..1) on the stack, kept faded until it lands in the graveyard. */
  fizz?: number;
  /** Hit by deathtouch: if it dies now it withers (green-grey) instead of charring. */
  wither?: boolean;
  /** On the stack: how far it has come forward under the pointer (0..1), and its brightness now (eases to its depth's). */
  zoom: number;
  shade: number;
  /** A resolved ability card going away: where it was (it swells and fades there over ABILITY_EXIT_MS). */
  vanish?: Transform;
}

/** A keyword moment playing (choreography KeywordTrack, drawn by keywordFx.ts). */
interface KeywordFx {
  kind: 'trample' | 'venom' | 'slash' | 'shield';
  g: Graphics;
  /** Where it plays (the hit card or plate); trample: the blockers it went through, and the plate. */
  at: Pt;
  through: Pt[];
  h: number;
  t0: number;
  dur: number;
  still: boolean;
}

/** A landing flourish at a card's slot: a summon ring, land dust, or a token gathering out of motes. */
interface Flourish {
  g: Graphics;
  /** `bloom`: a stack card resolving, a soft white bloom over its own rect and a thin ring just past it; `glint`: vigilance. */
  kind: 'ring' | 'dust' | 'materialise' | 'flash' | 'flame' | 'glint' | 'bloom';
  x: number;
  y: number;
  /** The card's height there (tu). */
  h: number;
  cols: number[];
  t0: number;
  dur: number;
}

/** Bolt / burst colours for WUBRG letters (colourless when none). */
function fxCols(letters: string | undefined): number[] {
  const cs = [...(letters ?? '')].filter((c): c is keyof typeof fx => c in fx).map((c) => fx[c]);
  return cs.length ? cs : [fx.C];
}

interface Impact {
  /** Mana sparks: a spray of motes to a plate, no burst. */
  sparks?: boolean;
  g: Graphics;
  from: Pt;
  to: Pt;
  cols: number[];
  t0: number;
  dur: number;
}

interface Pop {
  text: Text;
  t0: number;
  dur: number;
  x: number;
  y: number;
  still: boolean;
  big: boolean;
}

export interface SceneCallbacks {
  /** A click / tap on a card; `pointerType` tells a mouse's double-click (play from hand) from a touch. */
  onCardClick(id: CardId, pointerType?: string): void;
  onHover(id: CardId | null): void;
  /** A graveyard or exile pile (or the card on top of it) was clicked: open the zone viewer. */
  onPileClick?(player: PlayerId, zone: 'graveyard' | 'exile'): void;
  /** The pointer went down on a card (client px): a possible drag (arrows/controller.ts). */
  onCardDown?(id: CardId, x: number, y: number): void;
  /** Right-click: snooze / unsnooze the card for auto-skip. */
  onCardSnooze?(id: CardId): void;
  /** A touch long press (the touch stand-in for hover): pin the card's preview. */
  onCardLongPress?(id: CardId): void;
  /** Any pointer down on the table (a touch elsewhere unpins the preview). */
  onTableDown?(): void;
  /** A tap on the dimmed table around a raised hand (touch): put the hand away. */
  onHandDismiss?(): void;
}

/** What the HUD says about interaction this frame (selectables, highlights). */
export interface SceneUi {
  prompt: PromptBody | null;
  blocked: boolean;
  /** Arrows to draw (arrows/specs.ts) and what aiming emphasises (arrows/controller.ts). */
  arrows?: ArrowSpec[];
  focus?: AimFocus;
  /** A player's plate as a table-space box (the HUD measures it), for arrows that end on a player. */
  plateBox?: (player: PlayerId) => Box | null;
  /** My hand's order, as the player dragged it (client-side). */
  handOrder?: readonly CardId[];
  /** Cards I snoozed (autoPass.snoozed): marked, and slightly greyed. */
  snoozed?: readonly CardId[];
  /** Touch: the player tapped their hand up to read it (uiStore.handUp), and the card they tapped in it. */
  handUp?: boolean;
  handFocus?: CardId | null;
  /** The hand card being dragged (or held after a drop to play) and its pose (table/handDrag.ts). */
  drag?: DragView | null;
  /** Hand cards let go since the last frame: back into the hand, shaken back, or gone (their flight has them). */
  drops?: { id: CardId; kind: DropKind | 'gone' }[];
}

export interface SceneOptions {
  resolution: number;
  /** Tests: deterministic output (no hover effects from stray pointers). */
  test: boolean;
}

export class TableScene {
  readonly app = new Application();
  private world = new Container();
  private background = new TableBackground();
  private pileLayer = new Container();
  private cardLayer = new Container();
  private fxLayer = new Container();
  /** Every arrow draws above the cards (big and readable beats never crossing a card). */
  private arrows = new ArrowLayer(() => true);
  /** A card picked up to aim (layout lifts it). */
  private lifted: CardId | null = null;
  /** The world's resting position and the screen size (resize), which the camera shake moves around. */
  private base = { x: 0, y: 0, w: 0, h: 0 };
  /** The red screen-edge flash when I take damage. */
  private readonly hurt = new Graphics();
  /** The stack louder (MOOD_IN_MS…): the edge vignette (screen space), the glow under the stack zone, the focus ripple. */
  private readonly vignette = new Sprite(Texture.EMPTY);
  private readonly stackGlow = new Sprite(Texture.EMPTY);
  private readonly focusRipple = new Graphics();
  /** How far the stack's mood is in (0..1). */
  private mood = 0;
  /** Touch: behind a raised hand, dims the table and takes the tap that puts the hand away. */
  private readonly dimmer = new Graphics();
  /** Touch: "Drag up to cast" above the raised hand, when the card brought forward can be played. */
  private castHint: { view: Container; label: Text; land: boolean } | null = null;
  /** A touch screen (pointer: coarse): a raised hand becomes a grid, and the lowered hand only raises it. */
  readonly touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private handOrder: readonly CardId[] = [];
  private handFocus: CardId | null = null;
  /** The hand card dragged (or held) now; out of the fan once over the table. */
  private drag: DragView | null = null;
  private dragOut: CardId | null = null;
  /** The mouse, in table units (hover tilt). */
  private pointer: Pt | null = null;
  private press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  /** The card a long press just snoozed: the tap that ends the press must not also click it. */
  private pressFired: CardId | null = null;
  private textures!: CardTextures;
  private states = new Map<CardId, SpriteState>();
  private pops: Pop[] = [];
  /** Combat contact in progress: the source lunges toward a point (table units); the hit card jolts after. */
  private lunges: { card: CardId; x: number; y: number; hit: CardId | null; t0: number; dur: number; contact: number; release: number }[] = [];
  /** The killing blow last flashed for (director.lethal), so each flashes once. */
  private lethalSeen: unknown = null;
  /** Spell bolts in flight and their bursts. */
  private impacts: Impact[] = [];
  /** Fizzled spells dissolving, and their ash. */
  private fizzles: { card: CardId; t0: number; dur: number; g: Graphics; x: number; y: number }[] = [];
  private flourishes: Flourish[] = [];
  private keywordFx: KeywordFx[] = [];
  /** P/T changes pulsing (choreography `pulse`). */
  private pulses: { card: CardId; t0: number; dur: number }[] = [];
  /** The protected card the aim last bounced off, and the ward-trigger arrows already flared (protection flares, once each). */
  private deniedSeen: CardId | null = null;
  private wardSeen = new Set<string>();
  /** The untap ripple under way: when it began, and until when another untap joins it. */
  private ripple = { t0: -Infinity, until: -Infinity };
  /** Countered spells: the cracks drawn over each (until it breaks), and the shards flying off. */
  private cracks = new Map<CardId, { g: Graphics; broke: boolean }>();
  private shards: { s: Sprite; x: number; y: number; vx: number; vy: number; vr: number; t0: number }[] = [];
  /** The "+N" on the deepest card drawn when the stack is deeper than the cascade shows. */
  private stackMore: { view: Container; label: Text; n: number } | null = null;
  /** A click or key while a spell is presented: it settles at once (frame). */
  private skipPresent = false;
  private lastNow = 0;
  private readonly onSkip = (): void => {
    if (this.presentShown) this.skipPresent = true;
  };
  private pileViews = new Map<string, Container>();
  private lastTrackId = 0;
  private lastCollapse = -Infinity;
  private layoutMemo: { model: unknown; hover: CardId | null; viewer: string; raise: boolean; lifted: CardId | null; handOrder: readonly CardId[]; focus: CardId | null; marks: ReadonlyMap<CardId, string>; dragOut: CardId | null; alt: readonly AltCard[]; layout: Layout } | null = null;
  /** My castable cards waiting outside the hand (table/altZone.ts): the strip beside the hand, by id, and what made it. */
  private alt: readonly AltCard[] = [];
  private altById = new Map<CardId, AltCard>();
  private altSrc: { model: unknown; prompt: unknown; blocked: boolean; snoozed?: unknown } | null = null;
  /** Per-card UI state that keeps identical permanents from grouping (layout.ts groupUnits). */
  private marks: ReadonlyMap<CardId, string> = new Map();
  private marksKey = '';
  private markSrc: { prompt?: unknown; focus?: unknown; snoozed?: unknown } = {};
  private hover: CardId | null = null;
  private raiseHand = false;
  private hoverChanged = false;
  private firstFrame = true;
  private scale = 1;
  private worldW = TABLE_W;
  private worldH = TABLE_H;
  /** A spell is being presented in the centre this frame / as last shown to the HUD. */
  private presentNow = false;
  private presentShown = false;
  /** The table's geometry now (world size, card size, HUD size). */
  geo: Geometry = geometry();
  /** A Brawl game (table/commander.ts): the geometry has a command-zone pile beside each plate. */
  private command = false;
  private cardScale = 1;
  /** HUD tu per CSS unit, max(s, 0.9) / s: the hand fits between HUD boxes of this size. */
  private hudK = 1;
  private readonly markings = tableMarkings();
  private size = { w: TABLE_W, h: TABLE_H };
  private opts: SceneOptions = { resolution: 1, test: false };
  /** Image keys whose art changed since the last frame ('*' = all of them). */
  private readonly artDirty = new Set<string>();

  constructor(
    private readonly director: Director,
    private readonly cb: SceneCallbacks,
    private readonly art: ArtLoader | null = null,
    /** The art-crop loader ('frame' art mode). */
    private readonly crops: ArtLoader | null = null,
  ) {}

  async init(host: HTMLElement, opts: SceneOptions): Promise<void> {
    this.opts = opts;
    await this.app.init({
      preference: 'webgl',
      antialias: true,
      resolution: opts.resolution,
      autoDensity: true,
      backgroundColor: 0x0d0f13,
      width: host.clientWidth || TABLE_W,
      height: host.clientHeight || TABLE_H,
      autoStart: false,
      sharedTicker: false,
    });
    this.app.ticker?.stop();
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.dataset.testid = 'table-canvas';
    host.appendChild(canvas);
    // Right-click snoozes a card (no browser menu); a touch long press is cancelled by moving or lifting.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', () => this.cb.onTableDown?.());
    canvas.addEventListener('pointermove', (e) => {
      this.pointer = e.pointerType === 'mouse' ? this.toTable(e.clientX, e.clientY) : null;
    });
    for (const t of ['pointermove', 'pointerup', 'pointercancel'] as const) canvas.addEventListener(t, this.cancelPress);
    // Any click or key while an opponent's spell is presented skips the rest of its presentation (MTGA).
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onSkip, true);
      window.addEventListener('keydown', this.onSkip, true);
    }
    // Card textures at a resolution matching the display, capped at 2× the base.
    const texH = Math.min(704, Math.max(352, Math.ceil(MAX_CARD_H * opts.resolution * Math.min(2, (host.clientHeight || TABLE_H) / TABLE_H) / 2) * 2));
    this.textures = new CardTextures(texH, this.art, this.crops);
    // Framed faces drawn plain while the M15 fonts loaded are redone once they are in.
    this.textures.onFonts = () => this.artDirty.add('*');
    this.art?.subscribe((key) => this.artDirty.add(key ?? '*'));
    this.crops?.subscribe((key) => this.artDirty.add(key ?? '*'));
    this.cardLayer.sortableChildren = true;
    this.dimmer.rect(-4000, -4000, 12000, 12000).fill({ color: 0x05070a, alpha: 0.4 });
    this.dimmer.zIndex = 599;
    this.dimmer.visible = false;
    this.dimmer.eventMode = 'static';
    this.dimmer.on('pointertap', () => this.cb.onHandDismiss?.());
    this.cardLayer.addChild(this.dimmer);
    this.vignette.texture = moodTexture('vignette');
    this.stackGlow.texture = moodTexture('glow');
    this.stackGlow.anchor.set(0.5);
    this.stackGlow.blendMode = 'add';
    this.stackGlow.tint = table.stackHalo;
    this.focusRipple.blendMode = 'add';
    this.vignette.visible = this.stackGlow.visible = false;
    // Decoration only: under the stage's 'static' mode a visible full-screen sprite above the world would win every hit
    // test, and no card could be clicked while the stack mood is up (Wild Growth's land target did nothing).
    this.vignette.eventMode = this.stackGlow.eventMode = this.focusRipple.eventMode = this.hurt.eventMode = 'none';
    this.world.addChild(this.markings, this.stackGlow, this.pileLayer, this.cardLayer, this.arrows.view, this.fxLayer, this.focusRipple);
    this.app.stage.addChild(this.background.view, this.world, this.vignette, this.hurt);
    this.app.stage.eventMode = 'static';
    this.resize(host.clientWidth || TABLE_W, host.clientHeight || TABLE_H);
  }

  /** Resize to W×H CSS px: s = min(W/worldW, H/worldH), world centred (geometry.ts worldSize). */
  resize(w: number, h: number): void {
    this.size = { w, h };
    this.app.renderer.resize(w, h);
    const world = worldSize(w, h);
    this.scale = Math.min(w / world.w, h / world.h);
    const hudK = hudScale(this.scale) / this.scale;
    if (world.w !== this.worldW || world.h !== this.worldH || hudK !== this.hudK) {
      this.worldW = world.w;
      this.worldH = world.h;
      this.hudK = hudK;
      this.relayout();
    }
    this.world.scale.set(this.scale);
    this.base = { x: (w - world.w * this.scale) / 2, y: (h - world.h * this.scale) / 2, w, h };
    this.world.position.set(this.base.x, this.base.y);
    this.background.resize(this.app.renderer, w, h, this.opts.resolution, this.scale);
  }

  /** The card-size setting's multiplier (geometry.ts CARD_SCALE). */
  setCardScale(v: number): void {
    if (v === this.cardScale) return;
    this.cardScale = v;
    this.relayout();
  }

  private relayout(): void {
    this.layoutMemo = null;
    this.geo = geometry(this.worldW, this.cardScale, this.hudK, this.worldH, this.command);
    tableMarkings(this.geo, this.markings);
  }

  get tableScale(): number {
    return this.scale;
  }

  get viewport(): { w: number; h: number } {
    return this.size;
  }

  setHover(id: CardId | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.hoverChanged = true;
  }

  get hovered(): CardId | null {
    return this.hover;
  }

  /** My hand is raised for a choice (no hover lift then). */
  get handRaised(): boolean {
    return this.raiseHand;
  }

  /** My castable cards waiting outside the hand now, in strip order (the runtime treats them like hand cards). */
  get altCards(): readonly AltCard[] {
    return this.alt;
  }

  /**
   * The strip beside the hand follows the prompt: a priority prompt lists what I can cast now (table/altZone.ts); a
   * "waiting" one empties it; any other prompt (paying, targets, an ask over the table) keeps what was there, minus
   * cards that left their zone, so the strip doesn't flicker out and back mid-cast.
   */
  private updateAlt(ui: SceneUi): void {
    const d = this.director;
    const src = this.altSrc;
    if (src && src.model === d.shown && src.prompt === ui.prompt && src.blocked === !!ui.blocked && src.snoozed === ui.snoozed) return;
    this.altSrc = { model: d.shown, prompt: ui.prompt, blocked: !!ui.blocked, snoozed: ui.snoozed };
    const p = ui.prompt;
    const castable = p?.kind === 'priority' && !ui.blocked ? altCastables(d.shown, d.viewer, p, ui.snoozed) : !p || p.kind === 'waiting' ? [] : altHeld(this.alt.filter((a) => !a.idle), d.shown);
    // My Brawl commander waits in the strip whatever the prompt, dimmed while it can't be cast.
    const next = withMyCommanders(castable, d.shown, d.viewer);
    const same = next.length === this.alt.length && next.every((a, i) => a.id === this.alt[i]!.id && a.label === this.alt[i]!.label && a.cost === this.alt[i]!.cost && a.idle === this.alt[i]!.idle && a.snoozed === this.alt[i]!.snoozed);
    if (same) return;
    this.alt = next;
    this.altById = new Map(next.map((a) => [a.id, a]));
    this.hoverChanged = true; // the hand narrows / widens at hover speed
  }

  layout(): Layout {
    const d = this.director;
    // A Brawl game's geometry has its command-zone piles (computeLayout reads the same from the model).
    if (hasCommanders(d.shown) !== this.command) {
      this.command = !this.command;
      this.relayout();
    }
    const m = this.layoutMemo;
    // A card dragged within the hand counts as hovered (its neighbours part around the place it would drop into).
    const hover = this.drag ? (this.dragOut ? null : this.drag.id) : this.hover;
    if (m && m.model === d.shown && m.hover === hover && m.viewer === d.viewer && m.raise === this.raiseHand && m.lifted === this.lifted && m.handOrder === this.handOrder && m.focus === this.handFocus && m.marks === this.marks && m.dragOut === this.dragOut && m.alt === this.alt) return m.layout;
    const layout = computeLayout({ model: d.shown, viewer: d.viewer, hover, raiseHand: this.raiseHand, touchHand: this.touch ? { focus: this.handFocus } : undefined, worldW: this.worldW, worldH: this.worldH, cardScale: this.cardScale, hudK: this.hudK, lifted: this.lifted, handOrder: this.handOrder, marks: this.marks, dragOut: this.dragOut, alt: this.alt.map((a) => a.id) });
    this.layoutMemo = { model: d.shown, hover, viewer: d.viewer, raise: this.raiseHand, lifted: this.lifted, handOrder: this.handOrder, focus: this.handFocus, marks: this.marks, dragOut: this.dragOut, alt: this.alt, layout };
    return layout;
  }

  /** Camera shake on big damage and a red edge flash when I am hit (director.shake / hurtAt; MTGA feel). */
  private feel(now: number): void {
    const d = this.director;
    let ox = 0;
    let oy = 0;
    const len = d.shake?.lethal ? SHAKE_LETHAL_MS : SHAKE_MS;
    const t = d.shake ? (now - d.shake.at) / len : 1;
    if (d.shake && t >= 0 && t < 1) {
      const a = d.shake.mag * SHAKE_PX * (1 - t) * (1 - t);
      ox = Math.sin(t * 47) * a;
      oy = Math.cos(t * 39) * a * 0.6;
    }
    this.world.position.set(this.base.x + ox, this.base.y + oy);
    const h = (now - d.hurtAt) / HURT_MS;
    this.hurt.clear();
    // A killing blow: a player's death whites out the screen for a moment; a creature's gets a burst where it stands.
    const kill = d.lethal;
    if (kill && d.fx) {
      const q = (now - kill.at) / LETHAL_FLASH_MS;
      if (kill.player && q >= 0 && q < 1) this.hurt.rect(0, 0, this.base.w, this.base.h).fill({ color: 0xfff4e0, alpha: 0.42 * (1 - q) * (1 - q) });
      if (kill.card && kill !== this.lethalSeen) {
        this.lethalSeen = kill;
        const at = this.states.get(kill.card)?.target;
        if (at) this.flourish('flash', at, [0xffffff], kill.at, LETHAL_FLASH_MS);
      }
    }
    if (h >= 0 && h < 1) {
      const { w, h: sh } = this.base;
      const edge = Math.min(w, sh) * 0.05;
      for (let i = 0; i < 4; i++) {
        const inset = (i * edge) / 4;
        this.hurt.rect(inset, inset, w - 2 * inset, sh - 2 * inset).stroke({ color: 0xd8342c, width: edge / 4, alpha: 0.45 * (1 - h) * (1 - i / 4) });
      }
    }
  }

  /** Card pose in screen px (for HUD anchoring and tests). */
  screenPoint(x: number, y: number): { x: number; y: number } {
    return { x: this.world.position.x + x * this.scale, y: this.world.position.y + y * this.scale };
  }

  /** Client px (e.g. a pointer event's clientX / clientY) → table units. */
  toTable(clientX: number, clientY: number): Pt {
    const r = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: (clientX - r.left - this.world.position.x) / this.scale, y: (clientY - r.top - this.world.position.y) / this.scale };
  }

  /** The topmost card drawn at a table point (its current, on-screen rect), optionally only among `among`. */
  cardAt(p: Pt, among?: (id: CardId) => boolean): CardId | null {
    let best: { id: CardId; z: number } | null = null;
    for (const st of this.states.values()) {
      if (st.removingAt !== null || st.sprite.cur.alpha < 0.5) continue;
      const id = st.sprite.id;
      if (among && !among(id)) continue;
      const t = st.sprite.cur;
      const cx = t.x;
      const cy = t.y - t.lift * 0.35;
      // Into the card's own frame (rotation about its centre).
      const dx = p.x - cx;
      const dy = p.y - cy;
      const c = Math.cos(-t.rot);
      const s = Math.sin(-t.rot);
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      const h = t.h * t.scale;
      if (Math.abs(lx) > cardWidth(h) / 2 || Math.abs(ly) > h / 2) continue;
      const z = st.sprite.view.zIndex;
      if (!best || z > best.z) best = { id, z };
    }
    return best?.id ?? null;
  }

  /** Where an arrow end is right now: a card's on-screen box, a player's plate, or a point. */
  private arrowEnd(e: ArrowEnd, ui: SceneUi): End | null {
    if ('point' in e) return e.point;
    if ('player' in e) return ui.plateBox?.(e.player) ?? null;
    const st = this.states.get(e.card);
    if (!st || st.removingAt !== null) return null;
    const t = st.sprite.cur;
    const h = t.h * t.scale;
    // An older stack card (a counterspell's target) shows only its name bar above the card in front: aim there.
    if (st.target?.region === 'stack' && (st.target.depth ?? 0) > 0) {
      const strip = h * 0.09;
      return { x: t.x, y: t.y - t.lift * 0.35 - h / 2 + strip, hw: cardWidth(h) / 2, hh: strip };
    }
    return cardBox(t.x, t.y - t.lift * 0.35, h, t.rot);
  }

  /** Keys of the arrows on screen (tests). */
  get arrowKeys(): string[] {
    return [...this.arrows.keys];
  }

  /**
   * Bring the scene to the Director's playhead at `now`, and draw it unless `render` is false (tests
   * fast-forwarding the virtual clock only draw the frame they stop on).
   */
  frame(now: number, ui: SceneUi, render = true): void {
    const d = this.director;
    this.feel(now);
    this.presentNow = false;
    const dt = Math.min(100, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const speedRate = d.speed > 0 ? 1 / d.speed : 0;
    const raise = (!!ui.prompt && RAISED_KINDS.has(ui.prompt.kind)) || !!ui.handUp;
    if (raise !== this.raiseHand) {
      this.raiseHand = raise;
      this.dimmer.visible = raise && this.touch;
      if (typeof document !== 'undefined') document.documentElement.classList.toggle('hand-up', this.dimmer.visible);
      this.hoverChanged = true; // a quick, hover-speed reflow
    }
    const lifted = ui.focus?.lifted ?? null;
    if (lifted !== this.lifted) {
      this.lifted = lifted;
      this.hoverChanged = true;
    }
    const focus = ui.handFocus ?? null;
    if (focus !== this.handFocus) {
      this.handFocus = focus;
      this.hoverChanged = true;
    }
    if (ui.prompt !== this.markSrc.prompt || ui.focus !== this.markSrc.focus || ui.snoozed !== this.markSrc.snoozed) {
      this.markSrc = { prompt: ui.prompt, focus: ui.focus, snoozed: ui.snoozed };
      const marks = cardMarks(ui);
      const key = [...marks].join(';');
      if (key !== this.marksKey) {
        this.marks = marks;
        this.marksKey = key;
        this.hoverChanged = true;
      }
    }
    const handOrder = ui.handOrder ?? [];
    if (handOrder !== this.handOrder) {
      this.handOrder = handOrder;
      this.hoverChanged = true; // the hand reflows at hover speed
    }
    const drag = ui.drag ?? null;
    const dragOut = drag?.out ? drag.id : null;
    if ((drag?.id ?? null) !== (this.drag?.id ?? null) || dragOut !== this.dragOut) this.hoverChanged = true; // the fan closes / opens at hover speed
    this.drag = drag;
    this.dragOut = dragOut;
    let snap = false;
    if (d.collapsedAt !== this.lastCollapse) {
      // Collapse (or a snapshot): finish all motion, crossfade newcomers in.
      this.lastCollapse = d.collapsedAt;
      for (const st of this.states.values()) {
        st.motion = null;
        st.retarget = null;
      }
      for (const p of this.pops) p.text.destroy();
      this.pops = [];
      this.pulses = [];
      this.endFx();
      for (const st of this.states.values()) st.fizz = undefined;
      this.lastTrackId = d.tracks.reduce((m, t) => Math.max(m, t.id), this.lastTrackId);
      snap = true;
    }
    this.updateAlt(ui);
    const layout = this.layout();
    if (this.artDirty.size > 0) this.swapArt();
    for (const t of d.tracks) {
      if (t.id <= this.lastTrackId) continue;
      this.lastTrackId = t.id;
      this.startTrack(t, layout, now);
    }
    if (this.skipPresent) this.settlePresented(now);

    const seen = new Set<CardId>();
    const reflow = this.hoverChanged ? HOVER_MS : REFLOW_MS * speedRate;
    this.hoverChanged = false;
    for (const pose of layout.cards.values()) {
      seen.add(pose.id);
      let st = this.states.get(pose.id);
      if (!st) {
        st = this.create(pose.id, poseToTransform(pose, pose.lift), pose.faceUp, now);
        // Cards that appear without a choreographed entrance (settle patches, snapshots) crossfade in; on the stack an
        // ability card springs out of its source, an older item comes forward out of the cascade.
        if (!this.firstFrame) {
          if (pose.region === 'stack') this.enterStack(st, pose, layout, now);
          else if (pose.region === 'alt' && !this.director.calm && this.slideOutOfPile(st, pose, layout, now)) {
            // A card that became castable slides out of its pile into the strip beside the hand.
          } else st.motion = { kind: 'fadeIn', t0: now, dur: FADE_MS };
        }
      }
      st.removingAt = null;
      this.retarget(st, pose, now, snap ? 0 : reflow);
    }
    for (const drop of ui.drops ?? []) this.letGo(drop.id, drop.kind, now);
    for (const [id, st] of this.states) {
      if (seen.has(id)) continue;
      if (st.motion?.kind === 'flight' && now < st.motion.t0 + st.motion.dur) continue;
      st.target = null;
      if (st.removingAt === null) {
        st.removingAt = now;
        // An ability card whose item left the stack resolved (not just pushed out of the cascade): it flashes away.
        if (isAbilityId(id) && !stackItemFor(d.shown, id) && !d.calm) {
          const c = st.sprite.cur;
          st.vanish = { ...c };
          if (d.fx) this.flourish('bloom',{ x: c.x, y: c.y - c.lift * 0.35, h: c.h * c.scale, rot: 0, faceUp: true }, [0xffffff], now, ABILITY_EXIT_MS * 1.2);
        }
      }
      if (now - st.removingAt >= (st.vanish ? ABILITY_EXIT_MS : FADE_MS)) {
        st.sprite.destroy();
        this.states.delete(id);
      }
    }
    this.firstFrame = false;

    // Evaluate motion and draw.
    const selectable = new Set(ui.prompt?.selectable ?? []);
    for (const id of ui.focus?.selectable ?? []) selectable.add(id);
    // Picked cards (prompt `highlighted` in a selection prompt) outrank selectable: table/selection.ts.
    const allPicks = picksOf(ui.prompt);
    // Blocker-first blocking hides Forge's "current attacker" focus (arrows/controller.ts AimFocus.engineFocus).
    const picks = ui.focus && !ui.focus.engineFocus ? { ...allPicks, focus: new Set<string>() } : allPicks;
    const weak = ui.prompt?.weak ?? {};
    const stackTop = layout.stackTop;
    // Planned blocks (declareBlockers) are blocks too: the blue ring before the engine locks them.
    const blockers = blockerMap(d.shown.game.combat);
    // Stack arrows (arrows/specs.ts): what they point at gets a soft target ring; hovering a target lights the stack
    // card aiming at it. The top of the stack breathes while I have priority over it.
    const targeted = new Set<CardId>();
    const lit = new Set<CardId>();
    // Protection flares (director/protection.ts): the card an aimed spell bounced off flashes its shield once as the
    // pointer arrives; a ward trigger landing flashes the warded permanent's rune once.
    const denied = ui.focus?.denied ?? null;
    if (denied?.card !== this.deniedSeen) {
      this.deniedSeen = denied?.card ?? null;
      if (denied) this.states.get(denied.card)?.sprite.flare(now, denied.kind, 'deny');
    }
    const wardKeys = new Set<string>();
    for (const a of ui.arrows ?? []) {
      if (a.kind !== 'ward') continue;
      wardKeys.add(a.key);
      if (!this.wardSeen.has(a.key) && 'card' in a.to) this.states.get(a.to.card)?.sprite.flare(now, 'ward', 'ward');
    }
    this.wardSeen = wardKeys;
    for (const a of ui.arrows ?? []) {
      if (a.kind !== 'target' || a.pending || !('card' in a.to)) continue;
      targeted.add(a.to.card);
      if (this.hover && a.to.card === this.hover && 'card' in a.from) lit.add(a.from.card);
    }
    const myPriority = ui.prompt?.kind === 'priority' && !ui.blocked;
    const breath = d.fx ? 0.5 - 0.5 * Math.cos((now / FOCUS_MS) * Math.PI * 2) : 0.5;
    this.lunges = this.lunges.filter((l) => now < l.t0 + l.dur * 1.5);
    this.fizzles = this.fizzles.filter((f) => {
      // Gone once it is on its way (or never moves: 3 s).
      const st = this.states.get(f.card);
      const keep = !!st && now < f.t0 + Math.max(f.dur * 1.6, st.motion?.kind === 'flight' ? 0 : 3000);
      if (!keep) {
        f.g.destroy();
        if (st && st.motion?.kind !== 'flight') st.fizz = undefined;
      }
      return keep;
    });
    const mode: AmbientMode = d.calm ? 'calm' : d.fx ? 'full' : 'lite';
    this.pulses = this.pulses.filter((p) => now < p.t0 + p.dur);
    for (const st of this.states.values()) {
      // The dragged / held hand card rides the pointer (handDrag.ts) until a flight picks it up from there.
      const dragged = drag && drag.id === st.sprite.id && st.motion?.kind !== 'flight' ? drag : null;
      if (dragged) {
        st.motion = null;
        st.sprite.cur = { x: dragged.x, y: dragged.y, h: dragged.h, rot: dragged.rot, alpha: 1, scale: 1, flipX: 1, lift: dragged.lift };
        st.sprite.view.zIndex = DRAG_Z;
      } else {
        this.evaluate(st, now);
        this.contact(st, now);
        this.pulse(st, now);
        this.dissolve(st, now);
        this.tilt(st);
      }
      const onStack = !dragged && st.target?.region === 'stack';
      const focusTop = onStack && myPriority && st.sprite.id === stackTop;
      if (onStack) this.onStack(st, dt, focusTop ? breath : null);
      const card = d.shown.cards[st.sprite.id];
      const base = st.target?.h ?? st.sprite.cur.h;
      let ring: RingKind = ringFor({ id: st.sprite.id, blocked: ui.blocked, selectable, picks, card, stackTop });
      let pick = pickBadge(st.sprite.id, picks);
      // Aiming (arrows/controller.ts): the card aimed from is picked up (no badge), its legal ends get the
      // selectable ring (a click there completes the aim), the rest dim.
      const focus = ui.focus;
      if (focus?.source === st.sprite.id && focus.lifted === st.sprite.id) {
        ring = 'selected';
        pick = '';
      } else if (focus?.legal.has(st.sprite.id) && ring !== 'selected') ring = 'selectable'; // clickable now
      else if (ring === 'none' && blockers.has(st.sprite.id)) ring = 'blocking';
      if ((ring === 'none' || ring === 'stackTop') && lit.has(st.sprite.id)) ring = 'highlight';
      else if (ring === 'none' && targeted.has(st.sprite.id)) ring = 'targeted';
      const dim = !!focus?.dim.has(st.sprite.id);
      const idle = st.target?.region === 'alt' && !!this.altById.get(st.sprite.id)?.idle;
      // A dying card chars: white → ember → near black.
      const snoozed = !!ui.snoozed?.includes(st.sprite.id);
      // Dragged over the table: "release to play" is the ember ring and a full glow; a card that can't be played
      // is muted (and stays so while it is shaken back).
      const cant = dragged?.cue === 'cant' || (st.motion?.kind === 'reject' && now - st.motion.t0 < REJECT_SHAKE_MS);
      if (dragged) {
        ring = dragged.cue === 'play' ? 'selectable' : 'none';
        pick = '';
      }
      // Older stack items are darker the deeper they sit (layout/stack.ts shade).
      const shade = onStack && st.shade < 0.995 ? greyTint(st.shade) : 0xffffff;
      st.sprite.view.tint = st.burn ? (st.wither ? witherTint(st.burn) : burnTint(st.burn)) : (st.fizz ?? 0) > 0.2 ? FIZZ_TINT : cant ? CANT_TINT : dim ? DIM_TINT : idle ? IDLE_TINT : st.sprite.snooze.active ? blendTint(shade, SNOOZE_TINT, st.sprite.snooze.amt) : shade;
      st.sprite.chrome.tint = dim ? DIM_TINT : shade;
      st.sprite.setRing(ring, base, pick, now);
      // Playable cards (prompt `weak`) get a soft halo; a ring (selectable, target, combat) outranks it.
      // The halo breathes, the wave running along the hand (overhaul, playable shimmer).
      const breathe = !d.fx ? 1 : 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(now / 520 - st.sprite.cur.x / 260));
      // Paying mana (MTGA's lit lands): every source that can pay glows under its ring and pulses, all in step; the
      // ones Auto Pay would tap (weak 2) glow stronger.
      const paySource = !ui.blocked && ring === 'selectable' && ui.prompt?.kind === 'payMana';
      const payPulse = !d.fx ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 300));
      if (dragged && dragged.cue !== 'none') st.sprite.setGlow(dragged.cue === 'cant' ? 0 : 2, 1);
      else if (paySource) st.sprite.setGlow(Math.max(1, weak[st.sprite.id] ?? 0), payPulse);
      else if (focusTop) st.sprite.setGlow(1, 0.55 + 0.45 * breath);
      else st.sprite.setGlow(ui.blocked || ring !== 'none' || cant ? 0 : (weak[st.sprite.id] ?? 0), breathe);
      const inHand = st.target?.region === 'hand';
      // A castable card outside the hand (table/altZone.ts) glows in its zone's colour with its alternate cost; a hand
      // card that can swap with an unblocked attacker (ninjutsu, sneak) glows violet and brighter, with that cost. No
      // chips naming the zone: where it waits is a grey line on its preview (hud/Panels.tsx).
      const alt = st.target?.region === 'alt' ? this.altById.get(st.sprite.id) : undefined;
      const swap = inHand && !ui.blocked ? swapCue(d.shown, d.viewer, ui.prompt, st.sprite.id) : null;
      const tone = alt?.tone ?? (swap ? 'ninja' : null);
      st.sprite.setGlowTint(tone ? TONE_COLOR[tone] : table.ember);
      if (swap && !dragged && ring === 'none' && !cant) st.sprite.setGlow(2, d.fx ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 260)) : 1);
      // On a scan the chip covers the printed P/T; on an M15 face (which prints the current one) it only lights the plate.
      const chip = !inHand && (st.sprite.showingArt || st.sprite.showingFramed) ? ptChip(card, printedPt) : null;
      // A commander waiting in the command zone shows its cost with the tax (Brawl; table/commander.ts).
      const cost = inHand ? (swap?.cost ?? ui.prompt?.costs?.[st.sprite.id]) : st.target?.region === 'command' ? commanderCost(d.shown, st.sprite.id, card?.state?.manaCost) : alt?.cost;
      st.sprite.setBadges(inHand ? undefined : card, base, chip, snoozed, st.target?.count ?? 0, showsRevealedBadge(inHand, card));
      st.sprite.setCost(cost, alt ? knownFace(card) : card?.state, base, now, d.calm);
      // Ambient keyword motion (sickness Z's, a flyer's hover) and the edge rim, for battlefield cards.
      const field = !!st.target && BATTLEFIELD.has(st.target.region) && st.removingAt === null;
      const fly = field && !dragged && st.motion?.kind !== 'flight' && hasKeyword(card, KW.flying);
      st.sprite.ambient(now, mode, fly, field, base, !!st.target?.under, LABEL_MIN_PX / this.scale);
      st.sprite.apply();
      // Badges sit on their card, just above it: a card overlapping this one covers them as it covers the card.
      // (A strip card's cost draws above the cards beside it, which overlap it: its neighbour's halo would cut it.)
      st.sprite.chrome.zIndex = st.sprite.view.zIndex + (st.target?.region === 'alt' && st.motion?.kind !== 'flight' ? 100 : 0.5);
    }
    this.updateMood(layout, now, dt, myPriority ? breath : null);
    const resolve = (e: ArrowEnd) => this.arrowEnd(e, ui);
    this.arrows.calm = !d.fx;
    this.arrows.update(ui.arrows ?? [], resolve, now, snap);
    this.updatePops(now);
    this.updateImpacts(now);
    this.updateFlourishes(now);
    this.updateKeywordFx(now);
    this.updateShards(now);
    this.updateStackMore(layout);
    this.updatePiles(layout.piles);
    const hintCard = ui.handUp && ui.handFocus && !ui.blocked && !drag && (weak[ui.handFocus] ?? 0) > 0 ? this.states.get(ui.handFocus) : undefined;
    this.showCastHint(hintCard && hintCard.target?.region === 'hand' ? hintCard : undefined, d.shown.cards[ui.handFocus ?? '']);
    // An opponent's spell held big in the centre: the HUD on the centre line steps aside (styles.css .fx-presenting).
    if (this.presentNow !== this.presentShown && typeof document !== 'undefined') {
      this.presentShown = this.presentNow;
      document.documentElement.classList.toggle('fx-presenting', this.presentNow);
    }
    if (render) this.app.render();
  }

  render(): void {
    this.app.render();
  }

  /**
   * The hint above the raised hand (touch), like the HUD's status line: centred on the table, clear of the cards
   * and their glow (not a button stuck to the card); hidden without a playable card in front.
   */
  private showCastHint(st: SpriteState | undefined, card: Card | undefined): void {
    if (!st) {
      if (this.castHint) this.castHint.view.visible = false;
      return;
    }
    if (!this.castHint) {
      const label = new Text({ text: '', style: { fontFamily: fonts.ui, fontWeight: '600', fontSize: 28, fill: 0xe9e4da }, resolution: 2 });
      label.anchor.set(0.5);
      const view = new Container();
      view.addChild(new Graphics(), label);
      this.fxLayer.addChild(view);
      this.castHint = { view, label, land: false };
      this.setHintText(false);
    }
    const land = !!card && isLand(card);
    if (land !== this.castHint.land) this.setHintText(land);
    const c = st.sprite.cur;
    this.castHint.view.position.set(this.worldW / 2, c.y - (c.h * c.scale) / 2 - 80);
    this.castHint.view.visible = true;
  }

  private setHintText(land: boolean): void {
    const hint = this.castHint!;
    hint.land = land;
    hint.label.text = land ? 'Drag up to play' : 'Drag up to cast';
    const w = hint.label.width + 40;
    const g = hint.view.children[0] as Graphics;
    g.clear().roundRect(-w / 2, -26, w, 52, 26).fill({ color: 0x14171c, alpha: 0.85 }).stroke({ color: 0x3a3f48, width: 2 });
  }

  // ------------------------------------------------------------------------------------- sprites

  private create(id: CardId, t: Transform, faceUp: boolean, now: number): SpriteState {
    const sprite = new CardSprite(id, this.textures.shadow(), t, faceUp, this.textures.glow());
    this.applyFace(sprite, this.director.shown.cards[id]);
    sprite.view.on('pointertap', (e) => {
      if (e.button === 2 || this.pressFired === sprite.id) return; // a right-click snoozes, a long press pins the preview
      this.clickSprite(sprite.id, e.pointerType);
    });
    sprite.view.on('rightclick', () => this.cb.onCardSnooze?.(sprite.id));
    sprite.view.on('pointerdown', (e) => {
      if (e.button === 2) return;
      this.pressFired = null;
      if (e.pointerType === 'touch') this.startPress(sprite.id, e.clientX, e.clientY);
      this.cb.onCardDown?.(sprite.id, e.clientX, e.clientY);
    });
    sprite.view.on('pointerover', () => this.cb.onHover(sprite.id));
    sprite.view.on('pointerout', () => this.cb.onHover(null));
    this.cardLayer.addChild(sprite.view, sprite.chrome);
    const st: SpriteState = { sprite, target: null, targetKey: '', motion: null, removingAt: null, retarget: null, bornAt: now, card: undefined, zoom: 0, shade: 1 };
    this.states.set(id, st);
    return st;
  }

  /** Touch long press (LONG_PRESS_MS without moving): pin the preview. A move or a lift first cancels it. */
  private startPress(id: CardId, x: number, y: number): void {
    this.cancelPress();
    const timer = setTimeout(() => {
      this.press = null;
      this.pressFired = id;
      navigator.vibrate?.(15);
      this.cb.onCardLongPress?.(id);
    }, LONG_PRESS_MS);
    this.press = { timer, x, y };
  }

  private cancelPress = (e?: PointerEvent): void => {
    if (!this.press) return;
    if (e?.type === 'pointermove' && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < 10) return;
    clearTimeout(this.press.timer);
    this.press = null;
  };

  /** A click on a card sprite. The card on top of a graveyard / exile pile stands for the pile: it opens the viewer. */
  private clickSprite(id: CardId, pointerType?: string): void {
    const target = this.states.get(id)?.target;
    if (target && (target.region === 'graveyard' || target.region === 'exile') && this.cb.onPileClick) {
      this.cb.onPileClick(target.owner, target.region);
      return;
    }
    this.cb.onCardClick(id, pointerType);
  }

  /**
   * Give a sprite the face texture for a card (real art when ready, else procedural). An ability card (layout/stack.ts)
   * paints its item over its source's art; once its item has left the stack it keeps the face it has.
   */
  private applyFace(sprite: CardSprite, card: Card | undefined): void {
    if (isAbilityId(sprite.id)) {
      const d = this.director.shown;
      const si = stackItemFor(d, sprite.id);
      const src = si?.source ? d.cards[si.source] : undefined;
      const tex = si ? this.textures.ability(abilityFace(si, src?.state?.name), src) : null;
      if (tex) sprite.setTextures(tex, this.textures.back(), false);
      return;
    }
    const tex = this.textures.face(card);
    sprite.setTextures(tex, this.textures.back(), this.textures.isArt(tex), this.textures.isFramed(tex));
  }

  /** What an ability card's face depends on (its source card's object; patches replace objects), for retarget. */
  private abilitySource(id: CardId): Card | undefined {
    const d = this.director.shown;
    const src = stackItemFor(d, id)?.source;
    return src ? d.cards[src] : undefined;
  }

  /** Swap in art that became ready (or went away) on every live sprite showing it. Transforms are untouched. */
  private swapArt(): void {
    const all = this.artDirty.has('*');
    const cards = this.director.shown.cards;
    for (const st of this.states.values()) {
      const card = isAbilityId(st.sprite.id) ? this.abilitySource(st.sprite.id) : cards[st.sprite.id];
      const key = card?.state?.imageKey;
      if (all || (key && this.artDirty.has(key))) this.applyFace(st.sprite, card);
    }
    this.artDirty.clear();
  }

  private rename(st: SpriteState, to: CardId): void {
    const existing = this.states.get(to);
    if (existing && existing !== st) {
      existing.sprite.destroy();
      this.states.delete(to);
    }
    this.states.delete(st.sprite.id);
    st.sprite.id = to;
    this.states.set(to, st);
  }

  private retarget(st: SpriteState, pose: CardPose, now: number, dur: number): void {
    const ability = isAbilityId(pose.id);
    const card = ability ? this.abilitySource(pose.id) : this.director.shown.cards[pose.id];
    if (card !== st.card) {
      st.card = card;
      if (!ability) printedPt.observe(card);
      this.applyFace(st.sprite, ability ? undefined : card);
    }
    // Moving within the stack zone (a new item in front, or one resolved): older items step to their depth one after
    // another, front first, with a small overshoot.
    const restack = pose.region === 'stack' && st.target?.region === 'stack' && !st.retarget;
    const key = `${pose.x.toFixed(1)},${pose.y.toFixed(1)},${pose.h.toFixed(1)},${pose.rot.toFixed(3)},${pose.faceUp}`;
    const flying = st.motion?.kind === 'flight';
    if (!flying) st.sprite.setShowingFace(pose.faceUp, this.textures.back());
    if (key !== st.targetKey) {
      const first = st.target === null && st.motion?.kind !== 'fadeIn' && !flying;
      st.targetKey = key;
      st.target = pose;
      if (!flying && !first) {
        const r = st.retarget;
        st.retarget = null;
        const d = r ? r.dur : dur;
        if (d > 0 && restack && st.motion?.kind !== 'fadeIn') {
          const calm = this.director.calm;
          const delay = calm ? 0 : Math.max(0, (pose.depth ?? 0) - 1) * RESTACK_STAGGER;
          st.motion = { kind: 'tween', t0: now + delay, dur: calm ? RESTACK_CALM_MS : RESTACK_MS, from: { ...st.sprite.cur }, ease: calm ? standard : backOut(1.15) };
        } else if (d > 0 && st.motion?.kind !== 'fadeIn' && st.motion?.kind !== 'appear') {
          st.motion = { kind: 'tween', t0: now, dur: d, from: { ...st.sprite.cur }, ease: r?.overshoot ? backOut(r.lean ? STEP_GIVE : 1.4) : standard, ...(r?.fly ? { fly: true } : {}) };
          // A combat step leans toward the table's centre line as it goes: cards left of the axis clockwise, right
          // of it the other way; mine (moving up) and the opponent's (moving down) mirror each other.
          if (r?.lean) st.motion.lean = ((r.lean * Math.PI) / 180) * (pose.x < this.worldW / 2 ? 1 : -1) * (pose.y > this.worldH / 2 ? 1 : -1);
        } else if (st.motion?.kind !== 'fadeIn' && st.motion?.kind !== 'appear') {
          st.motion = null;
        }
      }
    }
    st.target = pose;
    st.sprite.view.zIndex = flying ? 2000 + pose.z : pose.z;
  }

  private startTrack(t: ScheduledTrack, layout: Layout, now: number): void {
    switch (t.type) {
      case 'flight': {
        let st = (t.fromId ? this.states.get(t.fromId) : undefined) ?? this.states.get(t.card);
        const anchorFrom = layout.anchor(t.from);
        if (st && st.sprite.id !== t.card) this.rename(st, t.card);
        // A sprite that only just faded in at its new slot (a zone beat delivered the card a moment before
        // this beat) has no real "before" position: start from the zone it came from instead.
        if (st && st.motion?.kind === 'fadeIn' && now - st.bornAt < 120) {
          st.sprite.cur = poseToTransform(anchorFrom, 8);
          st.sprite.setShowingFace(anchorFrom.faceUp, this.textures.back());
        }
        if (!st) {
          st = this.create(t.card, poseToTransform(anchorFrom, 8), anchorFrom.faceUp, now);
          st.sprite.setShowingFace(anchorFrom.faceUp, this.textures.back());
        }
        st.removingAt = null;
        st.retarget = null;
        const slot = layout.cards.get(t.card) ?? null;
        if (t.crossfade || t.dur <= 0) {
          st.motion = t.dur > 0 ? { kind: 'fadeIn', t0: t.at, dur: t.dur } : null;
          if (slot) st.sprite.cur = poseToTransform(slot, slot.lift);
          return;
        }
        st.motion = {
          kind: 'flight',
          t0: t.at,
          dur: t.dur,
          // A fizzled spell leaves the stack still faded and brightens on its way to the graveyard.
          from: { ...st.sprite.cur, alpha: st.fizz !== undefined ? st.sprite.cur.alpha : 1, scale: 1, flipX: 1 },
          arc: t.arc,
          tilt: t.tilt,
          settle: t.settle,
          startFace: st.sprite.showingFace,
          toAnchor: slot ? null : layout.anchor(t.to),
          present: !!t.present,
          burn: !!t.burn,
          // A fizzled spell keeps its plain flight (its dissolve already took it out).
          exit: t.stackExit && t.stackExit !== 'bounce' && st.fizz === undefined ? t.stackExit : null,
          land: slot?.region === 'stack',
          seq: t.seq,
        };
        st.sprite.view.zIndex = 3000 + t.id;
        const fxOn = this.director.fx;
        const c = st.sprite.cur;
        // Resolving: a white flash blooms over it as it pulses; cast onto the stack: an ember ring as it lands.
        if (fxOn && st.motion.exit && st.motion.exit !== 'countered') this.flourish('bloom',{ x: c.x, y: c.y - c.lift * 0.35, h: c.h * c.scale, rot: 0, faceUp: true }, [0xffffff], t.at, Math.max(160, t.dur * PULSE_SPLIT * 1.8));
        if (fxOn && slot?.region === 'stack') this.flourish('ring', slot, [table.stackHalo], t.at + t.dur, 300);
        // A permanent landing (ETB): a summon ring in its colours, or dust for a land.
        if (t.settle && slot && this.director.fx) {
          const card = this.director.shown.cards[t.card];
          this.flourish(isLand(card) ? 'dust' : 'ring', slot, fxCols(card?.state?.colors), t.at + t.dur, t.dur * 1.4);
          // Haste: a flick of flame as it lands, and it is awake at once (no sickness Z's).
          if (hasKeyword(card, KW.haste) && !isLand(card)) this.flourish('flame', slot, [], t.at + t.dur * 0.8, t.dur * 1.45);
        }
        // Ninjutsu / sneak: the ninja flips in tapped and attacking where the returned attacker stood, in a violet flare.
        if (t.swap && slot && this.director.fx) {
          this.flourish('bloom', slot, [TONE_COLOR.ninja], t.at + t.dur * 0.85, t.dur * 1.6);
          this.flourish('ring', slot, [TONE_COLOR.ninja], t.at + t.dur, t.dur * 1.8);
        }
        if (t.settle && slot && !this.director.calm && hasKeyword(this.director.shown.cards[t.card], KW.haste)) st.sprite.sweep(t.at + t.dur, 480, 'wake');
        return;
      }
      case 'retarget': {
        const st = this.states.get(t.card);
        if (st) st.retarget = { dur: t.dur, overshoot: t.overshoot, ...(t.lean ? { lean: t.lean } : {}), ...(t.fly ? { fly: true } : {}) };
        const pose = layout.cards.get(t.card) ?? st?.target;
        if (!st || !pose || t.dur <= 0) return;
        // A vigilant attacker glints as it is declared (it stays untapped).
        if (t.glint) this.flourish('glint', pose, [], t.at, t.dur * 1.6);
        // My permanents untapping light up in a ripple, left to right whatever order Forge untaps them in.
        if (t.untap && this.director.shown.cards[t.card]?.controller === this.director.viewer) {
          if (t.at > this.ripple.until) this.ripple = { t0: t.at, until: t.at };
          this.ripple.until = t.at + RIPPLE_SPREAD + t.dur;
          st.sprite.sweep(Math.max(t.at, this.ripple.t0 + rippleDelay(pose.x, 0, this.worldW, RIPPLE_SPREAD)), t.dur * RIPPLE_K, 'ripple');
        }
        return;
      }
      case 'keyword':
        this.startKeyword(t, layout);
        return;
      case 'appear': {
        const slot = layout.cards.get(t.card);
        let st = this.states.get(t.card);
        if (!st && slot) st = this.create(t.card, poseToTransform(slot, slot.lift), slot.faceUp, now);
        if (st && t.dur > 0) st.motion = { kind: 'appear', t0: t.at, dur: t.dur };
        if (slot && t.dur > 0 && this.director.fx) this.flourish('materialise', slot, fxCols(this.director.shown.cards[t.card]?.state?.colors), t.at, t.dur * 2.2);
        return;
      }
      case 'pop': {
        let x: number;
        let y: number;
        if (t.card) {
          const p = layout.cards.get(t.card) ?? this.states.get(t.card)?.target;
          if (!p) return;
          x = p.x;
          y = p.y - p.h * 0.1;
        } else if (t.player) {
          const c = plateCentre(t.player === this.director.viewer, this.geo);
          x = c.x + 70;
          y = c.y;
        } else return;
        const text = new Text({
          text: t.text,
          style: {
            fontFamily: fonts.numeral,
            fontWeight: '600',
            fontSize: t.tone === 'counter' ? 46 : t.big ? 84 : 64,
            fill: t.tone === 'damage' ? table.damage : t.trend === 'up' ? table.heal : t.trend === 'down' ? table.damage : t.tone === 'counter' ? 0xffd27a : table.heal,
            stroke: { color: 0x0d0f13, width: 6 },
          },
          resolution: 2,
        });
        text.anchor.set(0.5);
        text.position.set(x, y);
        this.fxLayer.addChild(text);
        this.pops.push({ text, t0: t.at, dur: Math.max(t.dur, 1), x, y, still: t.still, big: !!t.big });
        return;
      }
      case 'roll':
        return; // plates roll their numbers in the HUD
      case 'lunge': {
        const at = t.atCard ? (layout.cards.get(t.atCard) ?? this.states.get(t.atCard)?.target) : null;
        const p = at ?? (t.atPlayer ? plateCentre(t.atPlayer === this.director.viewer, this.geo) : null);
        if (p) this.lunges.push({ card: t.card, x: p.x, y: p.y, hit: t.hit ?? null, t0: t.at, dur: Math.max(t.dur, 1), contact: t.contact, release: t.release });
        return;
      }
      case 'impact': {
        // An ability's bolt leaves from its ability card on the stack (layout/stack.ts), a spell's from its card.
        const ability = this.director.shown.game.stack.find((si) => si.ability && si.source === t.card);
        const card = ability && this.states.has(abilityId(ability.id)) ? abilityId(ability.id) : t.card;
        const src = this.states.get(card)?.sprite.cur ?? layout.cards.get(card);
        const at = t.atCard ? (layout.cards.get(t.atCard) ?? this.states.get(t.atCard)?.target) : null;
        const to = at ?? (t.atPlayer ? plateCentre(t.atPlayer === this.director.viewer, this.geo) : null);
        if (!src || !to) return;
        const g = new Graphics();
        g.blendMode = 'add';
        this.fxLayer.addChild(g);
        this.impacts.push({ g, from: { x: src.x, y: src.y }, to: { x: to.x, y: to.y }, cols: fxCols(t.colors), t0: t.at, dur: Math.max(t.dur, 1) });
        return;
      }
      case 'sparks': {
        const src = this.states.get(t.card)?.sprite.cur ?? layout.cards.get(t.card);
        if (!src) return;
        const to = plateCentre(t.player === this.director.viewer, this.geo);
        const g = new Graphics();
        g.blendMode = 'add';
        this.fxLayer.addChild(g);
        this.impacts.push({ sparks: true, g, from: { x: src.x, y: src.y }, to: { x: to.x + 40, y: to.y }, cols: fxCols(t.colors), t0: t.at, dur: Math.max(t.dur, 1) });
        return;
      }
      case 'fizzle': {
        const st = this.states.get(t.card);
        if (!st) return;
        const g = new Graphics();
        this.fxLayer.addChild(g);
        this.fizzles.push({ card: t.card, t0: t.at, dur: Math.max(t.dur, 1), g, x: st.sprite.cur.x, y: st.sprite.cur.y });
        return;
      }
    }
  }

  /**
   * A bolt in the spell's colours arcs from its source to the target (a short comet tail), then bursts there:
   * a white flash, a ring and sparks, alternating colours for a multicoloured spell.
   */
  private updateImpacts(now: number): void {
    this.impacts = this.impacts.filter((m) => {
      const { g, from, to, cols, t0, dur } = m;
      const p = (now - t0) / dur;
      g.clear();
      if (m.sparks) {
        if (p >= 1) {
          g.destroy();
          return false;
        }
        // Motes pop up off the card, then curve away to the plate, each a little behind the last.
        for (let i = 0; i < 8; i++) {
          const k = clamp01(p * 1.4 - i * 0.05);
          if (k <= 0 || k >= 1) continue;
          const e = easeInOut(k);
          const cx = from.x + ((i % 4) - 1.5) * 40;
          const cy = from.y - 140 - (i % 3) * 30;
          const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e * e * to.x;
          const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e * e * to.y;
          const c = cols[i % cols.length]!;
          g.circle(x, y, 9).fill({ color: c, alpha: 0.25 * (1 - k) });
          g.circle(x, y, 3.5).fill({ color: c, alpha: 1 - k * k });
        }
        return true;
      }
      if (p >= 1 + BURST_K) {
        g.destroy();
        return false;
      }
      if (p < 0) return true;
      if (p < 1) {
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        for (let i = 7; i >= 0; i--) {
          const e = easeInOut(clamp01(p - i * 0.035));
          const x = lerp(from.x, to.x, e);
          const y = lerp(from.y, to.y, e) - 0.15 * dist * Math.sin(Math.PI * e);
          const k = 1 - i / 8;
          const c = cols[i % cols.length]!;
          if (i === 0) g.circle(x, y, 30).fill({ color: c, alpha: 0.25 });
          g.circle(x, y, 14 * k + 2).fill({ color: i === 0 ? 0xffffff : c, alpha: 0.85 * k });
        }
        return true;
      }
      const q = (p - 1) / BURST_K;
      const out = 1 - (1 - q) ** 3;
      g.circle(to.x, to.y, 46 * (1 - q)).fill({ color: 0xffffff, alpha: 0.55 * (1 - q) });
      g.circle(to.x, to.y, 24 + 120 * out).stroke({ color: cols[0]!, width: 12 * (1 - q) + 1, alpha: 0.9 * (1 - q) });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.3;
        const r1 = 30 + 100 * out;
        const r2 = r1 + 34 * (1 - q);
        g.moveTo(to.x + Math.cos(a) * r1, to.y + Math.sin(a) * r1)
          .lineTo(to.x + Math.cos(a) * r2, to.y + Math.sin(a) * r2)
          .stroke({ color: cols[i % cols.length]!, width: 5 * (1 - q) + 1, alpha: 1 - q });
      }
      return true;
    });
  }

  /** A keyword moment starts (choreography keywordTracks): its drawing, the lifelink motes, or a P/T pulse. */
  private startKeyword(t: Extract<ScheduledTrack, { type: 'keyword' }>, layout: Layout): void {
    const poseOf = (id: CardId | undefined) => (id ? (layout.cards.get(id) ?? this.states.get(id)?.target ?? null) : null);
    const plate = (p: PlayerId | undefined) => (p ? plateCentre(p === this.director.viewer, this.geo) : null);
    if (t.fx === 'pulse') {
      if (t.card && t.dur > 0) this.pulses.push({ card: t.card, t0: t.at, dur: t.dur });
      return;
    }
    const card = poseOf(t.card);
    const at = card ?? plate(t.player);
    if (t.fx === 'lifelink') {
      const to = plate(t.to);
      if (!at || !to) return;
      const g = new Graphics();
      g.blendMode = 'add';
      this.fxLayer.addChild(g);
      this.impacts.push({ sparks: true, g, from: { x: at.x, y: at.y }, to: { x: to.x + 40, y: to.y }, cols: [table.heal, 0xb9f6d0], t0: t.at, dur: Math.max(t.dur, 1) });
      return;
    }
    let through: Pt[] = [];
    let where = at;
    let h = card?.h ?? this.geo.SIZE.battlefield;
    if (t.fx === 'trample') {
      const poses = (t.from ?? []).map(poseOf).filter((p): p is CardPose => !!p);
      through = poses.map((p) => ({ x: p.x, y: p.y }));
      where = plate(t.to);
      h = poses[0]?.h ?? h;
      if (!where || through.length === 0) return;
    }
    if (!where) return;
    if (t.fx === 'venom' && t.card) {
      const st = this.states.get(t.card);
      if (st) st.wither = true;
    }
    const g = new Graphics();
    if (t.fx !== 'venom' || !t.still) g.blendMode = 'add';
    this.fxLayer.addChild(g);
    this.keywordFx.push({ kind: t.fx, g, at: { x: where.x, y: where.y }, through, h, t0: t.at, dur: Math.max(t.dur, 1), still: !!t.still });
  }

  private updateKeywordFx(now: number): void {
    this.keywordFx = this.keywordFx.filter((f) => {
      const p = (now - f.t0) / f.dur;
      f.g.clear();
      if (p >= (f.still ? 1 : TAIL[f.kind])) {
        f.g.destroy();
        return false;
      }
      if (p < 0) return true;
      if (f.kind === 'trample') drawTrample(f.g, f.through, f.at, f.h, p, f.still);
      else if (f.kind === 'venom') drawVenom(f.g, f.at, f.h, p, f.still);
      else if (f.kind === 'slash') drawSlash(f.g, f.at, f.h, p, f.still);
      else drawShield(f.g, f.at, f.h, p, f.still);
      return true;
    });
  }

  /** A P/T change: the card swells and settles (a quick ease-out up, a softer return). */
  private pulse(st: SpriteState, now: number): void {
    for (const p of this.pulses) {
      if (p.card !== st.sprite.id || now < p.t0) continue;
      const q = clamp01((now - p.t0) / p.dur);
      const b = q < 0.35 ? enter(q / 0.35) : 1 - easeInOut((q - 0.35) / 0.65);
      st.sprite.cur = { ...st.sprite.cur, scale: st.sprite.cur.scale * (1 + PT_PULSE_SCALE * b) };
    }
  }

  private flourish(kind: Flourish['kind'], at: Pose, cols: number[], t0: number, dur: number): void {
    const g = new Graphics();
    if (kind !== 'dust') g.blendMode = 'add';
    // Under the cards for the ring and dust, over them while a token gathers or a kill flashes.
    (kind === 'ring' || kind === 'dust' ? this.pileLayer : this.fxLayer).addChild(g);
    this.flourishes.push({ g, kind, x: at.x, y: at.y, h: at.h, cols, t0, dur: Math.max(dur, 1) });
  }

  private updateFlourishes(now: number): void {
    this.flourishes = this.flourishes.filter((f) => {
      const { g, x, y, h, cols } = f;
      const q = (now - f.t0) / f.dur;
      g.clear();
      if (q >= 1) {
        g.destroy();
        return false;
      }
      if (q < 0) return true;
      const out = 1 - (1 - q) ** 3;
      const w = cardWidth(h);
      if (f.kind === 'flame') drawFlame(g, f, h, q);
      else if (f.kind === 'glint') drawGlint(g, f, h, q);
      else if (f.kind === 'ring') {
        // Two flattened rings spread out from under the card; a soft glow fades with them.
        g.ellipse(x, y, w * 0.55 + w * 0.5 * out, h * 0.42 + h * 0.3 * out).fill({ color: cols[0]!, alpha: 0.18 * (1 - q) });
        for (let i = 0; i < Math.min(2, cols.length + 1); i++) {
          const k = clamp01(out - i * 0.18);
          g.ellipse(x, y, w * 0.55 + w * 0.6 * k, h * 0.42 + h * 0.36 * k).stroke({ color: cols[i % cols.length]!, width: 6 * (1 - q) + 1, alpha: 0.85 * (1 - q) });
        }
      } else if (f.kind === 'bloom') {
        const k = (1 - q) * (1 - q);
        g.roundRect(x - w / 2, y - h / 2, w, h, w * 0.05).fill({ color: 0xffffff, alpha: 0.32 * k });
        const d = 6 + 18 * out;
        g.roundRect(x - w / 2 - d, y - h / 2 - d, w + 2 * d, h + 2 * d, w * 0.05 + d).stroke({ color: 0xfff4e0, width: 3 * (1 - q) + 1, alpha: 0.8 * (1 - q) });
      } else if (f.kind === 'flash') {
        // A killing blow: a white burst over the card that swells and fades fast.
        g.ellipse(x, y, w * (0.45 + 0.35 * out), h * (0.4 + 0.25 * out)).fill({ color: 0xffffff, alpha: 0.55 * (1 - q) * (1 - q) });
        g.ellipse(x, y, w * (0.6 + 0.6 * out), h * (0.5 + 0.4 * out)).stroke({ color: 0xfff1d6, width: 8 * (1 - q) + 1, alpha: 0.8 * (1 - q) });
      } else if (f.kind === 'dust') {
        // Puffs kicked out sideways along the bottom edge, drifting up as they thin.
        for (let i = 0; i < 12; i++) {
          const side = i % 2 ? 1 : -1;
          const j = Math.floor(i / 2);
          const px = x + side * (w * 0.3 + (w * 0.25 + j * 9) * out);
          const py = y + h * 0.45 - (10 + j * 4) * out;
          g.circle(px, py, (8 + j * 2.5) * (0.5 + out)).fill({ color: 0x9c8f78, alpha: 0.32 * (1 - q) });
        }
      } else {
        // Motes spiral in to the slot, then a faint ring as the token settles.
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2 + q * 2.2;
          const r = h * (0.95 - 0.85 * out) * (0.8 + ((i * 7) % 5) * 0.06);
          g.circle(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8, 3.5 + 2 * (1 - q)).fill({ color: cols[i % cols.length]!, alpha: 0.9 * (q < 0.7 ? 1 : (1 - q) / 0.3) });
        }
        if (q > 0.55) {
          const k = (q - 0.55) / 0.45;
          g.ellipse(x, y, w * (0.5 + 0.3 * k), h * (0.5 + 0.2 * k)).stroke({ color: cols[0]!, width: 4 * (1 - k) + 1, alpha: 0.7 * (1 - k) });
        }
      }
      return true;
    });
  }

  // ------------------------------------------------------------------------------------- the stack zone

  /**
   * A card or ability card arriving in the stack zone with no flight of its own: an ability
   * card springs out of its source permanent (from its size and place, overshooting a little) while the source pulses
   * a ring; anything else (an older item coming into view as the stack shrinks) comes forward out of the cascade.
   * Reduced motion: it fades in at its slot.
   */
  private enterStack(st: SpriteState, pose: CardPose, layout: Layout, now: number): void {
    const d = this.director;
    if (d.calm) {
      st.motion = { kind: 'fadeIn', t0: now, dur: FADE_MS };
      return;
    }
    const srcId = isAbilityId(pose.id) ? stackItemFor(d.shown, pose.id)?.source : undefined;
    const live = srcId ? this.states.get(srcId) : undefined;
    const srcPose = srcId ? layout.cards.get(srcId) : undefined;
    const src = live && live.removingAt === null && live.sprite.cur.alpha > 0.3 ? { ...live.sprite.cur } : srcPose ? poseToTransform(srcPose, srcPose.lift) : null;
    if (src) {
      const from: Transform = { ...src, alpha: 0.35, scale: 1, flipX: 1 };
      st.sprite.cur = from;
      st.motion = { kind: 'tween', t0: now, dur: SPRING_MS, from, ease: emphasized, pop: SPRING_POP };
      if (d.fx) this.flourish('ring', { x: src.x, y: src.y, h: src.h, rot: 0, faceUp: true }, fxCols(d.shown.cards[srcId!]?.state?.colors), now, SPRING_MS);
      return;
    }
    const from: Transform = { ...poseToTransform(pose, pose.lift), y: pose.y - 28, scale: 0.92, alpha: 0 };
    st.sprite.cur = from;
    st.motion = { kind: 'tween', t0: now, dur: RESTACK_MS, from, ease: standard };
  }

  /**
   * A stack card's per-frame look: it eases to its depth's brightness, comes forward under the pointer (×1 + STACK_HOVER,
   * HOVER_MS; reduced motion: at once), and the top one breathes while I have priority over it (`breath` 0..1, or null).
   */
  private onStack(st: SpriteState, dt: number, breath: number | null): void {
    const calm = this.director.calm;
    const hovered = this.hover === st.sprite.id;
    const shade = hovered ? 1 : (st.target?.shade ?? 1);
    st.shade = calm ? shade : st.shade + (shade - st.shade) * Math.min(1, dt / 90);
    const to = hovered ? 1 : 0;
    st.zoom = calm ? to : to > st.zoom ? Math.min(to, st.zoom + dt / HOVER_MS) : Math.max(to, st.zoom - dt / HOVER_MS);
    const k = standard(st.zoom);
    const c = st.sprite.cur;
    st.sprite.cur = { ...c, scale: c.scale * (1 + STACK_HOVER * k), lift: c.lift + 12 * k + (breath ?? 0) * 6 };
    if (k > 0.01 && st.motion?.kind !== 'flight') st.sprite.view.zIndex = STACK_HOVER_Z;
  }

  /**
   * The stack's mood, per frame (MOOD_IN_MS…): the edge vignette and the glow under the front card ease in while the
   * stack is non-empty and out after; `focus` (my priority over it: the breath 0..1, else null) brightens the glow with
   * the breath and sends the top item's ripple out (not in reduced motion / Effects Off).
   */
  private updateMood(layout: Layout, now: number, dt: number, focus: number | null): void {
    const d = this.director;
    const to = layout.stackActive ? 1 : 0;
    const len = d.calm ? MOOD_CALM_MS : to > this.mood ? MOOD_IN_MS : MOOD_OUT_MS;
    this.mood = to > this.mood ? Math.min(to, this.mood + dt / len) : Math.max(to, this.mood - dt / len);
    const k = standard(this.mood);
    const top = layout.stackTop ? this.states.get(layout.stackTop) : undefined;
    const pose = layout.stackTop ? layout.cards.get(layout.stackTop) : undefined;
    this.vignette.visible = k > 0.001;
    this.vignette.alpha = VIGNETTE_ALPHA * k;
    this.vignette.width = this.base.w;
    this.vignette.height = this.base.h;
    // The glow stays where the front card last was while it fades out.
    if (pose) this.stackGlow.position.set(pose.x, pose.y);
    const h = pose?.h ?? this.geo.SIZE.stackTop;
    this.stackGlow.width = cardWidth(h) * 3.4;
    this.stackGlow.height = h * 1.9;
    this.stackGlow.visible = k > 0.001;
    this.stackGlow.alpha = k * STACK_GLOW_ALPHA * (focus === null ? 1 : 1.15 + 0.35 * focus);
    this.focusRipple.clear();
    if (focus === null || d.calm || !top || top.motion?.kind === 'flight' || top.removingAt !== null) return;
    // Two rounded rings a beat apart spread out from the card's edge and fade (an ease-out spread: decisive, then soft).
    const c = top.sprite.cur;
    const w = cardWidth(c.h) * c.scale;
    const ch = c.h * c.scale;
    const y = c.y - c.lift * 0.35;
    for (const off of [0, 0.32]) {
      const q = (now / FOCUS_MS + off) % 1;
      const out = 1 - (1 - q) ** 3;
      const pad = 4 + RIPPLE_PAD * out;
      this.focusRipple
        .roundRect(c.x - w / 2 - pad, y - ch / 2 - pad, w + 2 * pad, ch + 2 * pad, w * 0.05 + pad)
        .stroke({ color: table.stackHalo, width: 5 * (1 - q) + 1.5, alpha: 0.9 * (1 - q) * k });
    }
  }

  /**
   * An opponent's spell lands on the stack from its presentation (batch 11): its flight or the click-through tween
   * already left it compressed (THUD_GIVE, springing back); with full effects a wide ember ring bursts under it and
   * the camera shakes lightly, by what it costs (choreography stackThud), never weaker than a shake already ringing.
   */
  private thud(st: SpriteState, now: number): void {
    const d = this.director;
    if (!d.fx || !st.target) return;
    const mag = stackThud(manaValue(d.shown.cards[st.sprite.id]?.state?.manaCost));
    const ringing = d.shake && now - d.shake.at < SHAKE_MS ? d.shake.mag * (1 - (now - d.shake.at) / SHAKE_MS) : 0;
    if (mag > ringing) d.shake = { at: now, mag };
    const t = st.target;
    this.flourish('ring', { x: t.x, y: t.y, h: t.h * 1.25, rot: 0, faceUp: true }, [table.stackHalo, 0xfff4e0], now, THUD_RING_MS);
  }

  /** Where a spell is presented: big in the middle of the table. */
  private presentPose(dest: Transform): Transform {
    return { x: this.worldW / 2, y: this.worldH / 2, h: dest.h, rot: 0, alpha: 1, scale: PRESENT_H / dest.h, flipX: 1, lift: 60 };
  }

  /**
   * A click or key while a spell is presented: every presented card still in the centre settles into the stack now
   * (PRESENT_SKIP_MS, landing with the stack's give), and its beat lets the playhead go (Director.release).
   */
  private settlePresented(now: number): void {
    this.skipPresent = false;
    for (const st of this.states.values()) {
      const m = st.motion;
      if (m?.kind !== 'flight' || !m.present || !st.target) continue;
      if ((now - m.t0) / m.dur >= PRESENT_OUT) continue;
      st.sprite.setShowingFace(st.target.faceUp, this.textures.back());
      st.motion = { kind: 'tween', t0: now, dur: PRESENT_SKIP_MS, from: { ...st.sprite.cur, flipX: 1 }, ease: emphasized, thud: true };
      st.sprite.view.zIndex = st.target.z;
      this.director.release(m.seq, now);
    }
  }

  /**
   * A card leaving the stack (layout/stack.ts stackExit). Resolving, it pulses where it is for
   * PULSE_SPLIT of the flight (its flash blooms over it: startTrack), then a permanent flies to its slot (and lands with
   * a thump), a spell arcs to its graveyard shrinking to the pile, or fades up and out to exile and in on the pile. A
   * countered spell cracks for CRACK_SPLIT, then breaks: shards burst off it (Effects Lite: it fades) and it fades in
   * on the graveyard.
   */
  private leaveStack(st: SpriteState, m: Extract<Motion, { kind: 'flight' }>, p: number, dest: Transform, endFace: boolean): void {
    const sprite = st.sprite;
    const back = this.textures.back();
    const from = m.from;
    if (m.exit === 'countered') {
      if (p < CRACK_SPLIT) {
        const q = p / CRACK_SPLIT;
        sprite.setShowingFace(m.startFace, back);
        sprite.cur = { ...from, x: from.x + Math.sin(q * 70) * 2.5 * q, scale: 1 + 0.02 * q };
        this.drawCracks(st, q);
        return;
      }
      this.breakCard(st);
      sprite.setShowingFace(endFace, back);
      const q = clamp01((p - 0.62) / 0.38);
      const gone = this.director.fx ? 0 : 1 - clamp01((p - CRACK_SPLIT) / (0.62 - CRACK_SPLIT));
      sprite.cur = q <= 0 ? { ...from, alpha: gone } : { ...dest, y: dest.y - 14 * (1 - enter(q)), scale: 0.94 + 0.06 * enter(q), alpha: enter(q) };
      return;
    }
    const swell: Transform = { ...from, scale: 1 + PULSE_SCALE, lift: from.lift + 16 };
    if (p < PULSE_SPLIT) {
      const q = standard(p / PULSE_SPLIT);
      sprite.setShowingFace(m.startFace, back);
      sprite.cur = { ...from, scale: 1 + PULSE_SCALE * q, lift: from.lift + 16 * q };
      return;
    }
    const q = (p - PULSE_SPLIT) / (1 - PULSE_SPLIT);
    sprite.setShowingFace(endFace, back);
    if (m.exit === 'exile') {
      // Up and out (accelerating, fading), then in on the exile pile.
      if (q < 0.45) {
        const k = exit(q / 0.45);
        sprite.cur = { ...swell, y: swell.y - 50 * k, scale: swell.scale + 0.06 * k, alpha: 1 - k, lift: swell.lift + 14 * k };
      } else {
        const k = enter((q - 0.45) / 0.55);
        sprite.cur = { ...dest, y: dest.y - 16 * (1 - k), scale: 0.92 + 0.08 * k, alpha: k };
      }
      return;
    }
    // To its slot or its pile on an arc, tilting into the turn.
    const e = easeInOut(q);
    const cur = lerpT(swell, dest, e);
    const dx = dest.x - swell.x;
    const dist = Math.hypot(dx, dest.y - swell.y);
    const bump = Math.sin(Math.PI * e);
    cur.y -= m.arc * dist * bump;
    cur.rot += (dx >= 0 ? 1 : -1) * ((m.tilt * Math.PI) / 180) * Math.sin(Math.PI * q);
    cur.lift = Math.max(swell.lift * (1 - e), dest.lift) + 30 * bump;
    sprite.cur = cur;
  }

  /** Cracks spreading across a countered card from a point above its middle, drawn on with `q` (0..1). */
  private drawCracks(st: SpriteState, q: number): void {
    const id = st.sprite.id;
    let c = this.cracks.get(id);
    if (!c) {
      const g = new Graphics();
      this.fxLayer.addChild(g);
      c = { g, broke: false };
      this.cracks.set(id, c);
    }
    if (c.broke) return;
    const t = st.sprite.cur;
    const h = t.h * t.scale;
    const w = cardWidth(h);
    const g = c.g;
    g.clear();
    g.position.set(t.x, t.y - t.lift * 0.35);
    g.rotation = t.rot;
    const k = enter(q);
    // Seven rays, each a jagged polyline of three legs (deterministic from the card's id).
    let seed = [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) % 1000) / 1000;
    const ox = w * 0.06;
    const oy = -h * 0.12;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd() * 0.6;
      const len = (0.5 + rnd() * 0.5) * Math.hypot(w, h) * 0.55 * k;
      const pts: number[] = [ox, oy];
      let x = ox;
      let y = oy;
      for (let j = 1; j <= 3; j++) {
        const aj = a + (rnd() - 0.5) * 0.7;
        x += Math.cos(aj) * (len / 3);
        y += Math.sin(aj) * (len / 3);
        pts.push(Math.max(-w / 2, Math.min(w / 2, x)), Math.max(-h / 2, Math.min(h / 2, y)));
      }
      g.poly(pts, false).stroke({ color: CRACK, width: 7, alpha: 0.28 * k, join: 'round', cap: 'round' });
      g.poly(pts, false).stroke({ color: 0xffffff, width: 2.2, alpha: 0.95 * k, join: 'round', cap: 'round' });
    }
    g.circle(ox, oy, 10 + 18 * k).fill({ color: 0xffffff, alpha: 0.35 * (1 - q) + 0.15 });
  }

  /**
   * A countered card breaks (once): its cracks go and, with effects on, its face bursts into a 3×4 grid of shards that
   * fly out from the crack's centre, spinning and falling as they fade (updateShards).
   */
  private breakCard(st: SpriteState): void {
    const c = this.cracks.get(st.sprite.id);
    if (!c || c.broke) return;
    c.broke = true;
    c.g.clear();
    const d = this.director;
    if (!d.fx) return;
    const tex = this.textures.face(d.shown.cards[st.sprite.id]);
    if (!tex) return;
    const t = st.sprite.cur;
    const h = t.h * t.scale;
    const w = cardWidth(h);
    const now = this.lastNow;
    const f = tex.frame;
    const [cols, rows] = [3, 4];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const frame = new Rectangle(f.x + (i * f.width) / cols, f.y + (j * f.height) / rows, f.width / cols, f.height / rows);
        const s = new Sprite(new Texture({ source: tex.source, frame }));
        s.anchor.set(0.5);
        s.width = w / cols;
        s.height = h / rows;
        const lx = (i + 0.5) * (w / cols) - w / 2;
        const ly = (j + 0.5) * (h / rows) - h / 2;
        const x = t.x + lx;
        const y = t.y - t.lift * 0.35 + ly;
        const len = Math.hypot(lx, ly + h * 0.12) || 1;
        const v = 260 + ((i * 7 + j * 13) % 5) * 45;
        this.fxLayer.addChild(s);
        this.shards.push({ s, x, y, vx: (lx / len) * v, vy: ((ly + h * 0.12) / len) * v - 220, vr: (((i + j) % 2 ? 1 : -1) * (3 + ((i * j) % 3))), t0: now });
      }
    }
  }

  private updateShards(now: number): void {
    this.shards = this.shards.filter((p) => {
      const k = (now - p.t0) / SHARD_MS;
      if (k >= 1) {
        p.s.texture.destroy(false);
        p.s.destroy();
        return false;
      }
      const t = Math.max(0, now - p.t0) / 1000;
      p.s.position.set(p.x + p.vx * t, p.y + p.vy * t + 0.5 * SHARD_GRAVITY * t * t);
      p.s.rotation = p.vr * t;
      p.s.alpha = 1 - k * k;
      return true;
    });
    // Cracks whose card has gone on its way (or was never countered after all).
    for (const [id, c] of this.cracks) {
      const m = this.states.get(id)?.motion;
      if (m?.kind === 'flight' && m.exit === 'countered') continue;
      c.g.destroy();
      this.cracks.delete(id);
    }
  }

  /** "+N" on the deepest card the cascade draws, when the stack holds more than it shows. */
  private updateStackMore(layout: Layout): void {
    const n = layout.stackHidden;
    const st = n > 0 && layout.stackDeepest ? this.states.get(layout.stackDeepest) : undefined;
    if (!st) {
      if (this.stackMore) this.stackMore.view.visible = false;
      return;
    }
    if (!this.stackMore) {
      const label = new Text({ text: '', style: { fontFamily: fonts.numeral, fontWeight: '600', fontSize: 26, fill: 0xffb067 }, resolution: 2 });
      label.anchor.set(0.5);
      const view = new Container();
      view.addChild(new Graphics(), label);
      view.eventMode = 'none';
      this.cardLayer.addChild(view);
      this.stackMore = { view, label, n: 0 };
    }
    const more = this.stackMore;
    if (more.n !== n) {
      more.n = n;
      more.label.text = `+${n}`;
      const w = Math.max(44, more.label.width + 22);
      (more.view.children[0] as Graphics).clear().roundRect(-w / 2, -17, w, 34, 17).fill({ color: 0x14171c, alpha: 0.95 }).stroke({ color: table.stackHalo, width: 2 });
    }
    const c = st.sprite.cur;
    const h = c.h * c.scale;
    more.view.visible = true;
    more.view.alpha = c.alpha;
    more.view.position.set(c.x - cardWidth(h) / 2 + 4, c.y - c.lift * 0.35 - h / 2 + 4);
    more.view.zIndex = st.sprite.view.zIndex + 0.6;
  }

  /**
   * A card that just became castable (table/altZone.ts) starts at its pile (graveyard, exile, library) and slides
   * into the strip beside the hand, fading up and settling with a small overshoot. False when it has no pile to leave
   * (the command zone outside Brawl), so the caller fades it in instead.
   */
  private slideOutOfPile(st: SpriteState, pose: CardPose, layout: Layout, now: number): boolean {
    const zone = this.director.shown.cards[pose.id]?.zone;
    if (zone !== 'Graveyard' && zone !== 'Exile' && zone !== 'Library' && !(zone === 'Command' && this.geo.COMMAND)) return false;
    const from = layout.anchor({ player: this.director.shown.cards[pose.id]?.owner ?? this.director.viewer, zone });
    const start = { ...poseToTransform(from), alpha: 0.15, scale: 0.9 };
    st.sprite.cur = start;
    st.motion = { kind: 'tween', t0: now, dur: ALT_IN_MS, from: start, ease: backOut(1.15) };
    return true;
  }

  /** The hovered card in my hand leans a little toward the mouse. */
  private tilt(st: SpriteState): void {
    if (this.opts.test || !this.pointer || st.sprite.id !== this.hover || st.target?.region !== 'hand' || st.motion?.kind === 'flight') return;
    const c = st.sprite.cur;
    const k = Math.max(-0.5, Math.min(0.5, (this.pointer.x - c.x) / cardWidth(c.h * c.scale)));
    st.sprite.cur = { ...c, rot: c.rot + k * 0.09 };
  }

  /** A fizzled spell wavers, greys, thins out and sheds ash; it stays faded until its flight to the graveyard. */
  private dissolve(st: SpriteState, now: number): void {
    const f = this.fizzles.find((z) => z.card === st.sprite.id);
    if (!f || now < f.t0) return;
    const q = clamp01((now - f.t0) / f.dur);
    f.g.clear();
    for (let i = 0; i < (this.director.fx ? 16 : 0); i++) {
      // Ash rises off the card, each mote on its own little delay.
      const k = clamp01(q * 1.6 - (i % 5) * 0.12);
      if (k <= 0 || k >= 1) continue;
      const dx = (((i * 37) % 17) / 17 - 0.5) * st.sprite.cur.h * 0.6;
      const dy = (((i * 53) % 13) / 13 - 0.5) * st.sprite.cur.h * 0.7;
      f.g.circle(f.x + dx + Math.sin(k * 6 + i) * 6, f.y + dy - 70 * k, 3.5 * (1 - k) + 1).fill({ color: 0xb8c0d0, alpha: 0.8 * (1 - k) });
    }
    if (st.motion?.kind === 'flight') return; // the flight carries it on from here
    st.fizz = q;
    const c = st.sprite.cur;
    st.sprite.cur = { ...c, x: c.x + Math.sin(q * 50) * 2.5 * (1 - q), y: c.y - 8 * q, scale: c.scale * (1 - 0.06 * q), alpha: c.alpha * (1 - 0.7 * q) };
  }

  /**
   * Combat contact, kept small (the big lunge and wobble read cheesy): the attacker darts 16% of the way to
   * what it hits (ease-out), and there both freeze for the hit-stop (choreography LungeTrack contact → release): the
   * hit card dips and shudders in place. Then the attacker eases back (slower after a kill) and the hit card recovers.
   */
  private contact(st: SpriteState, now: number): void {
    for (const l of this.lunges) {
      if (now < l.t0) continue;
      const p = (now - l.t0) / l.dur;
      if (p >= 1) continue;
      const c = st.sprite.cur;
      if (l.card === st.sprite.id) {
        const q = p < l.contact ? 1 - (1 - p / l.contact) ** 2 : p < l.release ? 1 : 1 - easeInOut((p - l.release) / (1 - l.release));
        const k = 0.16 * q;
        st.sprite.cur = { ...c, x: c.x + (l.x - c.x) * k, y: c.y + (l.y - c.y) * k, lift: c.lift + 12 * q };
      } else if (l.hit === st.sprite.id && p >= l.contact) {
        // Frozen: a held dip with a fine shudder; after release the dip eases out over the attacker's return.
        const held = p < l.release;
        const dip = held ? 1 : 1 - clamp01((p - l.release) / (1 - l.release) / 0.6);
        const jx = held ? Math.sin(((now - l.t0) / 1000) * 2 * Math.PI * 28) * HIT_SHUDDER : 0;
        st.sprite.cur = { ...c, x: c.x + jx, scale: c.scale * (1 - 0.04 * dip) };
      }
    }
  }

  private evaluate(st: SpriteState, now: number): void {
    const sprite = st.sprite;
    const target = st.target ? poseToTransform(st.target, st.target.lift) : null;
    const m = st.motion;
    if (!m) {
      if (target) sprite.cur = target;
    } else if (m.kind === 'tween') {
      const p = m.dur > 0 ? clamp01((now - m.t0) / m.dur) : 1;
      if (target) sprite.cur = lerpT(m.from, target, m.ease(p));
      if (target && m.lean) {
        const b = Math.sin(Math.PI * p);
        sprite.cur = { ...sprite.cur, rot: sprite.cur.rot + m.lean * b, lift: sprite.cur.lift + (m.fly ? FLY_STEP_LIFT : STEP_LIFT) * b, scale: sprite.cur.scale * (1 + (m.fly ? 0.05 : 0.03) * b) };
      }
      // A spring: it swells to `pop` on the way in, then settles back on the snappy spring.
      if (target && m.pop) sprite.cur = { ...sprite.cur, scale: sprite.cur.scale * (1 + (m.pop - 1) * m.ease(p)) };
      if (p >= 1) st.motion = m.pop ? { kind: 'settle', t0: now, from: m.pop } : m.thud && !this.director.calm ? { kind: 'settle', t0: now, from: THUD_GIVE } : null;
      if (p >= 1 && m.thud) this.thud(st, now);
    } else if (m.kind === 'flight') {
      const dest = target ?? (m.toAnchor ? poseToTransform(m.toAnchor, 8) : m.from);
      const endFace = st.target ? st.target.faceUp : (m.toAnchor?.faceUp ?? m.startFace);
      const p = m.dur > 0 ? clamp01((now - m.t0) / m.dur) : 1;
      if (now < m.t0) {
        sprite.cur = { ...m.from };
      } else if (m.burn && p < BURN_SPLIT) {
        // Death: it shudders, darkens to embers and shrinks a little where it stands.
        const q = p / BURN_SPLIT;
        st.burn = q;
        sprite.cur = { ...m.from, x: m.from.x + Math.sin(q * 60) * 3 * q, scale: 1 - 0.08 * q, alpha: 1 - 0.25 * q };
      } else if (m.burn) {
        st.burn = 1;
        const q = (p - BURN_SPLIT) / (1 - BURN_SPLIT);
        const start = { ...m.from, scale: 0.92, alpha: 0.75 };
        sprite.cur = { ...lerpT(start, dest, easeInOut(q)), alpha: 0.75 + 0.25 * q };
        sprite.setShowingFace(endFace, this.textures.back());
      } else if (m.exit) {
        this.leaveStack(st, m, p, dest, endFace);
      } else if (m.present) {
        this.presentNow = true;
        // To the centre (turning face up), held big, then settled into the stack on the emphasised
        // ease-out (it lands with the stack's give: m.land).
        const centre = this.presentPose(dest);
        if (p < PRESENT_IN) {
          const q = p / PRESENT_IN;
          const cur = lerpT(m.from, centre, emphasized(q));
          cur.flipX = m.startFace === endFace ? 1 : Math.abs(Math.cos(Math.PI * q));
          sprite.setShowingFace(m.startFace === endFace || q >= 0.5 ? endFace : m.startFace, this.textures.back());
          sprite.cur = cur;
        } else if (p < PRESENT_OUT) {
          sprite.setShowingFace(endFace, this.textures.back());
          sprite.cur = { ...centre, scale: centre.scale * (1 + 0.015 * Math.sin(((p - PRESENT_IN) / (PRESENT_OUT - PRESENT_IN)) * Math.PI)) };
        } else {
          sprite.setShowingFace(endFace, this.textures.back());
          sprite.cur = lerpT(centre, dest, emphasized((p - PRESENT_OUT) / (1 - PRESENT_OUT)));
        }
      } else {
        // Onto the stack: fast out of the hand, a gentle arrival, swelling a touch as it lands (STACK_LAND).
        const e = m.land ? emphasized(p) : easeInOut(p);
        const cur = lerpT(m.from, dest, e);
        const dx = dest.x - m.from.x;
        const dy = dest.y - m.from.y;
        const dist = Math.hypot(dx, dy);
        const bump = Math.sin(Math.PI * e);
        cur.y -= m.arc * dist * bump;
        cur.rot += (dx >= 0 ? 1 : -1) * (m.tilt * Math.PI) / 180 * Math.sin(Math.PI * p);
        cur.lift = Math.max(m.from.lift, dest.lift) + 34 * bump;
        if (m.settle) cur.scale = 1 + 0.06 * e;
        else if (m.land) cur.scale = 1 + (STACK_LAND - 1) * e;
        if (m.startFace !== endFace) {
          // Turning over (a draw): it swells toward me as it turns, the face showing from 40% so it lands readable.
          const f = clamp01((p - 0.15) / 0.5);
          cur.flipX = Math.abs(Math.cos(Math.PI * f));
          cur.scale *= 1 + 0.14 * Math.sin(Math.PI * clamp01(p / 0.85));
          sprite.setShowingFace(f < 0.5 ? m.startFace : endFace, this.textures.back());
        } else {
          sprite.setShowingFace(endFace, this.textures.back());
        }
        sprite.cur = cur;
      }
      if (p >= 1) {
        st.burn = undefined;
        st.fizz = undefined;
        sprite.setShowingFace(endFace, this.textures.back());
        // A permanent off the stack lands with a thump (it gives under its own weight, then springs back); an ETB from
        // anywhere else pops; a card cast onto the stack settles from its landing swell.
        const from = m.exit === 'permanent' ? 0.95 : m.settle ? 1.06 : m.land && !this.director.calm ? (m.present ? THUD_GIVE : STACK_LAND) : 1;
        sprite.cur = { ...dest, scale: from };
        if (m.present && m.land) this.thud(st, now);
        if (!st.target) {
          st.removingAt = now - FADE_MS; // reached a pile slot it has no sprite in: drop it
          st.motion = null;
        } else {
          st.motion = from !== 1 ? { kind: 'settle', t0: now, from } : null;
          sprite.view.zIndex = st.target.z;
        }
      }
    } else if (m.kind === 'reject') {
      const t = now - m.t0;
      if (t < REJECT_SHAKE_MS) {
        sprite.cur = { ...m.from, x: m.from.x + shakeOffset(t / REJECT_SHAKE_MS, REJECT_AMP) };
      } else {
        const p = clamp01((t - REJECT_SHAKE_MS) / REJECT_BACK_MS);
        if (target) sprite.cur = lerpT(m.from, target, standard(p));
        if (p >= 1) st.motion = null;
      }
    } else if (m.kind === 'settle') {
      const s = (now - m.t0) / 1000;
      if (target) sprite.cur = { ...target, scale: 1 + (m.from - 1) * (1 - snappy(s)) };
      if (s >= SETTLE_S) st.motion = null;
    } else if (m.kind === 'fadeIn' || m.kind === 'appear') {
      const p = m.dur > 0 ? clamp01((now - m.t0) / m.dur) : 1;
      if (target) sprite.cur = { ...target };
      sprite.cur.alpha = p;
      if (m.kind === 'appear') sprite.cur.scale = 0.85 + 0.15 * standard(p);
      if (p >= 1) st.motion = null;
    }
    if (st.removingAt !== null) {
      // A resolved ability card swells a touch as it fades (ABILITY_EXIT_MS); anything else just fades.
      const v = st.vanish;
      const q = (now - st.removingAt) / (v ? ABILITY_EXIT_MS : FADE_MS);
      sprite.cur = v ? { ...v, alpha: Math.max(0, 1 - q * q), scale: v.scale * (1 + 0.12 * standard(clamp01(q))), lift: v.lift + 14 * q } : { ...sprite.cur, alpha: Math.max(0, 1 - q) };
    }
  }

  private updatePops(now: number): void {
    this.pops = this.pops.filter((p) => {
      const k = (now - p.t0) / p.dur;
      if (k >= 1) {
        p.text.destroy();
        return false;
      }
      if (k < 0) {
        p.text.alpha = 0;
        return true;
      }
      if (p.still) {
        p.text.alpha = 1;
        p.text.scale.set(1);
        return true;
      }
      // Fades in at 0.9 → 1 (no bounce), drifting up 14 tu, fading out over the last 40%. A kill's number punches in
      // from 1.5 with a small overshoot instead.
      p.text.scale.set(p.big ? (k < 0.2 ? lerp(1.5, 1, backOut(1.6)(k / 0.2)) : 1) : k < 0.15 ? lerp(0.9, 1, k / 0.15) : 1);
      p.text.position.set(p.x, p.y - 14 * k);
      p.text.alpha = k < 0.15 ? k / 0.15 : k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      return true;
    });
  }

  private updatePiles(piles: PileInfo[]): void {
    // A pile the layout no longer lists (an emptied exile) goes.
    const keys = new Set(piles.map((p) => `${p.player}:${p.zone}`));
    for (const [key, view] of this.pileViews) {
      if (keys.has(key)) continue;
      view.destroy({ children: true });
      this.pileViews.delete(key);
    }
    for (const p of piles) {
      const key = `${p.player}:${p.zone}`;
      let view = this.pileViews.get(key);
      const layers = p.zone === 'library' ? Math.min(5, Math.ceil(p.count / 8)) : 0;
      const stateKey = p.zone === 'command' ? `cmd:${!!p.topId}:${Math.round(p.h)}` : `${layers}:${p.count > 0}`;
      if (view && view.label === stateKey) {
        // A resize or a card-size change moves the piles.
        view.position.set(p.x, p.y);
        continue;
      }
      if (view) {
        view.destroy({ children: true });
        this.pileViews.delete(key);
      }
      view = new Container();
      view.label = stateKey;
      const h = p.zone === 'exile' ? p.h * 0.8 : p.h;
      const w = cardWidth(h);
      if (p.zone === 'command') {
        view.addChild(...this.commandSlot(w, h, !p.topId));
        view.position.set(p.x, p.y);
        this.pileLayer.addChild(view);
        this.pileViews.set(key, view);
        continue;
      }
      // An empty pile is just a faint brass outline; a full one sits in a soft recess.
      const slot = new Graphics().roundRect(-w / 2, -h / 2, w, h, w * 0.06);
      if (p.count === 0) slot.stroke({ color: table.brass, alpha: 0.16, width: 1 });
      else slot.fill({ color: 0x000000, alpha: 0.12 });
      view.addChild(slot);
      for (let i = 0; i < layers; i++) {
        const s = new Sprite(this.textures.back());
        s.anchor.set(0.5);
        s.width = w;
        s.height = h;
        s.position.set(-i * 1.4, -i * 1.8);
        view.addChild(s);
      }
      view.position.set(p.x, p.y);
      if ((p.zone === 'graveyard' || p.zone === 'exile') && this.cb.onPileClick) {
        // Graveyard and exile piles open the zone viewer.
        const zone = p.zone;
        view.eventMode = 'static';
        view.cursor = 'pointer';
        view.hitArea = new Rectangle(-w / 2, -h / 2, w, h);
        view.on('pointertap', () => this.cb.onPileClick?.(p.player, zone));
      }
      this.pileLayer.addChild(view);
      this.pileViews.set(key, view);
    }
  }

  /**
   * Brawl's command zone beside the opponent's plate (mine waits in the strip beside my hand): a soft recess their
   * commander sits in, like the other piles. While it is elsewhere (on the battlefield, castable) the slot is a faint dashed
   * outline around a small muted crown, so the zone still reads without a label (no loud labels on the table).
   */
  private commandSlot(w: number, h: number, empty: boolean): Container[] {
    const r = w * 0.06;
    const slot = new Graphics().roundRect(-w / 2, -h / 2, w, h, r).fill({ color: 0x000000, alpha: empty ? 0.1 : 0.12 });
    if (!empty) return [slot];
    // Dashes along the straight edges (the corners stay open), each edge's dashes centred on it.
    const dash = w * 0.07;
    const gap = w * 0.05;
    const edge = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.floor((len + gap) / (dash + gap)));
      const off = (len - (n * dash + (n - 1) * gap)) / 2;
      for (let i = 0; i < n; i++) {
        const t0 = (off + i * (dash + gap)) / len;
        const t1 = (off + i * (dash + gap) + dash) / len;
        slot.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0).lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
      }
    };
    const x = w / 2;
    const y = h / 2;
    edge(-x + r, -y, x - r, -y);
    edge(x, -y + r, x, y - r);
    edge(x - r, y, -x + r, y);
    edge(-x, y - r, -x, -y + r);
    slot.stroke({ color: table.brass, alpha: 0.3, width: 1 });
    // A three-point crown, about a quarter of the card's width.
    const c = w * 0.26;
    const crown = new Graphics()
      .poly([-c / 2, c * 0.3, -c / 2, -c * 0.22, -c / 4, c * 0.04, 0, -c * 0.34, c / 4, c * 0.04, c / 2, -c * 0.22, c / 2, c * 0.3])
      .fill({ color: table.brass, alpha: 0.22 });
    return [slot, crown];
  }

  /** Every sprite's current transform (tests and diagnostics). */
  debugSprites(): Array<{ id: string; x: number; y: number; h: number; rot: number; alpha: number; face: boolean; art: boolean; framed: boolean; sick: boolean; snoozed: boolean; revealed: boolean; prot: string | null; cost: string }> {
    return [...this.states.values()].map((s) => ({
      id: s.sprite.id,
      x: s.sprite.cur.x,
      y: s.sprite.cur.y,
      h: s.sprite.cur.h,
      rot: s.sprite.cur.rot,
      alpha: s.sprite.cur.alpha,
      face: s.sprite.showingFace,
      art: s.sprite.showingArt,
      framed: s.sprite.showingFramed,
      sick: s.sprite.sick,
      snoozed: s.sprite.snoozed,
      revealed: s.sprite.revealed,
      prot: s.sprite.prot?.key ?? null,
      cost: s.sprite.costText,
    }));
  }

  /**
   * A hand card let go (handDrag.ts): back into its slot with a little give, or (it can't be played) a firm shake
   * where it was dropped, then back. 'gone': its flight already has it. Reduced motion: straight back.
   */
  private letGo(id: CardId, kind: DropKind | 'gone', now: number): void {
    const st = this.states.get(id);
    if (!st || kind === 'gone' || kind === 'play' || st.motion?.kind === 'flight') return;
    const from = { ...st.sprite.cur };
    if (this.director.calm) st.motion = null;
    else if (kind === 'reject') st.motion = { kind: 'reject', t0: now, from };
    else st.motion = { kind: 'tween', t0: now, dur: DROP_BACK_MS, from, ease: backOut(1.1) };
  }

  /** A card as drawn now (centre in tu, the lift's offset taken out; height × scale), for picking it up. */
  spritePose(id: CardId): { x: number; y: number; h: number; rot: number; lift: number } | null {
    const st = this.states.get(id);
    if (!st || st.removingAt !== null) return null;
    const c = st.sprite.cur;
    return { x: c.x, y: c.y - c.lift * 0.35, h: c.h * c.scale, rot: c.rot, lift: c.lift };
  }

  /** The current target pose of a card (where a click should land), in table units. */
  poseOf(id: CardId): CardPose | undefined {
    return this.layout().cards.get(id);
  }

  /** Tests (settle): drop the decorative fx still playing (bolts, bursts, ash, landing flourishes, cracks, shards). */
  endFx(): void {
    for (const f of [...this.impacts, ...this.fizzles, ...this.flourishes, ...this.keywordFx, ...this.cracks.values()]) f.g.destroy();
    this.impacts = [];
    this.fizzles = [];
    this.flourishes = [];
    this.keywordFx = [];
    this.cracks.clear();
    for (const p of this.shards) {
      p.s.texture.destroy(false);
      p.s.destroy();
    }
    this.shards = [];
  }

  /** Any card still moving (tests settle on a still table). */
  get moving(): boolean {
    for (const st of this.states.values()) if (st.motion || st.removingAt !== null) return true;
    return this.shards.length > 0;
  }

  get cardCount(): number {
    return this.states.size;
  }

  get textureCount(): number {
    return this.textures.faceCount;
  }

  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onSkip, true);
      window.removeEventListener('keydown', this.onSkip, true);
    }
    this.app.destroy(true, { children: true, texture: true });
  }
}

function lerpT(a: Transform, b: Transform, t: number): Transform {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    h: lerp(a.h, b.h, t),
    rot: lerp(a.rot, b.rot, t),
    alpha: lerp(a.alpha, b.alpha, t),
    scale: lerp(a.scale, b.scale, t),
    flipX: lerp(a.flipX, b.flipX, t),
    lift: lerp(a.lift, b.lift, t),
  };
}


/** Per-card UI state that keeps otherwise identical permanents apart: s(electable), p(icked), z(snoozed), w(playable). */
export function cardMarks(ui: Pick<SceneUi, 'prompt' | 'focus' | 'snoozed'>): Map<CardId, string> {
  const out = new Map<CardId, string>();
  const add = (ids: Iterable<CardId> | undefined, tag: string) => {
    for (const id of ids ?? []) if (!out.get(id)?.includes(tag)) out.set(id, (out.get(id) ?? '') + tag);
  };
  add(ui.prompt?.selectable, 's');
  add(ui.focus?.selectable, 's');
  add(ui.prompt?.highlighted, 'p');
  add(ui.snoozed, 'z');
  add(Object.keys(ui.prompt?.weak ?? {}).filter((id) => (ui.prompt?.weak?.[id] ?? 0) > 0), 'w');
  return out;
}

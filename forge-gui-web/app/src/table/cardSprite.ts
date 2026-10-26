/**
 * One card on the table: a face/back sprite, a drop shadow, rings and glows outside the card rect, and status
 * badges ON the card (the P/T chip, damage, counters, summoning sickness), so each one plainly belongs to its
 * card (compact, never across the artist/copyright line, never tinting the scan).
 *
 * Badges live in `chrome`, a container the scene sorts just above its own card; it copies the card's transform
 * each frame.
 */
import { Container, Graphics, Rectangle, Sprite, Text, type Texture } from 'pixi.js';
import type { Card, CardFace } from '@forge-table/protocol';
import type { PtChip } from '../cards/pt';
import { manaValue, tokenizeMana } from '../cards/mana';
import { MANA_FONT, manaReady, msGlyph } from '../theme/manaFont';
import { SCAN_BAR, costPlateBox, costSlot, costTone, isPwFrame, nameBarFill, paintCostPlate, sampleCostBar, type CostPlate, type Ctx2D } from '../cards/face';
import { framedCard, ptHighlight } from '../cards/m15/framed';
import type { M15Card } from '../cards/m15/model';
import { costPatchBox, costSlotOf, layoutFor } from '../cards/m15/layouts';
import { M15_H, M15_W } from '../cards/m15/geometry';
import { costPips, paintM15CostPatch, paintM15Marks, type M15Counter, type M15Marks } from '../cards/m15/paint';
import { GLOW_PAD, GLOW_W, makeCanvas, toTexture } from '../cards/textures';
import { cardWidth } from '../layout/geometry';
import type { Pose } from '../layout/layout';
import { isSummoningSick } from '../store/model';
import { chrome as chromeTokens, fonts, table, type RGB } from '../theme/tokens';
import { PICK_CHECK } from './selection';
import { gainedKeywords, phaseOf } from '../director/keywords';
import { protectionOf, type Protections } from '../director/protection';
import { FLARE_MS, auraColor, drawAura, drawFlare, protectionChips, revealedEyeBadge, type FlareTone } from './protectionFx';
import { SNOOZE_SINK, SnoozeView } from './snoozeFx';
import { PRESS_SHRINK, PRESS_SINK, ambientKeywords, drawAmbientKeywords, drawBand, drawDent, drawPressShade, pressAt, type AmbientKeywords } from './ambientFx';

/** A transform in table units. */
export interface Transform {
  x: number;
  y: number;
  h: number;
  rot: number;
  alpha: number;
  /** Extra uniform scale (settle pop, appear). */
  scale: number;
  /** Horizontal squash for flips (1 = flat on the table, 0 = edge-on). */
  flipX: number;
  lift: number;
}

/** `targeted`: a stack item aims at it (a soft target-glow ring). */
export type RingKind = 'none' | 'selected' | 'selectable' | 'weak' | 'highlight' | 'attacking' | 'blocking' | 'stackTop' | 'targeted';

const RING_COLORS: Record<Exclude<RingKind, 'none'>, number> = {
  selected: table.pick,
  selectable: table.ember,
  weak: table.ember,
  highlight: table.targetGlow,
  attacking: table.attack,
  blocking: table.block,
  stackTop: table.stackHalo,
  targeted: table.targetGlow,
};

/**
 * Ring geometry in table units, outside the card edge: `pad` is the line's centre, `halo` the soft
 * band's centre. Selection clarity (2026-10): selectable got brighter and tighter (was pad 5 / halo 9 w8 α.22, line
 * α.95); picked is a thick cyan line with a dark keyline between it and the card, so it reads on white borders too.
 */
export const RING_STYLE = {
  selected: { pad: 4.5, line: 5, alpha: 1, halo: 9, haloW: 6, haloAlpha: 0.4, keyline: 2.5 },
  selectable: { pad: 3, line: 3, alpha: 1, halo: 5.5, haloW: 4, haloAlpha: 0.4, keyline: 0 },
  strong: { pad: 5, line: 3, alpha: 0.95, halo: 9, haloW: 8, haloAlpha: 0.22, keyline: 0 },
  weak: { pad: 5, line: 2, alpha: 0.5, halo: 9, haloW: 8, haloAlpha: 0.12, keyline: 0 },
} as const;

/**
 * Ambient keyword motion, run from the scene's frame loop (one shared ticker; requestAnimationFrame stops in a hidden
 * tab, so these stop with it) and costing a few transforms per card:
 * - Summoning sickness (the zZ coin "looks lame"): three small Z's drift up off the art's top-left on a slow
 *   loop and the art dims a touch; when the creature can attack (it untaps, or arrives with haste) a quick light
 *   sweep wakes it. Reduced: the three Z's stand still.
 * - Flying: the card hovers a little off the table (its shadow offset, softer) and bobs on a slow sine. Reduced:
 *   the hover without the bob.
 */
export const SICK_LOOP_MS = 2800;
export const FLY_LIFT = 5;
export const FLY_BOB = 2;
export const FLY_BOB_MS = 3600;
/** The sick creature's art, a touch dimmer (its badges and ring are not). */
const SICK_DIM = 0xcfd2d8;
/** Sweeps across the card: a waking creature's (cool white), an untap ripple's (warm, quicker), a keyword gained (silver-blue). */
const SWEEP = { wake: { color: 0xdfe8ff, alpha: 0.5 }, ripple: { color: 0xfff0cc, alpha: 0.32 }, gain: { color: 0xc8dcff, alpha: 0.6 } } as const;
export type SweepTone = keyof typeof SWEEP;
/** How the ambient motion plays: full and lite move; calm (reduced motion, Effects Off) stands still. */
export type AmbientMode = 'full' | 'lite' | 'calm';

/**
 * Where summoning sickness's Z number `i` (0..2) is at loop phase `k` (0..1), in card units for a card `baseH` tall
 * (origin at its centre), with its size factor and alpha. They rise from the art's top-left and leave the card over
 * its top edge, never right of the card's middle: the ×N group badge sits in the top-right corner.
 */
export function zPose(baseH: number, i: number, k: number): { x: number; y: number; s: number; a: number } {
  const w = cardWidth(baseH);
  const q = ((k % 1) + 1) % 1;
  const x = -w * 0.3 + w * 0.14 * q + Math.sin((q + i * 0.3) * Math.PI * 2) * w * 0.025 + i * w * 0.03;
  // From the top edge up and away: over the frame, never across the name or the art.
  const y = -baseH * 0.47 - baseH * 0.3 * q;
  const a = q < 0.2 ? q / 0.2 : q < 0.6 ? 1 : 1 - (q - 0.6) / 0.4;
  return { x, y, s: 0.75 + 0.45 * q, a: 0.7 * a };
}

/** A flyer's hover above the table (tu) at `now`: FLY_LIFT, plus a slow bob unless calm. */
export function flyOffset(id: string, now: number, calm: boolean): number {
  return FLY_LIFT + (calm ? 0 : FLY_BOB * Math.sin((now / FLY_BOB_MS + phaseOf(id)) * Math.PI * 2));
}

/**
 * The revealed-to-opponent eye's centre on a card `baseH` tall: just inside the art's top-left corner, under the name
 * line, clear of the mana cost (top-right) and of the pick badge on the top-left corner, and on the left edge a hand fan
 * leaves showing. A hand card wears no other badge there (summoning sickness and keyword icons are battlefield-only).
 */
export function revealedSpot(baseH: number): { x: number; y: number; r: number } {
  const u = baseH / 150;
  const r = 10 * u; // the badge's outer radius (protectionFx.ts revealedEyeBadge)
  return { x: -cardWidth(baseH) / 2 + cardWidth(baseH) * 0.075 + r + 3 * u, y: -baseH / 2 + baseH * 0.12 + r + 3 * u, r };
}

/** How far a picked card lifts (Transform.lift units) and how long it takes. */
export const PICK_LIFT = 18;
const PICK_LIFT_MS = 140;

/** The pick badge's centre and radius for a card `baseH` tall: straddling the top-left corner (a hand fan shows each card's left edge). */
export function pickSpot(baseH: number): { x: number; y: number; r: number } {
  const u = baseH / 150;
  return { x: -cardWidth(baseH) / 2 + 5 * u, y: -baseH / 2 + 3 * u, r: 13 * u };
}

export function poseToTransform(p: Pose, lift = 0): Transform {
  return { x: p.x, y: p.y, h: p.h, rot: p.rot, alpha: 1, scale: 1, flipX: 1, lift };
}

/** Whether setBadges should draw the eye badge: only a hand card the opponent has been shown. */
export function showsRevealedBadge(inHand: boolean, card: Card | undefined): boolean {
  return inHand && !!card?.revealedToOpponent;
}

export class CardSprite {
  id: string;
  readonly view = new Container();
  /** Badges and the P/T chip, on the card rect (the scene adds it to the card layer, just above the card). */
  readonly chrome = new Container();
  /** Status badges (rebuilt by setBadges) and the pick badge (setRing), both inside `chrome`. */
  private readonly badges = new Container();
  private readonly pickView = new Container();
  /** The adjusted cost in the cost slot (setCost): the current plate and the one fading out. */
  private readonly costView = new Container();
  private costIn: Container | null = null;
  private costOut: Container | null = null;
  private costKey = '';
  private costSize = '';
  private costT0 = 0;
  /** The adjusted cost showing ('' = the printed one), for tests. */
  costText = '';
  /** The pick badge's text ('' = none), for tests. */
  pickText = '';
  private pickKey = '';
  /** Pick lift: eased from `liftFrom` toward `liftTo` since `liftT0`. */
  private selLift = 0;
  private liftFrom = 0;
  private liftTo = 0;
  private liftT0 = 0;
  private readonly shadow: Sprite;
  /** "Playable" halo: behind the face, so only the part outside the card shows. Never on the card itself. */
  private readonly glow: Sprite;
  private glowLevel = 0;
  private readonly ring = new Graphics();
  private readonly face = new Sprite();
  private ringKey = '';
  private badgeKey = '';
  /** The summoning-sickness Z's are showing (for tests). */
  sick = false;
  /** Summoning sickness's drifting Z's (in `chrome`, kept across badge rebuilds). */
  private readonly zzz = new Container();
  /** A light sweep across the card (waking, untap ripple), drawn in `chrome`. */
  private readonly sweepG = new Graphics();
  private sweepAt: { t0: number; dur: number; tone: SweepTone } | null = null;
  /** Indestructible / deathtouch / lifelink on this battlefield card (setBadges), drawn per frame in `chrome` (table/ambientFx.ts). */
  private kw: AmbientKeywords | null = null;
  private readonly kwG = new Graphics();
  private kwOn = false;
  /** A trampler pressed into the table (0..1, set in ambient), and the dent in the mat around it, behind the card. */
  private press = 0;
  private readonly dent = new Graphics();
  /** The creature just stopped being sick: the next ambient frame wakes it. */
  private wakePending = false;
  /** Gained keywords last painted (null: none painted yet), and a new one arrived: the next ambient frame flashes it. */
  private gained: string[] | null = null;
  private gainPending = false;
  /** Hover above the table (tu): a flyer's (ambient). */
  private floatY = 0;
  /** A thin light rim on the card edge, so a dark border doesn't sink into the mat (stacked copies). */
  private readonly rim = new Graphics();
  private rimKey = '';
  /** The card is snoozed (for tests); the look itself is `snooze` (table/snoozeFx.ts). */
  snoozed = false;
  /** It wears the revealed-to-opponent eye (for tests). */
  revealed = false;
  /** The snooze veil and moon, in `chrome`: eases in and out by itself (set in ambient). */
  readonly snooze = new SnoozeView();
  /** Hexproof / shroud / protection / ward on this card (setBadges), if any. */
  prot: Protections | null = null;
  /** The shimmer aura around a hexproof or shroud card, outside the card edge (table/protectionFx.ts). */
  private readonly aura = new Graphics();
  private auraOn = false;
  /** A flare over the card (something turned away, a ward trigger landed), in `chrome`. */
  private readonly flareG = new Graphics();
  private flareAt: { t0: number; tone: FlareTone; kind: 'deny' | 'ward' } | null = null;
  private faceTexture: Texture | null = null;
  private faceIsArt = false;
  private faceIsFramed = false;
  /** Clicks hit the card rect only (not its shadow or halo). */
  private readonly hit = new Rectangle();
  /** Card height the chrome was drawn for; chrome scales with the card from there. */
  private chromeH = 150;

  /** Current transform (what is drawn). */
  cur: Transform;
  /** Whether the face (true) or the back (false) is showing. */
  showingFace: boolean;

  constructor(id: string, shadowTex: Texture, initial: Transform, faceUp: boolean, glowTex?: Texture) {
    this.id = id;
    this.cur = { ...initial };
    this.showingFace = faceUp;
    this.shadow = new Sprite(shadowTex);
    this.shadow.anchor.set(0.5);
    this.glow = new Sprite(glowTex);
    this.glow.anchor.set(0.5);
    this.glow.tint = table.ember;
    this.glow.visible = false;
    this.face.anchor.set(0.5);
    this.view.addChild(this.dent, this.shadow, this.glow, this.aura, this.ring, this.face, this.rim);
    this.chrome.eventMode = 'none';
    this.sweepG.blendMode = 'add';
    this.zzz.label = 'sick';
    this.chrome.addChild(this.sweepG, this.kwG, this.badges, this.zzz, this.snooze.view, this.flareG, this.costView, this.pickView);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = this.hit;
  }

  /**
   * `art`: the face texture is a real card scan (it shows printed P/T, so a P/T chip may be needed). `framed`: it is the
   * M15 face (Framed art mode: cards/m15), which prints the current P/T and keeps its cost and P/T plate where the layout says.
   */
  setTextures(face: Texture | null, back: Texture, art = false, framed = false): void {
    this.faceTexture = face;
    this.faceIsArt = art && !!face;
    this.faceIsFramed = framed && !!face;
    this.face.texture = this.showingFace && face ? face : back;
  }

  /** A real card scan is on screen right now. */
  get showingArt(): boolean {
    return this.showingFace && this.faceIsArt;
  }

  /** The M15 face is on screen right now. */
  get showingFramed(): boolean {
    return this.showingFace && this.faceIsFramed;
  }

  /** Show the face or the back (used mid-flip). */
  setShowingFace(v: boolean, back: Texture): void {
    this.showingFace = v;
    this.face.texture = v && this.faceTexture ? this.faceTexture : back;
  }

  /** Push `cur` into the Pixi transform. A flip squashes the whole card (face, ring, badges) on its own x axis. */
  apply(): void {
    const t = { ...this.cur, lift: this.cur.lift + this.selLift, scale: this.cur.scale * (1 - PRESS_SHRINK * this.press) };
    const w = cardWidth(t.h) * t.scale;
    const h = t.h * t.scale;
    // A snoozed card sinks a little (table/snoozeFx.ts).
    this.view.position.set(t.x, t.y - t.lift * 0.35 - this.floatY + this.snooze.amt * SNOOZE_SINK + this.press * PRESS_SINK);
    this.view.rotation = t.rot;
    this.view.alpha = t.alpha;
    this.view.scale.set(Math.max(0.001, t.flipX), 1);
    this.face.width = w;
    this.face.height = h;
    this.hit.x = -w / 2;
    this.hit.y = -h / 2;
    this.hit.width = w;
    this.hit.height = h;
    // The shadow texture is the card plus a 40px blur pad on a 160px-wide card.
    const k = w / 160;
    this.shadow.width = (160 + 80) * k;
    this.shadow.height = (160 / (63 / 88) + 80) * k;
    // A hovering flyer's shadow stays on the table, a little further off and softer.
    const fy = this.floatY;
    // A pressed card's shadow tucks in under it (table/ambientFx.ts).
    const tuck = 1 - 0.8 * this.press;
    this.shadow.position.set((t.lift * 0.25 + fy * 0.5) * tuck, (4 + t.lift * 0.6 + fy * 1.6) * tuck);
    this.shadow.alpha = Math.min(0.75, 0.35 + t.lift / 60) * t.flipX * (fy > 0 ? 0.8 : 1) * (1 - 0.5 * this.press);
    if (this.glowLevel > 0) {
      const g = w / GLOW_W;
      this.glow.width = (GLOW_W + 2 * GLOW_PAD) * g;
      this.glow.height = (GLOW_W / (63 / 88) + 2 * GLOW_PAD) * g;
    }
    const k2 = (t.h / this.chromeH) * t.scale;
    this.ring.scale.set(k2);
    this.rim.scale.set(k2);
    this.aura.scale.set(k2);
    this.dent.scale.set(k2 / (1 - PRESS_SHRINK * this.press));
    // The chrome container mirrors the card's transform; its children scale with the card like the ring.
    this.chrome.position.copyFrom(this.view.position);
    this.chrome.rotation = this.view.rotation;
    this.chrome.alpha = this.view.alpha;
    this.chrome.scale.set(this.view.scale.x * k2, k2);
    this.chrome.visible = this.view.visible;
  }

  /**
   * The soft ember halo for a playable card (prompt `weak`): 1 = can be played or activated, 2 = a bit
   * stronger (the auto-tap plan while paying mana). 0 = off. Subtler than any ring, and blurred, not a line.
   */
  /** `breathe` (0..1] scales the halo: the scene pulses it on playable cards. */
  setGlow(level: number, breathe = 1): void {
    const l = level >= 2 ? 2 : level > 0 ? 1 : 0;
    this.glowLevel = l;
    this.glow.visible = l > 0;
    this.glow.alpha = (l === 2 ? 1 : 0.9) * breathe;
  }

  /** The halo's colour (ember by default); an alt-zone card glows in its zone's colour (altZone.ts TONE_COLOR). */
  setGlowTint(color: number): void {
    this.glow.tint = color;
  }

  /**
   * Rings live outside the card edge: a crisp line plus a soft halo. A picked card (`selected`) also lifts and
   * shows `pick` (a check, or its pick number) in a badge on its top-left corner. `now` drives the lift's ease.
   */
  setRing(kind: RingKind, baseH: number, pick: string | null = null, now = 0): void {
    const to = kind === 'selected' ? PICK_LIFT : 0;
    if (to !== this.liftTo) {
      this.liftFrom = this.selLift;
      this.liftTo = to;
      this.liftT0 = now;
    }
    const p = Math.min(1, Math.max(0, (now - this.liftT0) / PICK_LIFT_MS));
    this.selLift = this.liftFrom + (this.liftTo - this.liftFrom) * (1 - (1 - p) ** 3);
    this.setPick(kind === 'selected' ? (pick ?? PICK_CHECK) : '', baseH);
    const key = `${kind}:${Math.round(baseH)}`;
    if (key === this.ringKey) return;
    this.ringKey = key;
    this.chromeH = baseH;
    this.ring.clear();
    if (kind === 'none') return;
    const color = RING_COLORS[kind];
    const st = kind === 'selected' ? RING_STYLE.selected : kind === 'selectable' ? RING_STYLE.selectable : kind === 'weak' || kind === 'targeted' ? RING_STYLE.weak : RING_STYLE.strong;
    // Table units, whatever the card's size (as before): a ring is as crisp on a small card as on a big one.
    const w = cardWidth(baseH);
    const h = baseH;
    const rr = (d: number) => this.ring.roundRect(-w / 2 - d, -h / 2 - d, w + 2 * d, h + 2 * d, w * 0.06 + d);
    rr(st.halo).stroke({ color, alpha: st.haloAlpha, width: st.haloW });
    // The dark keyline fills the gap between the card edge and the line.
    if (st.keyline > 0) rr(st.pad - st.line / 2 - st.keyline / 2 + 0.5).stroke({ color: 0x0d0f13, alpha: 0.9, width: st.keyline });
    rr(st.pad).stroke({ color, alpha: st.alpha, width: st.line });
  }

  /** The pick badge: a cyan disc with a dark check or number, on the card's top-left corner. */
  private setPick(text: string, baseH: number): void {
    const key = `${text}|${Math.round(baseH)}`;
    if (key === this.pickKey) return;
    this.pickKey = key;
    this.pickText = text;
    for (const c of this.pickView.removeChildren()) c.destroy({ children: true });
    if (!text) return;
    const s = pickSpot(baseH);
    const u = baseH / 150;
    const c = new Container();
    if (text.length > 2) {
      // A word ("Bottom"): a cyan tag along the card's top edge instead of the disc.
      const label = new Text({
        text,
        style: { fontFamily: fonts.numeral, fontWeight: '700', fontSize: 12 * u, fill: table.onPick, letterSpacing: 0.4 * u },
        resolution: 2,
      });
      label.anchor.set(0.5);
      const w = label.width + 14 * u;
      const h = 1.3 * s.r;
      const g = new Graphics()
        .roundRect(-w / 2 - 2 * u, -h / 2 - 2 * u, w + 4 * u, h + 4 * u, h / 2 + 2 * u)
        .fill({ color: 0x0d0f13, alpha: 0.9 })
        .roundRect(-w / 2, -h / 2, w, h, h / 2)
        .fill({ color: table.pick });
      c.addChild(g, label);
      c.position.set(s.x + w / 2 - s.r, s.y);
      c.label = 'pick';
      this.pickView.addChild(c);
      return;
    }
    const g = new Graphics()
      .circle(0, 0, s.r + 2 * u)
      .fill({ color: 0x0d0f13, alpha: 0.9 })
      .circle(0, 0, s.r)
      .fill({ color: table.pick });
    c.addChild(g);
    if (text === PICK_CHECK) {
      // Drawn, not a glyph: no font fallback can turn it into a box.
      const r = s.r;
      g.moveTo(-0.42 * r, 0.02 * r)
        .lineTo(-0.12 * r, 0.32 * r)
        .lineTo(0.44 * r, -0.3 * r)
        .stroke({ color: table.onPick, width: 0.24 * r, cap: 'round', join: 'round' });
    } else {
      const label = new Text({
        text,
        style: { fontFamily: fonts.numeral, fontWeight: '700', fontSize: 20 * u, fill: table.onPick },
        resolution: 2,
      });
      label.anchor.set(0.5);
      c.addChild(label);
    }
    c.position.set(s.x, s.y);
    c.label = 'pick';
    this.pickView.addChild(c);
  }

  /**
   * Status badges, all inside the card rect (see {@link badgeLayout}): the P/T chip (real art only, when the current
   * P/T differs from the printed one) over the card's own P/T box, damage just above it, counters up from the
   * bottom-left, and summoning sickness as a small "zZ" in the top-left corner of the art. `revealedToOpponent`
   * (a hand card shown to an opponent, e.g. Duress) draws an eye badge in the art's top-left corner, clear of the cost
   * ({@link revealedSpot}). It's the only badge that applies to a hand card, so it's a separate flag rather than read
   * off `card` (which is `undefined` in hand).
   */
  setBadges(card: Card | undefined, baseH: number, pt: PtChip | null = null, snoozed = false, count = 0, revealedToOpponent = false): void {
    const counters = card?.counters ?? {};
    const damage = card?.damage ?? 0;
    const sick = isSummoningSick(card);
    // Sick → able to attack while it stays on the battlefield (its controller's untap): wake it.
    if (this.sick && !sick && card?.zone === 'Battlefield') this.wakePending = true;
    this.sick = sick;
    this.face.tint = sick ? SICK_DIM : 0xffffff;
    this.snoozed = snoozed;
    this.revealed = revealedToOpponent;
    this.prot = protectionOf(card);
    this.kw = ambientKeywords(card);
    const framed = this.showingFramed;
    const gained = framed && card?.zone === 'Battlefield' && !card.facedown ? gainedKeywords(card.state) : [];
    // A keyword gained while it sits on the battlefield face up (not one it arrives or turns face up with): a flash as
    // its icon pops in, only once the icons can be painted.
    if (this.gained && manaReady() && gained.some((k) => !this.gained!.includes(k))) this.gainPending = true;
    this.gained = framed && card?.zone === 'Battlefield' && !card.facedown ? gained : null;
    const key = `${JSON.stringify(counters)}|${damage}|${sick}|${pt ? `${pt.text}:${pt.tone}` : ''}|${framed}|${Math.round(baseH)}|${count}|${this.prot?.key ?? ''}|${gained.join(',')}|${manaReady()}|${revealedToOpponent}`;
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.chromeH = baseH;
    // The marks sprite owns its painted texture; the rest share theirs.
    for (const c of this.badges.removeChildren()) c.destroy({ children: true, texture: c.label === 'marks', textureSource: c.label === 'marks' });
    const u = baseH / 150;
    const font = 16 * u;
    const pills: BadgeSpec[] = [];
    if (pt && framed && card?.state) {
      // The M15 face prints the current P/T itself; this lights its plate in the tone (green up, red down, amber mixed).
      const h = ptHighlight(framedCard(card.state, card, null), pt.tone, cardWidth(baseH), baseH);
      const r = h.rect;
      const ring = new Graphics()
        .roundRect(r.x - 3 * u, r.y - 3 * u, r.w + 6 * u, r.h + 6 * u, 7 * u)
        .stroke({ color: h.color, alpha: 0.28, width: 5 * u })
        .roundRect(r.x - u, r.y - u, r.w + 2 * u, r.h + 2 * u, 5 * u)
        .stroke({ color: h.color, alpha: 0.95, width: 1.8 * u });
      ring.label = 'pt-highlight';
      this.badges.addChild(ring);
    } else if (pt) {
      const ink = pt.tone === 'up' ? chromeTokens.success : pt.tone === 'down' ? chromeTokens.danger : pt.tone === 'set' ? chromeTokens.text : chromeTokens.warning;
      pills.push({ kind: 'pt', text: pt.text, fill: 0x14171c, stroke: table.brass, ink });
    }
    // Loyalty is already in the face's corner. Past three kinds the rest fold into "+N more" (QA: five chips buried
    // the card).
    const shownLoyalty = !!card?.state?.loyalty && card.state.loyalty !== '0';
    const kinds = Object.entries(counters).filter(([name, n]) => n && !(shownLoyalty && name.toUpperCase() === 'LOYALTY'));
    const listed = kinds.length > 3 ? kinds.slice(0, 2) : kinds;
    const marked = framed && !!card?.state;
    if (marked) {
      // The M15 face takes counters, damage and ×N as frame elements (coins in one style), not pills.
      const keywords = manaReady() ? gained.map((k) => msGlyph(`ability-${k}`)).filter((g): g is string => !!g) : [];
      const marks: M15Marks = { counters: kinds.map(([name, n]) => frameCounter(name, n)), damage, group: count, keywords };
      if (kinds.length || damage > 0 || count > 1 || keywords.length) this.badges.addChild(marksSprite(framedCard(card!.state!, card, null), marks, baseH));
    } else {
      if (damage > 0) pills.push({ kind: 'damage', text: `${damage}`, fill: 0x4a1714, stroke: table.damage, ink: 0xffe4e0 });
      for (const [name, n] of listed) {
        const icon = counterIcon(name);
        pills.push({ kind: 'counter', text: icon ? `${n}` : counterLabel(name, n), icon, fill: 0x14171c, stroke: table.brass, ink: 0xf4f2ec });
      }
      if (kinds.length > listed.length) pills.push({ kind: 'counter', text: `+${kinds.length - listed.length} more`, fill: 0x14171c, stroke: table.brass, ink: 0xc9c3b8 });
    }
    const made = pills.map((b) => pill(b.text, b.fill, b.stroke, b.ink, font, u, false, b.icon ?? null));
    const placed = badgeLayout(
      baseH,
      pills.map((b, i) => ({ kind: b.kind, w: made[i]!.width })),
    );
    placed.forEach((p, i) => {
      const c = made[i]!;
      c.scale.set(p.scale);
      c.position.set(p.x, p.y);
      this.badges.addChild(c);
    });
    for (const c of this.zzz.removeChildren()) c.destroy();
    if (sick) for (let i = 0; i < 3; i++) this.zzz.addChild(zGlyph(u, i));
    if (this.prot) for (const c of protectionChips(this.prot, baseH)) this.badges.addChild(c);
    if (count > 1 && !marked) {
      // Identical permanents stacked in one slot (layout.ts groupUnits): "×N" over the cost corner, like MTGA.
      const c = pill(`×${count}`, 0x14171c, table.brass, 0xf4e3b0, font * 1.15, u);
      const m = badgeMetrics(baseH);
      c.position.set(cardWidth(baseH) / 2 - m.inset - c.width / 2, -baseH / 2 + m.inset + c.height / 2);
      this.badges.addChild(c);
    }
    if (revealedToOpponent) {
      const c = revealedEyeBadge(baseH);
      const at = revealedSpot(baseH);
      c.position.set(at.x, at.y);
      this.badges.addChild(c);
    }
  }

  /**
   * The per-frame ambient motion (see SICK_LOOP_MS): the sick Z's drift, a flyer hovers (`fly`), a sweep plays.
   * Called by the scene before apply(); `rim` lights the card's edge (battlefield cards). `under`: a copy stacked
   * under the top card of a group (layout.ts groupUnits) keeps its dimmed art but leaves the Z's to the top one.
   */
  ambient(now: number, mode: AmbientMode, fly: boolean, rim: boolean, baseH: number, under = false, labelMin = 0): void {
    const calm = mode === 'calm';
    this.floatY = fly ? flyOffset(this.id, now, calm) : 0;
    this.setRim(rim, baseH);
    this.zzz.visible = !under;
    if (this.sick && !under) {
      const loop = now / SICK_LOOP_MS + phaseOf(this.id);
      this.zzz.children.forEach((z, i) => {
        // Calm: the three stand still, spread along the path (a small static mark).
        const p = zPose(this.chromeH, i, calm ? 0.25 + i * 0.22 : loop + i / 3);
        z.position.set(p.x, p.y);
        z.scale.set(p.s);
        z.alpha = calm ? 0.55 : p.a;
      });
    }
    if (this.wakePending) {
      this.wakePending = false;
      if (!calm) this.sweep(now, 480, 'wake');
    }
    if (this.gainPending) {
      this.gainPending = false;
      if (!calm) this.sweep(now, 560, 'gain');
    }
    this.drawSweep(now);
    const press = this.kw?.trample && rim && !under ? pressAt(now, phaseOf(this.id), calm) : 0;
    if (press !== this.press || press > 0) drawDent(this.dent, baseH, press);
    this.press = press;
    if (this.kw && rim && !under) {
      this.chromeH = baseH;
      drawAmbientKeywords(this.kwG, this.sweepG, this.kw, baseH, phaseOf(this.id), now, calm);
      drawPressShade(this.kwG, baseH, press);
      this.kwOn = true;
    } else if (this.kwOn) {
      this.kwG.clear();
      this.kwOn = false;
    }
    this.ambientProtection(now, calm, rim && !under, baseH);
    // Snoozed: the veil and moon settle in, and melt away on waking (table/snoozeFx.ts).
    this.snooze.set(this.snoozed, now, calm);
    this.snooze.frame(now, baseH, calm, phaseOf(this.id), labelMin);
    this.snooze.view.visible &&= !under;
  }

  /** The shimmer aura of a hexproof or shroud card on the battlefield, and any flare over the card. */
  private ambientProtection(now: number, calm: boolean, field: boolean, baseH: number): void {
    const color = field ? auraColor(this.prot) : null;
    if (color !== null) {
      this.chromeH = baseH;
      drawAura(this.aura, color, baseH, phaseOf(this.id), now, calm);
      this.auraOn = true;
    } else if (this.auraOn) {
      this.aura.clear();
      this.auraOn = false;
    }
    const f = this.flareAt;
    if (!f) return;
    const dur = calm ? FLARE_MS.deny * 0.7 : FLARE_MS[f.kind];
    const p = (now - f.t0) / dur;
    if (p >= 1) {
      this.flareAt = null;
      this.flareG.clear();
    } else drawFlare(this.flareG, f.tone, f.kind, baseH, p, calm);
  }

  /**
   * Flash a protection flare over the card: `deny` a shield (an aimed spell is turned away by hexproof, shroud or
   * protection), `ward` the rune (a ward trigger has landed on the stack). The tone says which sigil.
   */
  flare(now: number, tone: FlareTone, kind: 'deny' | 'ward'): void {
    this.flareAt = { t0: now, tone, kind };
  }

  /** A light sweep across the card from `t0` (waking, untap ripple); a later one replaces it. */
  sweep(t0: number, dur: number, tone: SweepTone): void {
    this.sweepAt = { t0, dur: Math.max(1, dur), tone };
  }

  /** The sweep: a soft slanted band of light crossing the card left to right, clipped to the card. */
  private drawSweep(now: number): void {
    const s = this.sweepAt;
    this.sweepG.clear();
    if (!s || now < s.t0) return;
    const q = (now - s.t0) / s.dur;
    if (q >= 1) {
      this.sweepAt = null;
      return;
    }
    const { color, alpha } = SWEEP[s.tone];
    drawBand(this.sweepG, cardWidth(this.chromeH), this.chromeH, q, color, alpha);
  }

  /** The edge rim: a thin warm light line on the card's edge and a dark hairline just outside it (between layers). */
  private setRim(on: boolean, baseH: number): void {
    const key = on ? `${Math.round(baseH)}` : '';
    if (key === this.rimKey) return;
    this.rimKey = key;
    this.rim.clear();
    if (!on) return;
    this.chromeH = baseH;
    const u = baseH / 150;
    const w = cardWidth(baseH);
    const rr = (d: number) => this.rim.roundRect(-w / 2 - d, -baseH / 2 - d, w + 2 * d, baseH + 2 * d, w * 0.05 + d);
    rr(1.1 * u).stroke({ color: 0x050608, alpha: 0.55, width: 1.2 * u });
    rr(-0.55 * u).stroke({ color: 0xe9dfc8, alpha: 0.34, width: 1.3 * u });
  }

  /**
   * A hand card's adjusted cost, MTGA style: painted in the card's own cost slot over the printed pips, the same size
   * and style, on a plate the colour of the name bar (a scan's is sampled from it), with a green halo when cheaper
   * and a red one when dearer. A new cost pops in (the plate fades in, the pips scale up with a small overshoot) while
   * the old one fades out; `calm` (reduced motion) swaps at once. A size change alone (hover lift, drag) redraws in
   * place. `adjusted` is the prompt's `costs` entry for the card; nothing shows when it matches the printed cost.
   */
  setCost(adjusted: string | undefined, face: CardFace | undefined, baseH: number, now: number, calm = false): void {
    const kind: CostKind = this.showingFramed && face ? 'm15' : this.showingArt ? 'scan' : 'plain';
    const cost = costChip(adjusted, face?.manaCost) ? adjusted! : null;
    const key = cost ? `${cost}|${kind}` : '';
    const size = `${key}|${Math.round(baseH)}|${manaReady()}`;
    if (key !== this.costKey) {
      this.costOut?.destroy({ children: true, texture: true, textureSource: true });
      this.costOut = this.costIn;
      this.costIn = null;
      this.costKey = key;
      this.costT0 = calm ? -Infinity : now;
      if (calm && this.costOut) {
        this.costOut.destroy({ children: true, texture: true, textureSource: true });
        this.costOut = null;
      }
    }
    if (size !== this.costSize || (cost && !this.costIn)) {
      this.costSize = size;
      this.chromeH = baseH;
      this.costIn?.destroy({ children: true, texture: true, textureSource: true });
      this.costIn = cost ? this.buildCost(cost, face, baseH, kind) : null;
      if (this.costIn) this.costView.addChild(this.costIn);
    }
    this.costText = cost ?? '';
    this.costView.visible = this.showingFace;
    const t = now - this.costT0;
    if (this.costOut) {
      const q = Math.min(1, t / COST_OUT_MS);
      if (q >= 1) {
        this.costOut.destroy({ children: true, texture: true, textureSource: true });
        this.costOut = null;
      } else this.costOut.alpha = 1 - q * q;
    }
    if (this.costIn) {
      const [plate, pips] = this.costIn.children as [Container, Container];
      plate.alpha = Math.min(1, t / COST_PLATE_MS);
      pips.alpha = Math.min(1, t / COST_PLATE_MS);
      pips.scale.set(popScale(Math.min(1, t / COST_POP_MS)));
    }
  }

  /** The plate and the pips (two layers: only the pips pop), in chrome units for a card `baseH` tall. */
  private buildCost(cost: string, face: CardFace | undefined, baseH: number, kind: CostKind): Container {
    const w = cardWidth(baseH);
    const spec = costSpec(cost, face, w, baseH, kind, kind === 'scan' ? scanBar(this.faceTexture, isPwFrame(face)) : null);
    const { x0, y0, tw, th, kx, ky } = spec;
    const res = Math.min(4, 2 * (globalThis.devicePixelRatio || 1));
    const layer = (which: 'plate' | 'pips') => {
      const canvas = makeCanvas(Math.ceil(tw * kx * res), Math.ceil(th * ky * res));
      const ctx = canvas.getContext('2d')!;
      ctx.scale(res * kx, res * ky);
      ctx.translate(-x0, -y0);
      spec.paint(ctx, which);
      const sprite = new Sprite(toTexture(canvas));
      sprite.scale.set(1 / res);
      sprite.position.set(x0 * kx - w / 2, y0 * ky - baseH / 2);
      return sprite;
    };
    const c = new Container();
    c.label = 'cost';
    const back = new Container();
    back.addChild(layer('plate'));
    // The pips scale about their own centre.
    const cx = spec.pivot.x - w / 2;
    const cy = spec.pivot.y - baseH / 2;
    const pips = new Container();
    const sprite = layer('pips');
    sprite.position.x -= cx;
    sprite.position.y -= cy;
    pips.addChild(sprite);
    pips.position.set(cx, cy);
    c.addChild(back, pips);
    return c;
  }

  destroy(): void {
    this.chrome.destroy({ children: true });
    this.view.destroy({ children: true });
  }
}

/** A hand card's cost right now, when it differs from the printed one (prompt `costs`). */
export interface CostChip {
  text: string;
  cheaper: boolean;
}

/** The chip for an adjusted cost: "{2}{U}" reads "2U"; null when there is none or it matches the printed cost. */
export function costChip(adjusted: string | undefined, printed: string | undefined): CostChip | null {
  if (!adjusted || adjusted === printed) return null;
  return { text: adjusted.replace(/[{}]/g, '') || '0', cheaper: manaValue(adjusted) <= manaValue(printed) };
}

/** Which frame a changed cost is painted into: the plain procedural face, a Scryfall scan, or the M15 face (Framed art mode). */
export type CostKind = 'plain' | 'scan' | 'm15';

/** A changed cost's two layers for one card: where they are, and how to paint them. */
export interface CostSpec {
  /** Painter units → chrome units (1 for card px; the M15 frame paints in its 672×936 design grid). */
  kx: number;
  ky: number;
  /** The patch's box in painter units (reaching past the plate by a pip radius, for the tone halo). */
  x0: number;
  y0: number;
  tw: number;
  th: number;
  /** The centre of the new pips, in chrome units from the card's top-left (they pop about it). */
  pivot: { x: number; y: number };
  /** Paint a layer with the canvas already scaled by (kx, ky) and translated by (−x0, −y0) in painter units. */
  paint: (ctx: Ctx2D, layer: 'plate' | 'pips') => void;
}

/** The changed cost `cost` of `face` on a card `w`×`h` chrome units, for the frame `kind`; `bar` = a scan's sampled name-bar colour. */
export function costSpec(cost: string, face: CardFace | undefined, w: number, h: number, kind: CostKind, bar: RGB | null): CostSpec {
  const printed = face?.manaCost;
  if (kind === 'm15' && face) {
    const m = framedCard(face, undefined, null);
    const layout = layoutFor(m);
    const slot = costSlotOf(layout);
    const n = costPips(cost).length;
    const box = costPatchBox(layout, costPips(printed).length, n);
    const kx = w / M15_W;
    const ky = h / M15_H;
    const pad = slot.d / 2;
    const span = Math.max(0, n - 1) * slot.pitch + slot.d;
    const patch = { cost, tone: costTone(cost, printed) };
    return { kx, ky, x0: box.x - pad, y0: box.y - pad, tw: box.w + 2 * pad, th: box.h + 2 * pad, pivot: { x: (slot.right - span / 2) * kx, y: slot.cy * ky }, paint: (ctx, layer) => paintM15CostPatch(ctx, m, patch, layer) };
  }
  const art = kind === 'scan';
  const pw = isPwFrame(face);
  const plate: CostPlate = { cost, printed, tone: costTone(cost, printed), art, pw, bar: bar ?? nameBarFill(face) };
  const s = costSlot(w, art, pw);
  const b = costPlateBox(w, plate);
  const n = tokenizeMana(cost).length;
  return { kx: 1, ky: 1, x0: b.x - s.r, y0: b.y - s.r, tw: b.w + 2 * s.r, th: b.h + 2 * s.r, pivot: { x: s.right - (n * 2 * s.r + (n - 1) * s.gap) / 2, y: s.cy }, paint: (ctx, layer) => paintCostPlate(ctx, w, plate, layer) };
}

/** Cost change timing (ms): the plate fades in, the pips pop, the old cost fades out (ease-in). */
const COST_PLATE_MS = 120;
const COST_POP_MS = 220;
const COST_OUT_MS = 150;

/** The pips' pop: 0.6 → 1 with a small overshoot (ease-out-back), the physical-landing feel of the motion system. */
export function popScale(q: number): number {
  const c1 = 1.4;
  const e = 1 + (c1 + 1) * (q - 1) ** 3 + c1 * (q - 1) ** 2;
  return 0.6 + 0.4 * e;
}

/** Name-bar colours sampled from scans, by image. */
const scanBars = new WeakMap<object, RGB>();

/** A scan's name-bar colour by its cost (sampled once per scan). */
function scanBar(tex: Texture | null, pw: boolean): RGB {
  const img = tex?.source.resource as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width) return SCAN_BAR;
  let c = scanBars.get(img);
  if (!c) {
    c = sampleCostBar(img, img.width, img.height, pw);
    scanBars.set(img, c);
  }
  return c;
}

/** The Mana font's symbol for a counter kind ("+1/+1", "Charge", "Time"…), or null (the chip then says it in words). */
export function counterIcon(name: string): string | null {
  if (!manaReady()) return null;
  const k = name.toUpperCase();
  const key = k === '+1/+1' || k === 'P1P1' ? 'plus' : k === '-1/-1' || k === 'M1M1' ? 'minus' : k.toLowerCase();
  return msGlyph(`counter-${key}`);
}

/**
 * A counter as a coin on the M15 frame: its Mana-font symbol ("+1/+1", "Charge"…, or a keyword counter's ability symbol:
 * a flying counter shows the flying symbol; oil and poison the Phyrexian one), else the kind's initial; +1/+1 and -1/-1 tinted.
 */
export function frameCounter(name: string, n: number): M15Counter {
  const k = name.toUpperCase();
  const plus = k === '+1/+1' || k === 'P1P1';
  const minus = k === '-1/-1' || k === 'M1M1';
  const key = name.toLowerCase().replace(/[_\s]+/g, '-');
  // Oil and poison have no counter symbol of their own: the Phyrexian one.
  const phyrexian = key === 'oil' || key === 'poison';
  const glyph = !manaReady() ? null : plus ? msGlyph('counter-plus') : minus ? msGlyph('counter-minus') : phyrexian ? msGlyph('p') : (msGlyph(`counter-${key}`) ?? msGlyph(`ability-${key}`));
  return { glyph, letter: (name.match(/[a-z]/i)?.[0] ?? '?').toUpperCase(), count: n, tone: plus ? 'plus' : minus ? 'minus' : 'plain' };
}

/** A counter badge's text. Keys are Forge CounterType names as sent ("+1/+1", "Loyalty", "Charge"…). */
export function counterLabel(name: string, n: number): string {
  switch (name) {
    // The counter and how many, never a sum: "+2/+2" read as the card's total boost (Llanowar Elves at 7/7).
    case '+1/+1':
    case 'P1P1':
      return n > 1 ? `+1/+1 ×${n}` : '+1/+1';
    case '-1/-1':
    case 'M1M1':
      return n > 1 ? `−1/−1 ×${n}` : '−1/−1';
    case 'Loyalty':
    case 'LOYALTY':
      return `${n}`;
    default:
      return `${n} ${name.charAt(0)}${name.slice(1).toLowerCase()}`;
  }
}

interface BadgeSpec {
  kind: BadgeKind;
  text: string;
  icon?: string | null;
  fill: number;
  stroke: number;
  ink: string | number;
}

export type BadgeKind = 'pt' | 'damage' | 'counter';

/** Where a badge goes: its centre in card units (origin at the card's centre) and a shrink factor to fit. */
export interface BadgePlace {
  x: number;
  y: number;
  scale: number;
}

/** Height of a badge pill and the gaps around it, for a card `baseH` tall. */
export function badgeMetrics(baseH: number): { h: number; inset: number; gap: number; bottom: number } {
  const u = baseH / 150;
  // The pills' bottom edge sits at 92% of the card: over the printed P/T box, clear of the bottom strip (artist,
  // copyright).
  return { h: 21 * u, inset: 4 * u, gap: 2 * u, bottom: baseH * 0.42 - u }; // less the outline
}

/**
 * Places badges inside a card `baseH` tall. The right column holds the P/T chip at the bottom (over the printed P/T
 * box; with no chip that spot stays free so the face's own P/T shows) and damage above it; counters go up from the
 * bottom-left, each shrunk if it would run into the right column. Nothing is ever wider than the card.
 */
export function badgeLayout(baseH: number, badges: Array<{ kind: BadgeKind; w: number }>): BadgePlace[] {
  const w = cardWidth(baseH);
  const m = badgeMetrics(baseH);
  const rowY = (row: number) => m.bottom - m.h / 2 - row * (m.h + m.gap);
  const full = w - 2 * m.inset;
  // Widths taken on the right, by row: the P/T box (or the chip over it), then damage.
  const right: number[] = [w * PT_BOX];
  const out: BadgePlace[] = badges.map(() => ({ x: 0, y: 0, scale: 1 }));
  badges.forEach((b, i) => {
    if (b.kind === 'counter') return;
    const row = b.kind === 'pt' ? 0 : 1;
    const scale = Math.min(1, full / b.w);
    right[row] = Math.max(right[row] ?? 0, b.w * scale);
    out[i] = { x: w / 2 - m.inset - (b.w * scale) / 2, y: rowY(row), scale };
  });
  let row = 0;
  badges.forEach((b, i) => {
    if (b.kind !== 'counter') return;
    const room = right[row] !== undefined ? full - right[row]! - m.gap * 2 : full;
    const scale = Math.min(1, Math.max(0.1, room) / b.w);
    out[i] = { x: -w / 2 + m.inset + (b.w * scale) / 2, y: rowY(row), scale };
    row++;
  });
  return out;
}

/** The printed P/T box's width, as a share of the card's (it is kept clear even without a chip). */
const PT_BOX = 0.24;

/** One of summoning sickness's drifting Z's (ambient() moves it): small, soft, outlined so it reads on any art. */
function zGlyph(u: number, i: number): Text {
  const z = new Text({
    text: 'z',
    style: { fontFamily: fonts.ui, fontWeight: '800', fontStyle: 'italic', fontSize: (15 + i * 3) * u, fill: 0xe4ecff, stroke: { color: 0x0d0f13, width: 3 * u, join: 'round' } },
    resolution: 2,
  });
  z.anchor.set(0.5);
  return z;
}

/** Counters, damage and ×N painted as M15 frame elements (paintM15Marks): a sprite over a card `baseH` tall. */
function marksSprite(m: M15Card, marks: M15Marks, baseH: number): Sprite {
  const w = cardWidth(baseH);
  const res = Math.min(4, 2 * (globalThis.devicePixelRatio || 1));
  const canvas = makeCanvas(Math.ceil(w * res), Math.ceil(baseH * res));
  const ctx = canvas.getContext('2d')!;
  ctx.scale((w * res) / M15_W, (baseH * res) / M15_H);
  paintM15Marks(ctx, m, marks);
  const sprite = new Sprite(toTexture(canvas));
  sprite.scale.set(1 / res);
  sprite.position.set(-w / 2, -baseH / 2);
  sprite.label = 'marks';
  return sprite;
}

/** A pill badge centred on its origin: dark fill, a coloured outline, bold numerals. */
function pill(text: string, fill: number, stroke: number, ink: string | number, fontSize: number, u: number, mana = false, icon: string | null = null): Container {
  const c = new Container();
  const label = new Text({
    text,
    style: mana ? { fontFamily: MANA_FONT, fontSize: fontSize * 0.95, fill: ink, letterSpacing: 1.5 * u } : { fontFamily: fonts.numeral, fontWeight: '700', fontSize, fill: ink },
    resolution: 2,
  });
  label.anchor.set(0.5);
  // A counter's Mana-font symbol before its number (use the font wherever it helps).
  const mark = icon ? new Text({ text: icon, style: { fontFamily: MANA_FONT, fontSize: fontSize * 1.05, fill: table.brass }, resolution: 2 }) : null;
  const gap = mark ? 3 * u : 0;
  const inner = label.width + (mark ? mark.width + gap : 0);
  if (mark) {
    mark.anchor.set(0.5);
    mark.x = -inner / 2 + mark.width / 2;
    label.x = mark.x + mark.width / 2 + gap + label.width / 2;
  }
  const h = 21 * u;
  const w = Math.max(h + 4 * u, inner + 12 * u);
  const g = new Graphics()
    .roundRect(-w / 2, -h / 2, w, h, h / 2)
    .fill({ color: fill, alpha: 0.94 })
    .stroke({ color: stroke, width: 1.5 * u });
  c.addChild(g, label);
  if (mark) c.addChild(mark);
  return c;
}

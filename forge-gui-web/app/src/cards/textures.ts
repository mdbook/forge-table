/**
 * Card textures for the table: each (face content, resolution) is painted once with the procedural
 * painter and cached. The back and the shadow are shared.
 *
 * Real art: when the art loader has a card's image key ready, `face()` returns a texture made straight from
 * its corner-rounded bitmap (one GPU texture per key, at the scan's own resolution with mipmaps, never
 * upscaled to the procedural size). Until then, and whenever art is off, it returns the procedural face.
 *
 * Framed art ('frame' mode): the face is the M15 frame (cards/m15) drawn once its fonts are loaded, with the card's art
 * crop in the art window and the artist credited once the crop is ready (a quiet placeholder panel until then, or if it
 * never comes). Until the fonts are in (or if they never load) it is the plain procedural face, which is also what a
 * crop loader that is off ('frame' mode not selected) gets.
 */
import { knownFace } from '../store/model';
import { CanvasSource, ImageSource, Texture } from 'pixi.js';
import type { Card, CardFace } from '@forge-table/protocol';
import { CARD_ASPECT } from '../layout/geometry';
import type { ArtLoader } from './art';
import { faceKey, paintCardBack, paintCardFace } from './face';
import { loadM15Fonts, m15FontsReady } from './m15/fonts';
import { framedAbility, framedCard, framedKey } from './m15/framed';
import { paintM15Face } from './m15/paint';
import { paintAbilityFace } from './abilityFace';
import type { AbilityFace } from '../layout/stack';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * @param mipmaps Off for a card face: the same texture is shared by a sprite at the hand's size and one at
 * the battlefield's, and a fanned hand card draws at ~0.5-0.8× it, rotated, and trilinear sampling there blends mip 0
 * with mip 1's box-filtered downsample, smearing the M15 frame's thin rules text. A card face reads better a touch
 * aliased small (battlefield) than blurred large (hand); everything else here (the back, the shadow, the glow) keeps
 * its mipmaps, drawn at one steady size.
 */
export function toTexture(canvas: HTMLCanvasElement, mipmaps = true): Texture {
  const source = new CanvasSource({
    resource: canvas,
    autoGenerateMipmaps: mipmaps,
    scaleMode: 'linear',
    antialias: true,
  });
  return new Texture({ source });
}

/**
 * The glow texture's card width, blur pad and blur (px on a 160-wide card). Selection clarity (2026-10): tighter and
 * brighter: was pad 36 / blur 24 / 2 passes; now pad 20 / blur 10 / 3 passes.
 */
export const GLOW_W = 160;
export const GLOW_PAD = 20;
export const GLOW_BLUR = 10;

/** What CardTextures needs from the art loader. */
export type ArtSource = Pick<ArtLoader, 'get'>;
/** ...and from the art-crop loader. */
export type CropSource = Pick<ArtLoader, 'get' | 'artist'> & { enabled?: boolean };

/** An ability card's text runs up to 1.2× a card's (chosen), its leading to match: the text is what the card is for. */
const ABILITY_RULES_FIT = { max: 40, lineBase: 21.8 };

export class CardTextures {
  private readonly faces = new Map<string, Texture>();
  /** Real-art textures by image key, and the bitmap each was made from (a re-decode makes a new one). */
  private readonly arts = new Map<string, { bitmap: ImageBitmap; texture: Texture }>();
  private readonly artTextures = new WeakSet<Texture>();
  private readonly framed = new WeakSet<Texture>();
  private fontsAsked = false;
  /** Called when the M15 fonts have loaded, so faces painted with the plain procedural fallback meanwhile can be redone. */
  onFonts: (() => void) | null = null;
  private backTex: Texture | null = null;
  private shadowTex: Texture | null = null;
  private glowTex: Texture | null = null;
  readonly heightPx: number;
  readonly widthPx: number;

  /** @param heightPx texture height; cards are drawn at this resolution and scaled on the table. */
  constructor(
    heightPx = 352,
    private readonly art: ArtSource | null = null,
    private readonly crops: CropSource | null = null,
  ) {
    this.heightPx = heightPx;
    this.widthPx = Math.round(heightPx * CARD_ASPECT);
  }

  /** The face texture for a card's current state (or null for a card with no visible face). */
  face(card: Card | undefined): Texture | null {
    const face = knownFace(card);
    if (!face) return null;
    const art = this.artFor(face.imageKey);
    if (art) return art;
    const bitmap = face.imageKey && this.crops ? this.crops.get(face.imageKey) : null;
    const crop = bitmap ? { bitmap, artist: this.crops!.artist(face.imageKey) } : undefined;
    // Framed art mode: the M15 face, art or not (its own placeholder panel until the crop comes), once its fonts are in.
    if (this.crops?.enabled) {
      if (m15FontsReady()) return this.framedFace(face, card, crop);
      this.loadFonts();
    }
    const key = faceKey(face, card, crop ? face.imageKey : undefined);
    let tex = this.faces.get(key);
    if (!tex) {
      const canvas = makeCanvas(this.widthPx, this.heightPx);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      paintCardFace(ctx, this.widthPx, this.heightPx, { face, card, crop });
      tex = toTexture(canvas, false);
      this.faces.set(key, tex);
    }
    return tex;
  }

  /** The M15 face for a card, painted once per (face content, art, resolution). */
  private framedFace(face: CardFace, card: Card | undefined, crop: { bitmap: ImageBitmap; artist: string | null } | undefined): Texture | null {
    const key = framedKey(face, card, crop ? face.imageKey : undefined, crop?.artist);
    let tex = this.faces.get(key);
    if (!tex) {
      const canvas = makeCanvas(this.widthPx, this.heightPx);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      paintM15Face(ctx, framedCard(face, card, crop?.artist), { width: this.widthPx, height: this.heightPx, art: crop?.bitmap ?? null });
      tex = toTexture(canvas, false);
      this.faces.set(key, tex);
      this.framed.add(tex);
    }
    return tex;
  }

  /** Start loading the M15 fonts (once); the owner is told when they are in, to repaint the faces drawn without them. */
  private loadFonts(): void {
    if (this.fontsAsked) return;
    this.fontsAsked = true;
    void loadM15Fonts().then(() => this.onFonts?.());
  }

  /** Whether a texture is an M15 face (its cost slot and P/T plate are the M15 frame's: cards/m15/layouts.ts). */
  isFramed(tex: Texture | null | undefined): boolean {
    return !!tex && this.framed.has(tex);
  }

  /**
   * An ability card's face (cards/abilityFace.ts): the ability's text over its source's art, the scan once it is
   * loaded. Cached by what it shows, like the procedural faces.
   */
  ability(face: AbilityFace, source: Card | undefined): Texture | null {
    const key = source?.state?.imageKey;
    if (this.crops?.enabled && m15FontsReady()) return this.framedAbility(face, source, key);
    const bitmap = key && this.art ? this.art.get(key) : null;
    const id = `ability|${face.kind}|${face.name}|${face.text}|${source?.state ? faceKey(source.state, source) : '-'}|${bitmap ? key : ''}`;
    let tex = this.faces.get(id);
    if (!tex) {
      const canvas = makeCanvas(this.widthPx, this.heightPx);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      paintAbilityFace(ctx, this.widthPx, this.heightPx, face, source, bitmap);
      tex = toTexture(canvas, false);
      this.faces.set(id, tex);
    }
    return tex;
  }

  /** Framed mode's ability card: the M15 frame of its source (cards/m15/framed.ts framedAbility), its art crop once it is in. */
  private framedAbility(face: AbilityFace, source: Card | undefined, key: string | undefined): Texture | null {
    const bitmap = key ? this.crops!.get(key) : null;
    const artist = bitmap ? this.crops!.artist(key!) : null;
    const id = `m15ability|${face.kind}|${face.name}|${face.text}|${source?.state ? faceKey(source.state, source) : '-'}|${bitmap ? key : ''}|${artist ?? ''}`;
    let tex = this.faces.get(id);
    if (!tex) {
      const canvas = makeCanvas(this.widthPx, this.heightPx);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      paintM15Face(ctx, framedAbility(face, source, artist), { width: this.widthPx, height: this.heightPx, art: bitmap ?? null, rulesFit: ABILITY_RULES_FIT, rulesTop: true });
      tex = toTexture(canvas, false);
      this.faces.set(id, tex);
    }
    return tex;
  }

  /** Whether a texture is a real card scan (the P/T chip and the image-treatment rule depend on it). */
  isArt(tex: Texture | null | undefined): boolean {
    return !!tex && this.artTextures.has(tex);
  }

  private artFor(key: string | undefined): Texture | null {
    if (!key || !this.art) return null;
    const bitmap = this.art.get(key);
    if (!bitmap) return null;
    const have = this.arts.get(key);
    if (have && have.bitmap === bitmap) return have.texture;
    have?.texture.destroy(true);
    const source = new ImageSource({
      resource: bitmap,
      autoGenerateMipmaps: true,
      scaleMode: 'linear',
      antialias: true,
    });
    const texture = new Texture({ source });
    this.arts.set(key, { bitmap, texture });
    this.artTextures.add(texture);
    return texture;
  }

  back(): Texture {
    if (!this.backTex) {
      const canvas = makeCanvas(this.widthPx, this.heightPx);
      const ctx = canvas.getContext('2d')!;
      paintCardBack(ctx, this.widthPx, this.heightPx);
      this.backTex = toTexture(canvas);
    }
    return this.backTex;
  }

  /** A soft drop shadow for a card, padded so its blur fits; draw it 1.25× the card size. */
  shadow(): Texture {
    if (!this.shadowTex) {
      const w = 160;
      const h = Math.round(w / CARD_ASPECT);
      const pad = 40;
      const canvas = makeCanvas(w + pad * 2, h + pad * 2);
      const ctx = canvas.getContext('2d')!;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 26;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      ctx.roundRect(pad, pad, w, h, w * 0.05);
      ctx.fill();
      this.shadowTex = toTexture(canvas);
    }
    return this.shadowTex;
  }

  /**
   * A soft white halo around a card's outline with the card area cut out, so it only ever lights the table
   * around the card (tinted ember for "playable"). Same geometry as the shadow: draw it at
   * (GLOW_W + 2·GLOW_PAD) / GLOW_W × the card width.
   */
  glow(): Texture {
    if (!this.glowTex) {
      const w = GLOW_W;
      const h = Math.round(w / CARD_ASPECT);
      const pad = GLOW_PAD;
      const canvas = makeCanvas(w + pad * 2, h + pad * 2);
      const ctx = canvas.getContext('2d')!;
      // Only the blur outside the card's own outline survives: a soft falloff, no solid edge line.
      ctx.shadowColor = 'rgba(255,255,255,1)';
      ctx.shadowBlur = GLOW_BLUR;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(pad, pad, w, h, w * 0.045);
      ctx.fill();
      ctx.fill();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.roundRect(pad, pad, w, h, w * 0.045);
      ctx.fill();
      this.glowTex = toTexture(canvas);
    }
    return this.glowTex;
  }

  get faceCount(): number {
    return this.faces.size;
  }

  get artCount(): number {
    return this.arts.size;
  }

  clear(): void {
    for (const t of this.faces.values()) t.destroy(true);
    this.faces.clear();
    // The bitmaps belong to the art loader: destroying a texture source frees the GPU copy, never the bitmap.
    for (const a of this.arts.values()) a.texture.destroy(true);
    this.arts.clear();
  }
}

/**
 * The comparison harness's page side (app/m15-compare.html, driven by tests/scripts/m15-compare.ts): renders a Scryfall
 * card JSON + art crop with paintM15Face at the scan's 672×936, lays it beside the reference scan with a diff heat map,
 * and scores the difference outside the art window. Dev tool only.
 */
import '@fontsource-variable/inter';
import { loadM15Fonts } from './fonts';
import { M15_H, M15_W, type Rect } from './geometry';
import { fromScryfall, type ScryfallCard } from './model';
import { layoutFor } from './layouts';
import { paintM15Face } from './paint';

export interface CompareResult {
  /** Mean absolute channel difference (0–255) over everything outside the art window. */
  mad: number;
  /** The same on 8× downsampled images (tolerant of text and noise: frame and colour structure). */
  mad8: number;
  /** [reference | ours | diff] as a PNG data URL. */
  sheet: string;
  /** Ours alone, on black. */
  ours: string;
}

async function bitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function canvas(w: number, h: number): HTMLCanvasElement {
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
}

function heat(v: number): [number, number, number] {
  // 0 black, then red, yellow, white.
  const t = Math.min(1, v / 96);
  return [Math.min(255, t * 3 * 255), Math.min(255, Math.max(0, t * 3 - 1) * 255), Math.min(255, Math.max(0, t * 3 - 2) * 255)];
}

function mad(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, skip: Rect | null): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skip && x >= skip.x && x < skip.x + skip.w && y >= skip.y && y < skip.y + skip.h) continue;
      const i = (y * w + x) * 4;
      sum += (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 3;
      n++;
    }
  }
  return sum / n;
}

function down(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const c = canvas(Math.round(src.width / k), Math.round(src.height / k));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function renderOurs(json: ScryfallCard, art: ImageBitmap, w = M15_W, h = M15_H): Promise<HTMLCanvasElement> {
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  paintM15Face(g, fromScryfall(json), { width: w, height: h, art, artSize: { w: art.width, h: art.height } });
  return c;
}

async function compare(json: ScryfallCard, cropUrl: string, refUrl: string): Promise<CompareResult> {
  const [art, ref] = await Promise.all([bitmap(cropUrl), bitmap(refUrl)]);
  const ours = await renderOurs(json, art);
  const refC = canvas(M15_W, M15_H);
  refC.getContext('2d')!.drawImage(ref, 0, 0, M15_W, M15_H);
  const a = pixels(refC);
  const b = pixels(ours);
  const geo = layoutFor(fromScryfall(json)).geo.art;
  const skip: Rect = { x: geo.x - 3, y: geo.y - 3, w: geo.w + 6, h: geo.h + 6 };
  const sheet = canvas(M15_W * 3, M15_H);
  const sg = sheet.getContext('2d')!;
  sg.drawImage(refC, 0, 0);
  sg.drawImage(ours, M15_W, 0);
  const diff = sg.createImageData(M15_W, M15_H);
  for (let i = 0; i < diff.data.length; i += 4) {
    const d = (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 3;
    const [r, g, bl] = heat(d);
    diff.data[i] = r;
    diff.data[i + 1] = g;
    diff.data[i + 2] = bl;
    diff.data[i + 3] = 255;
  }
  sg.putImageData(diff, M15_W * 2, 0);
  // The art window is out of the score: grey it in the heat map.
  sg.fillStyle = 'rgba(80,80,160,0.35)';
  sg.fillRect(M15_W * 2 + skip.x, skip.y, skip.w, skip.h);
  const r8 = down(refC, 8);
  const o8 = down(ours, 8);
  const k = 8;
  const s8: Rect = { x: Math.floor(skip.x / k), y: Math.floor(skip.y / k), w: Math.ceil(skip.w / k), h: Math.ceil(skip.h / k) };
  return {
    mad: mad(a, b, M15_W, M15_H, skip),
    mad8: mad(pixels(r8), pixels(o8), r8.width, r8.height, s8),
    sheet: sheet.toDataURL('image/png'),
    ours: ours.toDataURL('image/png'),
  };
}

/** A contact sheet: `images` (data URLs, all the same size) in `cols` columns, each scaled by `scale`. */
async function contact(images: string[], cols: number, scale: number): Promise<string> {
  const bms = await Promise.all(images.map(bitmap));
  const w = Math.round(bms[0]!.width * scale);
  const h = Math.round(bms[0]!.height * scale);
  const rows = Math.ceil(bms.length / cols);
  const c = canvas(w * cols, h * rows);
  const g = c.getContext('2d')!;
  g.fillStyle = '#222';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  bms.forEach((b, i) => g.drawImage(b, (i % cols) * w, Math.floor(i / cols) * h, w, h));
  return c.toDataURL('image/png');
}

/** Ours at an arbitrary size (a scaling sanity check), as a PNG data URL. */
async function oursAt(json: ScryfallCard, cropUrl: string, w: number, h: number): Promise<string> {
  const art = await bitmap(cropUrl);
  return (await renderOurs(json, art, w, h)).toDataURL('image/png');
}

declare global {
  interface Window {
    __m15: { ready: boolean; compare: typeof compare; contact: typeof contact; oursAt: typeof oursAt };
  }
}

window.__m15 = { ready: false, compare, contact, oursAt };
void loadM15Fonts().then(() => document.fonts.ready).then(() => {
  window.__m15.ready = true;
});

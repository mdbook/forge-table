/**
 * A card face (or the Kiln back) painted into a DOM canvas, for overlays and the preview. When the card's
 * real art is ready it is drawn instead (re-rendering when it arrives): the whole scan, scaled to fit, with
 * only its corners rounded, never cropped, tinted or covered. In 'frame' art mode the M15 face is painted
 * with the card's art crop in its art window instead (re-rendering when the crop and the M15 fonts arrive; the plain
 * procedural face stands in until the fonts are in): the same as the table (cards/textures.ts).
 */
import { knownFace } from '../store/model';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Card, CardFace } from '@forge-table/protocol';
import { CARD_ASPECT, CARD_RADIUS } from '../layout/geometry';
import { useUi } from '../store/uiStore';
import { costTone, faceKey, isPwFrame, nameBarFill, paintCardBack, paintCardFace, paintCostPlate, paintStruckCost, sampleCostBar, type Ctx2D } from './face';
import { cropArt } from './art';
import { loadM15Fonts, m15FontsReady } from './m15/fonts';
import { framedCard, framedKey } from './m15/framed';
import { M15_H, M15_W } from './m15/geometry';
import { costSlotPx, layoutFor } from './m15/layouts';
import { paintM15CostPatch, paintM15Face } from './m15/paint';
import { useCardArt } from './useCardArt';

export interface CardFaceViewProps {
  card?: Card | undefined;
  /** A face without a card object (inline `cardData`). */
  face?: CardFace | undefined;
  /** CSS px. */
  height: number;
  /**
   * The card's cost right now (prompt `costs`): when it differs from the printed one it is painted in the cost slot,
   * as on the table, with the printed cost small and struck through under it.
   */
  cost?: string | undefined;
}

/** Draw a card scan into a w×h canvas with the card's rounded corners. */
export function drawArt(ctx: Ctx2D, bmp: ImageBitmap, w: number, h: number): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, w * CARD_RADIUS);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  ctx.restore();
}

export function CardFaceView({ card, face, height, cost }: CardFaceViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const test = useUi((s) => s.test);
  const dpr = test ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const f = face ?? knownFace(card);
  const art = useCardArt(f?.imageKey);
  const cropBitmap = useCardArt(f?.imageKey, cropArt);
  const crop = cropBitmap ? { bitmap: cropBitmap, artist: cropArt.artist(f?.imageKey) } : undefined;
  const width = Math.round(height * CARD_ASPECT);
  // Framed art mode draws the M15 face (as the table does) once its fonts are in; until then, the procedural one.
  useUi((s) => s.artMode);
  const [, fontsIn] = useState(0);
  const framed = cropArt.enabled && !art;
  useEffect(() => {
    if (framed && !m15FontsReady()) void loadM15Fonts().then(() => fontsIn((n) => n + 1));
  }, [framed]);
  const m15 = framed && m15FontsReady();
  const key = f ? (m15 ? framedKey(f, card, crop ? f.imageKey : undefined, crop?.artist) : faceKey(f, card, crop ? f.imageKey : undefined)) : 'back';
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (f && art) drawArt(ctx, art, c.width, c.height);
    else if (f && m15) paintM15Face(ctx, framedCard(f, card, crop?.artist), { width: c.width, height: c.height, art: crop?.bitmap ?? null });
    else if (f) paintCardFace(ctx, c.width, c.height, { face: f, card, crop });
    else paintCardBack(ctx, c.width, c.height);
    if (f && cost && cost !== f.manaCost) {
      const tone = costTone(cost, f.manaCost);
      if (m15) {
        const m = framedCard(f, card, null);
        ctx.save();
        ctx.scale(c.width / M15_W, c.height / M15_H);
        paintM15CostPatch(ctx, m, { cost, tone });
        ctx.restore();
        paintStruckCost(ctx, c.width, { printed: f.manaCost, art: false, pw: false, slot: costSlotPx(layoutFor(m), c.width, c.height) });
      } else {
        const pw = isPwFrame(f);
        const bar = art ? sampleCostBar(art, art.width, art.height, pw) : nameBarFill(f);
        paintCostPlate(ctx, c.width, { cost, printed: f.manaCost, tone, art: !!art, pw, bar });
        paintStruckCost(ctx, c.width, { printed: f.manaCost, art: !!art, pw });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height, dpr, art, cost]);
  return (
    <canvas
      ref={ref}
      width={Math.round(width * dpr)}
      height={Math.round(height * dpr)}
      style={{ width: `${width}px`, height: `${height}px` }}
    />
  );
}

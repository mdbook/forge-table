/**
 * One option of a choice drawn as a card (overlays/optionFaces.ts): the source card's M15 frame, name, cost, type line
 * and art, with only the option's text in the box. The art is the crop (Framed), the scan's art box (Scans) or the
 * procedural face's art panel (Drawn), so it reads the same in every art mode. Until the M15 fonts are in, the
 * procedural face with the option's text stands in.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '@forge-table/protocol';
import { CARD_ASPECT } from '../layout/geometry';
import { useUi } from '../store/uiStore';
import { ART_CROP, artCrop } from './abilityFace';
import { cardArt, cropArt } from './art';
import { paintCardFace } from './face';
import { loadM15Fonts, m15FontsReady } from './m15/fonts';
import { framedOption } from './m15/framed';
import { paintM15Face } from './m15/paint';
import { useCardArt } from './useCardArt';

/** An option's few lines set larger than a full rules box, as the stack's ability cards are. */
const OPTION_RULES_FIT = { max: 52, lineBase: 26 };
/** The art box's own shape (cards/abilityFace.ts ART_CROP on a 63×88 card). */
const ART_BOX_ASPECT = (ART_CROP.w * 63) / (ART_CROP.h * 88);

/**
 * A card's art `w` px wide at `aspect` (width / height), cut from the middle: its crop when Framed art is on, else the
 * art box of its scan, else of its procedural face. Null without a known face.
 */
export function useArtBox(card: Card | undefined, aspect: number, w: number): HTMLCanvasElement | null {
  const key = card?.state?.imageKey;
  const crop = useCardArt(key, cropArt);
  const scan = useCardArt(key, cardArt);
  const state = card?.state;
  return useMemo(() => {
    if (!state || typeof document === 'undefined' || w <= 0) return null;
    let src: { img: CanvasImageSource; sx: number; sy: number; sw: number; sh: number } | null;
    if (crop) {
      // Cover: the middle of the crop at the box's shape.
      const sw = Math.min(crop.width, crop.height * aspect);
      const sh = sw / aspect;
      src = { img: crop, sx: (crop.width - sw) / 2, sy: (crop.height - sh) / 2, sw, sh };
    } else src = artCrop(card, scan, aspect, Math.max(252, Math.round(w / ART_CROP.w)));
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = Math.round(w);
    c.height = Math.round(w / aspect);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, 0, 0, c.width, c.height);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, crop, scan, aspect, w]);
}

export function OptionCardView({ card, text, cost, height }: { card: Card; text: string; cost?: string | undefined; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const test = useUi((s) => s.test);
  const dpr = test || typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(height * CARD_ASPECT);
  const face = card.state!;
  const crop = useCardArt(face.imageKey, cropArt);
  const box = useArtBox(card, ART_BOX_ASPECT, Math.round(width * dpr));
  const [fonts, setFonts] = useState(m15FontsReady());
  useEffect(() => {
    if (!fonts) void loadM15Fonts().then(() => setFonts(m15FontsReady()));
  }, [fonts]);
  useLayoutEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (fonts) {
      const m = framedOption(face, card, text, cost, crop ? cropArt.artist(face.imageKey) : null);
      paintM15Face(ctx, m, { width: c.width, height: c.height, art: crop ?? box, rulesFit: OPTION_RULES_FIT });
    } else paintCardFace(ctx, c.width, c.height, { face: { ...face, oracleText: text, ...(cost !== undefined ? { manaCost: cost } : {}) }, card });
  }, [face, card, text, cost, fonts, crop, box, height, dpr]);
  return <canvas ref={ref} width={Math.round(width * dpr)} height={Math.round(height * dpr)} style={{ width: `${width}px`, height: `${height}px` }} />;
}

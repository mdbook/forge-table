/** A card's art crop drawn cover-fit into a small canvas (keyed by name), or its first letters while it loads. */
import { useEffect, useRef } from 'react';
import { cropArt } from './art';
import { useCardArt } from './useCardArt';

export function CropArt({ name, className, width = 96, height = 70 }: { name: string; className: string; width?: number; height?: number }) {
  const bmp = useCardArt(`c:${name}`, cropArt);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !bmp) return;
    // Cover: fill the box, crop the overflow from the middle.
    const s = Math.max(c.width / bmp.width, c.height / bmp.height);
    const w = bmp.width * s;
    const h = bmp.height * s;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }, [bmp]);
  return bmp ? <canvas ref={ref} className={className} width={width} height={height} /> : <span className={`${className} art-none`}>{name.slice(0, 2)}</span>;
}

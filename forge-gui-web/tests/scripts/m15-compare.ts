/**
 * Renders the M15 card painter in a real browser canvas against reference Scryfall scans and writes, per card, a
 * [reference | ours | diff heat map] PNG plus contact sheets, printing a similarity score per card.
 *
 * Needs the Vite dev server for app/ (page app/m15-compare.html) and Chromium; run it in the Playwright image:
 *
 *   (cd app && npx vite --port 5195 --host 127.0.0.1)                       # on the host, in the background
 *   docker run --rm --network host -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":"$PWD" -v <refs>:<refs> -w "$PWD/tests" \
 *     mcr.microsoft.com/playwright:v1.56.1-noble node scripts/m15-compare.ts <refs> <out> [roundLabel] [baseUrl]
 *
 * <refs> holds NN.jpg (scan), NN.json (Scryfall card) and NN-crop.jpg (art crop) for NN = 01…; <out> gets
 * NN-compare.png, NN-ours.png, contact.png, contact-pairs.png and one line per card appended to scores.log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const refs = path.resolve(process.argv[2] ?? '.');
const out = path.resolve(process.argv[3] ?? path.join(refs, 'out'));
const round = process.argv[4] ?? 'run';
const base = process.argv[5] ?? 'http://127.0.0.1:5195';
mkdirSync(out, { recursive: true });

const dataUrl = (file: string) => `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
const png = (url: string) => Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');

interface Result {
  mad: number;
  mad8: number;
  sheet: string;
  ours: string;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
  await page.goto(`${base}/m15-compare.html`);
  await page.waitForFunction(() => (window as unknown as { __m15?: { ready: boolean } }).__m15?.ready === true, undefined, { timeout: 60_000 });

  const ids: string[] = [];
  for (let i = 1; existsSync(path.join(refs, `${String(i).padStart(2, '0')}.json`)); i++) ids.push(String(i).padStart(2, '0'));
  const ours: string[] = [];
  const refImgs: string[] = [];
  const rows: string[] = [];
  let sumMad = 0;
  let sumMad8 = 0;
  for (const id of ids) {
    const json = JSON.parse(readFileSync(path.join(refs, `${id}.json`), 'utf8')) as { name: string };
    const cropUrl = dataUrl(path.join(refs, `${id}-crop.jpg`));
    const refUrl = dataUrl(path.join(refs, `${id}.jpg`));
    const r = (await page.evaluate(([j, c, f]) => (window as unknown as { __m15: { compare: (...a: unknown[]) => Promise<unknown> } }).__m15.compare(j, c, f), [json, cropUrl, refUrl] as const)) as Result;
    writeFileSync(path.join(out, `${id}-compare.png`), png(r.sheet));
    writeFileSync(path.join(out, `${id}-ours.png`), png(r.ours));
    ours.push(r.ours);
    refImgs.push(refUrl);
    sumMad += r.mad;
    sumMad8 += r.mad8;
    rows.push(`${id} ${json.name.padEnd(28)} mad=${r.mad.toFixed(2)} mad8=${r.mad8.toFixed(2)} sim=${(100 - (r.mad / 255) * 100).toFixed(2)}%`);
  }
  const contact = (images: string[], cols: number, scale: number) =>
    page.evaluate(([i, c, s]) => (window as unknown as { __m15: { contact: (...a: unknown[]) => Promise<string> } }).__m15.contact(i, c, s), [images, cols, scale] as const);
  writeFileSync(path.join(out, 'contact.png'), png(await contact(ours, 5, 0.5)));
  const pairs: string[] = [];
  ids.forEach((_, i) => pairs.push(refImgs[i]!, ours[i]!));
  // The reference scans are JPEGs; the page decodes any image type from the data URL.
  writeFileSync(path.join(out, 'contact-pairs.png'), png(await contact(pairs, 4, 0.42)));
  const mean = `mean              mad=${(sumMad / ids.length).toFixed(2)} mad8=${(sumMad8 / ids.length).toFixed(2)}`;
  console.log([...rows, mean].join('\n'));
  appendFileSync(path.join(out, 'scores.log'), `# ${round}\n${[...rows, mean].join('\n')}\n`);
  await browser.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

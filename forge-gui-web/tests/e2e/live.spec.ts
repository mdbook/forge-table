/**
 * Live: the real sidecar (spawned by global setup: madness vs faeries vs Forge AI) driven
 * through the real UI at speed 2. The test clicks Start, keeps, then presses the PRIMARY button (a real hit
 * target) through every prompt until turn 3 or game over, taking a screenshot at each prompt. Video on.
 *
 * It observes state through window.__table (read-only) but acts only through DOM / canvas clicks.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { gateConsole } from '../support/console.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../output/live');
const TARGET_TURN = 3;
const STUCK_MS = 45_000;

type Spec = { label: string; enabled: boolean; action: string | null } | null;
type Live = {
  state(): {
    turn: number;
    phase: string | null;
    playerTurn: string | null;
    viewer: string;
    inMatch: boolean;
    gameOver: { won: boolean } | null;
    prompt: { kind: string; pid: number; selectable: string[]; ok: { enabled: boolean } } | null;
    asks: Array<{ id: string; kind: string }>;
  };
  buttons(): { primary: NonNullable<Spec>; secondary: Spec; endTurn: Spec };
  cardCenter(id: string): { x: number; y: number } | null;
};
const api = (p: Page) => ({
  state: () => p.evaluate(() => (window as unknown as { __table: Live }).__table.state()),
  buttons: () => p.evaluate(() => (window as unknown as { __table: Live }).__table.buttons()),
  cardCenter: (id: string) => p.evaluate((cid) => (window as unknown as { __table: Live }).__table.cardCenter(cid), id),
});

async function answerAsk(page: Page): Promise<string> {
  const confirm = page.getByTestId('ask-confirm');
  if (await confirm.isVisible()) {
    await page.getByTestId('ask-option-0').click();
    return 'confirm';
  }
  const done = page.getByTestId('ask-done');
  if ((await done.isVisible()) && (await done.isEnabled())) {
    await done.click();
    return 'done';
  }
  const none = page.getByTestId('ask-none');
  if (await none.isVisible()) {
    await none.click();
    return 'none';
  }
  const first = page.locator('[data-testid^="ask-item-"]:not([disabled]):not([aria-disabled="true"])').first();
  if (await first.isVisible()) {
    await first.click();
    return 'item';
  }
  return 'nothing';
}

test('live: keep, then press primary through prompts to turn 3 (or game over)', async ({ page }, testInfo) => {
  test.skip(!process.env.FT_LIVE_URL, 'live sidecar not started (FT_SKIP_LIVE set?)');
  mkdirSync(OUT, { recursive: true });
  const gate = gateConsole(page);
  const url = new URL(process.env.FT_LIVE_URL!);
  // art=0: procedural faces, so the run never depends on Scryfall downloads (or logs their 404s).
  url.search = '?speed=2&art=0';
  await page.goto(url.toString());

  // Tiny lobby: the sidecar's default decks are preselected.
  const start = page.getByTestId('start-match');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();

  const t = api(page);
  await expect.poll(async () => (await t.state()).inMatch, { timeout: 120_000 }).toBe(true);

  const deadline = Date.now() + 9 * 60_000;
  let shot = 0;
  let actedKey = '';
  let pidSeenAt = Date.now();
  let lastPid = -1;
  let stuck = 0;
  let prompts = 0;
  let reached = false;
  const log: string[] = [];
  while (Date.now() < deadline) {
    const s = await t.state();
    if (s.gameOver) {
      reached = true;
      log.push(`game over (won=${s.gameOver.won}) at turn ${s.turn}`);
      break;
    }
    if (s.turn >= TARGET_TURN && s.prompt && s.prompt.kind !== 'waiting' && s.asks.length === 0) {
      reached = true;
      log.push(`reached turn ${s.turn} (${s.phase}, ${s.playerTurn === s.viewer ? 'my' : 'their'} turn)`);
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-turn${s.turn}-reached.png`) });
      break;
    }
    if (s.asks.length > 0) {
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-ask-${s.asks[0]!.kind}.png`) });
      log.push(`ask ${s.asks[0]!.kind} → ${await answerAsk(page)}`);
      await page.waitForTimeout(250);
      continue;
    }
    const p = s.prompt;
    if (!p || p.kind === 'waiting') {
      await page.waitForTimeout(100);
      continue;
    }
    if (p.pid !== lastPid) {
      lastPid = p.pid;
      pidSeenAt = Date.now();
      prompts++;
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-t${s.turn}-${p.kind}.png`) });
    } else if (Date.now() - pidSeenAt > STUCK_MS) {
      stuck++;
      log.push(`STUCK on pid ${p.pid} (${p.kind})`);
      break;
    }
    const b = await t.buttons();
    const key = `${p.pid}|${b.primary.label}|${b.primary.enabled}|${p.selectable.length}`;
    if (key === actedKey) {
      await page.waitForTimeout(100);
      continue;
    }
    if (b.primary.enabled) {
      log.push(`t${s.turn} ${s.phase} ${p.kind}: primary "${b.primary.label}"`);
      // A framed yes/no (e.g. play or draw after winning the coin toss) has its own buttons, not the HUD's.
      const yes = page.getByTestId('confirm-yes');
      await ((await yes.isVisible()) ? yes : page.getByTestId('primary')).click({ timeout: 30_000 });
    } else if (p.selectable.length > 0) {
      const at = await t.cardCenter(p.selectable[0]!);
      if (!at) throw new Error(`selectable ${p.selectable[0]} has no position`);
      log.push(`t${s.turn} ${p.kind}: click card ${p.selectable[0]}`);
      await page.mouse.click(at.x, at.y);
    } else if (b.secondary?.enabled) {
      log.push(`t${s.turn} ${p.kind}: secondary "${b.secondary.label}"`);
      await page.getByTestId('secondary').click();
    } else {
      await page.waitForTimeout(100);
      continue;
    }
    actedKey = key;
    await page.waitForTimeout(120);
  }
  testInfo.attach('log', { body: log.join('\n'), contentType: 'text/plain' });
  console.log(log.join('\n'));
  await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-final.png`) });

  expect(stuck, 'stuck prompts').toBe(0);
  expect(reached, `reached turn ${TARGET_TURN} or game over`).toBe(true);
  expect(prompts).toBeGreaterThan(2);
  expect(gate.errors).toEqual([]);

  const video = page.video();
  await page.close();
  if (video) {
    const dest = path.join(OUT, 'live-game.webm');
    await video.saveAs(dest);
  }
});

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
/** Overlay-fallback answers allowed on one prompt before it is called stuck (a few picks may be needed to clear it). */
const MAX_OVERLAY_TRIES = 3;

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
  const first = page.locator('[data-testid^="ask-item-"]:visible:not([disabled]):not([aria-disabled="true"])').first();
  if ((await first.isVisible()) && (await first.isEnabled())) {
    await first.click();
    return 'item';
  }
  return 'nothing';
}

/**
 * The last-resort answer for a prompt the HUD buttons can't clear: a framed yes/no, a mana orb, a number picker or
 * any ask rendered over the table rather than in the prompt bar. Returns what it pressed, or 'nothing'.
 *
 * Every control is re-queried fresh on each call and must be currently visible AND enabled. An ask answered earlier
 * stays in the DOM (dimmed, pointer-events: none) until the engine sends the next prompt, and a hidden or disabled
 * tile would swallow the click; pressing one would still count as an answer and burn the retries down to a false
 * "stuck" verdict, so only a live control is pressed.
 */
async function answerOverlay(page: Page): Promise<string> {
  const yes = page.getByTestId('confirm-yes');
  if ((await yes.isVisible()) && (await yes.isEnabled())) {
    await yes.click();
    return 'yes';
  }
  const mana = page.locator('[data-testid^="mana-option-"]:visible:not([disabled])').first();
  if ((await mana.isVisible()) && (await mana.isEnabled())) {
    await mana.click();
    return 'mana';
  }
  const done = page.locator('[data-testid="ask-done"]:visible:not([disabled])').first();
  if ((await done.isVisible()) && (await done.isEnabled())) {
    await done.click();
    return 'done';
  }
  const item = page.locator('[data-testid^="ask-item-"]:visible:not([disabled]):not([aria-disabled="true"])').first();
  if ((await item.isVisible()) && (await item.isEnabled())) {
    await item.click();
    return 'item';
  }
  const none = page.locator('[data-testid="ask-none"]:visible:not([disabled])').first();
  if ((await none.isVisible()) && (await none.isEnabled())) {
    await none.click();
    return 'none';
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
  /** Prompts the loop answered (an act per meaningful prompt): monotonic, unlike the old distinct-pid count. */
  let answers = 0;
  /** How many times the overlay fallback has fired on the current prompt (a bounded retry before a real stuck verdict). */
  let stuckTries = 0;
  let reachedTurn = false;
  const log: string[] = [];
  while (Date.now() < deadline) {
    const s = await t.state();
    if (s.gameOver) {
      reachedTurn = s.turn >= TARGET_TURN;
      log.push(`game over (won=${s.gameOver.won}) at turn ${s.turn}`);
      break;
    }
    if (s.turn >= TARGET_TURN && s.prompt && s.prompt.kind !== 'waiting' && s.asks.length === 0) {
      reachedTurn = true;
      log.push(`reached turn ${s.turn} (${s.phase}, ${s.playerTurn === s.viewer ? 'my' : 'their'} turn)`);
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-turn${s.turn}-reached.png`) });
      break;
    }
    if (s.asks.length > 0) {
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-ask-${s.asks[0]!.kind}.png`) });
      log.push(`ask ${s.asks[0]!.kind} → ${await answerAsk(page)}`);
      answers++;
      stuckTries = 0;
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
      stuckTries = 0;
      await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-t${s.turn}-${p.kind}.png`) });
    } else if (Date.now() - pidSeenAt > STUCK_MS) {
      // The HUD buttons haven't moved this prompt in STUCK_MS: it may be one the prompt bar cannot clear (a framed
      // yes/no, a mana orb, a number picker, an ask rendered over the table). Answer that before calling it stuck.
      const over = stuckTries < MAX_OVERLAY_TRIES ? await answerOverlay(page) : 'nothing';
      if (over === 'nothing') {
        stuck++;
        log.push(`STUCK on pid ${p.pid} (${p.kind})`);
        break;
      }
      stuckTries++;
      log.push(`t${s.turn} ${p.kind}: overlay ${over} (try ${stuckTries})`);
      answers++;
      pidSeenAt = Date.now();
      await page.waitForTimeout(150);
      continue;
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
    answers++;
    actedKey = key;
    await page.waitForTimeout(120);
  }
  testInfo.attach('log', { body: log.join('\n'), contentType: 'text/plain' });
  console.log(log.join('\n'));
  await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-final.png`) });

  expect(stuck, 'stuck prompts').toBe(0);
  // The loop must actually drive the game to the target turn, not just end early; job 8590's flake was here.
  //
  // The old `expect(prompts).toBeGreaterThan(2)` counted distinct pids, but Forge reuses one pid across the steps of a
  // turn while the HUD primary's label and the selectable set change under it, so the loop drives a whole turn
  // re-pressing one pid. On a fast auto-skip run turn 3 arrived having seen two pids and the assertion failed although
  // the game was playing perfectly. A bare `answers >= TARGET_TURN` (ops' example) would re-flake the other way:
  // auto-skip is on by default and passes any window where the viewer has nothing to do, so a kept 7-card hand with no
  // land (about 7% of opening hands in this deck) auto-skips the viewer's whole turn with no answer, and turn 3 can
  // arrive on fewer than TARGET_TURN answers. Gating on the turn reached is the meaningful bound: reachedTurn is set
  // when the game reaches TARGET_TURN (the turn branch, above) or ends by game over at that turn or later. In this
  // matchup (mono-red madness vs mono-blue faeries, Default AI) neither side can close 20 life by turn 3, so a game
  // over before the target turn is a real anomaly, not a flake. `answers > 0` stays as a cheap secondary guard (the
  // opening keep is always an answered prompt); it counts answered acts, which unlike the old pid count cannot read low.
  expect(reachedTurn, `reached turn ${TARGET_TURN}`).toBe(true);
  expect(answers, 'prompts answered').toBeGreaterThan(0);
  expect(gate.errors).toEqual([]);

  const video = page.video();
  await page.close();
  if (video) {
    const dest = path.join(OUT, 'live-game.webm');
    await video.saveAs(dest);
  }
});

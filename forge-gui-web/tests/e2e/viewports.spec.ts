/** Scratch (not a golden): the replay at phone / tablet / desktop sizes, shots to tests/output/viewports/. */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../output/viewports');
const SIZES = (process.env.FT_VP ?? '844x390,390x844,667x375,1180x820,820x1180,1366x768,1920x1080,2560x1080').split(',');

for (const size of SIZES) {
  const [w, h] = size.split('x').map(Number) as [number, number];
  test(`viewport ${size}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    await page.route('**/session.jsonl', (route) =>
      route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/zones.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
    await page.goto('/?test=1&replay=session.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${size}-zones.png`) });
  });
  test(`viewport ${size} mulligan`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    await page.route('**/session.jsonl', (route) =>
      route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/madness-vs-faeries.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
    await page.goto('/?test=1&replay=session.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.waitForPrompt('mulligan'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${size}-mulligan.png`) });
  });
  test(`viewport ${size} lobby`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    const now = Date.now();
    await page.route('**/api/matches', (route) =>
      route.fulfill({ json: { user: 'alex', maxPerUser: 3, maxMatches: 6, admin: true,
        matches: [{ id: 'a1', status: 'playing', created: now - 600000 }, { id: 'b2', status: 'starting', created: now - 5000, progress: { stage: 'cards', label: 'Loading cards', pct: 40, elapsed: 5 } }] } }));
    await page.route('**/api/admin/matches', (route) =>
      route.fulfill({ json: { matches: [{ id: 'a1', owner: 'alex', status: 'playing', created: now - 600000 }, { id: 'c3', owner: 'robin', status: 'ready', created: now - 90000 }] } }));
    await page.goto('/lobby.html');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${size}-lobby.png`) });
  });
  test(`viewport ${size} pvp`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    const fixture = (name: string) => readFileSync(path.resolve(here, `../fixtures/sessions/${name}.jsonl`), 'utf8');
    await page.route((u) => u.pathname.endsWith('.jsonl'), (route) => route.fulfill({ body: fixture(new URL(route.request().url()).pathname.split('/').pop()!.replace('.jsonl', '')), contentType: 'application/x-ndjson' }));
    await page.goto('/?test=1&replay=pvp-start.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.seedStart(['Mono Red'], 'Mono Red'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${size}-pvp-start.png`) });
    await page.goto('/?test=1&replay=pvp-away.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.runUntil((s: any) => s.pvp?.presence != null, { settle: true }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${size}-pvp-away.png`) });
    await page.goto('/?test=1&replay=pvp-wait.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.runUntil((s: any) => s.pvp?.presence != null, { settle: true }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${size}-pvp-wait.png`) });
  });
  test(`viewport ${size} start`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?test=1');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${size}-start.png`) });
  });
  test(`viewport ${size} stack`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: w, height: h });
    await page.route('**/session.jsonl', (route) =>
      route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/madness-vs-faeries.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
    await page.goto('/?test=1&replay=session.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.runUntil((s: { stack: number }) => s.stack > 0, { settle: true }));
    await page.screenshot({ path: path.join(OUT, `${size}-stack.png`) });
    // Portrait: the stack list opens from its head.
    if (h > w) {
      // Test mode draws frames only when told: one more frame clears the last cast's .fx-presenting (scene.ts).
      await page.evaluate(() => (window as any).__table.advance(50));
      await page.locator('.stack-head').click({ timeout: 10000 });
      await page.screenshot({ path: path.join(OUT, `${size}-stack-open.png`) });
    }
  });
}

test('touch: a long press pins the preview, and its Snooze button snoozes the card', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/zones.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!(window as any).__table);
  await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
  // A card on the battlefield: the one nearest the middle of the screen.
  const pt = await page.evaluate(() => {
    const t = (window as any).__table;
    const pts = t.sprites().map((s: { id: string }) => t.cardCenter(s.id)).filter(Boolean) as Array<{ x: number; y: number }>;
    return pts.sort((a, b) => Math.hypot(a.x - 422, a.y - 195) - Math.hypot(b.x - 422, b.y - 195))[0]!;
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByTestId('pinned-preview').waitFor();
  await page.screenshot({ path: path.join(OUT, '844x390-pinned.png') });
  await page.getByTestId('pinned-snooze').tap();
  await page.getByText('Unsnooze').waitFor();
  await page.getByText('Close').tap();
  await page.getByTestId('pinned-preview').waitFor({ state: 'detached' });
  await page.evaluate(() => (window as any).__table.redraw());
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '844x390-snoozed.png') });
  await ctx.close();
});

/** FT_STRESS=flood,attach,…: the stress boards (fixtures/make-stress.mjs) at FT_VP's sizes, to stress-<name>-<size>.png. */
for (const name of (process.env.FT_STRESS ?? '').split(',').filter(Boolean)) {
  for (const size of SIZES) {
    const [w, h] = size.split('x').map(Number) as [number, number];
    test(`stress ${name} ${size}`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: w, height: h });
      await page.route('**/session.jsonl', (route) =>
        route.fulfill({ body: readFileSync(path.resolve(here, `../fixtures/sessions/stress-${name}.jsonl`), 'utf8'), contentType: 'application/x-ndjson' }));
      await page.goto('/?test=1&replay=session.jsonl');
      await page.waitForFunction(() => !!(window as any).__table);
      await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `stress-${name}-${size}.png`) });
    });
  }
}

/** FT_HAND=<fixture>: the touch hand shots from another session (default zones, a 4-card hand). */
const HAND_FIXTURE = process.env.FT_HAND ?? 'zones';
const HAND_SUFFIX = HAND_FIXTURE === 'zones' ? '' : `-${HAND_FIXTURE}`;

test('touch: a tap raises the hand as a fan, a tap brings a card forward, a tap on the table lowers it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, `../fixtures/sessions/${HAND_FIXTURE}.jsonl`), 'utf8'), contentType: 'application/x-ndjson' }));
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!(window as any).__table);
  await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
  await page.evaluate(() => (window as any).__table.pause(true));
  // My hand: the lowest cards on screen.
  const [card, other] = await page.evaluate(() => {
    const t = (window as any).__table;
    // (not the alt-zone strip's cards beside the hand: castable graveyard / exile cards)
    const alt = new Set((t.state().alt ?? []).map((a: { id: string }) => a.id));
    const pts = t.sprites().filter((s: { id: string }) => !alt.has(s.id)).map((s: { id: string }) => ({ id: s.id, ...t.cardCenter(s.id) })).filter((p: any) => p.y !== undefined);
    return pts.sort((a: any, b: any) => b.y - a.y).slice(0, 2) as { id: string; x: number; y: number }[];
  });
  const where = async (id: string) => page.evaluate((id) => (window as any).__table.cardCenter(id).y as number, id);
  await page.touchscreen.tap(card!.x, Math.min(card!.y, 836));
  await page.evaluate(() => (window as any).__table.advance(600));
  if ((await where(card!.id)) > card!.y - 100) throw new Error('the hand did not rise');
  await page.screenshot({ path: path.join(OUT, `390x844-hand-up${HAND_SUFFIX}.png`) });
  const o = await page.evaluate((id) => (window as any).__table.cardCenter(id), other!.id);
  await page.touchscreen.tap(o.x, o.y);
  await page.evaluate(() => (window as any).__table.advance(600));
  await page.screenshot({ path: path.join(OUT, `390x844-hand-focus${HAND_SUFFIX}.png`) });
  if ((await where(other!.id)) >= o.y) throw new Error('the tapped card did not come forward');
  await page.touchscreen.tap(20, 300);
  await page.evaluate(() => (window as any).__table.advance(600));
  if (Math.abs((await where(card!.id)) - card!.y) > 4) throw new Error('the hand did not go back down');
  await ctx.close();
});

/** Mid-animation shots of the overhaul's effects (FT_FX=fixture:seq:ms+ms…), to tests/output/viewports/fx-*.png. */
const FX = (process.env.FT_FX ?? 'targets:77:120+300+420,split:223:120+300+420,madness-vs-faeries:130:300+480,madness-vs-faeries:185:300+480').split(',');
for (const spec of FX) {
  const [fixture, seqS, times] = spec.split(':') as [string, string, string];
  test(`fx ${spec}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const [fw, fh] = (process.env.FT_FX_VP ?? '1920x1080').split('x').map(Number) as [number, number];
    await page.setViewportSize({ width: fw, height: fh });
    await page.route('**/session.jsonl', (route) =>
      route.fulfill({ body: readFileSync(path.resolve(here, `../fixtures/sessions/${fixture}.jsonl`), 'utf8'), contentType: 'application/x-ndjson' }));
    await page.goto('/?test=1&replay=session.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate((n) => (window as any).__table.runUntil((s: { playhead: number }) => s.playhead >= n, { maxMs: 600000 }), Number(seqS));
    let at = 0;
    for (const ms of times.split('+').map(Number)) {
      await page.evaluate((d) => (window as any).__table.advance(d), ms - at);
      at = ms;
      await page.screenshot({ path: path.join(OUT, `fx-${fixture}-${seqS}-${ms}.png`) });
      // FT_FX_OPEN: the portrait stack list opened.
      if (process.env.FT_FX_OPEN && (await page.locator('.stack-head').count())) {
        await page.locator('.stack-head').click();
        await page.screenshot({ path: path.join(OUT, `fx-${fixture}-${seqS}-${ms}-open.png`) });
      }
    }
  });
}

/** My hand's cards on screen (the lowest sprites), split into playable (prompt `weak`) and not. */
async function handCards(page: import('@playwright/test').Page, n: number) {
  return page.evaluate((n) => {
    const t = (window as any).__table;
    const weak = t.state().weak as Record<string, number>;
    const alt = new Set((t.state().alt ?? []).map((a: { id: string }) => a.id));
    const pts = t.sprites().filter((s: { id: string }) => !alt.has(s.id)).map((s: { id: string }) => ({ id: s.id, ...t.cardCenter(s.id) })).filter((p: any) => p.y !== undefined);
    const hand = (pts.sort((a: any, b: any) => b.y - a.y) as { id: string; x: number; y: number }[]).slice(0, n);
    return { playable: hand.filter((c) => (weak[c.id] ?? 0) > 0), other: hand.filter((c) => !((weak[c.id] ?? 0) > 0)) };
  }, n);
}

test('drag to play (mouse): out over the table, release to play; can\'t-play shakes back; click carries, click again lets go', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/zones.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!(window as any).__table);
  await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
  await page.evaluate(() => (window as any).__table.pause(true));
  const { playable, other } = await handCards(page, 4);
  if (!playable[0] || !other[0]) throw new Error(`need a playable and an unplayable hand card: ${JSON.stringify({ playable, other })}`);
  const card = playable[0];
  const advance = (ms: number) => page.evaluate((ms) => (window as any).__table.advance(ms), ms);
  const sprite = (id: string) => page.evaluate((id) => (window as any).__table.sprites().find((s: { id: string }) => s.id === id), id);
  const acts = () => page.evaluate(() => (window as any).__table.acts() as Array<{ kind: string; card?: string }>);

  // Pick it up and drag it up and to the right, a frame between moves: it follows the pointer and leans.
  await page.mouse.move(card.x, card.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(card.x + i * 14, card.y - i * 34);
    await advance(16);
  }
  if ((await page.evaluate(() => (window as any).__table.handDrag())) !== card.id) throw new Error('the hand card is not being dragged');
  const s1 = await sprite(card.id);
  if (!(s1.rot > 0.02)) throw new Error(`no lean while moving right: rot ${s1.rot}`);
  await page.screenshot({ path: path.join(OUT, 'drag-armed-1920.png') });
  // Resting: the lean springs back.
  await advance(400);
  const s2 = await sprite(card.id);
  if (Math.abs(s2.rot) > 0.01) throw new Error(`still leaning at rest: ${s2.rot}`);
  await page.screenshot({ path: path.join(OUT, 'drag-armed-still-1920.png') });
  await page.mouse.up();
  await advance(16);
  const sent = await acts();
  if (!sent.some((a) => a.kind === 'card' && a.card === card.id)) throw new Error(`no play act: ${JSON.stringify(sent)}`);
  await advance(200);
  await page.screenshot({ path: path.join(OUT, 'drag-held-1920.png') });
  // The replay never answers: after the hold it goes back to the hand.
  await advance(3000);
  const back = await page.evaluate((id) => (window as any).__table.cardCenter(id), card.id);
  if (Math.abs(back.y - card.y) > 40) throw new Error(`did not return to the hand: ${back.y} vs ${card.y}`);

  // A card that can't be played: muted over the table, shaken back, nothing sent.
  const n0 = (await acts()).length;
  const o = other[0];
  await page.mouse.move(o.x, o.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(o.x, o.y - i * 50);
    await advance(16);
  }
  await advance(200);
  await page.screenshot({ path: path.join(OUT, 'drag-cant-1920.png') });
  await page.mouse.up();
  await advance(120);
  await page.screenshot({ path: path.join(OUT, 'drag-cant-shake-1920.png') });
  await advance(800);
  if ((await acts()).length !== n0) throw new Error('an unplayable card sent an act');

  // Click to carry: a click picks it up (no big preview, no act) and it rides the pointer with no button held;
  // Esc puts it back; a click over the table plays it.
  const c = await page.evaluate((id) => (window as any).__table.cardCenter(id), card.id);
  const handDrag = () => page.evaluate(() => (window as any).__table.handDrag());
  await page.mouse.click(c.x, c.y);
  await advance(16);
  if ((await handDrag()) !== card.id) throw new Error('a click did not pick the card up');
  if (await page.getByTestId('pinned-preview').count()) throw new Error('a click pinned the big preview');
  if ((await acts()).length !== n0) throw new Error('a single click played the card');
  await page.keyboard.press('Escape');
  await advance(16);
  if ((await handDrag()) !== null) throw new Error('Esc did not put the carried card back');
  await advance(600);
  await page.mouse.click(c.x, c.y);
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(c.x + i * 10, c.y - i * 40);
    await advance(16);
  }
  if ((await handDrag()) !== card.id) throw new Error('the carried card was dropped while moving');
  await advance(300);
  await page.screenshot({ path: path.join(OUT, 'carry-armed-1920.png') });
  if ((await acts()).length !== n0) throw new Error('carrying played the card before the second click');
  await page.mouse.click(c.x + 100, c.y - 400);
  await advance(16);
  if ((await acts()).length !== n0 + 1) throw new Error('the second click over the table did not play the card');
});

test('drag to play (touch): drag straight up out of the lowered hand plays, with touch pointer events', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/zones.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!(window as any).__table);
  await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
  await page.evaluate(() => (window as any).__table.pause(true));
  // Record the pointer types the window sees (it must be real touch input, not mouse emulation).
  await page.evaluate(() => {
    (window as any).__ptypes = [];
    window.addEventListener('pointermove', (e) => (window as any).__ptypes.push(e.pointerType), true);
  });
  const { playable } = await handCards(page, 4);
  const card = playable[0];
  if (!card) throw new Error('no playable hand card');
  const y0 = Math.min(card.y, 836);
  const cdp = await ctx.newCDPSession(page);
  const advance = (ms: number) => page.evaluate((ms) => (window as any).__table.advance(ms), ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: card.x, y: y0 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: card.x - i * 3, y: y0 - i * 30 }] });
    await advance(16);
  }
  await advance(150);
  if ((await page.evaluate(() => (window as any).__table.handDrag())) !== card.id) throw new Error('touch drag did not pick the card up');
  await page.screenshot({ path: path.join(OUT, 'drag-touch-390x844.png') });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await advance(16);
  const types = await page.evaluate(() => [...new Set((window as any).__ptypes)]);
  if (!types.includes('touch')) throw new Error(`no touch pointer events: ${types}`);
  const sent = await page.evaluate(() => (window as any).__table.acts());
  if (!sent.some((a: { kind: string; card?: string }) => a.kind === 'card' && a.card === card.id)) throw new Error(`touch drag did not play: ${JSON.stringify(sent)}`);
  // The hand was never raised: no extra step.
  if (await page.evaluate(() => document.documentElement.classList.contains('hand-up'))) throw new Error('the hand went up');
  await ctx.close();
});

test('drag to play: the cast card flies on to the stack from where it was dropped (targets: Lightning Bolt)', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/targets.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!(window as any).__table);
  // The priority prompt (seq 51) where the recording player cast Bolt (c151); its toStack beat follows.
  await page.evaluate(() => (window as any).__table.runUntil((s: any) => s.playhead >= 51 && s.prompt?.kind === 'priority', { settle: true }));
  await page.evaluate(() => (window as any).__table.pause(true));
  const t = (id: string) => page.evaluate((id) => (window as any).__table.sprites().find((s: { id: string }) => s.id === id), id);
  const advance = (ms: number) => page.evaluate((ms) => (window as any).__table.advance(ms), ms);
  const slot = await t('c151');
  const c = await page.evaluate(() => (window as any).__table.cardCenter('c151'));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(c.x + i * 25, c.y - i * 40);
    await advance(16);
  }
  await page.mouse.up();
  await advance(16);
  const dropped = await t('c151');
  // The recorded game carries on: its toStack beat picks the held card up.
  await page.evaluate(() => (window as any).__table.pause(false));
  const path1: { x: number; y: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await advance(16);
    const s = await t('c151');
    path1.push({ x: s.x, y: s.y });
    if (i === 8) await page.screenshot({ path: path.join(OUT, 'drag-flight-1920.png') });
  }
  // Never back to the hand slot on the way: every frame is nearer the drop point (or beyond, toward the stack) than the slot.
  const far = path1.find((p) => Math.hypot(p.x - slot.x, p.y - slot.y) < Math.hypot(dropped.x - slot.x, dropped.y - slot.y) * 0.5);
  if (far) throw new Error(`the flight went back toward the hand: ${JSON.stringify({ slot, dropped, far })}`);
  const end = path1[path1.length - 1]!;
  if (Math.hypot(end.x - dropped.x, end.y - dropped.y) < 20) throw new Error(`it never flew: ${JSON.stringify({ dropped, end })}`);
});

// FT_MANA=1: the X picker and the mana pickers (tests/fixtures/make-choices.mjs) at each size.
if (process.env.FT_MANA) {
  for (const size of SIZES) {
    const [w, h] = size.split('x').map(Number) as [number, number];
    test(`viewport ${size} mana`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: w, height: h });
      await page.route('**/session.jsonl', (route) =>
        route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/mana.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
      await page.goto('/?test=1&replay=session.jsonl');
      await page.waitForFunction(() => !!(window as any).__table);
      for (const id of ['q1', 'q2', 'q3']) {
        await page.evaluate((q) => (window as any).__table.runUntil((s: { asks: { id: string }[] }) => s.asks.some((a) => a.id === q), { settle: true }), id);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `${size}-mana-${id}.png`) });
        if (id === 'q1') {
          // Three digits: the dial keeps its width, the buttons don't jump.
          await page.keyboard.type('105');
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(OUT, `${size}-mana-q1-105.png`) });
        }
      }
    });
  }
}

test('settings: inline buttons with room, the gear only when narrow', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.route('**/session.jsonl', (route) =>
    route.fulfill({ body: readFileSync(path.resolve(here, '../fixtures/sessions/zones.jsonl'), 'utf8'), contentType: 'application/x-ndjson' }));
  // [width, height, inline?]: the gear folds the buttons away under 900 px wide or squarer than 3:2 (styles.css, corner menu).
  for (const [w, h, inline] of [[1920, 1080, true], [1440, 900, true], [1366, 768, true], [960, 450, true], [1024, 768, false], [844, 390, false], [390, 844, false]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?test=1&replay=session.jsonl');
    await page.waitForFunction(() => !!(window as any).__table);
    await page.evaluate(() => (window as any).__table.waitForPrompt('priority'));
    const gear = page.getByRole('button', { name: 'Settings' });
    const corner = page.getByTestId('corner');
    await page.mouse.move(4, h - 4);
    await page.screenshot({ path: path.join(OUT, `settings-full-${w}.png`) });
    if (inline) {
      // Room: speed, card size, FX are on screen as buttons; no gear.
      await expect(gear).toBeHidden();
      await expect(page.getByTestId('effects')).toBeVisible();
      await expect(page.getByTestId('card-size')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Animation speed' })).toBeVisible();
      // Concede asks once more (the first click only arms it; blurring disarms it).
      const concede = page.getByRole('button', { name: /^Concede/ });
      await concede.click();
      await expect(concede).toHaveText('Concede? Click again');
      await page.mouse.click(4, h - 4);
      await expect(concede).toHaveText('Concede');
      const c = (await corner.boundingBox())!;
      await page.screenshot({ path: path.join(OUT, `settings-${w}.png`), clip: { x: Math.max(0, c.x - 12), y: Math.max(0, c.y - 12), width: Math.min(w, c.width + 24), height: c.height + 24 } });
      continue;
    }
    // Narrow: the gear (a 36 px+ target) opens the same controls in a popover.
    await expect(page.getByTestId('effects')).toBeHidden();
    const b = (await gear.boundingBox())!;
    if (b.width < 36 || b.height < 36) throw new Error(`gear target too small: ${b.width}x${b.height}`);
    const clip = { x: b.x - 12, y: Math.max(0, b.y - 12), width: b.width + 24, height: b.height + 24 };
    await page.screenshot({ path: path.join(OUT, `gear-${w}.png`), clip });
    await gear.hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `gear-${w}-hover.png`), clip });
    await gear.click();
    await expect(page.getByTestId('effects')).toBeVisible();
    await expect(page.getByTestId('card-size')).toBeVisible();
    const menu = (await page.locator('.corner-menu').boundingBox())!;
    await page.screenshot({ path: path.join(OUT, `gear-${w}-menu.png`), clip: { x: Math.max(0, menu.x - 12), y: Math.max(0, menu.y - 12), width: Math.min(w, menu.width + 24), height: menu.height + 24 } });
    const concede = page.getByRole('button', { name: /^Concede/ });
    await concede.click();
    await expect(concede).toHaveText('Concede? Click again');
    await gear.click();
    await expect(page.getByTestId('effects')).toBeHidden();
  }
});

/**
 * Replay goldens: a session recorded from the real sidecar is replayed with no JVM and
 * the virtual clock (`?test=1`), so every frame is deterministic. Named points are compared at
 * 1920×1080 with a 0.1% tolerance. Each run also writes the shots and their SHA-1s to tests/output/replay/
 * (to check run-to-run identity) and a contact sheet of the goldens.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { gateConsole } from '../support/console.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../fixtures/sessions/madness-vs-faeries.jsonl');
/** A board state (tests/fixtures/states/zones.txt) with full graveyards and exiles and playable cards. */
const ZONES_FIXTURE = path.resolve(here, '../fixtures/sessions/zones.jsonl');
/** Preordain, Ponder and Impulse cast in turn (tests/fixtures/states/choosers.txt): every card chooser. */
const CHOOSERS_FIXTURE = path.resolve(here, '../fixtures/sessions/choosers.jsonl');
/** A Lure'd trampler double-blocked, then Arc Lightning (tests/fixtures/states/split.txt): both kinds of split. */
const SPLIT_FIXTURE = path.resolve(here, '../fixtures/sessions/split.jsonl');
/** The AI swings with Wind Drake, Hill Giant and Grizzly Bears; I block blocker-first (tests/fixtures/states/blocks.txt). */
const BLOCKS_FIXTURE = path.resolve(here, '../fixtures/sessions/blocks.jsonl');
/** Lightning Bolt at the AI's Wind Drake (tests/fixtures/states/targets.txt). */
const TARGETS_FIXTURE = path.resolve(here, '../fixtures/sessions/targets.jsonl');
/** Every way onto and off the stack: Bolt, a trigger, a presented Counterspell, a ping, a creature (synthetic: tests/fixtures/make-stack.mjs). */
const STACK_FIXTURE = path.resolve(here, '../fixtures/sessions/stack-fx.jsonl');
/** Twelve items on the stack, spells and triggers (synthetic: tests/fixtures/make-stress.mjs). */
const DEEP_STACK_FIXTURE = path.resolve(here, '../fixtures/sessions/stress-stack.jsonl');
/** Fireball for X, paid with a dual land, City of Brass and Adarkar Wastes (synthetic: tests/fixtures/make-choices.mjs). */
const MANA_FIXTURE = path.resolve(here, '../fixtures/sessions/mana.jsonl');
/** Hexproof, shroud, protection and ward on the opponent's board, a sick and a snoozed creature on mine (synthetic: tests/fixtures/make-ward.mjs). */
const WARD_FIXTURE = path.resolve(here, '../fixtures/sessions/ward-fx.jsonl');
/** Emblems, a dungeon, markers and a lasting effect in both command zones (synthetic: tests/fixtures/make-lasting.mjs). */
const LASTING_FIXTURE = path.resolve(here, '../fixtures/sessions/lasting.jsonl');
/** Kolaghan's Command's modes, one ask each, then Ninja of the Deep Hours' optional trigger (synthetic: tests/fixtures/make-prompts.mjs). */
const PROMPTS_FIXTURE = path.resolve(here, '../fixtures/sessions/prompts.jsonl');
/** The mulligan (keep 7?, keep 6?, the London tuck) and three triggers to order (synthetic: tests/fixtures/make-b5b7.mjs). */
const MULL_FIXTURE = path.resolve(here, '../fixtures/sessions/mull.jsonl');
const TRIGGERS_FIXTURE = path.resolve(here, '../fixtures/sessions/triggers.jsonl');
/** Five castables outside the hand, a flashback, then a ninjutsu swap (synthetic: tests/fixtures/make-alt.mjs). */
const ALT_FIXTURE = path.resolve(here, '../fixtures/sessions/alt-zones.jsonl');
/** Human vs human (synthetic: tests/fixtures/make-pvp.mjs): the start screen, Sam holding priority, Sam dropped. */
const pvpFixture = (name: string) => readFileSync(path.resolve(here, `../fixtures/sessions/${name}.jsonl`), 'utf8');
const SNAPSHOTS = path.join(here, 'replay.spec.ts-snapshots');
const OUT = path.resolve(here, '../output/replay');

type TableApi = {
  waitForPrompt(kind: string): Promise<void>;
  waitForGameOver(): Promise<void>;
  runUntil(fn: (s: Record<string, any>) => boolean, opts?: { settle?: boolean }): Promise<void>;
  state(): Record<string, any>;
  sprites(): Array<{ id: string; face: boolean; art: boolean; framed: boolean; sick: boolean; snoozed: boolean; revealed?: boolean; prot: string | null; cost?: string }>;
  settle(ms?: number): void;
  now(): number;
  framed(on: boolean): void;
  preview(id: string | null): void;
  advance(ms: number): void;
  cardCenter(id: string): { x: number; y: number } | null;
  arrows(): string[];
  aim(): { selected: string | null; dragging: string | null };
  pause(on: boolean): void;
  redraw(): void;
  acts(): Array<Record<string, unknown>>;
  seedStart(decks: string[], deck: string): void;
};
declare global {
  interface Window {
    __table: TableApi;
  }
}

/**
 * Park the pointer off every choice and wait until the shot is the parked state, then redraw the table.
 *
 * The tiles in this test lift on `:hover`, and the docked preview is React state set from each tile's
 * onMouseEnter/onMouseLeave. A shot taken straight after a click (which leaves the pointer on the clicked tile) can
 * therefore catch the hover the click left behind: the lift, and the preview showing the clicked card. The browser
 * clears `:hover` synchronously, but the React preview state flushes a frame later, so wait for both before the shot.
 */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForFunction(() => document.querySelectorAll('.carousel-item:hover, .lane-face:hover').length === 0);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.evaluate(() => window.__table.redraw());
}

const SHOTS: Array<{ name: string; title: string; reach: (page: Page) => Promise<unknown> }> = [
  { name: '01-mulligan', title: 'Start / mulligan', reach: (p) => p.evaluate(() => window.__table.waitForPrompt('mulligan')) },
  { name: '02-opening-hand', title: 'Opening hand', reach: (p) => p.evaluate(() => window.__table.waitForPrompt('priority')) },
  {
    name: '03-first-land',
    title: 'First land on the battlefield',
    reach: (p) => p.evaluate(() => window.__table.runUntil((s) => s.landsOf[s.viewer] > 0, { settle: true })),
  },
  {
    name: '04-spell-on-stack',
    title: 'A spell on the stack',
    reach: (p) => p.evaluate(() => window.__table.runUntil((s) => s.stack > 0, { settle: true })),
  },
  {
    name: '05-attackers',
    title: 'Attackers declared',
    reach: (p) => p.evaluate(() => window.__table.runUntil((s) => s.attackers > 0, { settle: true })),
  },
  { name: '06-game-over', title: 'Game over', reach: (p) => p.evaluate(() => window.__table.waitForGameOver()) },
];

test('replay: six goldens from a recorded session', async ({ page }, testInfo) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!window.__table);

  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const shot of SHOTS) {
    await shot.reach(page);
    await expect(page).toHaveScreenshot(`${shot.name}.png`);
    const png = await page.screenshot();
    writeFileSync(path.join(OUT, 'shots', `${shot.name}.png`), png);
    hashes[shot.name] = createHash('sha1').update(png).digest('hex');
  }
  const state = await page.evaluate(() => window.__table.state());
  expect(state.gameOver).toMatchObject({ won: false, matchOver: true });
  writeFileSync(path.join(OUT, `hashes-${testInfo.repeatEachIndex}-${Date.now()}.json`), JSON.stringify(hashes, null, 2));
  expect(gate.errors).toEqual([]);
});

const ZONE_SHOTS = [
  { name: '07-playable-glow', title: 'Playable cards glow (hand, graveyard pile badge)' },
  { name: '08-graveyard-viewer', title: 'My graveyard in the zone viewer' },
  { name: '09-exile-viewer', title: 'Opponent’s exile (a face-down card shows the back)' },
];

test('replay: playable glow and the graveyard / exile viewer', async ({ page }, testInfo) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(ZONES_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=zones.jsonl');
  await page.waitForFunction(() => !!window.__table);
  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const hashes: Record<string, string> = {};
  const shoot = async (name: string) => {
    await expect(page).toHaveScreenshot(`${name}.png`);
    const png = await page.screenshot();
    writeFileSync(path.join(OUT, 'shots', `${name}.png`), png);
    hashes[name] = createHash('sha1').update(png).digest('hex');
  };

  // My main phase: the prompt's weak set marks what I can play. That's three hand cards, Lava Dart (flashback) on
  // top of my graveyard and a foretold card in my exile, whose closed piles carry a glow badge.
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  const before = await page.evaluate(() => window.__table.state());
  expect(Object.keys(before.weak).length).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('pile-me-graveyard-playable')).toHaveText('1');
  await expect(page.getByTestId('pile-me-exile-playable')).toHaveText('1');
  await expect(page.getByTestId('pile-opp-graveyard-playable')).toHaveCount(0);
  await shoot(ZONE_SHOTS[0]!.name);

  // Clicking my graveyard's chip opens the viewer on every card in it.
  await page.getByTestId('pile-me-graveyard').click();
  const viewer = page.getByTestId('zone-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('zone-viewer-count')).toHaveText('8 cards');
  await expect(viewer.locator('.zv-card')).toHaveCount(8);
  await expect(viewer.locator('.zv-card.playable')).toHaveCount(1);
  // The playable card leads with how it's played, Playable now counts it, the head counts card types.
  await expect(viewer.locator('.zv-card').first()).toHaveClass(/playable/);
  await expect(viewer.locator('.zv-card').first().locator('.zv-how')).toHaveText('Flashback');
  await expect(page.getByTestId('grid-chip-playable')).toContainText('1');
  await expect(page.getByTestId('zone-viewer-types')).toContainText('card type');
  await shoot(ZONE_SHOTS[1]!.name);
  await page.getByTestId('grid-chip-playable').click();
  await expect(viewer.locator('.zv-card')).toHaveCount(1);
  await page.getByTestId('grid-chip-all').click();
  await expect(viewer.locator('.zv-card')).toHaveCount(8);
  // In the search box Space and Enter type / do nothing (they used to be swallowed); Esc clears it, then closes.
  await page.keyboard.press('/');
  await expect(page.getByTestId('zone-viewer-bar-search')).toBeFocused();
  await page.keyboard.type('zz q');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('zone-viewer-bar-search')).toHaveValue('zz q');
  await expect(viewer.locator('.zv-card')).toHaveCount(0);
  await expect(viewer).toContainText('No cards match.');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.zv-card')).toHaveCount(8);

  // Esc closes it and the prompt is untouched (Esc never reaches the table's secondary button).
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  const after = await page.evaluate(() => window.__table.state());
  expect(after.prompt).toMatchObject({ kind: 'priority', pid: before.prompt.pid });
  expect(after.zoneView).toBeNull();

  // The opponent's exile: a face-down card (the Kiln back) and a face-up one; a click outside closes it.
  await page.getByTestId('pile-opp-exile').click();
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('zone-viewer-count')).toHaveText('2 cards');
  await shoot(ZONE_SHOTS[2]!.name);
  await page.mouse.click(8, 540);
  await expect(viewer).toBeHidden();

  // The session still plays out to its end.
  await page.evaluate(() => window.__table.waitForGameOver());
  writeFileSync(path.join(OUT, `hashes-zones-${testInfo.repeatEachIndex}-${Date.now()}.json`), JSON.stringify(hashes, null, 2));
  expect(gate.errors).toEqual([]);
});

const CHOOSER_SHOTS = [
  { name: '10-scry-lanes', title: 'Scry 2: top / bottom lanes, the top card previewed large' },
  { name: '11-scry-moved', title: 'Scry: a card clicked to the bottom; the hovered card is previewed' },
  { name: '12-ponder-order', title: 'Ponder: put three back in any order (one card lane)' },
  { name: '13-impulse-strip', title: 'Impulse: the top four dealt out over the dimmed table, the hovered card lifted and zoomed' },
  { name: '14-impulse-rest', title: 'Impulse: the rest to the bottom in any order' },
];

test('replay: card choosers (scry lanes, any-order lane, zone strip) with previews', async ({ page }, testInfo) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(CHOOSERS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=choosers.jsonl');
  await page.waitForFunction(() => !!window.__table);
  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const hashes: Record<string, string> = {};
  const shoot = async (name: string) => {
    await expect(page).toHaveScreenshot(`${name}.png`);
    const png = await page.screenshot();
    writeFileSync(path.join(OUT, 'shots', `${name}.png`), png);
    hashes[name] = createHash('sha1').update(png).digest('hex');
  };
  const askIs = (id: string) => page.evaluate((qid) => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === qid), { settle: true }), id);
  const laneIds = (lane: string) => page.getByTestId(`lane-${lane}`).locator('.lane-face').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  // Park the pointer off every tile, so the preview shows its default card.
  const park = () => page.mouse.move(4, 4);

  // Preordain: scry 2. Both cards start on top, the top one previewed.
  await askIs('q1');
  const arrange = page.getByTestId('ask-arrange');
  await expect(arrange).toBeVisible();
  await park();
  expect(await laneIds('top')).toEqual(['ask-item-0', 'ask-item-1']);
  expect(await laneIds('bottom')).toEqual([]);
  await expect(page.getByTestId('ask-preview')).toBeVisible();
  await shoot(CHOOSER_SHOTS[0]!.name);

  // Clicking a card sends it to the other lane; ↑ on a focused bottom card brings it back, ↓ sends it again.
  await page.getByTestId('ask-item-0').click();
  expect(await laneIds('top')).toEqual(['ask-item-1']);
  expect(await laneIds('bottom')).toEqual(['ask-item-0']);
  await expect(page.getByTestId('arrange-count')).toHaveText('1 on top · 1 on the bottom · click a card to switch');
  await page.getByTestId('ask-item-0').focus();
  await page.keyboard.press('ArrowUp');
  expect(await laneIds('top')).toEqual(['ask-item-1', 'ask-item-0']);
  await page.keyboard.press('ArrowDown');
  expect(await laneIds('bottom')).toEqual(['ask-item-0']);
  // The last card touched is previewed: the focused one until the pointer moves onto another.
  await park();
  await page.getByTestId('ask-item-1').hover();
  await shoot(CHOOSER_SHOTS[1]!.name);
  await page.getByTestId('ask-done').click();

  // Ponder: three cards in one lane, first = closest to the top; ‹ › reorder.
  await askIs('q2');
  await expect(page.getByTestId('ask-order-lanes')).toBeVisible();
  await park();
  expect(await laneIds('order')).toEqual(['ask-item-0', 'ask-item-1', 'ask-item-2']);
  await shoot(CHOOSER_SHOTS[2]!.name);
  await page.getByTestId('lane-earlier-2').click();
  expect(await laneIds('order')).toEqual(['ask-item-0', 'ask-item-2', 'ask-item-1']);
  await page.getByTestId('ask-item-2').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await laneIds('order')).toEqual(['ask-item-2', 'ask-item-0', 'ask-item-1']);
  await page.getByTestId('ask-done').click();

  // Impulse: the top four dealt out over the dimmed table; hovering one lifts and zooms it.
  await page.evaluate(() => window.__table.waitForPrompt('selectEntities'));
  const strip = page.getByTestId('zone-strip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('[data-testid^="zone-card-"]')).toHaveCount(4);
  await strip.locator('[data-testid^="zone-card-"]').nth(1).hover();
  await expect(strip.locator('[data-testid^="zone-card-"]').nth(1)).toHaveClass(/\bpeek\b/);
  await shoot(CHOOSER_SHOTS[3]!.name);
  await park();
  await expect(strip.locator('.zr-card.peek')).toHaveCount(0);

  // The other three go to the bottom in any order.
  await askIs('q3');
  await expect(page.getByTestId('ask-order-lanes')).toBeVisible();
  await park();
  await shoot(CHOOSER_SHOTS[4]!.name);

  await page.evaluate(() => window.__table.waitForGameOver());
  writeFileSync(path.join(OUT, `hashes-choosers-${testInfo.repeatEachIndex}-${Date.now()}.json`), JSON.stringify(hashes, null, 2));
  expect(gate.errors).toEqual([]);
});

const SICK_SHOTS = [{ name: '15-summoning-sick', title: 'Summoning sickness: the zZ tag on a new creature, and its preview' }];

test('replay: summoning sickness tag and preview chip', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=session.jsonl');
  await page.waitForFunction(() => !!window.__table);
  const sick = () => page.evaluate(() => window.__table.sprites().filter((x) => x.sick).map((x) => x.id));

  // The opponent's Moon-Circuit Hacker resolves on turn 4: tagged until its controller's next untap.
  await page.evaluate(() => window.__table.runUntil((s) => s.stack === 0 && window.__table.sprites().some((x) => x.sick), { settle: true }));
  expect(await sick()).toEqual(['c118']);
  await page.evaluate(() => window.__table.preview('c118'));
  await expect(page.getByTestId('preview-sick')).toHaveText('zZ Summoning sick');
  await expect(page).toHaveScreenshot(`${SICK_SHOTS[0]!.name}.png`);
  await page.evaluate(() => window.__table.preview(null));

  // Still sick through my turn 5; gone once its controller untaps on turn 6.
  await page.evaluate(() => window.__table.runUntil((s) => s.turn === 5 && s.phase === 'MAIN1', { settle: true }));
  expect(await sick()).toEqual(['c118']);
  await page.evaluate(() => window.__table.runUntil((s) => s.turn === 6, { settle: true }));
  expect(await sick()).toEqual([]);
  expect(gate.errors).toEqual([]);
});

const SPLIT_SHOTS = [
  { name: '16-damage-assign', title: 'O7 DamageAssign: a trampler double-blocked, lethal to each blocker, the rest to the player' },
  { name: '17-amount-split', title: 'O7 AmountSplit: Arc Lightning divided between a creature and the player' },
  { name: '18-surveil-lanes', title: 'Surveil 2: top of library and graveyard lanes' },
];

test('replay: damage assignment, divided damage (O7) and surveil lanes', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(SPLIT_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=split.jsonl');
  await page.waitForFunction(() => !!window.__table);
  const askIs = (id: string) => page.evaluate((qid) => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === qid), { settle: true }), id);
  const amounts = () => page.locator('[data-testid^="split-amount-"]').allTextContents();
  // The split tiles and the lane cards lift (and the preview follows the pointer) on hover: the golden is the parked
  // state, so a shot parks the pointer through parkPointer() and redraws first.
  const park = () => parkPointer(page);

  // Combat: starts at Auto (2 to each Bears, the other 2 trample over).
  await askIs('q1');
  await expect(page.getByTestId('ask-split')).toBeVisible();
  expect(await amounts()).toEqual(['2', '2', '2']);
  await expect(page.getByTestId('split-left')).toHaveText('All 6 damage assigned');
  // Each tile says what it needs; the blockers have lethal, the player tramples over.
  await expect(page.getByTestId('split-hint-0')).toHaveText('lethal ✓');
  await expect(page.getByTestId('split-hint-2')).toHaveText('tramples over');
  await park();
  await expect(page).toHaveScreenshot(`${SPLIT_SHOTS[0]!.name}.png`);
  // Taking 1 off a blocker drops what the player held; the player can't take damage again until it's lethal.
  await page.getByTestId('split-less-0').click();
  expect(await amounts()).toEqual(['1', '2', '0']);
  await expect(page.getByTestId('ask-done')).toBeDisabled();
  await expect(page.getByTestId('ask-done')).toHaveText('Assign 3 more');
  await expect(page.getByTestId('split-hint-0')).toHaveText('needs 2 for lethal');
  await expect(page.getByTestId('split-hint-2')).toHaveText('only once every blocker has lethal');
  // The tile's own button: lethal first, then the rest on the last target.
  await page.getByTestId('split-act-0').click();
  expect(await amounts()).toEqual(['2', '2', '0']);
  await page.getByTestId('split-act-2').click();
  expect(await amounts()).toEqual(['2', '2', '2']);
  await page.getByTestId('split-reset').click();
  await expect(page.getByTestId('split-more-2')).toBeDisabled();
  await page.getByTestId('split-auto').click();
  expect(await amounts()).toEqual(['2', '2', '2']);
  await page.getByTestId('ask-done').click();

  // Arc Lightning: one each to start, the third point still to place.
  await askIs('q2');
  expect(await amounts()).toEqual(['1', '1']);
  await expect(page.getByTestId('ask-done')).toBeDisabled();
  await page.getByTestId('split-item-0').locator('.split-target').click();
  await expect(page.getByTestId('ask-done')).toBeEnabled();
  await park();
  await expect(page).toHaveScreenshot(`${SPLIT_SHOTS[1]!.name}.png`);
  await page.getByTestId('ask-done').click();

  // Notion Rain: surveil 2. Both start on top; a click sends one to the graveyard.
  const laneIds = (lane: string) => page.getByTestId(`lane-${lane}`).locator('.lane-face').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await askIs('q3');
  await expect(page.getByTestId('ask-arrange')).toBeVisible();
  expect(await laneIds('top')).toEqual(['ask-item-0', 'ask-item-1']);
  expect(await laneIds('graveyard')).toEqual([]);
  await page.getByTestId('ask-item-0').click();
  expect(await laneIds('graveyard')).toEqual(['ask-item-0']);
  await expect(page.getByTestId('arrange-count')).toHaveText('1 on top · 1 in the graveyard · click a card to switch');
  // The clicked tile was re-parented into another lane and may disappear before mouseleave fires.
  // Enter the remaining top tile before parking, so the preview always receives a real leave event.
  await page.getByTestId('ask-item-1').hover();
  await park();
  // This recording has no zone reveal for surveil: the arrange ask owns the cards, not a second zone strip.
  await expect(page.getByTestId('zone-strip')).toHaveCount(0);
  await expect(page.getByTestId('zone-strip-reopen')).toHaveCount(0);
  await expect(page).toHaveScreenshot(`${SPLIT_SHOTS[2]!.name}.png`);

  await page.evaluate(() => window.__table.waitForGameOver());
  expect(gate.errors).toEqual([]);
});

const AUTOPASS_SHOTS = [{ name: '19-autopass-chips', title: 'Auto-pass chips under the ladder: auto-skip off, passing until end of turn' }];

test('replay: auto-pass chips (auto-skip, pass until end of turn) and their keys', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(ZONES_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=zones.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  const skip = page.getByTestId('auto-skip');
  const pass = page.getByTestId('pass-turn');

  // Defaults: auto-skip on (nothing saved yet), not passing.
  await expect(skip).toHaveAttribute('aria-pressed', 'true');
  await expect(pass).toHaveAttribute('aria-pressed', 'false');
  await expect(pass).toHaveText('Pass turn');

  // A replay sends nothing, so the chips show the state the client asked for (the bridge confirms it live).
  await skip.click();
  await pass.click();
  await expect(skip).toHaveAttribute('aria-pressed', 'false');
  await expect(pass).toHaveAttribute('aria-pressed', 'true');
  await expect(pass).toHaveText('Passing');
  expect(await page.evaluate(() => localStorage.getItem('forge-table.autoSkip'))).toBe('0');
  await page.mouse.move(4, 4);
  const ladder = (await page.getByTestId('phase-ladder').boundingBox())!;
  const chips = (await page.getByTestId('autopass').boundingBox())!;
  const x = Math.floor(Math.min(ladder.x, chips.x)) - 8;
  const y = Math.floor(ladder.y) - 8;
  await expect(page).toHaveScreenshot(`${AUTOPASS_SHOTS[0]!.name}.png`, {
    clip: { x, y, width: Math.ceil(Math.max(ladder.x + ladder.width, chips.x + chips.width)) + 8 - x, height: Math.ceil(chips.y + chips.height) + 8 - y },
  });

  // Keys: E stops passing, S turns auto-skip back on, Shift+Space starts passing again.
  await page.keyboard.press('e');
  await expect(pass).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('s');
  await expect(skip).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('forge-table.autoSkip'))).toBe('1');
  await page.keyboard.press('Shift+Space');
  await expect(pass).toHaveAttribute('aria-pressed', 'true');
  expect(gate.errors).toEqual([]);
});

const BLOCK_SHOTS = [
  { name: '20-blocker-picked', title: 'Blocker-first: Giant Spider picked up, its blue arrow snapped to the Wind Drake (the attackers it can’t block dim)' },
  { name: '21-blocks-locked', title: 'Blocks declared: the Spider in front of the Drake, both Bears fanned in front of the Hill Giant; red and blue arrows' },
  { name: '22-combat-damage', title: 'Combat damage: attack and block arrows stay up through damage' },
];

test('replay: blocker-first blocking, combat arrows and blockers in front of their attacker', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(BLOCKS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=blocks.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const at = async (id: string) => (await page.evaluate((i) => window.__table.cardCenter(i), id))!;
  const arrows = () =>
    page.evaluate(() => {
      window.__table.redraw();
      return window.__table.arrows();
    });
  const aim = () => page.evaluate(() => window.__table.aim());

  // Declare blockers: three attackers at me draw no arrows (QA: they crossed the board); the replay holds while I
  // aim.
  await page.evaluate(() => window.__table.waitForPrompt('declareBlockers'));
  await page.evaluate(() => window.__table.pause(true));
  // (Hover is off in test mode: specs.test.ts covers the hovered arrow.)
  expect((await arrows()).filter((k) => k.startsWith('attack:'))).toEqual([]);
  // Blocker-first instructions replace Forge's attacker-first text.
  const bar = page.getByTestId('prompt-bar');
  await expect(bar).toHaveText('Pick a creature, then the attacker it blocks');

  // Click Giant Spider: picked up (client-side). Esc drops it; a second click on it drops it too.
  const spider = await at('c161');
  await page.mouse.click(spider.x, spider.y);
  expect((await aim()).selected).toBe('c161');
  await page.keyboard.press('Escape');
  expect((await aim()).selected).toBeNull();
  await page.mouse.click(spider.x, spider.y);
  expect((await aim()).selected).toBe('c161');
  // The blue arrow follows the pointer and snaps onto an attacker it can block.
  const drake = await at('c177');
  await page.mouse.move(drake.x, drake.y);
  await page.evaluate(() => window.__table.advance(400));
  expect(await arrows()).toContain('pending:block:c161');
  await expect(bar).toHaveText('Now pick an attacker for Giant Spider');
  await expect(page).toHaveScreenshot(`${BLOCK_SHOTS[0]!.name}.png`);
  await page.mouse.click(spider.x, spider.y);
  expect((await aim()).selected).toBeNull();

  // Drag: a Bear pressed and pulled past the threshold carries the arrow; dropping it on the Hill Giant blocks
  // (a replay sends nothing, so the recorded blocks follow).
  const bear = await at('c162');
  const giant = await at('c178');
  await page.mouse.move(bear.x, bear.y);
  await page.mouse.down();
  await page.mouse.move(giant.x, giant.y, { steps: 6 });
  expect((await aim()).dragging).toBe('c162');
  expect(await arrows()).toContain('pending:block:c162');
  await page.mouse.up();
  expect(await aim()).toEqual({ selected: null, dragging: null });
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.pause(false));

  // All three blocks declared (Block ×3 still to press): blockers sit in front of their attacker, two Bears fanned
  // across the Giant (the attacker row spread to make room).
  await page.evaluate(() =>
    window.__table.runUntil(
      (s) =>
        s.prompt?.kind === 'declareBlockers' &&
        ['block:c161:c177', 'block:c162:c178', 'block:c163:c178'].every((k) => window.__table.arrows().includes(k)),
      { settle: true },
    ),
  );
  const x = async (id: string) => (await at(id)).x;
  expect(Math.abs((await x('c161')) - (await x('c177')))).toBeLessThan(2);
  expect(Math.abs(((await x('c162')) + (await x('c163'))) / 2 - (await x('c178')))).toBeLessThan(2);
  await expect(page).toHaveScreenshot(`${BLOCK_SHOTS[1]!.name}.png`);

  await page.evaluate(() => window.__table.runUntil((s) => s.phase === 'COMBAT_DAMAGE', { settle: true }));
  // Blocked attackers' red arrows give way to the block arrows; the unblocked Bears still point at me.
  expect((await arrows()).filter((k) => k.startsWith('block:')).length).toBe(3);
  expect((await arrows()).filter((k) => k.startsWith('attack:'))).toEqual(['attack:c179']);
  await expect(page).toHaveScreenshot(`${BLOCK_SHOTS[2]!.name}.png`);
  expect(gate.errors).toEqual([]);
});

const TARGET_SHOTS = [
  { name: '23-target-aim', title: 'Lightning Bolt: the yellow arrow follows the cursor and snaps to the Wind Drake; what it can’t target dims' },
  { name: '24-stack-arrow', title: 'Bolt on the stack: an arrow from it to its target' },
];

test('replay: targeting arrow and stack target arrows', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(TARGETS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=targets.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const arrows = () =>
    page.evaluate(() => {
      window.__table.redraw();
      return window.__table.arrows();
    });

  await page.evaluate(() => window.__table.waitForPrompt('chooseTargets'));
  await page.evaluate(() => window.__table.pause(true));
  const drake = (await page.evaluate(() => window.__table.cardCenter('c175')))!;
  await page.mouse.move(drake.x, drake.y);
  await page.evaluate(() => window.__table.advance(400));
  expect(await arrows()).toContain('pending:target:c151');
  await expect(page).toHaveScreenshot(`${TARGET_SHOTS[0]!.name}.png`);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.pause(false));

  await page.evaluate(() => window.__table.runUntil((s) => s.stack > 0, { settle: true }));
  // As runUntil left it: another frame could already start the next step (the spell resolving) and clear the arrow.
  expect(await page.evaluate(() => window.__table.arrows())).toContain('target:c151:c175');
  await expect(page).toHaveScreenshot(`${TARGET_SHOTS[1]!.name}.png`);
  expect(gate.errors).toEqual([]);
});

/**
 * A click on a legal target while the spell waits on the stack sends the `card` act (Wild Growth's and
 * Utopia Sprawl's land targets did nothing). The stack mood's full-screen vignette sat above the cards and took every
 * hit while anything was on the stack. Bolt at a creature, an Aura at a land, an Aura at a creature; mouse and touch.
 */
const AURA_LAND_FIXTURE = path.resolve(here, '../fixtures/sessions/aura.jsonl');
const AURA_CREATURE_FIXTURE = path.resolve(here, '../fixtures/sessions/aura-creature.jsonl');

for (const { fixture, spell, target, touch } of [
  { fixture: TARGETS_FIXTURE, spell: 'Lightning Bolt at Wind Drake', target: 'c175', touch: false },
  { fixture: AURA_LAND_FIXTURE, spell: 'Wild Growth at my Forest', target: 'c163', touch: false },
  { fixture: AURA_LAND_FIXTURE, spell: 'Wild Growth at my Forest, touch', target: 'c163', touch: true },
  { fixture: AURA_CREATURE_FIXTURE, spell: 'Rancor at my Arbor Elf', target: 'c164', touch: false },
]) {
  test(`replay: clicking a legal target sends it (${spell})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 }, hasTouch: touch });
    const page = await context.newPage();
    const gate = gateConsole(page);
    await page.route(
      (u) => u.pathname.endsWith('.jsonl'),
      (route) => route.fulfill({ body: readFileSync(fixture, 'utf8'), contentType: 'application/x-ndjson' }),
    );
    await page.goto(`/?test=1&replay=${path.basename(fixture)}`);
    await page.waitForFunction(() => !!window.__table);
    await page.evaluate(() => window.__table.waitForPrompt('chooseTargets'));
    await page.evaluate(() => window.__table.pause(true));
    const s = await page.evaluate(() => window.__table.state());
    expect(s.prompt.selectable).toContain(target);
    const at = (await page.evaluate((id) => window.__table.cardCenter(id), target))!;
    if (touch) {
      await page.touchscreen.tap(at.x, at.y);
    } else {
      await page.mouse.move(at.x, at.y);
      await page.evaluate(() => window.__table.advance(100));
      await page.mouse.click(at.x, at.y);
    }
    await page.evaluate(() => window.__table.advance(100));
    expect(await page.evaluate(() => window.__table.acts())).toContainEqual({ t: 'act', pid: s.prompt.pid, kind: 'card', card: target });
    expect(gate.errors).toEqual([]);
    await context.close();
  });
}

const MANA_SHOTS = [
  { name: '25-x-picker', title: 'Fireball, choose X: the X picker at 12, past the old nine-stop list (−5 −1 +1 +5, Min chip), the total cost {12}{R} live' },
  { name: '26-mana-picker', title: 'Paying {3}{R}: Stomping Ground’s two abilities as red / green orbs fanned over it; the cost tracker' },
  { name: '27-cost-tracker', title: 'Red paid: the cost tracker at {3}, the lands that can pay glowing' },
  { name: '28-mana-colors', title: 'City of Brass: any colour, five orbs over the cost being paid' },
  { name: '29-mana-two-colors', title: 'Adarkar Wastes: white or blue (Forge’s confirm prompt) as two orbs over the land' },
];

test('replay: X picker, mana picker and cost tracker', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(MANA_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=mana.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const askIs = (id: string) => page.evaluate((qid) => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === qid), { settle: true }), id);
  const value = page.getByTestId('xpick-value');

  // Choose X for Fireball: 0..9 and "Other..." become the dial; Fireball's {X}{R} totals live.
  await askIs('q1');
  await expect(page.getByTestId('ask-number')).toBeVisible();
  await expect(page.getByTestId('ask-options')).toHaveCount(0);
  await expect(value).toHaveText('X =0');
  await page.keyboard.press('ArrowRight');
  await page.getByTestId('xpick-more').click();
  await page.keyboard.press('ArrowUp');
  await expect(value).toHaveText('X =3');
  await expect(page.getByTestId('xpick-cost')).toHaveAttribute('aria-label', 'Total cost {3}{R}');
  await expect(page.getByTestId('ask-done')).toHaveText('X = 3');
  // No slider and no cap: +5 carries on past the listed 0..9 (Other... then the digits), the cost follows.
  await page.getByTestId('xpick-more5').click();
  await page.getByTestId('xpick-more5').click();
  await page.getByTestId('xpick-less').click();
  await expect(value).toHaveText('X =12');
  await expect(page.getByTestId('xpick-cost')).toHaveAttribute('aria-label', 'Total cost {12}{R}');
  await expect(page.getByTestId('xpick-max')).toHaveCount(0);
  await expect(page.getByTestId('xpick-track')).toHaveCount(0);
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${MANA_SHOTS[0]!.name}.png`);
  // Typing runs digits together; PgUp / PgDn step by 5; Home goes to the min (an "Other..." list has no End).
  await page.keyboard.type('105');
  await expect(value).toHaveText('X =105');
  await page.keyboard.press('PageDown');
  await expect(value).toHaveText('X =100');
  await page.keyboard.press('Home');
  await expect(value).toHaveText('X =0');
  await page.keyboard.press('PageUp');
  await expect(value).toHaveText('X =5');

  // Paying: the dual land's ability menu is two orbs over it, hotkeyed R / G; the cost tracker shows {3}{R}.
  await askIs('q2');
  const picker = page.getByTestId('mana-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('ask-carousel')).toHaveCount(0);
  await expect(page.getByTestId('mana-option-0')).toHaveAttribute('aria-label', 'Add red mana');
  await expect(page.getByTestId('mana-option-1')).toHaveAttribute('aria-label', 'Add green mana');
  await expect(page.getByTestId('mana-option-0')).toHaveAttribute('aria-keyshortcuts', 'R 1');
  await expect(page.getByTestId('cost-tracker')).toHaveAttribute('aria-label', 'Mana left to pay: 3 generic, red');
  // The fan sits over Stomping Ground.
  const land = (await page.evaluate(() => window.__table.cardCenter('c43')))!;
  const orb = (await page.getByTestId('mana-option-0').boundingBox())!;
  expect(Math.abs(orb.x + orb.width / 2 - land.x)).toBeLessThan(160);
  expect(orb.y + orb.height / 2).toBeLessThan(land.y);
  await expect(page).toHaveScreenshot(`${MANA_SHOTS[1]!.name}.png`);

  // Red paid: one pip fewer, the lands that can still pay glow.
  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.message === 'Pay Mana Cost: {3}' && s.asks.length === 0, { settle: true }));
  await expect(page.getByTestId('cost-tracker')).toHaveAttribute('aria-label', 'Mana left to pay: 3 generic');
  await expect(page.locator('[data-testid^="cost-pip-"]')).toHaveCount(1);
  await expect(page).toHaveScreenshot(`${MANA_SHOTS[2]!.name}.png`);

  // City of Brass: Forge's colour enum as five orbs (no source card: over the cost tracker).
  await askIs('q3');
  await expect(page.locator('[data-testid^="mana-option-"]')).toHaveCount(5);
  await expect(page.getByTestId('mana-option-3')).toHaveAttribute('aria-label', 'Add red mana');
  await expect(page).toHaveScreenshot(`${MANA_SHOTS[3]!.name}.png`);

  // Adarkar Wastes: two colours arrive as a confirm prompt; the orbs press its buttons. Esc never picks one.
  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.kind === 'confirm', { settle: true }));
  const two = page.getByTestId('mana-prompt-picker');
  await expect(two).toBeVisible();
  await expect(two.locator('[data-testid^="mana-option-"]')).toHaveCount(2);
  await expect(page.getByTestId('mana-option-1')).toHaveAttribute('aria-label', 'Add blue mana');
  await page.keyboard.press('Escape');
  await expect(two).toBeVisible();
  await expect(page).toHaveScreenshot(`${MANA_SHOTS[4]!.name}.png`);

  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === 4, { settle: true }));
  await expect(page.getByTestId('cost-tracker')).toHaveCount(0);
  expect(gate.errors).toEqual([]);
});

const PEEK_SHOTS = [
  { name: '36-battlefield-peek', title: 'Show battlefield: the scry put away (selections kept), the table in view, the ember “Return to scry” pill top centre' },
];

test('replay: show battlefield (the toggle, the Return pill, V / Esc, hold Space to peek)', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(CHOOSERS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=choosers.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === 'q1'), { settle: true }));
  const layer = page.getByTestId('ask-layer');
  const toggle = page.getByTestId('peek-toggle');
  const laneIds = (lane: string) => page.getByTestId(`lane-${lane}`).locator('.lane-face').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await expect(toggle).toHaveText(/^Show battlefield/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // A selection made before putting the scry away is still there when it comes back.
  await page.getByTestId('ask-item-0').click();
  expect(await laneIds('bottom')).toEqual(['ask-item-0']);
  await toggle.click();
  await expect(layer).toHaveClass(/\bpeek-hidden\b/);
  await expect(layer).toBeHidden();
  await expect(toggle).toHaveText('Return to scry');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Away, the scry takes no keys (Enter would have answered it).
  await page.keyboard.press('Enter');
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${PEEK_SHOTS[0]!.name}.png`);
  await toggle.click();
  await expect(layer).toBeVisible();
  await expect(layer).not.toHaveClass(/\bpeek-hidden\b/);
  expect(await laneIds('bottom')).toEqual(['ask-item-0']);
  expect(await laneIds('top')).toEqual(['ask-item-1']);
  // V toggles, Esc brings it back.
  await page.keyboard.press('v');
  await expect(layer).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(layer).toBeVisible();
  // Holding Space peeks: away while held, back on release; a tap is not a peek (with nothing focused: a tap on the
  // focused toggle presses it, as Space on any button does).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down(' ');
  await expect(layer).toBeHidden();
  await expect(toggle).toHaveText('Release Space to return');
  await page.keyboard.up(' ');
  await expect(layer).toBeVisible();
  await page.keyboard.press(' ');
  await expect(layer).toBeVisible();
  expect(await laneIds('bottom')).toEqual(['ask-item-0']);
  // The answer is the same act as ever.
  await page.getByTestId('ask-done').click();

  // The next ask comes up shown (a new prompt is never hidden); the zone strip has the toggle too.
  await page.evaluate(() => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === 'q2'), { settle: true }));
  await expect(page.getByTestId('ask-order-lanes')).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('ask-order-lanes')).toBeHidden();
  await toggle.click();
  await page.getByTestId('ask-done').click();
  await page.evaluate(() => window.__table.waitForPrompt('selectEntities'));
  const strip = page.getByTestId('zone-strip');
  await expect(strip).toBeVisible();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(strip).toBeHidden();
  await expect(toggle).toContainText('Return to your library');
  await toggle.click();
  await expect(strip).toBeVisible();
  expect(gate.errors).toEqual([]);
});

const STACK_SHOTS = [
  { name: '32-deep-stack', title: 'Twelve on the stack: the cascade shows five (newest in front, older up and left, darker), "+7" on the deepest, the Stack · 12 pill' },
  { name: '33-stack-ability', title: 'Bolt and Kessig’s trigger: the trigger as an ability card in front, Bolt behind it; Resolve names the top item' },
  { name: '34-stack-three', title: 'The opponent’s Counterspell on top, its arrow to the Bolt; the Bolt’s target ring on the Sprite' },
  { name: '35-stack-ping', title: 'Prodigal Pyromancer’s ability card on the stack, its arrow to the opponent' },
  { name: '37-stack-loud', title: 'The louder stack on a 1366×768 laptop: the big front card right-centre, the ember glow and edge vignette, the focus ripple while I hold priority; the rows clear of it' },
];

test('replay: the stack zone (cascade, ability cards, deep stack)', async ({ page }) => {
  const gate = gateConsole(page);
  const fixture = { current: DEEP_STACK_FIXTURE };
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(fixture.current, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=deep.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  expect((await page.evaluate(() => window.__table.state())).stack).toBe(12);
  await expect(page.getByTestId('stack-head')).toHaveText('Stack · 12');
  await expect(page).toHaveScreenshot(`${STACK_SHOTS[0]!.name}.png`);

  fixture.current = STACK_FIXTURE;
  await page.goto('/?test=1&replay=stack.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const atPrompt = (pid: number) => page.evaluate((n) => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === n, { settle: true }), pid);
  await atPrompt(1);
  // The trigger is an ability card (virtual id ab:<item>) in front of the Bolt; the primary button names it.
  const sprites = async () => (await page.evaluate(() => window.__table.sprites())).map((x) => x.id);
  expect(await sprites()).toContain('ab:i2');
  await expect(page.getByTestId('primary')).toContainText('Kessig Flamebreather ability');
  await expect(page).toHaveScreenshot(`${STACK_SHOTS[1]!.name}.png`);
  await atPrompt(2);
  expect(await page.evaluate(() => window.__table.arrows())).toContain('target:c116:c112');
  await expect(page).toHaveScreenshot(`${STACK_SHOTS[2]!.name}.png`);
  // The same moment on a laptop: the bigger stack still fits, clear of the front rows.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForFunction(() => window.innerWidth === 1366);
  // The resize handler clears the Pixi canvas; wait for it, then draw, so the shot never catches a blank canvas.
  await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).some((c) => c.width === 1366));
  await page.evaluate(() => window.__table.advance(100));
  await page.evaluate(() => window.__table.redraw());
  await expect(page).toHaveScreenshot(`${STACK_SHOTS[4]!.name}.png`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction(() => window.innerWidth === 1920);
  // The resize handler clears the Pixi canvas; wait for it, then draw, so the shot never catches a blank canvas.
  await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).some((c) => c.width === 1920));
  await page.evaluate(() => window.__table.advance(100));
  await page.evaluate(() => window.__table.redraw());
  await atPrompt(5);
  expect(await page.evaluate(() => window.__table.arrows())).toContain('target:ab:i4:p1');
  await expect(page).toHaveScreenshot(`${STACK_SHOTS[3]!.name}.png`);
  await atPrompt(10);
  // Everything left the stack: no ability cards linger, the pill is gone.
  expect((await sprites()).filter((id) => id.startsWith('ab:'))).toEqual([]);
  await expect(page.getByTestId('stack-list')).toHaveCount(0);
  expect(gate.errors).toEqual([]);
});

const ALT_SHOTS = [
  { name: '42-castable-from-exile-gy', title: 'Five castables outside the hand in a strip beside it: the commander, a flashback, a foretold, a plotted and an adventure card, each glowing in its zone\'s colour with its alternate cost (no chips)' },
  { name: '43-ninjutsu', title: 'Declare blockers, no block: the Ninja in hand glows violet with its ninjutsu cost' },
];

test('replay: castables outside the hand (alt-zone strip) and the ninjutsu cue', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(ALT_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=alt.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const atPrompt = (n: number) => page.evaluate((pid) => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === pid, { settle: true }), n);
  const strip = async () => (await page.evaluate(() => window.__table.state())).alt as Array<{ id: string; label: string; cost: string | null }>;

  await atPrompt(1);
  expect((await strip()).map((a) => [a.label, a.cost])).toEqual([
    ['Command zone', null],
    ['Graveyard · Flashback', '{2}{R}'],
    ['Exile · Foretold', '{R}'],
    ['Exile · Plotted', '{0}'],
    ['Exile · On an adventure', null],
  ]);
  await expect(page).toHaveScreenshot(`${ALT_SHOTS[0]!.name}.png`);

  // A laptop and a phone: every card of the strip is on screen (scratch shots in tests/output, not goldens).
  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  await page.evaluate(() => window.__table.pause(true));
  for (const [w, h] of [[1366, 768], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__table.advance(600));
    await page.evaluate(() => window.__table.redraw());
    expect(await strip()).toHaveLength(5);
    for (const a of await strip()) {
      const c = await page.evaluate((id) => window.__table.cardCenter(id), a.id);
      expect(c, `${a.label} at ${w}x${h}`).not.toBeNull();
      expect(c!.x).toBeGreaterThan(0);
      expect(c!.x).toBeLessThan(w);
      expect(c!.y).toBeLessThan(h);
    }
    writeFileSync(path.join(OUT, 'shots', `alt-${w}x${h}.png`), await page.screenshot());
  }
  // Hovering one (a touch pin alike) says where it waits, in a grey line above its preview; nothing on the table does.
  for (const [w, h] of [[1920, 1080], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__table.advance(600));
    await page.evaluate(() => window.__table.redraw());
    const fb = (await strip())[1]!.id;
    await page.evaluate((id) => window.__table.preview(id), fb);
    await expect(page.getByTestId('preview-from')).toHaveText('Graveyard · Flashback');
    writeFileSync(path.join(OUT, 'shots', `alt-preview-${w}x${h}.png`), await page.screenshot());
    await page.evaluate(() => window.__table.preview(null));
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => window.__table.pause(false));

  // Flashing back the Looting takes it out of the strip.
  await atPrompt(3);
  expect((await strip()).map((a) => a.label)).toEqual(['Command zone', 'Exile · Foretold', 'Exile · Plotted', 'Exile · On an adventure']);

  // Declare blockers: the strip is empty (the ninja is a hand card), and the cue (violet glow, ninjutsu cost) shows on the Ninja.
  await atPrompt(4);
  expect(await strip()).toEqual([]);
  expect(await page.evaluate(() => window.__table.sprites().find((x) => x.id === 'c115'))).toMatchObject({ cost: '{1}{U}' });
  await expect(page).toHaveScreenshot(`${ALT_SHOTS[1]!.name}.png`);

  await page.evaluate(() => window.__table.waitForGameOver().catch(() => undefined));
  expect(gate.errors).toEqual([]);
});

/** A Brawl game (tests/fixtures/states/brawl.txt): Fynn cast from the command zone, Bolted, back in the command zone. */
const BRAWL_FIXTURE = path.resolve(here, '../fixtures/sessions/brawl.jsonl');
const BRAWL_SHOTS = [
  { name: '47-brawl-command-zones', title: 'Brawl, the mulligan: my commander waits dimmed in the strip beside my hand (like flashback), the opponent\'s on the pile beside their plate' },
  { name: '48-brawl-castable', title: 'Brawl first on the status line; my commander castable in the strip beside my hand, glowing in the command zone\'s colour (printed cost)' },
  { name: '49-brawl-on-battlefield', title: 'My commander on the battlefield: the strip beside my hand empty' },
  { name: '50-brawl-tax', title: 'Back in the command zone after one cast: its cost shows the tax ({1}{G} → {3}{G}), dimmed in the strip and in its preview' },
];

test('replay: Brawl command zones, the commander cast and its tax as a modified cost', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(BRAWL_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=brawl.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const atPrompt = (n: number) => page.evaluate((pid) => window.__table.runUntil((s) => s.prompt?.pid === pid, { settle: true }), n);
  const sprite = (id: string) => page.evaluate((c) => window.__table.sprites().find((x) => x.id === c), id);

  // The mulligan: my commander (Fynn) waiting in the strip beside my hand, the opponent's (Krenko) on their pile.
  await page.evaluate(() => window.__table.waitForPrompt('mulligan'));
  for (const id of ['c100', 'c201']) expect(await page.evaluate((x) => window.__table.cardCenter(x), id), id).not.toBeNull();
  await expect(page).toHaveScreenshot(`${BRAWL_SHOTS[0]!.name}.png`);

  // The board state: my Fynn castable from the command zone at its printed cost, the Brawl label on.
  await atPrompt(5);
  expect((await page.evaluate(() => window.__table.state())).alt).toEqual([{ id: 'c220', label: 'Command zone', cost: null }]);
  await expect(page.getByTestId('format-tag')).toHaveText('Brawl');
  await expect(page).toHaveScreenshot(`${BRAWL_SHOTS[1]!.name}.png`);

  await atPrompt(11);
  expect((await page.evaluate(() => window.__table.state())).players.p0.battlefield).toContain('c220');
  await expect(page).toHaveScreenshot(`${BRAWL_SHOTS[2]!.name}.png`);

  // Bolted, back in the command zone, too dear to recast: it waits dimmed in the strip with its tax in its cost.
  await atPrompt(19);
  expect((await page.evaluate(() => window.__table.state())).alt).toEqual([{ id: 'c220', label: 'Command zone', cost: '{3}{G}' }]);
  expect(await sprite('c220')).toMatchObject({ cost: '{3}{G}' });
  // Its preview says it big: {3}{G} in the cost slot, the printed {1}{G} struck through under it.
  await page.evaluate(() => window.__table.preview('c220'));
  await expect(page.locator('.preview')).toBeVisible();
  await expect(page).toHaveScreenshot(`${BRAWL_SHOTS[3]!.name}.png`);
  await page.evaluate(() => window.__table.preview(null));

  // A phone each way: the command zones on screen (scratch shots in tests/output, not goldens).
  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  await page.evaluate(() => window.__table.pause(true));
  for (const [w, h] of [[390, 844], [844, 390], [1366, 768]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__table.advance(600));
    await page.evaluate(() => window.__table.redraw());
    for (const id of ['c220', 'c238']) {
      const c = await page.evaluate((x) => window.__table.cardCenter(x), id);
      expect(c, `${id} at ${w}x${h}`).not.toBeNull();
      expect(c!.x).toBeGreaterThan(0);
      expect(c!.x).toBeLessThan(w);
      expect(c!.y).toBeGreaterThan(0);
      expect(c!.y).toBeLessThan(h);
    }
    writeFileSync(path.join(OUT, 'shots', `brawl-${w}x${h}.png`), await page.screenshot());
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => window.__table.pause(false));

  await page.evaluate(() => window.__table.waitForGameOver().catch(() => undefined));
  expect(gate.errors).toEqual([]);
});

/**
 * Framed art mode draws the M15 face (cards/m15). A replay never loads art, so the test turns the crop loader on
 * (`__table.framed`) and serves a synthetic art crop (a gradient with a sun) at /img/crop/<imageKey> in place of the sidecar.
 */
const FRAMED_SHOTS = [
  { name: '51-framed-hand-costs', title: 'Framed art mode, hand: the M15 face on every card; reduced, taxed, longer and hybrid costs show their current cost in the name plate (green cheaper, red dearer), the unchanged one its printed cost' },
  { name: '52-framed-preview-cost', title: 'Framed art mode, preview: the M15 face big, the changed cost in its slot with the printed cost struck through under it' },
  { name: '53-framed-battlefield', title: 'Framed art mode, battlefield: M15 creatures (a buffed creature\'s P/T plate lit green), a planeswalker with its loyalty, lands' },
  { name: '54-framed-stack-ability', title: 'Framed art mode, stack: Kessig\'s trigger as an M15 ability card (its frame and art, "Triggered Ability", the trigger\'s text) in front of the M15 Bolt' },
  { name: '55-framed-stack-ping', title: 'Framed art mode, stack: Prodigal Pyromancer\'s activated ability as an M15 ability card, its arrow to the opponent' },
  { name: '56-framed-counters', title: 'Framed art mode, counters and damage as frame elements: counter plates on the frame\'s left edge, damage on the P/T plate, the ×N group tab' },  { name: '57-framed-keywords', title: 'Framed art mode, gained keywords as icons down the art\'s left edge (none for printed ones), "+N" past what fits' },
  { name: '58-ambient-keywords', title: 'Ambient keywords: indestructible\'s steel sheen mid-pass (Grizzly Bears), trample\'s green stomp under the bottom edge (Grizzly Bears, Colossal Dreadmaw), deathtouch\'s violet haze and lifelink\'s pulse ringing out (Serra Angel)' },
  { name: '59-framed-hand-fanned', title: 'Framed art mode, a 15-card hand fanned and tilted at rest: the M15 frame\'s rules text sharp on every card, not mip-blurred' },
  { name: '60-framed-tokens', title: 'Framed art mode, combat: a vanilla Goblin token attacking and a vanilla Faerie Rogue token blocking, both clear art the whole way down with no empty rules box' },
];
/** A framed golden's file name, looked up by its number (not its index in FRAMED_SHOTS). */
const framedShot = (n: number) => `${FRAMED_SHOTS.find((s) => s.name.startsWith(`${n}-`))!.name}.png`;

/** Serve a synthetic art crop at /img/crop/<imageKey>; returns the paths served. */
async function serveCrops(page: Page): Promise<Set<string>> {
  const art = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 626;
    c.height = 457;
    const g = c.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 457);
    sky.addColorStop(0, '#2d4a7a');
    sky.addColorStop(0.6, '#d98e4a');
    sky.addColorStop(1, '#3a2a22');
    g.fillStyle = sky;
    g.fillRect(0, 0, 626, 457);
    g.fillStyle = '#ffd98a';
    g.beginPath();
    g.arc(430, 170, 70, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1c1714';
    g.beginPath();
    g.moveTo(0, 457);
    g.lineTo(150, 260);
    g.lineTo(300, 380);
    g.lineTo(470, 230);
    g.lineTo(626, 457);
    g.fill();
    return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  });
  const served = new Set<string>();
  await page.route('**/img/crop/**', (route) => {
    served.add(new URL(route.request().url()).pathname);
    return route.fulfill({ body: Buffer.from(art, 'base64'), contentType: 'image/png', headers: { 'X-Card-Artist': 'Test%20Artist' } });
  });
  return served;
}

async function openFramed(page: Page, fixture: string, imageKeys: string[], minFramed: number): Promise<void> {
  const text = readFileSync(path.resolve(here, `../fixtures/sessions/${fixture}.jsonl`), 'utf8');
  await page.route((u) => u.pathname.endsWith('.jsonl'), (route) => route.fulfill({ body: text, contentType: 'application/x-ndjson' }));
  await page.goto(`/?test=1&replay=${fixture}.jsonl`);
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const served = await serveCrops(page);
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  await page.evaluate(() => window.__table.framed(true));
  // Fonts and crops arrive on real time; the table only moves on the virtual clock: step it until every face is the M15 one.
  const want = new Set(imageKeys);
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.__table.advance(100));
    await page.waitForTimeout(60);
    const sprites = await page.evaluate(() => window.__table.sprites());
    if (served.size >= want.size && sprites.filter((s) => s.framed).length >= minFramed) break;
  }
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__table.advance(400));
  await page.evaluate(() => window.__table.settle());
  // How long the fonts and crops took decides the virtual time here: step on to a fixed one, so the looping ambient
  // motion (a flyer's bob, lifelink's pulse, indestructible's sheen) is drawn at the same moment every run.
  const now = await page.evaluate(() => window.__table.now());
  expect(now).toBeLessThan(FRAMED_AT);
  await page.evaluate((ms) => window.__table.advance(ms), FRAMED_AT - now);
}
/** The virtual time every framed golden is shot at (ms). */
const FRAMED_AT = 62_000;

test('replay: Framed art mode draws the M15 face; changed costs and buffed P/T show on it', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'stress-costs', ['Tolarian Terror', 'Lightning Bolt', 'Frogmite', 'Fireblast', 'Kitchen Finks', 'Nicol Bolas, the Ravager', 'Wildest Dreams of Esper'], 10);
  const hand = await page.evaluate(() => window.__table.sprites().filter((s) => s.cost));
  // Six hand cards carry a changed cost (the seventh, Fireblast, is the unchanged control).
  expect(hand.map((s) => s.cost).sort()).toEqual(['{0}', '{1}{R}', '{3}{U}', '{3}{U}{B}{R}', '{G/W}{G/W}', '{X}{X}{1}{W}{U}{B}'].sort());
  expect((await page.evaluate(() => window.__table.sprites())).filter((s) => s.framed).length).toBeGreaterThanOrEqual(10);
  await expect(page).toHaveScreenshot(framedShot(51));

  // The preview: a changed cost in the M15 name plate, the printed one struck through under it.
  const cheap = await page.evaluate(() => window.__table.sprites().find((s) => s.cost === '{3}{U}')!.id);
  await page.evaluate((id) => window.__table.preview(id), cheap);
  await expect(page.locator('.preview')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot(framedShot(52));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode on the battlefield (buffed creature, planeswalker, lands)', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'stress-attach', [], 10);
  const sprites = await page.evaluate(() => window.__table.sprites());
  expect(sprites.filter((s) => s.framed).length).toBeGreaterThan(10);
  expect(sprites.some((s) => s.art)).toBe(false);
  await expect(page).toHaveScreenshot(framedShot(53));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode on the stack (ability cards in the M15 frame)', async ({ page }) => {
  const gate = gateConsole(page);
  const text = readFileSync(STACK_FIXTURE, 'utf8');
  await page.route((u) => u.pathname.endsWith('.jsonl'), (route) => route.fulfill({ body: text, contentType: 'application/x-ndjson' }));
  await serveCrops(page);
  await page.goto('/?test=1&replay=stack.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  // Framed on (its fonts loaded) at the first prompt, before the stack.
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  await page.evaluate(() => window.__table.framed(true));
  const atPrompt = (pid: number) => page.evaluate((n) => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === n, { settle: true }), pid);
  await atPrompt(1);
  expect((await page.evaluate(() => window.__table.sprites())).map((x) => x.id)).toContain('ab:i2');
  await expect(page).toHaveScreenshot(framedShot(54));
  await atPrompt(5);
  expect(await page.evaluate(() => window.__table.arrows())).toContain('target:ab:i4:p1');
  await expect(page).toHaveScreenshot(framedShot(55));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode draws counters and damage as frame elements', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'stress-counters', [], 8);
  await expect(page).toHaveScreenshot(framedShot(56));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode shows gained keywords as icons on the frame', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'framed-keywords', [], 8);
  await expect(page).toHaveScreenshot(framedShot(57));
  expect(gate.errors).toEqual([]);
});

test('replay: indestructible, deathtouch and lifelink have their ambient touches', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'framed-keywords', [], 8);
  // On to Grizzly Bears' (s74) sheen, 30% into the pass (table/ambientFx.ts sheenAt: its phase puts it 2878 ms past a pass).
  await page.evaluate(() => window.__table.advance(5512));
  await expect(page).toHaveScreenshot(framedShot(58));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode keeps a fanned hand\'s rules text sharp', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'stress-hand', [], 12);
  const sprites = await page.evaluate(() => window.__table.sprites());
  expect(sprites.filter((s) => s.framed).length).toBeGreaterThanOrEqual(12);
  await expect(page).toHaveScreenshot(framedShot(59));
  expect(gate.errors).toEqual([]);
});

test('replay: Framed art mode draws a token\'s tall art window, clear of an empty rules box', async ({ page }) => {
  const gate = gateConsole(page);
  await openFramed(page, 'stress-combat', [], 10);
  const sprites = await page.evaluate(() => window.__table.sprites());
  expect(sprites.filter((s) => s.framed).length).toBeGreaterThanOrEqual(10);
  await expect(page).toHaveScreenshot(framedShot(60));
  expect(gate.errors).toEqual([]);
});

const LASTING_SHOTS = [
  {
    name: '61-lasting-rail',
    title: 'Lasting effects beside the plates (The Monarch, Undercity, an emblem, a lasting effect; theirs: The Initiative, an emblem), Darksteel Myr’s resting indestructible sheen, combat open in the phase strip',
  },
  { name: '62-lasting-dungeon', title: 'Hovering Undercity: its rooms by depth, the Forge lit, what that room does' },
  { name: '63-lasting-effect', title: 'Hovering Spirit Water Revival’s effect: no maximum hand size for the rest of the game' },
];

test('replay: lasting effects beside the plates and their previews; the phase strip opens the part the turn is in', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(LASTING_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=lasting.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  await page.evaluate(() => window.__table.pause(true));

  // Ids as make-lasting.mjs deals them: mine c109 Spirit Water Revival's effect, c110 Undercity, c111 Elspeth's emblem,
  // c112 The Monarch; theirs c113 The Initiative, c114 Chandra's emblem. Markers first, then dungeons, emblems, effects.
  const rail = (who: string) => page.getByTestId(`lasting-${who}`).locator('.lasting').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(await rail('me')).toEqual(['lasting-card-c112', 'lasting-card-c110', 'lasting-card-c111', 'lasting-card-c109']);
  expect(await rail('opp')).toEqual(['lasting-card-c113', 'lasting-card-c114']);
  // The turn is in combat (declare attackers): combat shows its steps, the other parts are single icons.
  await expect(page.locator('[data-phase-group="combat"]')).toHaveAttribute('data-expanded', 'true');
  await expect(page.locator('[data-phase-group="beginning"]')).toHaveAttribute('data-expanded', 'false');
  await expect(page.locator('.rung-label.current.mine')).toHaveAttribute('aria-label', 'Attackers');
  // The sheen pass is between passes here: what shows on the Myr is the resting sheen alone.
  await page.evaluate(() => window.__table.advance(900));
  await expect(page).toHaveScreenshot(`${LASTING_SHOTS[0]!.name}.png`);

  await page.getByTestId('lasting-card-c110').hover();
  await expect(page.getByTestId('dungeon-map')).toBeVisible();
  await expect(page.locator('.dungeon-room.here')).toHaveText('Forge');
  await expect(page.getByTestId('lasting-preview')).toContainText('Put two +1/+1 counters on target creature.');
  await expect(page).toHaveScreenshot(`${LASTING_SHOTS[1]!.name}.png`);

  await page.getByTestId('lasting-card-c109').hover();
  await expect(page.getByTestId('lasting-preview')).toContainText('You have no maximum hand size for the rest of the game.');
  await expect(page).toHaveScreenshot(`${LASTING_SHOTS[2]!.name}.png`);

  // Hovering a closed part opens it to its steps (to set a step's stop), and leaving closes it again.
  await page.locator('[data-phase-group="end"]').hover();
  await expect(page.locator('[data-phase-group="end"]')).toHaveAttribute('data-expanded', 'true');
  await page.mouse.move(4, 4);
  await expect(page.locator('[data-phase-group="end"]')).toHaveAttribute('data-expanded', 'false');
  // Their stops on the closed beginning part: none of its two steps, so its pip is off; the end part's is half lit.
  await expect(page.locator('[data-phase-group="beginning"] .pg-head .rung.opp')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-phase-group="end"] .pg-head .rung.opp')).toHaveAttribute('aria-pressed', 'mixed');
  expect(gate.errors).toEqual([]);
});

const PROMPT_SHOTS = [
  { name: '64-mode-cards', title: "Kolaghan's Command: one card per mode, each the Command with only that mode in its text box, 1–4 keys (B2)" },
  { name: '65-confirm-question', title: "Ninja of the Deep Hours' optional trigger: the question as the title, the card, Yes as the Enter default (B6)" },
  { name: '66-library-search', title: "Wooded Foothills: the three cards you can take first with 1–3 keys, the other 19 folded away; search, type chips, sort (B3)" },
];

test('replay: mode tiles and confirms in the prompt frame', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(PROMPTS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=prompts.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const askIs = (id: string) => page.evaluate((qid) => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === qid), { settle: true }), id);

  // "Choose a mode": a card per mode, not the option list; the head names the card, the engine's sentence is gone.
  await askIs('m1');
  const modes = page.getByTestId('ask-option-cards');
  await expect(modes).toBeVisible();
  await expect(page.getByTestId('ask-options')).toHaveCount(0);
  await expect(page.getByTestId('ask-preview')).toHaveCount(0);
  await expect(modes.locator('h2')).toHaveText('Choose a mode');
  await expect(modes).not.toContainText('activated');
  await expect(modes.locator('.option-card')).toHaveCount(4);
  await expect(page.getByTestId('ask-item-1')).toHaveAccessibleName('Target player discards a card.');
  await expect(page).toHaveScreenshot(`${PROMPT_SHOTS[0]!.name}.png`);
  // A key picks (cyan ring), Enter confirms; the second mode is a second ask over the rest.
  await page.keyboard.press('2');
  await expect(page.getByTestId('ask-pick-1')).toBeVisible();
  await expect(page.getByTestId('ask-done')).toHaveText('Choose mode');
  await page.keyboard.press('Enter');
  await askIs('m2');
  await expect(modes.locator('.option-card')).toHaveCount(3);
  // A click picks, a second click on the same card confirms.
  await page.getByTestId('ask-item-0').click();
  await page.getByTestId('ask-item-0').click();

  // The optional trigger: the question is the title (no card id), the reminder under it, Yes is the Enter default.
  await askIs('c1');
  const confirm = page.getByTestId('ask-confirm');
  await expect(confirm.locator('h2')).toHaveText('Use triggered ability of Ninja of the Deep Hours?');
  await expect(confirm.locator('.msg')).toContainText('you may draw a card');
  await expect(page.getByTestId('ask-option-0')).toHaveClass(/default/);
  await expect(page.getByTestId('ask-option-0').locator('kbd')).toHaveText('Enter');
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${PROMPT_SHOTS[1]!.name}.png`);
  // Space no longer answers; Enter takes the default.
  await page.keyboard.press(' ');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Enter');

  // A library search: the three cards you can take come first with 1–3 on them; the 19 others fold into a shelf.
  await askIs('s1');
  const search = page.getByTestId('ask-carousel');
  const main = search.locator('.carousel').first().locator('.carousel-item');
  await expect(main).toHaveCount(3);
  await expect(search.locator('.grid-key')).toHaveText(['1', '2', '3']);
  await expect(page.getByTestId('ask-shelf-toggle')).toContainText('19 cards you can’t pick here');
  await expect(page.getByTestId('ask-shelf').locator('.carousel-item')).toHaveCount(0);
  await expect(page.getByTestId('grid-chip-land')).toContainText('8');
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${PROMPT_SHOTS[2]!.name}.png`);
  // Search by name, text or type line: "mountain" keeps Sacred Foundry and Mountain, and four on the shelf.
  await page.keyboard.press('/');
  await page.keyboard.type('mountain');
  await expect(main).toHaveCount(2);
  await page.getByTestId('ask-shelf-toggle').click();
  await expect(page.getByTestId('ask-shelf').locator('.carousel-item')).toHaveCount(4);
  // Esc in the box clears the search (outside it, Esc would answer "find nothing").
  await page.getByTestId('ask-grid-bar-search').focus();
  await page.keyboard.press('Escape');
  await expect(search).toBeVisible();
  await expect(main).toHaveCount(3);
  // Lands only, sorted by name.
  await page.getByTestId('grid-chip-land').click();
  await expect(page.getByTestId('ask-shelf').locator('.carousel-item')).toHaveCount(5);
  await page.getByTestId('ask-grid-bar-sort').click();
  await page.getByTestId('ask-grid-bar-sort-name').click();
  await expect(page.getByTestId('ask-grid-bar-sort')).toContainText('Name');
  await expect(main.first()).toHaveAttribute('aria-label', 'Mountain');
  // A key picks the card it's on; Enter answers.
  await page.mouse.move(4, 4);
  await page.keyboard.press('1');
  await expect(page.getByTestId('ask-pick-13')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  expect(gate.errors).toEqual([]);
});

/** One card's options as cards (synthetic: tests/fixtures/make-select.mjs). */
const SELECT_FIXTURE = path.resolve(here, '../fixtures/sessions/select.jsonl');
const SELECT_SHOTS = [
  { name: '72-option-cards-alt-cost', title: "Land Grant's two ways to cast it as two Land Grants: printed cost and the search, or no cost with \"reveal your hand\" leading the text box; captions Cast / Alternative cost; the second picked" },
];

test('replay: one card\'s options as cards (abilities, ways to cast, several picks)', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(SELECT_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=select.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const askIs = (id: string) => page.evaluate((qid) => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === qid), { settle: true }), id);
  const cards = page.getByTestId('ask-option-cards');
  // A replay drops replies; an answered ask stops taking input until the next one comes up.
  const answered = () => expect(page.getByTestId('ask-layer')).toHaveCSS('pointer-events', 'none');

  // Land Grant: a card per way to cast it; no initials tile in the head, no side preview.
  await askIs('a1');
  await expect(cards.locator('.option-card')).toHaveCount(2);
  await expect(cards.getByTestId('pf-source')).toHaveCount(0);
  await expect(page.getByTestId('ask-preview')).toHaveCount(0);
  await expect(cards.locator('.oc-caption')).toHaveText(['Cast', 'Alternative cost']);
  await expect(page.getByTestId('ask-done')).toBeDisabled();
  await page.keyboard.press('2');
  await expect(page.getByTestId('ask-pick-1')).toBeVisible();
  await expect(page.getByTestId('ask-done')).toHaveText('Cast');
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${SELECT_SHOTS[0]!.name}.png`);
  // A key only moves the pick; Enter casts.
  await page.keyboard.press('1');
  await expect(page.getByTestId('ask-pick-0')).toBeVisible();
  await expect(page.getByTestId('ask-pick-1')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await answered();

  // Fireblast: Esc cancels the menu (min 0).
  await askIs('a2');
  await page.keyboard.press('Escape');
  await answered();

  // Mishra's Factory's three abilities: cards with no captions; Cancel is there until one is picked.
  await askIs('a3');
  await expect(cards.locator('.option-card')).toHaveCount(3);
  await expect(cards.locator('.oc-caption')).toHaveCount(0);
  await expect(page.getByTestId('ask-none')).toHaveText('Cancel');
  await page.getByTestId('ask-item-1').click();
  await expect(page.getByTestId('ask-none')).toHaveCount(0);
  await expect(page.getByTestId('ask-layer')).not.toHaveCSS('pointer-events', 'none');
  await page.getByTestId('ask-done').click();
  await answered();

  // The Command's two modes, one ask each; then two at once (max 2): numbered picks, a counter, no third.
  await askIs('m1');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await askIs('m2');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await askIs('k1');
  await expect(page.getByTestId('ask-done')).toHaveText('Choose 2 options');
  await expect(page.getByTestId('ask-done')).toBeDisabled();
  await page.keyboard.press('1');
  await page.keyboard.press('3');
  await page.keyboard.press('4');
  await expect(page.getByTestId('ask-pick-0')).toHaveText('1');
  await expect(page.getByTestId('ask-pick-2')).toHaveText('2');
  await expect(page.getByTestId('ask-pick-3')).toHaveCount(0);
  await expect(page.getByTestId('pf-count')).toContainText('2 of 2');
  await page.keyboard.press('Enter');
  await answered();
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  expect(gate.errors).toEqual([]);
});

const B5B7_SHOTS = [
  { name: '67-mulligan-again', title: 'After one mulligan: on the play, "1 mulligan taken · you\'d keep 6", Keep 6 / Mulligan to 5 (B5)' },
  { name: '68-mulligan-tuck', title: 'The London tuck: "Put 1 card on the bottom", 1 of 1 chosen, Bottom 1, keep 6 (B5)' },
  { name: '69-trigger-order', title: 'Three combat damage triggers: rows with the source card and its text, ↑ ↓, the stack it builds, "Always use this order" (B7)' },
];

test('replay: the mulligan banner, keep / mulligan counts and the London tuck (B5)', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(MULL_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=mull.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const atPrompt = (n: number, ok = false) => page.evaluate(([pid, on]) => window.__table.runUntil((s) => s.prompt?.pid === pid && (!on || s.prompt.ok.enabled), { settle: true }), [n, ok] as const);
  const banner = page.getByTestId('mull-banner');

  // The opening hand: on the play, 7 kept, the facts; the buttons say what happens.
  await atPrompt(1);
  await expect(page.getByTestId('mull-seat')).toHaveText('On the play');
  await expect(banner).toContainText('Opening hand · no mulligans yet');
  await expect(page.getByTestId('mull-facts')).toContainText('3 lands · 4 spells');
  await expect(page.getByTestId('primary')).toHaveText(/^Keep 7/);
  await expect(page.getByTestId('secondary')).toHaveText('Mulligan to 6');
  await expect(page.getByTestId('prompt-bar')).toHaveCount(0);

  // Asked again: one mulligan taken.
  await atPrompt(2);
  await expect(banner).toContainText("1 mulligan taken · you'd keep 6");
  await expect(page.getByTestId('primary')).toHaveText(/^Keep 6/);
  await expect(page.getByTestId('secondary')).toHaveText('Mulligan to 5');
  await expect(page).toHaveScreenshot(`${B5B7_SHOTS[0]!.name}.png`);
  // The facts hide with a click (and stay hidden).
  await page.getByTestId('mull-facts').click();
  await expect(page.getByTestId('mull-facts')).toHaveText('Hand facts');
  await page.getByTestId('mull-facts').click();

  // The tuck: what's left to choose on the disabled button, then the outcome once one is chosen.
  await atPrompt(3);
  await expect(banner).toContainText('Put 1 card on the bottom');
  await expect(page.getByTestId('primary')).toHaveText('Choose 1 more');
  await atPrompt(3, true);
  await expect(page.getByTestId('mull-count')).toContainText('1 of 1');
  await expect(page.getByTestId('primary')).toHaveText('Bottom 1, keep 6');
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${B5B7_SHOTS[1]!.name}.png`);
  await atPrompt(4);
  await expect(banner).toHaveCount(0);
  expect(gate.errors).toEqual([]);
});

test('replay: ordering simultaneous triggers with the stack they build (B7)', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(TRIGGERS_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=triggers.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.runUntil((s) => s.asks.some((a: { id: string }) => a.id === 't1'), { settle: true }));
  const order = page.getByTestId('ask-trigger-order');
  const rows = order.locator('.trig-row b');
  const stack = page.getByTestId('trigger-stack').locator('.trig-stk-name');
  await expect(order.locator('h2')).toHaveText('Order your triggers');
  await expect(rows).toHaveText(['Ragavan, Nimble Pilferer', 'Sword of Fire and Ice', 'Ninja of the Deep Hours']);
  // The source's name is the row's title, not repeated in its text.
  await expect(page.getByTestId('trigger-row-1').locator('.trig-text')).toHaveText(/^Whenever equipped creature/);
  await expect(page.getByTestId('trigger-stack')).toContainText('Nothing else on the stack');
  await expect(page.getByTestId('trigger-suggested')).toBeDisabled();
  // ↓ on the first row moves Ragavan down (and selects it); Alt + ↑ moves the selected row back up.
  await page.getByTestId('trigger-down-0').click();
  await expect(rows).toHaveText(['Sword of Fire and Ice', 'Ragavan, Nimble Pilferer', 'Ninja of the Deep Hours']);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(rows).toHaveText(['Ragavan, Nimble Pilferer', 'Sword of Fire and Ice', 'Ninja of the Deep Hours']);
  // Again: the Sword now resolves first, in the list and on the stack.
  await page.getByTestId('trigger-down-0').click();
  await expect(stack.first()).toHaveText('Sword of Fire and Ice');
  await expect(page.getByTestId('trigger-up-1')).toBeDisabled();
  await page.getByTestId('trigger-remember').check();
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot(`${B5B7_SHOTS[2]!.name}.png`);
  // "Suggested order" puts the engine's back.
  await page.getByTestId('trigger-suggested').click();
  await expect(rows).toHaveText(['Ragavan, Nimble Pilferer', 'Sword of Fire and Ice', 'Ninja of the Deep Hours']);
  await page.getByTestId('ask-done').click();
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  expect(gate.errors).toEqual([]);
});

// Animation preview (motion as MP4/GIF): with FT_ANIM=<dir>, writes a frame per 40 ms of virtual time
// across the ambient loops, cropped to the creatures. Not a golden; skipped otherwise.
test('anim: ambient keyword touches, preview frames', async ({ page }) => {
  const out = process.env.FT_ANIM;
  test.skip(!out, 'set FT_ANIM=<dir> to write preview frames');
  test.setTimeout(180_000);
  await openFramed(page, 'framed-keywords', [], 8);
  mkdirSync(out!, { recursive: true });
  for (let i = 0; i < 220; i++) {
    await page.screenshot({ path: path.join(out!, `f${String(i).padStart(4, '0')}.png`), clip: { x: 430, y: 440, width: 700, height: 280 } });
    await page.evaluate(() => window.__table.advance(40));
  }
});

// Contact sheet of every golden (for PR review).
test.afterAll(async ({ browser }) => {
  const all = [...SHOTS.map((s) => ({ name: s.name, title: s.title })), ...ZONE_SHOTS, ...CHOOSER_SHOTS, ...SICK_SHOTS, ...SPLIT_SHOTS, ...AUTOPASS_SHOTS, ...BLOCK_SHOTS, ...TARGET_SHOTS, ...MANA_SHOTS, ...REVEAL_SHOTS, ...EYE_SHOTS, ...STACK_SHOTS, ...PEEK_SHOTS, ...ALT_SHOTS, ...BRAWL_SHOTS, ...FRAMED_SHOTS, ...LASTING_SHOTS, ...PROMPT_SHOTS, ...B5B7_SHOTS];
  const tiles = all
    .map((s) => {
      const file = path.join(SNAPSHOTS, `${s.name}.png`);
      const src = existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : '';
      return `<figure><img src="${src}"><figcaption>${s.name} · ${s.title}</figcaption></figure>`;
    })
    .join('');
  const sheet = await browser.newPage();
  await sheet.setViewportSize({ width: 1920, height: 800 });
  await sheet.setContent(`<!doctype html><style>
    body{margin:0;background:#0d0f13;color:#9ba2ae;font:14px system-ui;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px}
    figure{margin:0}img{width:100%;border:1px solid #363c47;border-radius:6px;display:block}figcaption{padding:6px 2px}
  </style>${tiles}`);
  mkdirSync(OUT, { recursive: true });
  await sheet.screenshot({ path: path.join(OUT, 'contact-sheet.png'), fullPage: true });
  await sheet.close();
});

/** Duress over the opponent's revealed hand (synthetic: tests/fixtures/make-reveal.mjs). */
const REVEAL_FIXTURE = path.resolve(here, '../fixtures/sessions/reveal.jsonl');
const REVEAL_SHOTS = [
  { name: '30-opp-hand', title: 'Duress: the opponent’s revealed hand dealt out in a fan over the dimmed, blurred table; the pickable card ringed, the hovered one zoomed' },
  { name: '31-opp-hand-phone', title: 'The same reveal on a phone (390×844): the cards wrap into rows that fit' },
];

test('replay: the opponent’s revealed hand (zone strip)', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(REVEAL_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=reveal.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.waitForPrompt('selectEntities'));
  const strip = page.getByTestId('zone-strip');
  await expect(strip).toBeVisible();
  const cardsIn = strip.locator('[data-testid^="zone-card-"]');
  await expect(cardsIn).toHaveCount(5);
  await expect(strip.locator('.zr-head')).toContainText('Opponent’s hand');
  await expect(strip.locator('.zr-head')).toContainText('5 cards');
  // The pickable card (Lead the Stampede) comes first, ringed.
  await expect(cardsIn.first()).toHaveClass(/\bselectable\b/);
  // A table preview never shows through the backdrop.
  await page.evaluate(() => window.__table.preview('c50'));
  await expect(page.locator('.preview')).toHaveCount(0);
  await page.evaluate(() => window.__table.preview(null));
  await cardsIn.nth(2).hover();
  await expect(cardsIn.nth(2)).toHaveClass(/\bpeek\b/);
  await expect(page).toHaveScreenshot(`${REVEAL_SHOTS[0]!.name}.png`);

  // Esc puts it away (the prompt stays), a chip brings it back; a click away puts it away too.
  await page.mouse.move(4, 4);
  await page.keyboard.press('Escape');
  await expect(strip).toHaveCount(0);
  await expect(page.getByTestId('zone-strip-reopen')).toBeVisible();
  await page.getByTestId('zone-strip-reopen').click();
  await expect(strip).toBeVisible();
  await page.mouse.click(20, 540);
  await expect(strip).toHaveCount(0);
  await page.getByTestId('zone-strip-reopen').click();

  // A phone: the five cards wrap and fit the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cardsIn).toHaveCount(5);
  await page.mouse.move(2, 2);
  await expect(page).toHaveScreenshot(`${REVEAL_SHOTS[1]!.name}.png`);
  for (let i = 0; i < 5; i++) {
    const b = (await cardsIn.nth(i).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(b.y + b.height).toBeLessThanOrEqual(844);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Choosing it is the same card act as on the table; then the engine hides the zone.
  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === 3, { settle: true }));
  await expect(strip).toHaveCount(0);
  await expect(page.getByTestId('zone-strip-reopen')).toHaveCount(0);
  expect(gate.errors).toEqual([]);
});

/** The revealed-to-opponent eye on hand cards (synthetic: tests/fixtures/make-eye.mjs). */
const EYE_FIXTURE = path.resolve(here, '../fixtures/sessions/eye.jsonl');
const EYE_SHOTS = [
  { name: '70-revealed-eye', title: 'After the opponent’s Thoughtseize: an eye on the three hand cards they saw, none on the card drawn since' },
  { name: '71-revealed-eye-played', title: 'The revealed Swamp played: no eye on the battlefield, the two cards still in hand keep theirs' },
];

test('replay: hand cards an opponent has seen wear an eye', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(EYE_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=eye.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  const revealed = () => page.evaluate(() => window.__table.sprites().filter((s) => s.revealed).map((s) => s.id).sort());
  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === 1, { settle: true }));
  // Swamp c44, Vampire Nighthawk c45, Doom Blade c46 were seen; Night's Whisper c47 was drawn after.
  expect(await revealed()).toEqual(['c44', 'c45', 'c46']);
  await expect(page).toHaveScreenshot(`${EYE_SHOTS[0]!.name}.png`);

  await page.evaluate(() => window.__table.runUntil((s) => s.prompt?.kind === 'priority' && s.prompt.pid === 2, { settle: true }));
  expect(await page.evaluate(() => window.__table.state().players.p0.battlefield)).toContain('c44');
  expect(await revealed()).toEqual(['c45', 'c46']);
  await expect(page).toHaveScreenshot(`${EYE_SHOTS[1]!.name}.png`);
  expect(gate.errors).toEqual([]);
});

const WARD_SHOTS = [
  { name: '40-hexproof-ward', title: 'Lightning Bolt aimed: sigils and auras on hexproof, shroud, protection and ward cards; the arrow bounces off the hexproof Scout (shield flare), ward cards stay legal' },
  { name: '41-snoozed-vs-sick', title: 'Snoozed (frost veil, crescent moon, sunk card) beside summoning-sick (corner z’s) and a plain creature' },
];

test('replay: hexproof / shroud / protection / ward sigils, the aim turned away, ward on the stack, snoozed vs sick', async ({ page }) => {
  const gate = gateConsole(page);
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => route.fulfill({ body: readFileSync(WARD_FIXTURE, 'utf8'), contentType: 'application/x-ndjson' }),
  );
  await page.goto('/?test=1&replay=ward-fx.jsonl');
  await page.waitForFunction(() => !!window.__table);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.waitForPrompt('priority'));
  await page.evaluate(() => window.__table.pause(true));

  // Ids as make-ward.mjs deals them: mine c109 plain, c110 sick, c111 snoozed, c112 sick + snoozed; theirs c115 hexproof,
  // c116 shroud, c117 protection from red, c118 ward {2}, c119 ward (3 life), c120 hexproof + pro black + ward, c121 plain.
  const sprites = () => page.evaluate(() => window.__table.sprites());
  let all = await sprites();
  expect(all.filter((s) => s.snoozed).map((s) => s.id).sort()).toEqual(['c111', 'c112']);
  expect(all.filter((s) => s.sick).map((s) => s.id).sort()).toEqual(['c110']);
  expect(all.find((s) => s.id === 'c115')?.prot).toBe('hexproof:');
  expect(all.find((s) => s.id === 'c118')?.prot).toBe('{2}');
  expect(all.find((s) => s.id === 'c121')?.prot).toBeNull();
  await page.evaluate(() => window.__table.advance(900));
  await expect(page).toHaveScreenshot(`${WARD_SHOTS[1]!.name}.png`);
  await page.evaluate(() => window.__table.pause(false));

  // Aiming the Bolt: hovering the hexproof Scout turns the arrow away; the Bears (legal) take it as usual.
  await page.evaluate(() => window.__table.waitForPrompt('chooseTargets'));
  await page.evaluate(() => window.__table.pause(true));
  const arrows = () =>
    page.evaluate(() => {
      window.__table.redraw();
      return window.__table.arrows();
    });
  const scout = (await page.evaluate(() => window.__table.cardCenter('c115')))!;
  await page.mouse.move(scout.x, scout.y);
  await page.evaluate(() => window.__table.advance(330));
  expect(await arrows()).toContain('pending:target:c113');
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'ward-deflect-mid.png') });
  await expect(page).toHaveScreenshot(`${WARD_SHOTS[0]!.name}.png`);
  const shroud = (await page.evaluate(() => window.__table.cardCenter('c116')))!;
  await page.mouse.move(shroud.x, shroud.y);
  await page.evaluate(() => window.__table.advance(330));
  await page.screenshot({ path: path.join(OUT, 'ward-deflect-shroud.png') });
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__table.pause(false));

  // The Shock at Warded Sentinel: its ward trigger links to it.
  await page.evaluate(() => window.__table.runUntil((s) => s.stack >= 2, { settle: false }));
  await page.evaluate(() => window.__table.advance(260));
  expect(await arrows()).toContain('ward:ab:i3:c118');
  await page.screenshot({ path: path.join(OUT, 'ward-trigger.png') });
  expect(gate.errors).toEqual([]);
});

const PVP_SHOTS = [
  { name: '44-pvp-start-waiting', title: 'PvP start screen: Mik has chosen a deck, "Waiting for Sam…" (no AI or opponent-deck pickers)' },
  { name: '45-pvp-disconnect', title: 'PvP: Sam dropped, banner under his plate, Claim win unlocked' },
  { name: '46-pvp-opp-priority', title: 'PvP: Sam holds priority, "Waiting for Sam…" on his plate (his name, no AI tag)' },
];

test('replay: pvp start screen, opponent-priority indicator, disconnect banner and Claim win', async ({ page }) => {
  const gate = gateConsole(page);
  let away = pvpFixture('pvp-away');
  await page.route(
    (u) => u.pathname.endsWith('.jsonl'),
    (route) => {
      const file = new URL(route.request().url()).pathname.split('/').pop()!.replace(/\.jsonl$/, '');
      route.fulfill({ body: file === 'pvp-away' ? away : pvpFixture(file), contentType: 'application/x-ndjson' });
    },
  );
  const open = async (file: string) => {
    await page.goto(`/?test=1&replay=${file}.jsonl`);
    await page.waitForFunction(() => !!window.__table);
    await page.mouse.move(4, 4);
  };

  // The start screen: no AI or opponent-deck pickers; Mik is ready, Sam is choosing.
  await open('pvp-start');
  await page.evaluate(() => window.__table.seedStart(['Mono Red', 'Grixis Control'], 'Mono Red'));
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await expect(page.getByTestId('pvp-status')).toContainText('Waiting for Sam…');
  await expect(page.getByTestId('pvp-status')).toContainText('Sam is choosing a deck.');
  await expect(page.getByTestId('ai-select')).toHaveCount(0);
  await expect(page.getByTestId('opp-deck-select')).toHaveCount(0);
  await expect(page.getByTestId('start-match')).toBeDisabled();
  await expect(page).toHaveScreenshot(`${PVP_SHOTS[0]!.name}.png`);

  // Sam holds priority: a calm line on his plate, his name and no "AI" tag.
  await open('pvp-wait');
  await page.evaluate(() => window.__table.runUntil((s) => s.pvp?.presence != null, { settle: true }));
  await expect(page.getByTestId('opp-waiting')).toHaveText('Waiting for Sam');
  await expect(page.getByTestId('plate-opp')).toContainText('Sam');
  await expect(page.getByTestId('plate-opp')).not.toContainText('AI');
  await expect(page.getByTestId('pvp-banner')).toHaveCount(0);
  await expect(page).toHaveScreenshot(`${PVP_SHOTS[2]!.name}.png`);

  // Sam dropped long ago: the banner, Claim win unlocked; the waiting line gives way to it. Claiming sends the act.
  await open('pvp-away');
  await page.evaluate(() => window.__table.runUntil((s) => s.pvp?.presence != null, { settle: true }));
  await expect(page.getByTestId('pvp-banner')).toContainText('Sam disconnected');
  await expect(page.getByTestId('claim-win')).toBeEnabled();
  await expect(page.getByTestId('pvp-countdown')).toHaveCount(0);
  await expect(page.getByTestId('opp-waiting')).toHaveCount(0);
  await expect(page).toHaveScreenshot(`${PVP_SHOTS[1]!.name}.png`);
  await page.getByTestId('claim-win').click();
  expect(await page.evaluate(() => window.__table.acts())).toContainEqual({ t: 'act', kind: 'claimWin' });

  // Still inside the two minutes: a live countdown and a disabled button. The deadline is real time and the page
  // takes a while to get there on a busy runner, so any time left under the 1:30 set here counts.
  away = away.replace('"claimableAt":120001', `"claimableAt":${Date.now() + 90_000}`);
  await open('pvp-away');
  await page.evaluate(() => window.__table.runUntil((s) => s.pvp?.presence != null, { settle: true }));
  await expect(page.getByTestId('pvp-countdown')).toHaveText(/^Claim win unlocks in (1:[0-2]\d|1:30|0:[0-5]\d)$/);
  await expect(page.getByTestId('claim-win')).toBeDisabled();
  expect(gate.errors).toEqual([]);
});

const LOBBY_HTML = path.resolve(here, '../../app/dist/lobby.html');

test('lobby: play a friend, the join link, open games, conceding, and the /join/<code> page', async ({ page, context }) => {
  const gate = gateConsole(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const now = Date.now();
  const url = 'https://mtg.example/join/abcdefghijklmnopqrstuvwxyz';
  const waiting = { id: 'g1', status: 'ready', created: now - 60_000, mode: 'pvp', seat: 0, players: [{ seat: 0, name: 'alex' }], waiting: true, listed: true, invite: { url, expires: now + 14 * 60_000 } };
  const playing = { id: 'g2', status: 'playing', created: now - 600_000, mode: 'pvp', seat: 1, players: [{ seat: 0, name: 'sam' }, { seat: 1, name: 'alex' }] };
  const vsAi = { id: 'g3', status: 'ready', created: now - 900_000 };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    if (req.method() !== 'GET') calls.push({ method: req.method(), url: u.pathname, body });
    // Ended games stay gone from the list.
    const ended = new Set(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()));
    const list = () => ({ user: 'alex', maxPerUser: 5, maxMatches: 8, matches: [waiting, playing, vsAi].filter((m) => !ended.has(m.id)), open: [{ id: 'o1', host: 'Sam', created: now - 300_000 }] });
    if (u.pathname === '/api/matches' && req.method() === 'GET') return route.fulfill({ json: list() });
    if (req.method() === 'DELETE') return route.fulfill({ json: list() });
    if (u.pathname === '/api/decks') return route.fulfill({ json: { decks: ['Mono Red', 'Grixis Control'] } });
    if (u.pathname === '/api/join' && body?.code === 'deadcodedeadcode') {
      return route.fulfill({ status: 404, json: { error: 'That invite has expired or was already used.' } });
    }
    if (u.pathname === '/api/join' || u.pathname === '/api/matches') return route.fulfill({ json: { ...waiting, id: 'g9' } });
    return route.fulfill({ json: waiting });
  });
  await page.goto('/lobby.html');

  // My waiting game: the link, how long it lives, whether it is listed.
  const row = page.getByTestId('game-g1');
  await expect(row.getByTestId('pvp-status')).toContainText('Waiting for a friend…');
  await expect(row.getByTestId('invite-url')).toHaveValue(url);
  await expect(row.getByTestId('invite-expiry')).toHaveText(/^Link expires in 1[34]:\d\d$/);
  await expect(row.getByTestId('invite-listed')).toHaveText('Shown in open games');
  await expect(row.getByTestId('resume')).toHaveCount(0);
  await row.getByTestId('invite-copy').click();
  await expect(row.getByTestId('invite-copy')).toHaveText('Copied');
  await row.getByTestId('invite-new').click();
  await expect.poll(() => calls.some((c) => c.url === '/api/matches/g1/invite')).toBe(true);

  // A game in play against a friend: "vs Sam"; its × turns into "Concede?" and concedes on the second click.
  const live = page.getByTestId('game-g2');
  await expect(live.getByTestId('pvp-status')).toContainText('vs sam');
  await expect(live.getByTestId('end')).toHaveAccessibleName('Concede');
  await live.getByTestId('end').click();
  await expect(live.getByTestId('end')).toHaveText('Concede?');
  await expect(live.getByTestId('end-ask')).toHaveText('This concedes the game.');
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  // Esc puts the × back.
  await page.keyboard.press('Escape');
  await expect(live.getByTestId('end')).toHaveText('');
  await expect(live.getByTestId('end-ask')).toHaveCount(0);
  // A game against the AI ends on one click, no confirm.
  await expect(page.getByTestId('game-g3').getByTestId('end')).toHaveAccessibleName('End game');
  await page.getByTestId('game-g3').getByTestId('end').click();
  await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.url === '/api/matches/g3')).toBe(true);
  await expect(page.getByTestId('game-g3')).toHaveCount(0);

  // Play a friend: New game, its "A friend" tab; a deck, unlisted, Create link.
  await page.getByTestId('new-game').click();
  await page.getByTestId('ng-friend').click();
  await expect(page.getByTestId('ng-friend')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('friend-listed').uncheck();
  await page.locator('[data-testid="ng-deck"][data-deck="Mono Red"]').click();
  await expect(page.getByTestId('ng-start')).toContainText('Create link');
  await page.getByTestId('ng-start').click();
  await expect.poll(() => calls.find((c) => c.url === '/api/matches')?.body).toEqual({ mode: 'pvp', deck: 'Mono Red', listed: false });

  // Waiting for you: an open table with host, format and age; Join is one tap with my last deck, "with …" changes it.
  const open = page.getByTestId('open-o1');
  await expect(open).toContainText('Sam’s open table');
  await expect(open).toContainText('Constructed · 5 min ago');
  await expect(open.getByTestId('open-deck')).toHaveAccessibleName('Your deck: Mono Red. Change');
  await open.getByTestId('open-deck').click();
  await page.locator('.deck-sheet [data-testid="ng-deck"][data-deck="Grixis Control"]').click();
  await expect(page.locator('.deck-sheet')).toHaveCount(0);
  await open.getByTestId('open-join').click();
  await expect.poll(() => calls.find((c) => c.url === '/api/join')?.body).toEqual({ id: 'o1', deck: 'Grixis Control' });

  // A phone: nothing runs off the side, and the link row stays reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByTestId('invite-copy')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'lobby-pvp-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(OUT, 'lobby-pvp.png'), fullPage: true });

  // /join/<code>: the lobby page, with the router's <base href="/"> so its bundle loads from the root.
  calls.length = 0;
  await page.route('**/join/**', (route) =>
    route.fulfill({ body: readFileSync(LOBBY_HTML, 'utf8').replace('<head>', '<head><base href="/">'), contentType: 'text/html' }));
  await page.goto('/join/abcdefghijklmnopqrstuvwxyz');
  await expect(page.getByTestId('join-page')).toBeVisible();
  await page.locator('[data-testid="ng-deck"][data-deck="Mono Red"]').click();
  await page.getByTestId('join-go').click();
  await expect.poll(() => calls.find((c) => c.url === '/api/join')?.body).toEqual({ code: 'abcdefghijklmnopqrstuvwxyz', deck: 'Mono Red' });
  await page.screenshot({ path: path.join(OUT, 'join-page.png') });

  // An expired link is reported in the server's words.
  await page.goto('/join/deadcodedeadcode');
  await page.getByTestId('join-go').click();
  await expect(page.getByTestId('join-error')).toHaveText('That invite has expired or was already used.');
  expect(gate.errors.filter((e) => !/404/.test(e))).toEqual([]);
});

test('lobby: a game card shows its deck’s art before the deal (starting, waiting for a friend) and after it', async ({ page }) => {
  const gate = gateConsole(page);
  const now = Date.now();
  const booting = { id: 'b1', status: 'starting', created: now - 13_000, progress: { stage: 'ai', label: 'Preparing the AI opponent', pct: 87, elapsed: 13 } };
  const waiting = { id: 'w1', status: 'ready', created: now - 60_000, mode: 'pvp', seat: 0, players: [{ seat: 0, name: 'alex' }], waiting: true, invite: { url: 'https://mtg.example/join/x', expires: now + 60_000 } };
  const playing = { id: 'p1', status: 'playing', created: now - 600_000, table: { turn: 3, mine: false, life: [20, 18], deck: 'Mono Red', key: 'Table Key', oppDeck: 'Grixis Control', oppKey: 'Their Table Key' } };
  await page.addInitScript(() => {
    sessionStorage.setItem('forge-table.newGame.b1', JSON.stringify({ start: { deck: 'Mono Red', oppDeck: 'Grixis Control' } }));
    sessionStorage.setItem('forge-table.pvpDeck.w1', 'Grixis Control');
  });
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/art/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>' });
    if (u.pathname === '/api/matches') return route.fulfill({ json: { user: 'alex', maxPerUser: 5, maxMatches: 8, matches: [booting, waiting, playing], open: [] } });
    if (u.pathname === '/api/decks') {
      return route.fulfill({ json: { decks: ['Mono Red', 'Grixis Control'], details: { 'Mono Red': { cards: 60, colors: 'R', key: 'Goblin Guide' }, 'Grixis Control': { cards: 60, colors: 'UBR', key: 'Kolaghan’s Command' } } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/lobby.html');
  const art = (id: string, cls = 'gc-art') => page.getByTestId(`game-${id}`).locator(`.${cls} img`);
  const crop = (card: string) => `/api/art/crop/${encodeURIComponent(card)}`;
  await expect(art('b1')).toHaveAttribute('src', crop('Goblin Guide'));
  await expect(art('b1', 'gc-opp-art')).toHaveAttribute('src', crop('Kolaghan’s Command'));
  await expect(art('w1')).toHaveAttribute('src', crop('Kolaghan’s Command'));
  await expect(art('w1', 'gc-opp-art')).toHaveCount(0);
  // Dealt: the table's own key cards win over the deck list's.
  await expect(art('p1')).toHaveAttribute('src', crop('Table Key'));
  await expect(art('p1', 'gc-opp-art')).toHaveAttribute('src', crop('Their Table Key'));
  expect(gate.errors).toEqual([]);
});

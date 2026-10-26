/**
 * Live (runs in the `live` project against the sidecar global setup spawns, before live.spec.ts): import a
 * pasted deck list from the start screen. Check reports what was recognized and the unknown line, Import
 * saves it, refreshes the deck list and selects it as the player's deck. No match is started, so the game
 * test that follows still finds the start screen.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { gateConsole } from '../support/console.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../output/live');
const LIST = '20 Mountain\n4 Lightning Bolt\n4 Not A Real Card';

test('live: import a pasted deck list from the start screen', async ({ page }) => {
  test.skip(!process.env.FT_LIVE_URL, 'live sidecar not started (FT_SKIP_LIVE set?)');
  mkdirSync(OUT, { recursive: true });
  const gate = gateConsole(page);
  const url = new URL(process.env.FT_LIVE_URL!);
  url.search = '?art=0'; // no autostart: stay on the start screen
  await page.goto(url.toString());
  await expect(page.getByTestId('start-match')).toBeEnabled({ timeout: 60_000 });
  const name = `E2E Import ${Date.now().toString(36)}`;

  // The panel opens in-page and Esc closes it.
  await page.getByTestId('import-open').click();
  const panel = page.getByTestId('import-panel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await page.getByTestId('import-open').click();
  await expect(page.getByTestId('import-mode-paste')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('import-text').fill(LIST);
  await page.getByTestId('import-name').fill(name);

  // Check (dry run): 24 cards recognized, the made-up card reported.
  await page.getByTestId('import-check').click();
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('import-unknown')).toContainText('Not A Real Card');
  await expect(page.getByTestId('import-error')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, 'import-1-check.png') });
  // A dry run saves nothing.
  await expect(page.getByTestId('deck-select')).not.toHaveAccessibleName(`Your deck: ${name}. Change`);

  // Import (Ctrl+Enter from the text area): the panel closes and the new deck is mine.
  await page.getByTestId('import-text').focus();
  await page.keyboard.press('Control+Enter');
  await expect(panel).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('deck-select')).toHaveAccessibleName(`Your deck: ${name}. Change`);
  await page.screenshot({ path: path.join(OUT, 'import-2-selected.png') });

  // An unusable list fails inline with the server's message, never an alert.
  await page.getByTestId('import-open').click();
  await page.getByTestId('import-text').fill('4 Not A Real Card');
  await page.getByTestId('import-check').click();
  await expect(page.getByTestId('import-error')).toContainText('Not A Real Card', { timeout: 30_000 });
  // With a pasted list, Esc asks first; a second Esc closes.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  expect(gate.errors).toEqual([]);
});

import { expect, test } from '@playwright/test';

for (const zone of ['Graveyard', 'Exile', 'Library']) {
  test(`${zone} choices open already sorted and legal, never against the old prompt`, async ({ page }) => {
    const acts: Array<Record<string, unknown>> = [];
    let send: (message: object) => void;
    const cards = Object.fromEntries(['c1', 'c2', 'c3'].map((id) => [id, {
      id, zone, owner: 'p0', controller: 'p0', state: { face: 'Original', name: id },
    }]));
    const prompt = {
      t: 'prompt', seq: 1, pid: 1, kind: 'priority', message: 'Old prompt',
      ok: { label: 'OK', enabled: true }, cancel: { label: 'Cancel', enabled: true },
      focusOk: true, selectable: ['c1'], highlighted: [], weak: {}, zones: [],
    };
    await page.routeWebSocket('**/ws', (ws) => {
      send = (message) => ws.send(JSON.stringify(message));
      ws.onMessage((text) => {
        const message = JSON.parse(String(text));
        if (message.t === 'hello') {
          send({ t: 'welcome', proto: 1, session: 'zone-choice', forgeVersion: 'test', features: [], match: true, defaults: {} });
          send({
            t: 'snapshot', seq: 0, viewer: 'p0', game: { stack: [] }, cards,
            players: { p0: { id: 'p0', life: 20, zones: {} }, p1: { id: 'p1', life: 20, zones: {} } },
            asks: [], stops: {},
          });
          send(prompt);
        } else if (message.t === 'act') acts.push(message);
      });
    });
    await page.goto('/?test=1#t=zone-choice');
    await page.waitForFunction(() => !!window.__table);
    await expect.poll(() => page.evaluate(() => {
      window.__table.advance(100);
      return window.__table.state().prompt?.pid;
    })).toBe(1);
    await expect(page.getByTestId('zone-strip')).toHaveCount(0);

    // Delayed computation finishes while animations are still ahead of the new prompt.
    send!({ t: 'beat', seq: 2, kind: 'draw', card: 'c4', patch: { cards: {
      c4: { id: 'c4', zone: 'Hand', owner: 'p0', controller: 'p0', state: { face: 'Original', name: 'c4' } },
    } } });
    send!({ t: 'settle', seq: 3, patch: { players: {
      p0: { id: 'p0', life: 20, zones: { [zone.toLowerCase()]: ['c1', 'c2', 'c3'], hand: ['c4'] } },
    } } });
    send!({ ...prompt, seq: 4, pid: 2, kind: 'chooseTargets', message: 'Choose a card', selectable: ['c3'], zones: [{ player: 'p0', zone }] });
    await expect.poll(() => page.evaluate(() => {
      window.__table.redraw();
      return window.__table.state().lastSeq;
    })).toBe(4);
    await expect(page.getByTestId('zone-strip')).toHaveCount(0);
    await page.evaluate(() => window.__table.advance(2000));
    const strip = page.getByTestId('zone-strip');
    await expect(strip).toBeVisible();
    await expect(strip.locator('.zr-card')).toHaveCount(3);
    expect(await strip.locator('.zr-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))
      .toEqual(['zone-card-c3', 'zone-card-c1', 'zone-card-c2']);
    await page.getByTestId('zone-card-c1').click(); // visible for inspection, not a legal choice
    expect(acts).toEqual([]);
    await page.getByTestId('zone-card-c3').click();
    await expect.poll(() => acts).toEqual([{ t: 'act', pid: 2, kind: 'card', card: 'c3' }]);
  });
}

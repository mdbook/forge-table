import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

for (const loop of [false, true]) {
  for (const key of ['Enter', 'Escape']) {
    test(`optional trigger: focused remember switch answers with ${key}, loop=${loop}`, async ({ page }) => {
      const snapshot = readFileSync(new URL('../fixtures/sessions/zones.jsonl', import.meta.url), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line)).find((m) => m.t === 'snapshot');
      const triggerKey = 'Optional trigger';
      const autoPass = { autoSkip: false, untilEndOfTurn: false, ...(loop ? { loop: { state: 'recording', steps: 1 } } : {}) };
      const acts: Array<Record<string, unknown>> = [];
      let seq = snapshot.seq;
      await page.routeWebSocket('**/ws', (ws) => {
        ws.onMessage((text) => {
          const message = JSON.parse(String(text));
          if (message.t === 'hello') {
            ws.send(JSON.stringify({ t: 'welcome', proto: 1, session: 'confirm-keys', forgeVersion: 'test', features: [], match: true, defaults: {} }));
            ws.send(JSON.stringify({ ...snapshot, autoPass }));
            ws.send(JSON.stringify({
              t: 'prompt', seq: ++seq, pid: 700, kind: 'confirm', message: 'Use this optional trigger?', triggerKey,
              ok: { label: 'Yes', enabled: true }, cancel: { label: 'No', enabled: true },
              focusOk: true, selectable: [], highlighted: [], weak: {}, seat: snapshot.viewer,
            }));
          } else if (message.t === 'rpc') {
            ws.send(JSON.stringify({ t: 'rpcResult', id: message.id, ok: true, value: [] }));
          } else if (message.t === 'act') {
            acts.push(message);
            if (message.kind === 'triggerAnswer') {
              ws.send(JSON.stringify({ t: 'notice', kind: 'autoPass', ...autoPass, answers: [{ key: triggerKey, decision: message.decision }] }));
              ws.send(JSON.stringify({ t: 'promptClear', seq: ++seq, pid: 700 }));
            }
          }
        });
      });
      await page.goto('/?test=1#t=confirm-keys');
      await page.waitForFunction(() => !!window.__table);
      // The socket delivers asynchronously; advance the virtual clock between browser event-loop turns.
      await expect.poll(() => page.evaluate(() => {
        window.__table.advance(100);
        return window.__table.state().prompt?.kind;
      })).toBe('confirm');
      const remember = page.getByTestId('confirm-remember');
      // Space toggles the focused control without answering the prompt. Refocusing must not swallow Enter/Esc.
      await remember.focus();
      await page.keyboard.press('Space');
      await expect(remember).toBeChecked();
      expect(acts).toEqual([]);
      await remember.focus();
      // A key consumed by a control must not bubble into a table answer.
      await remember.evaluate((el) => el.addEventListener('keydown', (e) => e.preventDefault(), { once: true }));
      await page.keyboard.press(key);
      expect(acts).toEqual([]);
      await expect(remember).toBeChecked();
      await page.keyboard.press(key);
      await expect.poll(() => acts).toEqual([{ t: 'act', kind: 'triggerAnswer', key: triggerKey, decision: key === 'Enter' ? 'accept' : 'decline' }]);
      await expect(page.getByTestId('auto-answers')).toHaveText('1 auto answer');
      await page.evaluate(() => window.__table.advance(100));
      await page.getByTestId('auto-answers').click();
      await expect(page.getByTestId('auto-answers-list')).toContainText(key === 'Enter' ? 'Yes' : 'No');
    });
  }
}

/**
 * Records the zones replay fixture: boots the real sidecar on a board state (tests/fixtures/states/zones.txt)
 * with `--record`, starts the match, waits for the player's first main-phase priority (graveyards and exiles
 * full, playable cards marked in the prompt's `weak` set), lingers, then concedes so the session ends on the
 * game-over panel.
 *
 *   node tests/scripts/record-zones.ts [out.jsonl]
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { ServerMessage } from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const out = path.resolve(process.argv[2] ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/zones.jsonl'));
const state = path.join(WEB_ROOT, 'tests/fixtures/states/zones.txt');

async function main() {
  const sc = await startSidecar({
    record: out,
    extraArgs: ['--state', state],
    logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-zones-sidecar.log'),
  });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  const send = (m: object) => ws.send(JSON.stringify(m));
  let seq = 0;
  let conceded = false;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      void sc.stop();
      reject(new Error('recording timed out'));
    }, 180_000);
    ws.onopen = () => send({ t: 'hello', proto: 1, token: sc.ready.token, client: { speed: 0, reducedMotion: false, beatCosts: {} } });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if ('seq' in m && typeof m.seq === 'number') seq = m.seq;
      if (m.t === 'welcome') send({ t: 'rpc', id: 'start', method: 'match.start', params: {} });
      const prompt = m.t === 'prompt' || m.t === 'promptUpdate' ? m : m.t === 'snapshot' ? m.prompt : undefined;
      if (prompt && prompt.kind === 'priority' && !conceded) {
        conceded = true;
        console.log(`priority: weak=${JSON.stringify(prompt.weak)} selectable=${JSON.stringify(prompt.selectable)}`);
        setTimeout(() => send({ t: 'act', kind: 'concede' }), 1500);
      } else if (prompt && prompt.kind !== 'waiting' && prompt.kind !== 'priority' && !conceded && prompt.ok.enabled) {
        // The empty opening hand's keep / play-or-draw prompts: accept them (the board state is applied after).
        const pid = prompt.pid;
        setTimeout(() => send({ t: 'act', pid, kind: 'ok' }), 200);
      }
      if (m.t === 'ask') {
        const id = m.id;
        const value = m.kind === 'confirm' || m.kind === 'options' ? (m.default ?? 0) : m.kind === 'text' ? (m.initial ?? null) : [];
        setTimeout(() => send({ t: 'reply', id, value }), 200);
      }
      if (m.t === 'gameOver') {
        clearTimeout(deadline);
        setTimeout(resolve, 1000);
      }
    };
    setInterval(() => ws.readyState === WebSocket.OPEN && send({ t: 'ack', playedSeq: seq, backlogMs: 0, hidden: false }), 50);
  });
  ws.close();
  await sc.stop();
  console.log(`recorded ${out} (${statSync(out).size} bytes)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

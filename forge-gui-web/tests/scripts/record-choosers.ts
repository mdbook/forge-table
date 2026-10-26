/**
 * Records the choosers replay fixture: boots the real sidecar on a board state
 * (tests/fixtures/states/choosers.txt) with `--record`, casts Preordain, Ponder and Impulse in turn and
 * answers what they ask: the scry lanes (one card to the bottom), the Ponder order (reversed), no shuffle,
 * the first card Impulse offers in the zone strip, the rest in order. Then it concedes.
 *
 *   node tests/scripts/record-choosers.ts [out.jsonl]
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { AskMsg, Card, GameModel, PromptBody, ServerMessage } from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const out = path.resolve(process.argv[2] ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/choosers.jsonl'));
const state = path.join(WEB_ROOT, 'tests/fixtures/states/choosers.txt');
const PLAN = ['Preordain', 'Ponder', 'Impulse'];

function answer(a: AskMsg): unknown {
  switch (a.kind) {
    case 'arrange': {
      // Scry 2: the first card to the bottom, the second stays on top.
      const [first, ...rest] = a.items.map((i) => i.idx);
      return a.bottom ? { top: rest, bottom: first === undefined ? [] : [first] } : { top: a.items.map((i) => i.idx), bottom: [] };
    }
    case 'order':
      return { order: a.items.map((i) => i.idx).reverse().slice(0, a.max) };
    case 'confirm':
    case 'options': {
      const no = a.options.findIndex((o) => /^no$/i.test(o));
      return no >= 0 ? no : (a.default ?? 0);
    }
    case 'text':
      return a.initial ?? null;
    case 'split':
      // Not in this fixture: everything on the first target (valid for combat damage in every rule).
      return a.items.map((_, i) => (i === 0 ? a.amount : 0));
    default:
      return a.items.filter((i) => i.enabled !== false).slice(0, Math.max(a.min, 1)).map((i) => i.idx);
  }
}

async function main() {
  const sc = await startSidecar({
    record: out,
    extraArgs: ['--state', state],
    logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-choosers-sidecar.log'),
  });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  const send = (m: object) => ws.send(JSON.stringify(m));
  let model: GameModel = { game: { stack: [] }, players: {}, cards: {} } as unknown as GameModel;
  let viewer = 'p0';
  let prompt: PromptBody | null = null;
  let asks: AskMsg[] = [];
  let seq = 0;
  let cast = 0;
  let conceded = false;
  const asked = new Set<string>();
  const acted = new Set<string>();
  const apply = (p: { game?: GameModel['game']; players?: GameModel['players']; cards?: Record<string, Card | null> } | undefined) => {
    if (!p) return;
    if (p.game) model.game = p.game;
    Object.assign(model.players, p.players ?? {});
    for (const [k, v] of Object.entries(p.cards ?? {})) {
      if (v === null) delete model.cards[k];
      else model.cards[k] = v;
    }
  };
  const later = (f: () => void, ms = 80) => setTimeout(f, ms);

  const decide = () => {
    const top = asks[asks.length - 1];
    if (top) {
      if (asked.has(top.id)) return;
      asked.add(top.id);
      const value = answer(top);
      console.log(`ask ${top.id} ${top.kind}: ${top.title ?? top.message ?? ''} -> ${JSON.stringify(value)}`);
      later(() => send({ t: 'reply', id: top.id, value }));
      return;
    }
    const p = prompt;
    if (!p || p.kind === 'waiting' || conceded) return;
    // One action per prompt state (a promptUpdate after a click is a new state).
    const key = `${p.pid}:${p.selectable.join(',')}:${p.ok.enabled}:${model.game.stack.length}`;
    if (acted.has(key)) return;
    acted.add(key);
    const act = (body: object) => later(() => send({ t: 'act', pid: p.pid, ...body }));
    const me = model.players[viewer];
    const myTurn = model.game.playerTurn === viewer;
    if (p.kind === 'priority' && myTurn && model.game.stack.length === 0) {
      const name = PLAN[cast];
      if (!name) {
        conceded = true;
        later(() => send({ t: 'act', kind: 'concede' }), 600);
        return;
      }
      const id = (me?.zones.hand ?? []).find((c) => model.cards[c]?.state?.name === name);
      if (id && (p.selectable.includes(id) || (p.weak?.[id] ?? 0) > 0)) {
        cast++;
        console.log(`cast ${name}`);
        act({ kind: 'card', card: id });
        return;
      }
    }
    if ((p.kind === 'selectEntities' || p.kind === 'generic') && !p.ok.enabled && p.selectable.length > 0) {
      act({ kind: 'card', card: p.selectable[0] });
      return;
    }
    if (p.ok.enabled) act({ kind: 'ok' });
    else if (p.cancel.enabled) act({ kind: 'cancel' });
  };

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      void sc.stop();
      reject(new Error('recording timed out'));
    }, 180_000);
    ws.onopen = () => send({ t: 'hello', proto: 1, token: sc.ready.token, client: { speed: 0, reducedMotion: false, beatCosts: {} } });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if ('seq' in m && typeof m.seq === 'number') seq = m.seq;
      switch (m.t) {
        case 'welcome':
          send({ t: 'rpc', id: 'start', method: 'match.start', params: {} });
          break;
        case 'snapshot':
          model = { game: m.game, players: m.players, cards: m.cards };
          viewer = m.viewer;
          prompt = m.prompt ?? null;
          asks = m.asks ?? [];
          decide();
          break;
        case 'beat':
        case 'settle':
          apply(m.patch);
          break;
        case 'prompt':
        case 'promptUpdate':
          prompt = m;
          decide();
          break;
        case 'promptClear':
          if (prompt?.pid === m.pid) prompt = null;
          break;
        case 'ask':
          asks.push(m);
          decide();
          break;
        case 'askClear':
          asks = asks.filter((a) => a.id !== m.id);
          decide();
          break;
        case 'gameOver':
          clearTimeout(deadline);
          setTimeout(resolve, 1000);
          break;
        case 'notice':
          if (m.kind === 'stale') console.warn('stale act', JSON.stringify(m));
          break;
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

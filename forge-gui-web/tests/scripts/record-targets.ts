/**
 * Records the targets replay fixture: boots the real sidecar on a board state (tests/fixtures/states/targets.txt)
 * with `--record`, casts Lightning Bolt from hand, picks the AI's Wind Drake at the chooseTargets prompt, pays,
 * passes until it resolves, and concedes.
 *
 *   node tests/scripts/record-targets.ts [out.jsonl]
 *
 * The same flow for another spell: FT_STATE=<states file> FT_SPELL=<hand card> FT_TARGET=<my permanent to target>, e.g.
 *   FT_STATE=aura.txt FT_SPELL='Wild Growth' FT_TARGET=Forest node tests/scripts/record-targets.ts tests/fixtures/sessions/aura.jsonl
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { AskMsg, Card, GameModel, PromptBody, ServerMessage } from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const out = path.resolve(process.argv[2] ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/targets.jsonl'));
const state = path.join(WEB_ROOT, 'tests/fixtures/states', process.env.FT_STATE ?? 'targets.txt');
const SPELL = process.env.FT_SPELL ?? 'Lightning Bolt';
const TARGET = process.env.FT_TARGET ?? 'Wind Drake';

function answer(a: AskMsg): unknown {
  switch (a.kind) {
    case 'confirm':
    case 'options': {
      const no = a.options.findIndex((o) => /^no$/i.test(o));
      return no >= 0 ? no : (a.default ?? 0);
    }
    case 'text':
      return a.initial ?? null;
    case 'order':
      return { order: a.items.map((i) => i.idx).slice(0, a.max) };
    case 'arrange':
      return { top: a.items.map((i) => i.idx), graveyard: [] };
    case 'split':
      if (a.lethal) {
        let left = a.amount;
        return a.lethal.map((l, i) => {
          const give = i === a.lethal!.length - 1 ? left : Math.min(l, left);
          left -= give;
          return give;
        });
      }
      return a.items.map((_, i) => (i === 0 ? a.amount : 0));
    default:
      return a.items.filter((i) => i.enabled !== false).slice(0, Math.max(a.min, 1)).map((i) => i.idx);
  }
}

async function main() {
  const sc = await startSidecar({
    record: out,
    extraArgs: ['--state', state],
    logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-targets-sidecar.log'),
  });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  const send = (m: object) => ws.send(JSON.stringify(m));
  let model: GameModel = { game: { stack: [] }, players: {}, cards: {} } as unknown as GameModel;
  let prompt: PromptBody | null = null;
  let asks: AskMsg[] = [];
  let seq = 0;
  let viewer = 'p0';
  let cast = false;
  let targeted = false;
  let onStack = false;
  let conceded = false;
  const asked = new Set<string>();
  const acted = new Set<string>();
  const name = (id: string) => model.cards[id]?.state?.name;
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
  // Concede once the Bolt has been on the stack and left it.
  const concedeAfterResolve = () => {
    if (model.game.stack.length > 0) onStack = true;
    else if (onStack && !conceded) {
      conceded = true;
      console.log('resolved; conceding');
      send({ t: 'act', kind: 'concede' }); // at once: at speed 0 the engine runs on meanwhile
    }
  };

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
    const key = `${p.pid}:${p.selectable.join(',')}:${p.highlighted.join(',')}:${p.ok.enabled}:${model.game.stack.length}`;
    if (acted.has(key)) return;
    acted.add(key);
    const act = (body: object) => later(() => send({ t: 'act', pid: p.pid, ...body }));
    if (p.kind === 'priority' && !cast && model.game.playerTurn === viewer && model.game.stack.length === 0) {
      const id = (model.players[viewer]?.zones.hand ?? []).find((c) => name(c) === SPELL);
      if (id && (p.selectable.includes(id) || (p.weak?.[id] ?? 0) > 0)) {
        cast = true;
        console.log(`cast ${SPELL}`);
        act({ kind: 'card', card: id });
        return;
      }
    }
    if (p.kind === 'chooseTargets' && !targeted) {
      const target = p.selectable.find((c) => name(c) === TARGET && model.cards[c]?.controller === viewer) ?? p.selectable.find((c) => name(c) === TARGET);
      if (!target) throw new Error(`no ${TARGET} among the targets: ${JSON.stringify(p)}`);
      targeted = true;
      console.log(`target ${TARGET} (${target})`);
      act({ kind: 'card', card: target });
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
          concedeAfterResolve();
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
          if (m.kind === 'stale' || m.kind === 'flash' || m.kind === 'toast') console.warn(`${m.kind}`, JSON.stringify(m));
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

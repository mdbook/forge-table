/**
 * Records the blocks replay fixture: boots the real sidecar on a board state (tests/fixtures/states/blocks.txt)
 * with `--record`. The AI attacks with Wind Drake, Hill Giant and Grizzly Bears; using the one-step `block` act
 * (from the prompt's `blockable` pairs) Giant Spider blocks the Drake and both of my Grizzly Bears block the Hill
 * Giant, then OK. Concedes once combat damage is done.
 *
 *   node tests/scripts/record-blocks.ts [out.jsonl]
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { AskMsg, Card, GameModel, PromptBody, ServerMessage } from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const out = path.resolve(process.argv[2] ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/blocks.jsonl'));
const state = path.join(WEB_ROOT, 'tests/fixtures/states/blocks.txt');
/** [my blocker, their attacker], by name; a name used twice means the next unused card of that name. */
const PLAN: [string, string][] = [
  ['Giant Spider', 'Wind Drake'],
  ['Grizzly Bears', 'Hill Giant'],
  ['Grizzly Bears', 'Hill Giant'],
];
const AFTER_COMBAT = new Set(['COMBAT_END', 'MAIN2', 'END_OF_TURN', 'CLEANUP']);

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
    logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-blocks-sidecar.log'),
  });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  const send = (m: object) => ws.send(JSON.stringify(m));
  let model: GameModel = { game: { stack: [] }, players: {}, cards: {} } as unknown as GameModel;
  let prompt: PromptBody | null = null;
  let asks: AskMsg[] = [];
  let seq = 0;
  let step = 0;
  let blocked = false;
  let conceded = false;
  const asked = new Set<string>();
  const acted = new Set<string>();
  const used = new Set<string>();
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
  const concedeAfterCombat = () => {
    if (blocked && !conceded && model.game.phase && AFTER_COMBAT.has(model.game.phase)) {
      conceded = true;
      console.log(`combat over (${model.game.phase}); conceding`);
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
    const key = `${p.pid}:${JSON.stringify(p.blockable ?? {})}:${JSON.stringify(model.game.combat ?? [])}:${p.ok.enabled}`;
    if (acted.has(key)) return;
    acted.add(key);
    const act = (body: object) => later(() => send({ t: 'act', pid: p.pid, ...body }));
    if (p.kind === 'declareBlockers') {
      const pair = PLAN[step];
      if (pair) {
        const blockable = p.blockable ?? {};
        const blocker = Object.keys(blockable).find((b) => name(b) === pair[0] && !used.has(b));
        const attacker = blocker ? blockable[blocker]?.find((a) => name(a) === pair[1]) : undefined;
        if (!blocker || !attacker) throw new Error(`can't block ${pair[1]} with ${pair[0]}: ${JSON.stringify(blockable)}`);
        used.add(blocker);
        step++;
        console.log(`block ${pair[1]} (${attacker}) with ${pair[0]} (${blocker})`);
        act({ kind: 'block', blocker, attacker });
        return;
      }
      blocked = true;
      act({ kind: 'ok' });
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
          prompt = m.prompt ?? null;
          asks = m.asks ?? [];
          decide();
          break;
        case 'beat':
        case 'settle':
          apply(m.patch);
          concedeAfterCombat();
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

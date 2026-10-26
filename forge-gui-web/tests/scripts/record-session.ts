/**
 * Records a replay fixture (`sessions/*.jsonl`): boots the real sidecar with `--record`, plays
 * a short madness-vs-faeries game over the protocol with a simple scripted policy (keep, play a land, cast
 * the cheapest affordable creature, attack with everything, never block), and concedes after a few turns
 * so the session ends on a game-over panel.
 *
 *   node tests/scripts/record-session.ts [out.jsonl] [--turns N]
 *
 * The recording holds only server messages, so replays are independent of how fast this script ran.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  AskMsg,
  Card,
  GameModel,
  PromptBody,
  ServerMessage,
} from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/madness-vs-faeries.jsonl'));
const turnsIdx = args.indexOf('--turns');
const maxTurns = turnsIdx >= 0 ? Number(args[turnsIdx + 1]) : 6;

const manaValue = (cost: string | undefined) =>
  (cost?.match(/\{([^}]+)\}/g) ?? []).reduce((n, t) => n + (/^\{\d+\}$/.test(t) ? Number(t.slice(1, -1)) : t === '{X}' ? 0 : 1), 0);

async function main() {
  const sc = await startSidecar({ record: out, logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-sidecar.log') });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  let model: GameModel = { game: { stack: [] }, players: {}, cards: {} };
  let viewer = 'p0';
  let prompt: PromptBody | null = null;
  let asks: AskMsg[] = [];
  let seq = 0;
  let landTurn = -1;
  let castTurn = -1;
  let conceded = false;
  let lastClick: string | null = null;
  const attacked = new Set<number>();
  const send = (m: object) => ws.send(JSON.stringify(m));
  const apply = (p: { game?: GameModel['game']; players?: GameModel['players']; cards?: Record<string, Card | null> } | undefined) => {
    if (!p) return;
    if (p.game) model.game = p.game;
    Object.assign(model.players, p.players ?? {});
    for (const [k, v] of Object.entries(p.cards ?? {})) {
      if (v === null) delete model.cards[k];
      else model.cards[k] = v;
    }
  };
  const later = (f: () => void, ms = 60) => setTimeout(f, ms);

  const decide = () => {
    const top = asks[asks.length - 1];
    if (top) {
      let value: unknown;
      switch (top.kind) {
        case 'choose':
        case 'ability':
          value = top.items.filter((i) => i.enabled !== false).slice(0, Math.max(top.min, top.kind === 'ability' ? 1 : 0)).map((i) => i.idx);
          break;
        case 'order':
          value = { order: top.items.map((i) => i.idx).slice(0, top.max) };
          break;
        case 'arrange':
          value = top.top ? { top: top.items.map((i) => i.idx), bottom: [] } : { top: [], bottom: top.items.map((i) => i.idx) };
          break;
        case 'confirm':
        case 'options':
          value = top.default ?? 0;
          break;
        case 'text':
          value = top.initial ?? null;
          break;
      }
      const id = top.id;
      later(() => send({ t: 'reply', id, value }));
      return;
    }
    const p = prompt;
    if (!p || p.kind === 'waiting') return;
    const me = model.players[viewer];
    const turn = model.game.turn ?? 0;
    const myTurn = model.game.playerTurn === viewer;
    const act = (body: object) => later(() => send({ t: 'act', pid: p.pid, ...body }));
    if (p.kind === 'priority' && turn >= maxTurns && !conceded && myTurn) {
      conceded = true;
      later(() => send({ t: 'act', kind: 'concede' }), 400);
      return;
    }
    if (p.kind === 'priority' && myTurn && (model.game.phase === 'MAIN1' || model.game.phase === 'MAIN2') && model.game.stack.length === 0) {
      const hand = me?.zones.hand ?? [];
      if (landTurn !== turn) {
        landTurn = turn;
        const land = hand.find((id) => model.cards[id]?.state?.type?.core.includes('Land'));
        if (land) {
          lastClick = land;
          act({ kind: 'card', card: land });
          return;
        }
      }
      if (castTurn !== turn) {
        castTurn = turn;
        const untapped = (me?.zones.battlefield ?? []).filter((id) => {
          const c = model.cards[id];
          return c && c.state?.type?.core.includes('Land') && !c.tapped;
        }).length;
        const spell = hand
          .map((id) => model.cards[id])
          .filter((c): c is Card => !!c && !!c.state?.type?.core.includes('Creature') && manaValue(c.state.manaCost) <= untapped)
          .sort((a, b) => manaValue(a.state?.manaCost) - manaValue(b.state?.manaCost))[0];
        if (spell) {
          lastClick = spell.id;
          act({ kind: 'card', card: spell.id });
          return;
        }
      }
    }
    if (p.kind === 'payMana') {
      if (p.ok.enabled) act({ kind: 'ok' });
      else later(() => prompt === p && p.cancel.enabled && send({ t: 'act', pid: p.pid, kind: 'cancel' }), 1500);
      return;
    }
    if (p.kind === 'declareAttackers' && !attacked.has(p.pid)) {
      const declared = new Set((model.game.combat ?? []).map((c) => c.attacker));
      const next = (me?.zones.battlefield ?? []).find((id) => {
        const c = model.cards[id];
        return c && c.state?.type?.core.includes('Creature') && !c.tapped && !c.sickness && !declared.has(id);
      });
      if (next) {
        act({ kind: 'card', card: next });
        return;
      }
      attacked.add(p.pid);
    }
    if ((p.kind === 'selectEntities' || p.kind === 'generic') && !p.ok.enabled && p.selectable.length > 0) {
      act({ kind: 'card', card: p.selectable[0] });
      return;
    }
    if (p.ok.enabled) act({ kind: 'ok' });
    else if (p.cancel.enabled) act({ kind: 'cancel' });
  };

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('recording timed out')), 600_000);
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
          // The web client answers a lone ability right after the player's own click (legacy behaviour).
          decide();
          break;
        case 'askClear':
          asks = asks.filter((a) => a.id !== m.id);
          decide();
          break;
        case 'gameOver':
          console.log(`game over at turn ${model.game.turn}: ${JSON.stringify(m)}`);
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
  void lastClick;
  ws.close();
  await sc.stop();
  console.log(`recorded ${out} (${statSync(out).size} bytes)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

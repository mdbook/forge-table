/**
 * Records the Brawl replay fixture: boots the real sidecar with `--format brawl` (two shipped Brawl decks) on
 * a board state (tests/fixtures/states/brawl.txt) with `--record`, then at my first main phase: lingers (both
 * commanders in their command zones, mine castable), casts my commander from the command zone, lingers (it is on the
 * battlefield), Bolts it and puts it back in the command zone when asked, lingers (it waits there, its cost taxed),
 * and concedes so the session ends on the game-over panel.
 *
 *   node tests/scripts/record-brawl.ts [out.jsonl]
 *
 * The recording holds only server messages, so replays are independent of how fast this script ran.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { AskMsg, Card, GameModel, PromptBody, ServerMessage } from '@forge-table/protocol';
import { startSidecar, WEB_ROOT } from '../support/sidecar.ts';

const out = path.resolve(process.argv[2] ?? path.join(WEB_ROOT, 'tests/fixtures/sessions/brawl.jsonl'));
const state = path.join(WEB_ROOT, 'tests/fixtures/states/brawl.txt');
const LINGER = 1500;

async function main() {
  const sc = await startSidecar({
    record: out,
    deck: 'Fynn Deathtouch - Competitive Brawl',
    oppDeck: 'Krenko, Mob Boss - Mono-Red Goblins',
    extraArgs: ['--format', 'brawl', '--state', state],
    logFile: path.join(WEB_ROOT, 'tests', 'output', 'record-brawl-sidecar.log'),
  });
  console.log(`sidecar ready on ${sc.ready.port}; recording to ${out}`);
  const ws = new WebSocket(`ws://127.0.0.1:${sc.ready.port}/ws`);
  const send = (m: object) => ws.send(JSON.stringify(m));
  let model: GameModel = { game: { stack: [] }, players: {}, cards: {} };
  let viewer = 'p0';
  let prompt: PromptBody | null = null;
  let seq = 0;
  /** cast: commander cast · bolt: Bolt cast · back: commander back in the command zone · done: conceded. */
  let step: 'start' | 'cast' | 'bolt' | 'back' | 'done' = 'start';
  let busy = false;
  const apply = (p: { game?: GameModel['game']; players?: GameModel['players']; cards?: Record<string, Card | null> } | undefined) => {
    if (!p) return;
    if (p.game) model.game = p.game;
    Object.assign(model.players, p.players ?? {});
    for (const [k, v] of Object.entries(p.cards ?? {})) {
      if (v === null) delete model.cards[k];
      else model.cards[k] = v;
    }
  };
  const me = () => model.players[viewer];
  const commander = () => me()?.commander?.[0];
  const named = (name: string) => Object.values(model.cards).find((c) => c.owner === viewer && c.state?.name === name)?.id;
  /** Act after a pause (the replay shows the moment before it). */
  const later = (f: () => void, ms = 80) => {
    busy = true;
    setTimeout(() => {
      busy = false;
      f();
    }, ms);
  };

  const decide = () => {
    const p = prompt;
    if (busy || !p || p.kind === 'waiting' || step === 'done') return;
    const act = (body: object, ms?: number) => later(() => send({ t: 'act', pid: p.pid, ...body }), ms);
    const cmd = commander();
    const idle = p.kind === 'priority' && model.game.stack.length === 0 && model.game.playerTurn === viewer;
    if (p.kind === 'priority' && idle) {
      const zones = me()?.zones ?? {};
      if (step === 'start' && cmd && zones.command?.includes(cmd) && (p.weak?.[cmd] ?? 0) > 0) {
        console.log(`commanders: ${JSON.stringify(Object.values(model.players).map((pl) => [pl.id, pl.commander, pl.commanderCast]))}`);
        step = 'cast';
        return act({ kind: 'card', card: cmd }, LINGER);
      }
      if (step === 'cast' && cmd && zones.battlefield?.includes(cmd)) {
        const bolt = named('Lightning Bolt');
        if (!bolt) throw new Error('no Lightning Bolt in hand');
        step = 'bolt';
        return act({ kind: 'card', card: bolt }, LINGER);
      }
      if (step === 'back' || (step === 'bolt' && cmd && zones.command?.includes(cmd))) {
        console.log(`back: commanderCast=${JSON.stringify(me()?.commanderCast)} weak=${JSON.stringify(p.weak)}`);
        step = 'done';
        return later(() => send({ t: 'act', kind: 'concede' }), LINGER);
      }
    }
    if (p.kind === 'chooseTargets' && step === 'bolt' && cmd && p.selectable.includes(cmd)) return act({ kind: 'card', card: cmd });
    if (p.kind === 'payMana') {
      if (p.ok.enabled) act({ kind: 'ok' });
      return;
    }
    // Keep / play-or-draw before the board state, and passing with a spell on the stack.
    if (p.ok.enabled) act({ kind: 'ok' });
  };

  const answer = (a: AskMsg) => {
    let value: unknown;
    const text = JSON.stringify(a).toLowerCase();
    console.log(`ask ${a.kind}: ${text.slice(0, 300)}`);
    switch (a.kind) {
      case 'confirm':
        // "Move Fynn to the command zone?": yes.
        value = text.includes('command') ? true : (a.default ?? 0);
        break;
      case 'options':
        value = text.includes('command') ? Math.max(0, a.options.findIndex((o) => /command|yes/i.test(String(o)))) : (a.default ?? 0);
        break;
      case 'choose':
      case 'ability':
        value = a.items.filter((i) => i.enabled !== false).slice(0, Math.max(a.min, 1)).map((i) => i.idx);
        break;
      case 'text':
        value = a.initial ?? null;
        break;
      default:
        value = [];
    }
    setTimeout(() => send({ t: 'reply', id: a.id, value }), 200);
  };

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      void sc.stop();
      reject(new Error(`recording timed out at step ${step}`));
    }, 240_000);
    ws.onopen = () => send({ t: 'hello', proto: 1, token: sc.ready.token, client: { speed: 0, reducedMotion: false, beatCosts: {} } });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if ('seq' in m && typeof m.seq === 'number') seq = m.seq;
      switch (m.t) {
        case 'welcome':
          console.log(`welcome format=${m.format}`);
          send({ t: 'rpc', id: 'start', method: 'match.start', params: {} });
          break;
        case 'rpcResult':
          console.log(JSON.stringify(m).slice(0, 400));
          break;
        case 'snapshot':
          model = { game: m.game, players: m.players, cards: m.cards };
          viewer = m.viewer;
          prompt = m.prompt ?? null;
          decide();
          break;
        case 'beat':
        case 'settle':
          apply(m.patch);
          if (step === 'bolt' && commander() && me()?.zones.command?.includes(commander()!)) step = 'back';
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
          answer(m);
          break;
        case 'gameOver':
          console.log(`game over at turn ${model.game.turn}`);
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

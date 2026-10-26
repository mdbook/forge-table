// Two synthetic sessions for the mulligan banner and trigger ordering (no recording has either):
// - mull.jsonl: the mulligan as InputConfirmMulligan / InputLondonMulligan send it: keep 7?, mulligan, keep 6?, then the
//   London tuck ("Return 1 card(s) to the bottom of your library"), one card picked (the engine's OK lights up).
// - triggers.jsonl: three combat damage triggers at once, ordered as PlayerControllerHuman.orderSimultaneousSa asks
//   (BridgeGuiGame.order: every item its host card, min = max = all, remember).
// node tests/fixtures/make-b5b7.mjs → tests/fixtures/sessions/{mull,triggers}.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions');

function session(title, turn, phase, build) {
  let next = 1;
  const cards = {};
  const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };
  const add = (owner, zone, name, o = {}) => {
    const id = o.id ?? `c${next++}`;
    const core = o.core ?? ['Creature'];
    const creature = core.includes('Creature');
    cards[id] = {
      id,
      owner,
      controller: owner,
      zone,
      state: {
        face: 'Original',
        name,
        colors: o.colors ?? '',
        type: { super: o.super ?? [], core, sub: o.sub ?? [] },
        manaCost: o.cost,
        oracleText: o.text ?? '',
        power: creature ? (o.power ?? 2) : undefined,
        toughness: creature ? (o.toughness ?? 2) : undefined,
        printedPower: creature ? (o.power ?? 2) : undefined,
        printedToughness: creature ? (o.toughness ?? 2) : undefined,
      },
    };
    zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()].push(id);
    return cards[id];
  };
  for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) add(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
  const hidden = (owner, n) => {
    for (let i = 0; i < n; i++) {
      const id = `h${owner}${i}`;
      cards[id] = { id, owner, controller: owner, zone: 'Hand' };
      zones[owner].hand.push(id);
    }
  };
  const steps = build(add, hidden);
  const players = {
    p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
    p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
  };
  const game = { gameType: 'Constructed', title, turn, phase, playerTurn: 'p0', priority: 'p0', stack: [] };
  let seq = 0;
  const lines = [{ t: 'snapshot', viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] }, seq: seq++ }];
  for (const m of steps) lines.push({ ...m, seq: seq++ });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });

const mull = session('Mulligan', 0, undefined, (add, hidden) => {
  const hand = [
    add('p0', 'Hand', 'Monastery Swiftspear', { colors: 'R', cost: '{R}', power: 1, toughness: 2, text: 'Haste\nProwess' }),
    add('p0', 'Hand', 'Goblin Guide', { colors: 'R', cost: '{R}', text: 'Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library. If it\'s a land card, that player puts it into their hand.' }),
    add('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], colors: 'R', cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' }),
    add('p0', 'Hand', 'Skewer the Critics', { core: ['Sorcery'], colors: 'R', cost: '{2}{R}', text: 'Spectacle {R}\nSkewer the Critics deals 3 damage to any target.' }),
    add('p0', 'Hand', 'Mountain', { core: ['Land'], super: ['Basic'], sub: ['Mountain'], text: '({T}: Add {R}.)' }),
    add('p0', 'Hand', 'Mountain', { core: ['Land'], super: ['Basic'], sub: ['Mountain'], text: '({T}: Add {R}.)' }),
    add('p0', 'Hand', 'Sacred Foundry', { core: ['Land'], sub: ['Mountain', 'Plains'], text: '({T}: Add {R} or {W}.)\nAs Sacred Foundry enters, you may pay 2 life. If you don\'t, it enters tapped.' }),
  ];
  hidden('p1', 7);
  const keep = (pid) => ({ t: 'prompt', ...prompt({ kind: 'mulligan', pid, message: 'Player, you are going first!\n\nDo you want to keep your hand?', ok: { label: 'Keep', enabled: true }, cancel: { label: 'Mulligan', enabled: true }, focusOk: true }) });
  const ids = hand.map((c) => c.id);
  const skewer = hand[3].id;
  return [
    keep(1),
    { t: 'promptClear', pid: 1 },
    keep(2),
    { t: 'promptClear', pid: 2 },
    { t: 'prompt', ...prompt({ kind: 'mulliganTuck', pid: 3, message: 'Return 1 card(s) to the bottom of your library', ok: { label: 'OK', enabled: false }, cancel: { label: 'Auto', enabled: true }, selectable: ids, selMin: 1, selMax: 1 }) },
    { t: 'promptUpdate', ...prompt({ kind: 'mulliganTuck', pid: 3, message: 'Return 0 card(s) to the bottom of your library', ok: { label: 'OK', enabled: true }, cancel: { label: 'Auto', enabled: false }, selectable: ids, highlighted: [skewer], selMin: 1, selMax: 1 }) },
    { t: 'promptClear', pid: 3 },
    { t: 'prompt', ...prompt({ kind: 'waiting', pid: 4, message: 'Waiting for opponent…' }) },
  ];
});

const triggers = session('Triggers', 5, 'COMBAT_DAMAGE', (add, hidden) => {
  for (let i = 0; i < 3; i++) add('p0', 'Battlefield', 'Island', { core: ['Land'], super: ['Basic'], sub: ['Island'], text: '({T}: Add {U}.)' });
  add('p0', 'Battlefield', 'Mountain', { core: ['Land'], super: ['Basic'], sub: ['Mountain'], text: '({T}: Add {R}.)' });
  const ragavan = add('p0', 'Battlefield', 'Ragavan, Nimble Pilferer', {
    colors: 'R',
    cost: '{R}',
    super: ['Legendary'],
    sub: ['Monkey', 'Pirate'],
    text: 'Whenever Ragavan, Nimble Pilferer deals combat damage to a player, create a Treasure token and exile the top card of that player\'s library. Until end of turn, you may cast that card.\nDash {1}{R}',
  });
  const sword = add('p0', 'Battlefield', 'Sword of Fire and Ice', {
    core: ['Artifact'],
    sub: ['Equipment'],
    cost: '{3}',
    text: 'Equipped creature gets +2/+2 and has protection from red and from blue.\nWhenever equipped creature deals combat damage to a player, Sword of Fire and Ice deals 2 damage to any target and you draw a card.\nEquip {2}',
  });
  const ninja = add('p0', 'Battlefield', 'Ninja of the Deep Hours', { colors: 'U', cost: '{3}{U}', sub: ['Human', 'Ninja'], text: 'Ninjutsu {1}{U}\nWhenever Ninja of the Deep Hours deals combat damage to a player, you may draw a card.' });
  for (let i = 0; i < 4; i++) add('p1', 'Battlefield', 'Island', { core: ['Land'], super: ['Basic'], sub: ['Island'] });
  hidden('p0', 2);
  hidden('p1', 4);
  return [
    {
      t: 'ask',
      id: 't1',
      pid: 1,
      kind: 'order',
      title: 'Select order for simultaneous abilities',
      message: 'Resolve first',
      items: [
        { idx: 0, card: ragavan.id, label: 'Ragavan, Nimble Pilferer - Whenever Ragavan, Nimble Pilferer deals combat damage to a player, create a Treasure token and exile the top card of that player\'s library.' },
        { idx: 1, card: sword.id, label: 'Sword of Fire and Ice - Whenever equipped creature deals combat damage to a player, Sword of Fire and Ice deals 2 damage to any target and you draw a card.' },
        { idx: 2, card: ninja.id, label: 'Ninja of the Deep Hours - Whenever Ninja of the Deep Hours deals combat damage to a player, you may draw a card.' },
      ],
      min: 3,
      max: 3,
      ordered: true,
      remember: true,
    },
    { t: 'askClear', id: 't1' },
    { t: 'prompt', ...prompt({ kind: 'priority', pid: 2, cancel: { label: 'End Turn', enabled: true } }) },
  ];
});

writeFileSync(path.join(DIR, 'mull.jsonl'), mull);
writeFileSync(path.join(DIR, 'triggers.jsonl'), triggers);

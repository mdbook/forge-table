// A synthetic session for "Choose a mode" (mode tiles) and an engine confirm: Kolaghan's Command cast, its
// two modes asked one at a time as PlayerControllerHuman.chooseModeForAbility does (every item the host card, the
// second ask over the modes left), then Ninja of the Deep Hours' optional trigger as BridgeGuiGame.confirm sends it.
// Last, Wooded Foothills' library search: 22 cards with faces, three of them can be picked.
// node tests/fixtures/make-prompts.mjs → tests/fixtures/sessions/prompts.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'prompts.jsonl');
let next = 1;
const cards = {};
const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };

function add(owner, zone, name, o = {}) {
  const n = next++; // a library slot passes its own hidden id but still takes a number, so other ids don't shift
  const id = o.id ?? `c${n}`;
  const core = o.core ?? ['Creature'];
  const c = {
    id,
    owner,
    controller: owner,
    zone,
    tapped: o.tapped,
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? '',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost,
      oracleText: o.text ?? '',
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      printedPower: core.includes('Creature') ? (o.power ?? 2) : undefined,
      printedToughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
    },
  };
  cards[id] = c;
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()].push(id);
  return c;
}
const land = (p, name, o = {}) => add(p, 'Battlefield', name, { core: ['Land'], ...o });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) add(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (const c of ['Mountain', 'Mountain', 'Swamp', 'Swamp']) land('p0', c, { super: ['Basic'], sub: [c], tapped: true });
const ninja = add('p0', 'Battlefield', 'Ninja of the Deep Hours', { colors: 'U', cost: '{3}{U}', sub: ['Human', 'Ninja'], text: 'Ninjutsu {1}{U}\nWhenever Ninja of the Deep Hours deals combat damage to a player, you may draw a card.' });
const command = add('p0', 'Hand', "Kolaghan's Command", { core: ['Instant'], colors: 'BR', cost: '{1}{B}{R}', text: "Choose two —\n• Return target creature card from your graveyard to your hand.\n• Target player discards a card.\n• Destroy target artifact.\n• Kolaghan's Command deals 2 damage to any target." });
add('p0', 'Graveyard', 'Bloodghast', { colors: 'B', cost: '{1}{B}', sub: ['Vampire', 'Spirit'], power: 2, toughness: 1 });
add('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], colors: 'R', cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' });
for (let i = 0; i < 4; i++) land('p1', 'Island', { super: ['Basic'], sub: ['Island'] });
add('p1', 'Battlefield', 'Ornithopter', { core: ['Artifact', 'Creature'], cost: '{0}', power: 0, toughness: 2, text: 'Flying' });
add('p1', 'Battlefield', 'Wind Drake', { colors: 'U', cost: '{2}{U}', power: 2, toughness: 2, text: 'Flying' });
for (let i = 0; i < 4; i++) {
  const id = `c${next++}`;
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}

const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Modes and confirms', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

let seq = 0;
const lines = [];
const push = (m) => lines.push({ ...m, seq: seq++ });
const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });
const MODES = [
  'Return target creature card from your graveyard to your hand.',
  'Target player discards a card.',
  'Destroy target artifact.',
  "Kolaghan's Command deals 2 damage to any target.",
];
const modeAsk = (id, left, min) => ({ t: 'ask', id, pid: 1, kind: 'choose', message: "Player activated Kolaghan's Command - Choose a mode", items: left.map((m, idx) => ({ idx, label: MODES[m], card: command.id })), min, max: 1 });

push({ t: 'snapshot', viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 1, cancel: { label: 'End Turn', enabled: true } }) });
push(modeAsk('m1', [0, 1, 2, 3], 1));
push({ t: 'askClear', id: 'm1' });
push(modeAsk('m2', [0, 2, 3], 1));
push({ t: 'askClear', id: 'm2' });
push({
  t: 'ask',
  id: 'c1',
  pid: 1,
  kind: 'confirm',
  message: `Use triggered ability of Ninja of the Deep Hours (${ninja.id.slice(1)})?\n(Whenever Ninja of the Deep Hours deals combat damage to a player, you may draw a card.)`,
  options: ['Yes', 'No'],
  default: 0,
  card: ninja.id,
});
push({ t: 'askClear', id: 'c1' });
const LIB = [
  ['Lightning Bolt', 'R', ['Instant'], '{R}', 'Lightning Bolt deals 3 damage to any target.'],
  ['Goblin Guide', 'R', ['Creature'], '{R}', 'Haste'],
  ['Monastery Swiftspear', 'R', ['Creature'], '{R}', 'Haste\nProwess'],
  ['Eidolon of the Great Revel', 'R', ['Enchantment', 'Creature'], '{R}{R}', 'Whenever a player casts a spell with mana value 3 or less, Eidolon of the Great Revel deals 2 damage to that player.'],
  ['Skewer the Critics', 'R', ['Sorcery'], '{2}{R}', 'Spectacle {R}\nSkewer the Critics deals 3 damage to any target.'],
  ['Rift Bolt', 'R', ['Sorcery'], '{2}{R}', 'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R}'],
  ['Lava Spike', 'R', ['Sorcery'], '{R}', 'Lava Spike deals 3 damage to target player or planeswalker.'],
  ['Light Up the Stage', 'R', ['Sorcery'], '{2}{R}', 'Spectacle {R}\nExile the top two cards of your library. Until the end of your next turn, you may play those cards.'],
  ['Searing Blaze', 'R', ['Instant'], '{R}{R}', 'Searing Blaze deals 1 damage to target player and 1 damage to target creature that player controls.'],
  ['Boros Charm', 'RW', ['Instant'], '{R}{W}', 'Choose one —\n• Boros Charm deals 4 damage to target player or planeswalker.\n• Permanents you control gain indestructible until end of turn.\n• Target creature gains double strike until end of turn.'],
  ['Lightning Helix', 'RW', ['Instant'], '{R}{W}', 'Lightning Helix deals 3 damage to any target and you gain 3 life.'],
  ['Sacred Foundry', '', ['Land'], '', '({T}: Add {R} or {W}.)', ['Mountain', 'Plains']],
  ['Inspiring Vantage', '', ['Land'], '', 'Inspiring Vantage enters tapped unless you control two or fewer other lands.\n{T}: Add {R} or {W}.'],
  ['Mountain', '', ['Land'], '', '({T}: Add {R}.)', ['Mountain']],
  ['Sunbaked Canyon', '', ['Land'], '', '{T}, Pay 1 life: Add {R} or {W}.'],
  ['Arid Mesa', '', ['Land'], '', '{T}, Pay 1 life, Sacrifice Arid Mesa: Search your library for a Mountain or Plains card.'],
  ['Bloodstained Mire', '', ['Land'], '', '{T}, Pay 1 life, Sacrifice Bloodstained Mire: Search your library for a Swamp or Mountain card.'],
  ['Wooded Foothills', '', ['Land'], '', '{T}, Pay 1 life, Sacrifice Wooded Foothills: Search your library for a Mountain or Forest card.'],
  ['Plains', '', ['Land'], '', '({T}: Add {W}.)', ['Plains']],
  ['Fireblast', 'R', ['Instant'], '{4}{R}{R}', 'You may sacrifice two Mountains rather than pay this spell\'s mana cost.\nFireblast deals 4 damage to any target.'],
  ['Roiling Vortex', 'R', ['Enchantment'], '{1}{R}', 'At the beginning of each player\'s upkeep, Roiling Vortex deals 1 damage to them.'],
  ['Path to Exile', 'W', ['Instant'], '{W}', 'Exile target creature. Its controller may search their library for a basic land card.'],
];
const libFace = ([name, colors, core, manaCost, oracleText, sub = []]) => ({ face: 'Original', name, colors, type: { super: [], core, sub }, ...(manaCost ? { manaCost } : {}), oracleText });
const PICKABLE = ['Sacred Foundry', 'Mountain', 'Sunbaked Canyon'];
push({
  t: 'ask',
  id: 's1',
  pid: 2,
  kind: 'choose',
  title: 'Search your library',
  message: 'Wooded Foothills: choose a Mountain or Forest card',
  items: LIB.map((c, idx) => ({ idx, label: c[0], cardData: { state: libFace(c) }, enabled: PICKABLE.includes(c[0]) })),
  min: 0,
  max: 1,
});
push({ t: 'askClear', id: 's1' });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 3, cancel: { label: 'End Turn', enabled: true } }) });

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

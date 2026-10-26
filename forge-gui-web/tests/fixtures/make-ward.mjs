// A synthetic session for the protection look and the snooze look: the opponent's
// board wears hexproof, shroud, protection and ward in every shape; mine has a summoning-sick creature next to a
// snoozed one. I aim Lightning Bolt (prompt chooseTargets, only the plain Grizzly Bears is legal), then Shock at the
// ward creature: the ward trigger lands on the stack above it and links to the warded permanent.
// node tests/fixtures/make-ward.mjs → tests/fixtures/sessions/ward-fx.jsonl (replay.spec.ts goldens 40-41).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'ward-fx.jsonl');

let next = 100;
const cards = {};
const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };
function card(owner, zone, name, o = {}) {
  const id = o.id ?? `c${next++}`;
  const core = o.core ?? ['Creature'];
  const c = {
    id,
    owner,
    controller: owner,
    zone,
    tapped: o.tapped,
    sickness: o.sickness,
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? 'R',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost ?? (core.includes('Land') ? undefined : '{1}{R}'),
      oracleText: o.text ?? '',
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      keywords: (o.keywords ?? []).map((title) => ({ title })),
    },
  };
  cards[id] = c;
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()]?.push(id);
  return c;
}
const land = (p, name) => card(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], sub: [name], colors: '' });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) card(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 5; i++) land('p0', 'Mountain');
for (let i = 0; i < 4; i++) land('p1', 'Forest');
// Mine: a plain creature, a summoning-sick one (new this turn) and a snoozed one; the snoozed-and-sick one is the odd one out.
const plain = card('p0', 'Battlefield', 'Hill Giant', { power: 3, toughness: 3, sub: ['Giant'], cost: '{3}{R}' });
const sick = card('p0', 'Battlefield', 'Goblin Raider', { power: 2, toughness: 2, sub: ['Goblin'], sickness: true });
const snoozed = card('p0', 'Battlefield', 'Prodigal Pyromancer', { power: 1, toughness: 1, sub: ['Human', 'Wizard'], cost: '{2}{R}' });
const both = card('p0', 'Battlefield', 'Raging Goblin', { power: 1, toughness: 1, sub: ['Goblin'], sickness: true, keywords: ['Haste'] });
const bolt = card('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' });
const shock = card('p0', 'Hand', 'Shock', { core: ['Instant'], cost: '{R}', text: 'Shock deals 2 damage to any target.' });
// Theirs: every protection shape, and a plain bear so something is a legal target.
const G = { colors: 'G', cost: '{1}{G}' };
const hex = card('p1', 'Battlefield', 'Gladecover Scout', { ...G, power: 1, toughness: 1, sub: ['Elf', 'Scout'], keywords: ['Hexproof'] });
const shroud = card('p1', 'Battlefield', 'Argothian Enchantress', { ...G, power: 0, toughness: 1, sub: ['Human', 'Druid'], keywords: ['Shroud'] });
const pro = card('p1', 'Battlefield', 'Kor Firewalker', { colors: 'W', cost: '{W}{W}', power: 2, toughness: 2, sub: ['Kor', 'Soldier'], keywords: ['Protection from red'] });
const ward = card('p1', 'Battlefield', 'Warded Sentinel', { ...G, power: 3, toughness: 3, sub: ['Construct'], keywords: ['Ward {2}'] });
const lifeWard = card('p1', 'Battlefield', 'Vault Warden', { colors: 'U', cost: '{2}{U}', power: 2, toughness: 4, sub: ['Human', 'Wizard'], keywords: ['Ward—Pay 3 life.'] });
const combo = card('p1', 'Battlefield', 'Sacred Guardian', { colors: 'W', cost: '{2}{W}', power: 2, toughness: 3, sub: ['Angel'], keywords: ['Flying', 'Hexproof', 'Protection from black', 'Ward {1}{U}'] });
const bear = card('p1', 'Battlefield', 'Grizzly Bears', { ...G, power: 2, toughness: 2, sub: ['Bear'] });
for (const id of ['xh1', 'xh2', 'xh3']) {
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}
const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Ward Deck', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Ward', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

const lines = [{ t: 'snapshot', seq: 0, viewer: 'p0', game: clone(game), players: clone(players), cards: clone(cards), asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } }];
lines.push({ t: 'notice', kind: 'autoPass', autoSkip: true, untilEndOfTurn: false, snoozed: [snoozed.id, both.id] });
let seq = 0;
let pid = 0;
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function beat(kind, fields, fn) {
  const touched = new Set(fn?.() ?? []);
  const patchCards = {};
  for (const id of touched) patchCards[id] = cards[id] ? clone(cards[id]) : null;
  lines.push({ t: 'beat', seq: ++seq, kind, ...fields, patch: { game: clone(game), players: clone(players), cards: patchCards } });
}
function move(id, zone, owner = cards[id].owner) {
  const c = cards[id];
  for (const p of ['p0', 'p1']) for (const z of Object.keys(zones[p])) zones[p][z] = zones[p][z].filter((x) => x !== id);
  players.p0.zones = zones.p0;
  players.p1.zones = zones.p1;
  c.zone = zone;
  if (zone !== 'Stack') zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()].push(id);
  return id;
}
function priority(message = '') {
  game.priority = 'p0';
  lines.push({ t: 'prompt', seq: ++seq, pid: ++pid, kind: 'priority', seat: 'p0', message, ok: { label: 'OK', enabled: true }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak: {} });
  lines.push({ t: 'promptClear', seq: ++seq, pid });
}
const item = (id, source, text, o = {}) => ({ id, text, source, activator: o.activator ?? 'p0', ability: !!o.ability, trigger: !!o.trigger, targets: o.targets ?? [] });

priority('Main phase: the board');
// 1. Lightning Bolt: choose a target. Only the Bears are legal (the rest are protected from it).
beat('toStack', { card: bolt.id, from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } }, () => [move(bolt.id, 'Stack')]);
lines.push({ t: 'prompt', seq: ++seq, pid: ++pid, kind: 'chooseTargets', seat: 'p0', card: bolt.id, message: 'Lightning Bolt deals 3 damage to any target.\n\nSelect any target', ok: { label: 'OK', enabled: false }, cancel: { label: 'Cancel', enabled: true }, focusOk: false, selectable: [bear.id, ward.id, lifeWard.id], selMin: 1, selMax: 1, highlighted: [], weak: {} });
lines.push({ t: 'promptClear', seq: ++seq, pid });
// 2. The Bolt is cast at the Bears and resolves.
beat('cast', {}, () => {
  game.stack = [item('i1', bolt.id, 'Lightning Bolt - Lightning Bolt deals 3 damage to Grizzly Bears.', { targets: [bear.id] })];
  return [];
});
priority();
beat('dies', { card: bear.id, from: { player: 'p1', zone: 'Battlefield' }, to: { player: 'p1', zone: 'Graveyard' } }, () => [move(bear.id, 'Graveyard')]);
beat('toGraveyard', { card: bolt.id, from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Graveyard' } }, () => {
  game.stack = [];
  return [move(bolt.id, 'Graveyard')];
});
priority();
// 3. Shock at Warded Sentinel: its ward trigger goes on the stack above the Shock.
beat('toStack', { card: shock.id, from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } }, () => {
  move(shock.id, 'Stack');
  game.stack = [item('i2', shock.id, 'Shock - Shock deals 2 damage to Warded Sentinel.', { targets: [ward.id] })];
  return [shock.id];
});
beat('cast', {}, () => []);
beat('activate', {}, () => {
  game.stack = [item('i3', ward.id, 'Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)', { activator: 'p1', ability: true, trigger: true }), ...game.stack];
  return [];
});
priority('Ward trigger on the stack');

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`${OUT}: ${lines.length} messages`);

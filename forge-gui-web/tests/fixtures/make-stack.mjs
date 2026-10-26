// A synthetic session for the stack zone: every way onto and off the stack in one
// replay. I bolt the opponent's Spellstutter Sprite, my Kessig Flamebreather triggers, the opponent answers with a
// Counterspell (presented), which counters the Bolt (it shatters); the Counterspell and the trigger resolve; I activate
// Prodigal Pyromancer at the opponent (an ability card with an arrow), then cast Hill Giant (it lands with a thump)
// and a rebound spell that resolves to exile. Priority prompts between steps give the goldens stable frames.
// node tests/fixtures/make-stack.mjs → tests/fixtures/sessions/stack-fx.jsonl (replay.spec.ts goldens 30–33).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'stack-fx.jsonl');

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
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? 'R',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost ?? (core.includes('Land') ? undefined : '{1}{R}'),
      oracleText: o.text ?? '',
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
    },
  };
  cards[id] = c;
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()]?.push(id);
  return c;
}
const land = (p, name) => card(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], sub: [name], colors: '' });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) card(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 5; i++) land('p0', 'Mountain');
for (let i = 0; i < 4; i++) land('p1', 'Island');
const kessig = card('p0', 'Battlefield', 'Kessig Flamebreather', { power: 1, toughness: 3, sub: ['Human', 'Shaman'], text: 'Whenever you cast a noncreature spell, Kessig Flamebreather deals 1 damage to each opponent.' });
const pyro = card('p0', 'Battlefield', 'Prodigal Pyromancer', { power: 1, toughness: 1, sub: ['Human', 'Wizard'], cost: '{2}{R}', text: '{T}: Prodigal Pyromancer deals 1 damage to any target.' });
const sprite = card('p1', 'Battlefield', 'Spellstutter Sprite', { colors: 'U', cost: '{1}{U}', power: 1, toughness: 1, sub: ['Faerie', 'Wizard'], text: 'Flash\nFlying' });
const bolt = card('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' });
const giant = card('p0', 'Hand', 'Hill Giant', { cost: '{3}{R}', power: 3, toughness: 3, sub: ['Giant'] });
const rebound = card('p0', 'Hand', 'Staggershock', { core: ['Instant'], cost: '{2}{R}', text: 'Staggershock deals 2 damage to any target.\nRebound' });
card('p0', 'Hand', 'Mountain', { core: ['Land'], colors: '' });
const oppHand = ['xh1', 'xh2', 'xh3'];
for (const id of oppHand) {
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}
const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Stack', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

const lines = [{ t: 'snapshot', seq: 0, viewer: 'p0', game: clone(game), players: clone(players), cards: clone(cards), asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } }];
let seq = 0;
let pid = 0;
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
/** A beat: `fn` changes the model; the patch carries the game, both players and every card it touched. */
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

// 1. I cast Lightning Bolt at the Sprite; Kessig triggers.
beat('toStack', { card: bolt.id, from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } }, () => {
  move(bolt.id, 'Stack');
  game.stack = [item('i1', bolt.id, `Lightning Bolt - Lightning Bolt deals 3 damage to Spellstutter Sprite.`, { targets: [sprite.id] })];
  return [bolt.id];
});
beat('cast', {}, () => []);
beat('activate', {}, () => {
  game.stack = [item('i2', kessig.id, 'Kessig Flamebreather - Whenever you cast a noncreature spell, Kessig Flamebreather deals 1 damage to each opponent.', { ability: true, trigger: true }), ...game.stack];
  return [];
});
priority();
// 2. The opponent answers: Counterspell at the Bolt (presented on its way to the stack).
const counter = card('p1', 'Stack', 'Counterspell', { core: ['Instant'], colors: 'U', cost: '{U}{U}', text: 'Counter target spell.' });
zones.p1.hand = zones.p1.hand.filter((x) => x !== 'xh1');
delete cards.xh1;
beat('toStack', { card: counter.id, fromId: 'xh1', from: { player: 'p1', zone: 'Hand' }, to: { zone: 'Stack' } }, () => {
  game.priority = 'p1';
  game.stack = [item('i3', counter.id, 'Counterspell - Counter target spell. (Targeting: [[Lightning Bolt]])', { activator: 'p1', targets: [bolt.id] }), ...game.stack];
  return [counter.id, 'xh1'];
});
beat('cast', {}, () => []);
priority();
// 3. Counterspell resolves: the Bolt is countered (it shatters), then the Counterspell goes to its graveyard.
beat('toGraveyard', { card: bolt.id, from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Graveyard' } }, () => [move(bolt.id, 'Graveyard')]);
beat('toGraveyard', { card: counter.id, from: { zone: 'Stack' }, to: { player: 'p1', zone: 'Graveyard' } }, () => {
  game.stack = game.stack.filter((s) => s.id !== 'i3' && s.id !== 'i1');
  return [move(counter.id, 'Graveyard')];
});
beat('resolve', {}, () => []);
beat('removeFromStack', {}, () => []);
priority();
// 4. Kessig's trigger resolves (1 to the opponent): the ability card flashes away.
beat('damage', { target: 'p1', amount: 1, source: kessig.id }, () => []);
beat('life', { player: 'p1', oldLives: 20, newLives: 19 }, () => {
  players.p1.life = 19;
  return [];
});
beat('resolve', {}, () => {
  game.stack = [];
  return [];
});
beat('removeFromStack', {}, () => []);
priority();
// 5. Prodigal Pyromancer pings the opponent: its ability springs out of it, an arrow to the opponent.
beat('tap', { card: pyro.id }, () => {
  cards[pyro.id].tapped = true;
  return [pyro.id];
});
beat('activate', {}, () => {
  game.stack = [item('i4', pyro.id, 'Prodigal Pyromancer - Prodigal Pyromancer deals 1 damage to Mono-Blue Faeries.', { ability: true, targets: ['p1'] })];
  return [];
});
priority();
beat('damage', { target: 'p1', amount: 1, source: pyro.id }, () => []);
beat('life', { player: 'p1', oldLives: 19, newLives: 18 }, () => {
  players.p1.life = 18;
  return [];
});
beat('resolve', {}, () => {
  game.stack = [];
  return [];
});
priority();
// 6. Hill Giant: onto the stack, then lands on the battlefield with a thump.
beat('toStack', { card: giant.id, from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } }, () => {
  move(giant.id, 'Stack');
  game.stack = [item('i5', giant.id, 'Hill Giant')];
  return [giant.id];
});
priority();
beat('etb', { card: giant.id, from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Battlefield' } }, () => {
  game.stack = [];
  cards[giant.id].sickness = true;
  return [move(giant.id, 'Battlefield')];
});
priority();
// 7. Staggershock (rebound) at the Sprite: resolves to exile.
beat('toStack', { card: rebound.id, from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } }, () => {
  move(rebound.id, 'Stack');
  game.stack = [item('i6', rebound.id, 'Staggershock - Staggershock deals 2 damage to Spellstutter Sprite.', { targets: [sprite.id] })];
  return [rebound.id];
});
priority();
beat('dies', { card: sprite.id, from: { player: 'p1', zone: 'Battlefield' }, to: { player: 'p1', zone: 'Graveyard' } }, () => [move(sprite.id, 'Graveyard')]);
beat('exile', { card: rebound.id, from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Exile' } }, () => {
  game.stack = [];
  return [move(rebound.id, 'Exile')];
});
priority();

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`${OUT}: ${lines.length} messages`);

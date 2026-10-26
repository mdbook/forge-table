// A synthetic session for the alt-zone strip and the ninjutsu cue: in my first main
// phase five cards wait outside my hand and are castable (the commander, Faithless Looting by flashback, a foretold
// Demon Bolt, a plotted Slickshot Show-Off, Bonecrusher Giant on an adventure); I flash back the Looting (it leaves the
// strip); then my Faerie Seer attacks unblocked and my hand's Ninja of the Deep Hours glows with its ninjutsu cue; I
// activate it (Seer returns to hand, the Ninja enters tapped and attacking).
// node tests/fixtures/make-alt.mjs → tests/fixtures/sessions/alt-zones.jsonl (replay.spec.ts goldens 42–43).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'alt-zones.jsonl');

let next = 100;
const cards = {};
const zones = {
  p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [], command: [] },
  p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [], command: [] },
};
const key = (zone) => (zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase());
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
      keywords: o.keywords?.map((title) => ({ title })),
    },
  };
  cards[id] = c;
  zones[owner][key(zone)]?.push(id);
  return c;
}
const land = (p, name) => card(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], sub: [name], colors: '' });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) card(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 5; i++) land('p0', 'Mountain');
for (let i = 0; i < 3; i++) land('p0', 'Island');
for (let i = 0; i < 4; i++) land('p1', 'Island');
const seer = card('p0', 'Battlefield', 'Faerie Seer', { colors: 'U', cost: '{U}', power: 1, toughness: 1, sub: ['Faerie', 'Wizard'], keywords: ['Flying'] });
const sprite = card('p1', 'Battlefield', 'Spellstutter Sprite', { colors: 'U', cost: '{1}{U}', power: 1, toughness: 1, sub: ['Faerie', 'Wizard'], keywords: ['Flash', 'Flying'] });
card('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' });
const ninja = card('p0', 'Hand', 'Ninja of the Deep Hours', { colors: 'U', cost: '{3}{U}', power: 2, toughness: 2, sub: ['Human', 'Ninja'], keywords: ['Ninjutsu {1}{U}'], text: 'Ninjutsu {1}{U}\nWhenever Ninja of the Deep Hours deals combat damage to a player, you may draw a card.' });
card('p0', 'Hand', 'Mountain', { core: ['Land'], colors: '' });
card('p0', 'Hand', 'Hill Giant', { cost: '{3}{R}', power: 3, toughness: 3, sub: ['Giant'] });
// The strip: the commander, a flashback spell, a foretold card (face down, its face in alt), a plotted card, an adventure card.
const krenko = card('p0', 'Command', 'Krenko, Mob Boss', { cost: '{2}{R}{R}', power: 3, toughness: 3, sub: ['Goblin', 'Warrior'], super: ['Legendary'] });
const looting = card('p0', 'Graveyard', 'Faithless Looting', { core: ['Sorcery'], cost: '{R}', keywords: ['Flashback {2}{R}'], text: 'Draw two cards, then discard two cards.\nFlashback {2}{R}' });
card('p0', 'Graveyard', 'Lightning Bolt', { core: ['Instant'], cost: '{R}' });
const demon = card('p0', 'Exile', 'Demon Bolt', { core: ['Instant'], cost: '{2}{R}', keywords: ['Foretell {R}'], text: 'Foretell {R}\nDemon Bolt deals 4 damage to target creature or planeswalker.' });
demon.alt = demon.state;
demon.state = { face: 'FaceDown', imageKey: 't:hidden', type: { super: [], core: ['Creature'], sub: [] }, power: 2, toughness: 2 };
demon.facedown = true;
demon.playerMayLook = ['p0'];
const slick = card('p0', 'Exile', 'Slickshot Show-Off', { cost: '{1}{R}', power: 1, toughness: 2, sub: ['Bird', 'Wizard'], keywords: ['Flying', 'Haste', 'Plot {1}{R}'] });
const giant = card('p0', 'Exile', 'Bonecrusher Giant', { cost: '{2}{R}', power: 4, toughness: 3, sub: ['Giant'], text: 'Whenever Bonecrusher Giant becomes the target of a spell, Bonecrusher Giant deals 2 damage to that spell’s controller.' });
giant.alt = { face: 'Original', name: 'Stomp', manaCost: '{1}{R}', type: { super: [], core: ['Instant'], sub: ['Adventure'] }, colors: 'R' };
for (const id of ['xh1', 'xh2', 'xh3']) {
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}
const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Alt zones', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

const clone = (o) => JSON.parse(JSON.stringify(o));
const lines = [{ t: 'snapshot', seq: 0, viewer: 'p0', game: clone(game), players: clone(players), cards: clone(cards), asks: [], stops: { p0: ['MAIN1', 'MAIN2', 'COMBAT_DECLARE_BLOCKERS'], p1: [] } }];
let seq = 0;
let pid = 0;
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
  if (zone !== 'Stack') zones[owner][key(zone)].push(id);
  return id;
}
function priority(weak, message = '') {
  game.priority = 'p0';
  lines.push({ t: 'prompt', seq: ++seq, pid: ++pid, kind: 'priority', seat: 'p0', message, ok: { label: 'OK', enabled: true }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak });
  lines.push({ t: 'promptClear', seq: ++seq, pid });
}
const item = (id, source, text, o = {}) => ({ id, text, source, activator: 'p0', ability: !!o.ability, trigger: false, targets: o.targets ?? [] });
const handIds = () => zones.p0.hand;
const boltId = handIds()[0];

// 1. Main phase: the strip holds five castable cards, and a Bolt and the Hill Giant are castable from hand.
priority({ [boltId]: 1, [handIds()[3]]: 1, [krenko.id]: 1, [looting.id]: 1, [demon.id]: 1, [slick.id]: 1, [giant.id]: 1 });
// 2. I flash back Faithless Looting: it leaves the strip for the stack, then is exiled.
beat('toStack', { card: looting.id, from: { player: 'p0', zone: 'Graveyard' }, to: { zone: 'Stack' } }, () => {
  move(looting.id, 'Stack');
  game.stack = [item('i1', looting.id, 'Faithless Looting - Draw two cards, then discard two cards.')];
  return [looting.id];
});
beat('cast', {}, () => []);
priority({});
beat('exile', { card: looting.id, from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Exile' } }, () => {
  game.stack = [];
  return [move(looting.id, 'Exile')];
});
priority({ [boltId]: 1, [krenko.id]: 1, [demon.id]: 1, [slick.id]: 1, [giant.id]: 1 });
// 3. Combat: Faerie Seer attacks and is not blocked.
beat('phase', { phase: 'COMBAT_DECLARE_ATTACKERS' }, () => {
  game.phase = 'COMBAT_DECLARE_ATTACKERS';
  return [];
});
beat('tap', { card: seer.id }, () => {
  cards[seer.id].tapped = true;
  cards[seer.id].attacking = true;
  game.combat = [{ attacker: seer.id, defender: 'p1', blockers: [] }];
  return [seer.id];
});
beat('phase', { phase: 'COMBAT_DECLARE_BLOCKERS' }, () => {
  game.phase = 'COMBAT_DECLARE_BLOCKERS';
  return [];
});
// 4. Declare blockers, no block: the Ninja in my hand is the only thing to do, and shows its cue.
priority({ [ninja.id]: 1 });
// 5. Ninjutsu: the Seer returns to my hand, the ability goes on the stack, the Ninja enters tapped and attacking.
beat('bounce', { card: seer.id, from: { player: 'p0', zone: 'Battlefield' }, to: { player: 'p0', zone: 'Hand' } }, () => {
  cards[seer.id].tapped = false;
  cards[seer.id].attacking = false;
  game.combat = [];
  return [move(seer.id, 'Hand')];
});
beat('activate', {}, () => {
  game.stack = [item('i2', ninja.id, 'Ninja of the Deep Hours - Ninjutsu: put it onto the battlefield tapped and attacking.', { ability: true })];
  return [];
});
priority({});
beat('etb', { card: ninja.id, from: { player: 'p0', zone: 'Hand' }, to: { player: 'p0', zone: 'Battlefield' } }, () => {
  game.stack = [];
  cards[ninja.id].tapped = true;
  cards[ninja.id].attacking = true;
  game.combat = [{ attacker: ninja.id, defender: 'p1', blockers: [] }];
  return [move(ninja.id, 'Battlefield')];
});
priority({});

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`${OUT}: ${lines.length} messages (sprite ${sprite.id}, seer ${seer.id}, ninja ${ninja.id}, krenko ${krenko.id}, looting ${looting.id}, demon ${demon.id}, slick ${slick.id}, giant ${giant.id})`);

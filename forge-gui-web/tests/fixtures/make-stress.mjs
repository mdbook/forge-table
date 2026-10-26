// Stress sessions for the UI QA pass: a snapshot of an extreme board and a priority prompt, nothing else.
// node tests/fixtures/make-stress.mjs → tests/fixtures/sessions/stress-*.jsonl (shot by viewports.spec.ts, FT_STRESS).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions');

let next = 1;
function card(owner, zone, name, o = {}) {
  const n = next++; // a library slot passes its own hidden id but still takes a number, so other ids don't shift
  const id = o.id ?? `s${n}`;
  const core = o.core ?? ['Creature'];
  return {
    id,
    owner,
    controller: o.controller ?? owner,
    zone,
    token: o.token,
    tapped: o.tapped,
    sickness: o.sickness,
    damage: o.damage,
    counters: o.counters,
    attacking: o.attacking,
    blocking: o.blocking,
    entityAttachedTo: o.on,
    name,
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? 'R',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost ?? (core.includes('Land') ? undefined : '{1}{R}'),
      oracleText: o.text ?? '',
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      printedPower: core.includes('Creature') && !o.token ? (o.printedPower ?? o.power ?? 2) : undefined,
      printedToughness: core.includes('Creature') && !o.token ? (o.printedToughness ?? o.toughness ?? 2) : undefined,
      loyalty: o.loyalty,
      keywords: (o.keywords ?? []).map((k) => ({ title: k })),
      imageKey: o.imageKey,
    },
  };
}

const land = (p, name = p === 'p0' ? 'Mountain' : 'Island', o = {}) =>
  card(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], sub: [name], colors: '', ...o });

function session(name, build) {
  next = 1;
  const cards = {};
  const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };
  const add = (c) => {
    cards[c.id] = c;
    // Stack cards live in game.stack, not in a player zone.
    if (c.zone !== 'Stack') zones[c.owner][c.zone === 'Battlefield' ? 'battlefield' : c.zone.toLowerCase()].push(c.id);
    return c;
  };
  const players = {
    p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
    p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
  };
  const game = { gameType: 'Constructed', title: 'Stress', turn: 9, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };
  for (const p of ['p0', 'p1']) for (let i = 0; i < 30; i++) add(card(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` }));
  for (let i = 0; i < 4; i++) add(card('p0', 'Hand', ['Lightning Bolt', 'Fiery Temper', 'Kessig Flamebreather', 'Mountain'][i], i === 3 ? { core: ['Land'], colors: '' } : { core: i < 2 ? ['Instant'] : ['Creature'] }));
  for (let i = 0; i < 3; i++) add(card('p1', 'Hand', 'Hidden'));
  // Extra prompt fields (e.g. `costs`), appended after the usual ones.
  const extra = {};
  const weak = build({ add, card, land, players, game, zones, cards, extra }) ?? {};
  // The opponent's hand is hidden: no faces.
  for (const id of zones.p1.hand) cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  const lines = [
    { t: 'snapshot', seq: 0, viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } },
    { message: '', ok: { label: '', enabled: false }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak, kind: 'priority', pid: 1, seat: 'p0', t: 'prompt', seq: 1, ...extra },
  ];
  writeFileSync(path.join(OUT, `stress-${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// 1. Board flood: tokens by the dozen, a wide creature line-up and a full manabase on both sides.
session('flood', ({ add, card, land }) => {
  for (const p of ['p0', 'p1']) {
    for (let i = 0; i < 14; i++) add(land(p, undefined, { tapped: i % 3 === 0 }));
    for (let i = 0; i < 24; i++) add(card(p, 'Battlefield', p === 'p0' ? 'Goblin' : 'Faerie Rogue', { token: true, power: 1, toughness: 1, sub: [p === 'p0' ? 'Goblin' : 'Faerie'], colors: p === 'p0' ? 'R' : 'B', sickness: i > 18 }));
    for (let i = 0; i < 10; i++) add(card(p, 'Battlefield', ['Kessig Flamebreather', 'Spellstutter Sprite', 'Young Pyromancer', 'Bitterblossom'][i % 4], { core: i % 4 === 3 ? ['Enchantment'] : ['Creature'], power: 1 + (i % 3), toughness: 3, tapped: i % 4 === 1 }));
    for (let i = 0; i < 5; i++) add(card(p, 'Battlefield', 'Ornithopter', { core: ['Artifact', 'Creature'], power: 0, toughness: 2, colors: '' }));
  }
});

// 2. Attachments: one creature wearing eight auras and equipment, another with three, a planeswalker.
session('attach', ({ add, card, land }) => {
  for (let i = 0; i < 6; i++) add(land('p0'));
  const host = add(card('p0', 'Battlefield', 'Kor Skyfisher', { power: 14, toughness: 15, printedPower: 2, printedToughness: 3, colors: 'W' }));
  const names = ['Rancor', 'Ethereal Armor', 'Sigil of the Empty Throne', 'Bonesplitter', 'Sword of Fire and Ice', 'Spider Umbra', 'Hyena Umbra', 'Colossus Hammer'];
  for (const n of names) add(card('p0', 'Battlefield', n, { core: [n.includes('Sword') || n.includes('splitter') || n.includes('Hammer') ? 'Artifact' : 'Enchantment'], sub: [n.includes('Sword') || n.includes('splitter') || n.includes('Hammer') ? 'Equipment' : 'Aura'], on: host.id }));
  const b = add(card('p0', 'Battlefield', 'Goblin Guide', { power: 4, toughness: 2 }));
  for (const n of ['Rancor', 'Bonesplitter', 'Curiosity']) add(card('p0', 'Battlefield', n, { core: ['Enchantment'], sub: ['Aura'], on: b.id }));
  add(card('p0', 'Battlefield', 'Chandra, Torch of Defiance', { core: ['Planeswalker'], sub: ['Chandra'], loyalty: '7', counters: { LOYALTY: 7 } }));
  for (let i = 0; i < 4; i++) add(land('p1'));
  const ob = add(card('p1', 'Battlefield', 'Faerie Seer', { colors: 'U', power: 1, toughness: 1 }));
  add(card('p1', 'Battlefield', 'Pacifism', { core: ['Enchantment'], sub: ['Aura'], colors: 'W', on: ob.id }));
});

// 3. Counters, damage and odd numbers: 99 +1/+1 counters, mixed counter kinds, -1/-1 below zero, marked damage.
session('counters', ({ add, card, land }) => {
  for (let i = 0; i < 5; i++) add(land('p0'));
  add(card('p0', 'Battlefield', 'Walking Ballista', { core: ['Artifact', 'Creature'], colors: '', power: 99, toughness: 99, printedPower: 0, printedToughness: 0, counters: { P1P1: 99 } }));
  add(card('p0', 'Battlefield', 'Hangarback Walker', { core: ['Artifact', 'Creature'], colors: '', power: 12, toughness: 12, printedPower: 0, printedToughness: 0, counters: { P1P1: 12, CHARGE: 3, OIL: 4, SHIELD: 1, STUN: 2 } }));
  add(card('p0', 'Battlefield', 'Guttersnipe', { power: -4, toughness: 3, printedPower: 2, printedToughness: 2, counters: { M1M1: 6 }, damage: 2 }));
  add(card('p0', 'Battlefield', 'Colossal Dreadmaw', { colors: 'G', power: 6, toughness: 6, damage: 5, keywords: ['Trample'] }));
  add(card('p0', 'Battlefield', 'Grim Lavamancer', { power: 1, toughness: 1, tapped: true, counters: { P1P1: 1 } }));
  add(card('p0', 'Battlefield', 'Experiment One', { colors: 'G', power: 1000, toughness: 1000, printedPower: 1, printedToughness: 1, counters: { P1P1: 999 } }));
  for (let i = 0; i < 4; i++) add(land('p1'));
  add(card('p1', 'Battlefield', 'Spellstutter Sprite', { colors: 'U', power: 1, toughness: 1, damage: 1, counters: { M1M1: 1, FLYING: 1 } }));
});

// 4. Big hands: 15 cards in mine, 20 in the opponent's.
session('hand', ({ add, card, land, zones, cards }) => {
  for (const id of [...zones.p0.hand]) delete cards[id];
  zones.p0.hand.length = 0;
  for (const id of [...zones.p1.hand]) delete cards[id];
  zones.p1.hand.length = 0;
  const names = ['Lightning Bolt', 'Fiery Temper', 'Kessig Flamebreather', 'Mountain', 'Highway Robbery', 'Grab the Prize', 'Bloodrage Brawler', 'Alms of the Vein', 'Fireblast', 'Asmoranomardicadaistinaculdacar', 'Mountain', 'Faithless Looting', 'Burning Inquiry', 'Insolent Neonate', 'Fling'];
  const weak = {};
  for (const [i, n] of names.entries()) {
    const c = add(card('p0', 'Hand', n, n === 'Mountain' ? { core: ['Land'], colors: '' } : { core: [i % 3 ? 'Instant' : 'Creature'] }));
    if (i % 2 === 0) weak[c.id] = 1;
  }
  for (let i = 0; i < 20; i++) add(card('p1', 'Hand', 'Hidden'));
  for (let i = 0; i < 3; i++) add(land('p0'));
  for (let i = 0; i < 3; i++) add(land('p1'));
  return weak;
});

// 5. A deep stack: twelve items, spells and triggers, some with targets.
session('stack', ({ add, card, land, game }) => {
  for (let i = 0; i < 5; i++) add(land('p0'));
  for (let i = 0; i < 5; i++) add(land('p1'));
  const kessig = add(card('p0', 'Battlefield', 'Kessig Flamebreather', { power: 1, toughness: 3 }));
  const sprite = add(card('p1', 'Battlefield', 'Spellstutter Sprite', { colors: 'U', power: 1, toughness: 1 }));
  for (let i = 0; i < 12; i++) {
    const spell = i % 3 !== 2;
    const p = i % 2 ? 'p1' : 'p0';
    const c = spell ? add(card(p, 'Stack', p === 'p0' ? 'Lightning Bolt' : 'Counterspell', { core: ['Instant'], colors: p === 'p0' ? 'R' : 'U' })) : null;
    game.stack.unshift({ id: `st${i}`, text: spell ? `${c.state.name} targeting something rather long to read on a phone` : 'Kessig Flamebreather: Whenever you cast a noncreature spell, Kessig Flamebreather deals 1 damage to each opponent.', source: spell ? c.id : kessig.id, activator: p, ability: !spell, trigger: !spell, targets: spell ? [i % 4 ? 'p1' : sprite.id] : [] });
  }
});

// 6. Long names everywhere: players, cards, tokens; a long phase-less prompt.
session('names', ({ add, card, land, players }) => {
  players.p0.name = 'Alexandria the Extremely Long-Named Planeswalker of the Kitchen Table';
  players.p1.name = 'Grixis Affinity Control Combo Midrange Tempo · AI';
  for (let i = 0; i < 5; i++) add(land('p0', 'Snow-Covered Mountain', { super: ['Basic', 'Snow'] }));
  add(card('p0', 'Battlefield', 'Asmoranomardicadaistinaculdacar', { colors: 'BR', power: 6, toughness: 6 }));
  add(card('p0', 'Battlefield', 'Our Market Research Shows That Players Like Really Long Card Names So We Made this Card to Have the Absolute Longest Card Name Ever Elemental', { colors: 'G', power: 1, toughness: 1, sub: ['Elemental'] }));
  add(card('p0', 'Battlefield', 'Phyrexian Germ Construct Clue Food Treasure Token', { token: true, core: ['Artifact', 'Creature'], colors: '', power: 0, toughness: 0, counters: { P1P1: 3 } }));
  for (let i = 0; i < 4; i++) add(land('p1', 'Island'));
  add(card('p1', 'Battlefield', 'Jace, the Mind Sculptor', { core: ['Planeswalker'], colors: 'U', loyalty: '13', counters: { LOYALTY: 13 } }));
});

// 7. Extreme player numbers: 999 and negative life, poison, energy, a huge graveyard and exile, empty library.
session('numbers', ({ add, card, land, players, zones, cards }) => {
  players.p0.life = 9999;
  players.p1.life = -37;
  players.p0.counters = { POISON: 9, ENERGY: 142, EXPERIENCE: 30 };
  players.p1.counters = { POISON: 10 };
  players.p0.mana = { R: 12, G: 4, C: 7, W: 1, U: 2, B: 3 };
  for (const id of [...zones.p1.library]) delete cards[id];
  zones.p1.library.length = 0;
  for (let i = 0; i < 200; i++) add(card('p0', 'Graveyard', 'Faithless Looting', { core: ['Sorcery'] }));
  for (let i = 0; i < 80; i++) add(card('p1', 'Exile', 'Counterspell', { core: ['Instant'], colors: 'U' }));
  for (let i = 0; i < 4; i++) add(land('p0'));
  for (let i = 0; i < 4; i++) add(land('p1'));
});

// 8. A crowded combat: twelve attackers, most blocked, two gang-blocked.
session('combat', ({ add, card, land, game }) => {
  game.phase = 'COMBAT_DECLARE_BLOCKERS';
  for (let i = 0; i < 6; i++) add(land('p0'));
  for (let i = 0; i < 6; i++) add(land('p1'));
  const att = [];
  for (let i = 0; i < 12; i++) att.push(add(card('p0', 'Battlefield', i % 2 ? 'Goblin' : 'Kessig Flamebreather', { token: i % 2 === 1, power: 2, toughness: 2, attacking: true, tapped: true })));
  const blk = [];
  for (let i = 0; i < 14; i++) blk.push(add(card('p1', 'Battlefield', 'Faerie Rogue', { token: true, colors: 'B', power: 1, toughness: 1, blocking: i < 12 })));
  game.combat = att.map((a, i) => ({ attacker: a.id, defender: 'p1', blockers: i < 8 ? [blk[i].id] : i === 8 ? [blk[8].id, blk[9].id] : i === 9 ? [blk[10].id, blk[11].id] : [] }));
});

// 9. Modified costs (revamp the modified-cost display): reducers and taxes on hand cards, in the cost slot. Cheaper,
// dearer, a longer cost than printed, a hybrid, a zero, a five-symbol cost, and one unchanged card as a control.
session('costs', ({ add, card, land, zones, cards, extra }) => {
  for (const id of [...zones.p0.hand]) delete cards[id];
  zones.p0.hand.length = 0;
  const hand = [
    ['Tolarian Terror', { colors: 'U', cost: '{6}{U}', power: 5, toughness: 5 }, '{3}{U}'],
    ['Lightning Bolt', { core: ['Instant'], cost: '{R}' }, '{1}{R}'],
    ['Frogmite', { core: ['Artifact', 'Creature'], colors: '', cost: '{4}' }, '{0}'],
    ['Fireblast', { core: ['Instant'], cost: '{4}{R}{R}' }, undefined],
    ['Kitchen Finks', { colors: 'GW', cost: '{1}{G/W}{G/W}', power: 3, toughness: 2 }, '{G/W}{G/W}'],
    ['Nicol Bolas, the Ravager', { colors: 'UBR', cost: '{1}{U}{B}{R}', power: 4, toughness: 4 }, '{3}{U}{B}{R}'],
    ['Wildest Dreams of Esper', { core: ['Sorcery'], colors: 'WUB', cost: '{X}{X}{W}{U}{B}' }, '{X}{X}{1}{W}{U}{B}'],
  ];
  const weak = {};
  extra.costs = {};
  for (const [name, o, adjusted] of hand) {
    // An image key, so an art-enabled build can fetch a scan for every card (replays never do).
    const c = add(card('p0', 'Hand', name, { ...o, imageKey: name }));
    weak[c.id] = 1;
    if (adjusted) extra.costs[c.id] = adjusted;
  }
  for (let i = 0; i < 4; i++) add(land('p0'));
  for (let i = 0; i < 3; i++) add(land('p1'));
  return weak;
});

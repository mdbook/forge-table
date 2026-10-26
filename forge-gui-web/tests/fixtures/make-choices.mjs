// A synthetic session for the X picker, the mana picker and the cost tracker (no recording has these): Fireball for
// X, then paying {X}{R} with a dual land (ability menu), a five-colour land (colour ask), a two-colour land (Forge's
// confirm prompt) and Auto Pay. The asks and prompts are shaped as forge-gui-bridge sends them (overlays/numberChoice.ts,
// overlays/manaChoice.ts). node tests/fixtures/make-choices.mjs → tests/fixtures/sessions/mana.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'mana.jsonl');

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
const mountain = land('p0', 'Mountain', { super: ['Basic'], sub: ['Mountain'], text: '({T}: Add {R}.)' });
const mountain2 = land('p0', 'Mountain', { super: ['Basic'], sub: ['Mountain'], text: '({T}: Add {R}.)' });
const stomping = land('p0', 'Stomping Ground', { sub: ['Mountain', 'Forest'], text: '({T}: Add {R} or {G}.)\nAs Stomping Ground enters, you may pay 2 life. If you don\'t, it enters tapped.' });
const city = land('p0', 'City of Brass', { text: 'Whenever City of Brass becomes tapped, it deals 1 damage to you.\n{T}: Add one mana of any color.' });
const wastes = land('p0', 'Adarkar Wastes', { text: '{T}: Add {C}.\n{T}: Add {W} or {U}. Adarkar Wastes deals 1 damage to you.' });
const fireball = add('p0', 'Hand', 'Fireball', { core: ['Sorcery'], colors: 'R', cost: '{X}{R}', text: 'This spell costs {1} more to cast for each target beyond the first.\nFireball deals X damage divided evenly, rounded down, among any number of targets.' });
add('p0', 'Hand', 'Lightning Bolt', { core: ['Instant'], colors: 'R', cost: '{R}', text: 'Lightning Bolt deals 3 damage to any target.' });
add('p0', 'Hand', 'Kessig Flamebreather', { colors: 'R', cost: '{1}{R}', power: 1, toughness: 3 });
add('p0', 'Battlefield', 'Kessig Flamebreather', { colors: 'R', cost: '{1}{R}', power: 1, toughness: 3 });
for (let i = 0; i < 4; i++) land('p1', 'Island', { super: ['Basic'], sub: ['Island'] });
add('p1', 'Battlefield', 'Wind Drake', { colors: 'U', cost: '{2}{U}', power: 2, toughness: 2 });
for (let i = 0; i < 4; i++) {
  const id = `c${next++}`;
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}

const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Mana choices', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

let seq = 0;
const lines = [];
const push = (m) => lines.push({ ...m, seq: seq++ });
const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });
const tap = (c) => push({ t: 'settle', patch: { cards: { [c.id]: { ...c, tapped: true } } } });
const lands = [mountain, mountain2, stomping, city, wastes];
const payMana = (t, rest, untapped) =>
  push({ t, ...prompt({ kind: 'payMana', pid: 2, card: fireball.id, message: `Pay Mana Cost: ${rest}`, ok: { label: 'Auto', enabled: true }, cancel: { label: 'Cancel', enabled: true }, focusOk: true, selectable: untapped.map((c) => c.id), weak: Object.fromEntries(untapped.slice(0, 2).map((c) => [c.id, 2])) }) });

push({ t: 'snapshot', viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 1, cancel: { label: 'End Turn', enabled: true }, weak: { [fireball.id]: 1 } }) });
// Choose X: AbstractGuiGame.getInteger(message, 0, MAX, 9) → 0..9 and "Other...", oneOrNone.
push({ t: 'ask', id: 'q1', pid: 1, kind: 'choose', message: 'Choose X for Fireball', items: [...Array.from({ length: 10 }, (_, i) => ({ idx: i, label: String(i) })), { idx: 10, label: 'Other...' }], min: 0, max: 1 });
push({ t: 'askClear', id: 'q1' });
payMana('prompt', '{3}{R}', lands);
// The dual land clicked while paying: InputPayMana asks which of its abilities (one()).
push({ t: 'ask', id: 'q2', pid: 2, kind: 'choose', message: 'Choose a mana ability:', items: [{ idx: 0, label: '{T}: Add {R}.', card: stomping.id }, { idx: 1, label: '{T}: Add {G}.', card: stomping.id }], min: 1, max: 1 });
push({ t: 'askClear', id: 'q2' });
tap(stomping);
payMana('promptUpdate', '{3}', [mountain, mountain2, city, wastes]);
// City of Brass: any colour, three or more to choose from → a choose ask over Forge's colour enum.
push({ t: 'ask', id: 'q3', pid: 2, kind: 'choose', message: 'Select Mana to Produce', items: ['WHITE', 'BLUE', 'BLACK', 'RED', 'GREEN'].map((label, idx) => ({ idx, label })), min: 1, max: 1 });
push({ t: 'askClear', id: 'q3' });
tap(city);
payMana('promptUpdate', '{2}', [mountain, mountain2, wastes]);
// Adarkar Wastes' "{W} or {U}": two colours → InputConfirm, a prompt with the colours on its buttons.
push({ t: 'prompt', ...prompt({ kind: 'confirm', pid: 3, card: wastes.id, message: 'Select Mana to Produce', ok: { label: 'White', enabled: true }, cancel: { label: 'Blue', enabled: true }, focusOk: true }) });
tap(wastes);
payMana('prompt', '{1}', [mountain, mountain2]);
tap(mountain);
push({ t: 'promptClear', pid: 2 });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 4, cancel: { label: 'End Turn', enabled: true } }) });

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

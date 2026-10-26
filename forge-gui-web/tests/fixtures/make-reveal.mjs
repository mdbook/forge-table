// A synthetic session for the zone strip over the opponent's revealed hand (no recording has one): Duress, the
// engine shows the opponent's hand (`notice{zones}`) while I choose a noncreature, nonland card from it, then hides
// it. The prompt is shaped as forge-gui-bridge sends it (choosers.jsonl's Impulse). node tests/fixtures/make-reveal.mjs
// → tests/fixtures/sessions/reveal.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'reveal.jsonl');

let next = 1;
const cards = {};
const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };

function add(owner, zone, name, o = {}) {
  const n = next++; // a library slot passes its own hidden id but still takes a number, so other ids don't shift
  const id = o.id ?? `c${n}`;
  const core = o.core ?? ['Creature'];
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
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      printedPower: core.includes('Creature') ? (o.power ?? 2) : undefined,
      printedToughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
    },
  };
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()].push(id);
  return cards[id];
}
const land = (p, name, o = {}) => add(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], ...o });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) add(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 3; i++) land('p0', 'Swamp', { sub: ['Swamp'], text: '({T}: Add {B}.)' });
const duress = add('p0', 'Hand', 'Duress', { core: ['Sorcery'], colors: 'B', cost: '{B}', text: 'Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card.' });
add('p0', 'Hand', 'Vampire Nighthawk', { colors: 'B', cost: '{1}{B}{B}', power: 2, toughness: 3, text: 'Flying, deathtouch, lifelink' });
add('p0', 'Hand', 'Swamp', { core: ['Land'], super: ['Basic'], sub: ['Swamp'], text: '({T}: Add {B}.)' });
for (let i = 0; i < 3; i++) land('p1', 'Forest', { sub: ['Forest'], text: '({T}: Add {G}.)' });
add('p1', 'Battlefield', 'Fyndhorn Elves', { colors: 'G', cost: '{G}', sub: ['Elf', 'Druid'], power: 1, toughness: 1, text: '{T}: Add {G}.' });
// The opponent's hand, as in the bug report's screenshot.
add('p1', 'Hand', 'Priest of Titania', { colors: 'G', cost: '{1}{G}', sub: ['Elf', 'Druid'], power: 1, toughness: 1, text: '{T}: Add {G} for each Elf on the battlefield.' });
add('p1', 'Hand', 'Llanowar Elves', { colors: 'G', cost: '{G}', sub: ['Elf', 'Druid'], power: 1, toughness: 1, text: '{T}: Add {G}.' });
add('p1', 'Hand', 'Sagu Wildling', { colors: 'G', cost: '{4}{G}', sub: ['Dragon'], power: 3, toughness: 3, text: 'Flying\nWhen this creature enters, you gain 3 life.' });
const stampede = add('p1', 'Hand', 'Lead the Stampede', { core: ['Sorcery'], colors: 'G', cost: '{2}{G}', text: 'Look at the top five cards of your library. You may reveal any number of creature cards from among them and put the revealed cards into your hand. Put the rest on the bottom of your library in any order.' });
add('p1', 'Hand', 'Avenging Hunter', { colors: 'G', cost: '{4}{G}', sub: ['Dragon', 'Ranger'], power: 5, toughness: 4, text: 'Trample\nWhen Avenging Hunter enters, you take the initiative.' });

const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Elves', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Revealed hand', turn: 3, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

let seq = 0;
const lines = [];
const push = (m) => lines.push({ ...m, seq: seq++ });
const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });

push({ t: 'snapshot', viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 1, cancel: { label: 'End Turn', enabled: true }, weak: { [duress.id]: 1 } }) });
// Duress resolving: the hand is shown, a card chosen from it.
push({ t: 'notice', kind: 'zones', show: [{ player: 'p1', zone: 'Hand' }] });
push({ t: 'promptClear', pid: 1 });
push({
  t: 'prompt',
  ...prompt({
    kind: 'selectEntities',
    pid: 2,
    card: duress.id,
    message: `Duress (${duress.id.slice(1)})\n - Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card.\nChoose a card to discard`,
    ok: { label: 'OK', enabled: false },
    focusOk: true,
    selectable: [stampede.id],
    selMin: 1,
    selMax: 1,
  }),
});
push({ t: 'notice', kind: 'zones', hide: true });
push({ t: 'promptClear', pid: 2 });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 3, cancel: { label: 'End Turn', enabled: true } }) });

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

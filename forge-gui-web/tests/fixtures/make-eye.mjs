// A synthetic session for the revealed-to-opponent eye (no recording has one): the opponent's Thoughtseize last turn
// showed my hand, so the three cards still in it carry `revealedToOpponent` (forge-gui-bridge ViewProjector); the card
// drawn since doesn't. Then I play the revealed Swamp: on the battlefield it has no eye, the others keep theirs.
// node tests/fixtures/make-eye.mjs → tests/fixtures/sessions/eye.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'eye.jsonl');

let next = 1;
const cards = {};
const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [] } };

function add(owner, zone, name, o = {}) {
  const n = next++;
  const id = o.id ?? `c${n}`;
  const core = o.core ?? ['Creature'];
  cards[id] = {
    id,
    owner,
    controller: owner,
    zone,
    ...(o.revealed ? { revealedToOpponent: true } : {}),
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
const swamp = { core: ['Land'], super: ['Basic'], sub: ['Swamp'], text: '({T}: Add {B}.)' };

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) add(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 3; i++) add('p0', 'Battlefield', 'Swamp', swamp);
const land = add('p0', 'Hand', 'Swamp', { ...swamp, revealed: true });
const nighthawk = add('p0', 'Hand', 'Vampire Nighthawk', { colors: 'B', cost: '{1}{B}{B}', power: 2, toughness: 3, text: 'Flying, deathtouch, lifelink', revealed: true });
const blade = add('p0', 'Hand', 'Doom Blade', { core: ['Instant'], colors: 'B', cost: '{1}{B}', text: 'Destroy target nonblack creature.', revealed: true });
const drawn = add('p0', 'Hand', "Night's Whisper", { core: ['Sorcery'], colors: 'B', cost: '{1}{B}', text: 'You draw two cards and you lose 2 life.' });
add('p0', 'Graveyard', 'Gurmag Angler', { colors: 'B', cost: '{6}{B}', sub: ['Zombie', 'Fish'], power: 5, toughness: 5, text: 'Delve' });
for (let i = 0; i < 3; i++) add('p1', 'Battlefield', 'Swamp', swamp);
add('p1', 'Graveyard', 'Thoughtseize', { core: ['Sorcery'], colors: 'B', cost: '{B}', text: 'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.' });
for (let i = 0; i < 4; i++) add('p1', 'Hand', '', { id: `xp1h${i}` });

const player = (id, name, life, o = {}) => ({ id, name, life, opponents: [id === 'p0' ? 'p1' : 'p0'], zones: zones[id], ...o });
const game = { gameType: 'Constructed', title: 'Revealed to opponent', turn: 4, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

let seq = 0;
const lines = [];
const push = (m) => lines.push({ ...m, seq: seq++ });
const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });

// The opponent's hand, hidden: only id, owner and zone (as the bridge sends it).
for (let i = 0; i < 4; i++) cards[`xp1h${i}`] = { id: `xp1h${i}`, owner: 'p1', controller: 'p1', zone: 'Hand' };
push({ t: 'snapshot', viewer: 'p0', game, players: { p0: player('p0', 'Player', 20), p1: player('p1', 'Opponent', 18, { isAI: true }) }, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 1, cancel: { label: 'End Turn', enabled: true }, weak: { [land.id]: 1, [nighthawk.id]: 1, [blade.id]: 1, [drawn.id]: 1 } }) });
push({ t: 'promptClear', pid: 1 });
// The Swamp leaves the hand: the bridge drops its flag, so it lands on the battlefield as a plain card.
const played = { ...land, zone: 'Battlefield' };
delete played.revealedToOpponent;
const p0 = { ...zones.p0, hand: zones.p0.hand.filter((id) => id !== land.id), battlefield: [...zones.p0.battlefield, land.id] };
push({ t: 'settle', patch: { players: { p0: player('p0', 'Player', 20, { zones: p0 }) }, cards: { [land.id]: played } } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 2, cancel: { label: 'End Turn', enabled: true }, weak: { [nighthawk.id]: 1, [blade.id]: 1, [drawn.id]: 1 } }) });

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

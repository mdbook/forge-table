// A synthetic session for one card's options drawn as cards (overlays/OptionCards.tsx): Land Grant's two ways to cast it
// (its alternative cost as StaticAbilityAlternativeCost describes it), Fireblast's (sacrifice two Mountains), Mishra's
// Factory's three abilities, as BridgeGuiGame.getAbilityToPlay sends them; then Kolaghan's Command's "choose two" asked
// one mode at a time (PlayerControllerHuman.chooseModeForAbility), and a pick of two of its abilities at once (max 2).
// node tests/fixtures/make-select.mjs → tests/fixtures/sessions/select.jsonl (replay.spec.ts).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'select.jsonl');
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
    tapped: o.tapped,
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? '',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost,
      oracleText: o.text ?? '',
      rarity: o.rarity,
      imageKey: o.key ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      printedPower: core.includes('Creature') ? (o.power ?? 2) : undefined,
      printedToughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
    },
  };
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()].push(id);
  return cards[id];
}

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) add(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (const c of ['Mountain', 'Mountain', 'Forest', 'Swamp']) add('p0', 'Battlefield', c, { core: ['Land'], super: ['Basic'], sub: [c] });
const factory = add('p0', 'Battlefield', "Mishra's Factory", {
  core: ['Land'],
  rarity: 'uncommon',
  text: "{T}: Add {C}.\n{1}: Mishra's Factory becomes a 2/2 Assembly-Worker artifact creature until end of turn. It's still a land.\n{T}: Target Assembly-Worker creature gets +1/+1 until end of turn.",
});
const SEARCH = 'Search your library for a Forest card, reveal that card, put it into your hand, then shuffle.';
const grant = add('p0', 'Hand', 'Land Grant', { core: ['Sorcery'], colors: 'G', cost: '{1}{G}', rarity: 'common', text: `If you have no land cards in hand, you may reveal your hand rather than pay this spell's mana cost.\n${SEARCH}` });
const BLAST = 'Fireblast deals 4 damage to any target.';
const fireblast = add('p0', 'Hand', 'Fireblast', { core: ['Instant'], colors: 'R', cost: '{4}{R}{R}', rarity: 'uncommon', text: `You may sacrifice two Mountains rather than pay this spell's mana cost.\n${BLAST}` });
const command = add('p0', 'Hand', "Kolaghan's Command", { core: ['Instant'], colors: 'BR', cost: '{1}{B}{R}', rarity: 'rare', text: "Choose two —\n• Return target creature card from your graveyard to your hand.\n• Target player discards a card.\n• Destroy target artifact.\n• Kolaghan's Command deals 2 damage to any target." });
add('p1', 'Battlefield', 'Ornithopter', { core: ['Artifact', 'Creature'], cost: '{0}', power: 0, toughness: 2, text: 'Flying' });
for (let i = 0; i < 4; i++) add('p1', 'Battlefield', 'Island', { core: ['Land'], super: ['Basic'], sub: ['Island'] });
for (let i = 0; i < 4; i++) {
  const id = `c${next++}`;
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}

const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Mono-Blue Faeries', isAI: true, life: 20, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Options as cards', turn: 5, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [] };

let seq = 0;
const lines = [];
const push = (m) => lines.push({ ...m, seq: seq++ });
const prompt = (o) => ({ message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, seat: 'p0', ...o });
const menu = (id, card, labels) => ({ t: 'ask', id, pid: 1, kind: 'ability', message: 'Choose an ability', items: labels.map((label, idx) => ({ idx, label, card: card.id, enabled: true })), min: 0, max: 1, card: card.id });
const MODES = [
  'Return target creature card from your graveyard to your hand.',
  'Target player discards a card.',
  'Destroy target artifact.',
  "Kolaghan's Command deals 2 damage to any target.",
];
const modeAsk = (id, left, min) => ({ t: 'ask', id, pid: 1, kind: 'choose', message: "Player activated Kolaghan's Command - Choose a mode", items: left.map((m, idx) => ({ idx, label: MODES[m], card: command.id })), min, max: 1 });

push({ t: 'snapshot', viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'MAIN2'], p1: [] } });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 1, cancel: { label: 'End Turn', enabled: true } }) });
push(menu('a1', grant, [SEARCH, `${SEARCH} (If you have no land cards in hand, you may reveal your hand rather than pay this spell's mana cost.) `]));
push({ t: 'askClear', id: 'a1' });
push(menu('a2', fireblast, [BLAST, `${BLAST} (You may sacrifice two Mountains rather than pay this spell's mana cost.) `]));
push({ t: 'askClear', id: 'a2' });
push(menu('a3', factory, ['{T}: Add {C}.', "{1}: Mishra's Factory becomes a 2/2 Assembly-Worker artifact creature until end of turn. It's still a land.", '{T}: Target Assembly-Worker creature gets +1/+1 until end of turn.']));
push({ t: 'askClear', id: 'a3' });
push(modeAsk('m1', [0, 1, 2, 3], 1));
push({ t: 'askClear', id: 'm1' });
push(modeAsk('m2', [0, 2, 3], 1));
push({ t: 'askClear', id: 'm2' });
push({ t: 'ask', id: 'k1', pid: 1, kind: 'choose', message: 'Choose two modes to copy', items: MODES.map((label, idx) => ({ idx, label, card: command.id })), min: 2, max: 2 });
push({ t: 'askClear', id: 'k1' });
push({ t: 'prompt', ...prompt({ kind: 'priority', pid: 2, cancel: { label: 'End Turn', enabled: true } }) });

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

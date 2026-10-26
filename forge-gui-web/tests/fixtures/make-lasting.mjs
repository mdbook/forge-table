// A synthetic session for lasting effects (hud/LastingRail.tsx, table/lastingFx.ts) and indestructible's resting sheen:
// my command zone holds The Monarch, Undercity (in the Forge room), an emblem and Spirit Water Revival's effect; the
// opponent's holds The Initiative and an emblem. Darksteel Myr (indestructible) stands on my side. The command-zone
// cards carry what the bridge sends for them (gamePieceType, isEmblem, currentRoom, the face's abilityText / oracleText).
// node tests/fixtures/make-lasting.mjs → tests/fixtures/sessions/lasting.jsonl (replay.spec.ts goldens 61-63).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', 'lasting.jsonl');

let next = 100;
const cards = {};
const zones = { p0: { battlefield: [], hand: [], graveyard: [], exile: [], library: [], command: [] }, p1: { battlefield: [], hand: [], graveyard: [], exile: [], library: [], command: [] } };
function card(owner, zone, name, o = {}) {
  const id = o.id ?? `c${next++}`;
  const core = o.core ?? ['Creature'];
  const c = {
    id,
    owner,
    controller: owner,
    zone,
    ...(o.extra ?? {}),
    state: {
      face: 'Original',
      name,
      colors: o.colors ?? '',
      type: { super: o.super ?? [], core, sub: o.sub ?? [] },
      manaCost: o.cost,
      oracleText: o.text ?? '',
      ...(o.abilityText ? { abilityText: o.abilityText } : {}),
      power: core.includes('Creature') ? (o.power ?? 2) : undefined,
      toughness: core.includes('Creature') ? (o.toughness ?? 2) : undefined,
      keywords: (o.keywords ?? []).map((title) => ({ title })),
    },
  };
  cards[id] = c;
  zones[owner][zone === 'Battlefield' ? 'battlefield' : zone.toLowerCase()]?.push(id);
  return c;
}
const land = (p, name) => card(p, 'Battlefield', name, { core: ['Land'], super: ['Basic'], sub: [name] });
const effect = (p, name, abilityText, extra = {}) => card(p, 'Command', name, { core: ['Effect'], abilityText, extra: { gamePieceType: 'EFFECT', ...extra } });

for (const p of ['p0', 'p1']) for (let i = 0; i < 20; i++) card(p, 'Library', `Library ${i}`, { id: `x${p}l${i}` });
for (let i = 0; i < 4; i++) land('p0', 'Plains');
for (let i = 0; i < 3; i++) land('p1', 'Mountain');
card('p0', 'Battlefield', 'Darksteel Myr', { core: ['Artifact', 'Creature'], sub: ['Myr'], cost: '{3}', power: 0, toughness: 1, keywords: ['Indestructible'], text: 'Indestructible' });
card('p1', 'Battlefield', 'Goblin Piker', { colors: 'R', cost: '{1}{R}', sub: ['Goblin', 'Warrior'], power: 2, toughness: 1 });

// Mine: a marker, a dungeon, an emblem and a lasting effect, in the order Forge happened to put them there.
effect('p0', "Spirit Water Revival's Effect", 'You have no maximum hand size for the rest of the game.');
const undercity = card('p0', 'Command', 'Undercity', {
  core: ['Dungeon'],
  extra: { gamePieceType: 'DUNGEON', currentRoom: 'Forge' },
  text: [
    'You can\'t enter this dungeon unless you "venture into Undercity."',
    'Secret Entrance — Search your library for a basic land card, reveal it, put it into your hand, then shuffle. (Leads to: Forge, Lost Well)',
    'Forge — Put two +1/+1 counters on target creature. (Leads to: Trap!, Arena)',
    'Lost Well — Scry 2. (Leads to: Arena, Stash)',
    'Trap! — Target player loses 5 life. (Leads to: Archives)',
    'Arena — Goad target creature. (Leads to: Archives, Catacombs)',
    'Stash — Create a Treasure token. (Leads to: Catacombs)',
    'Archives — Draw a card. (Leads to: Throne of the Dead Three)',
    'Catacombs — Create a 4/1 black Skeleton creature token with menace. (Leads to: Throne of the Dead Three)',
    'Throne of the Dead Three — Reveal the top ten cards of your library. Put a creature card from among them onto the battlefield with three +1/+1 counters on it. It gains hexproof until your next turn. Then shuffle.',
  ].join('\r\n\r\n'),
});
effect('p0', 'Emblem — Elspeth, Knight-Errant', 'Artifacts, creatures, enchantments, and lands you control have indestructible.', { isEmblem: true });
const monarch = effect('p0', 'The Monarch', 'At the beginning of your end step, draw a card.\r\n\r\nWhenever a creature deals combat damage to you, its controller becomes the monarch.');
// Theirs.
effect('p1', 'The Initiative', 'At the beginning of your upkeep, venture into Undercity.\r\n\r\nWhenever one or more creatures a player controls deal combat damage to you, that player takes the initiative.');
effect('p1', 'Emblem — Chandra, Torch of Defiance', 'Whenever you cast a spell, this emblem deals 5 damage to any target.', { isEmblem: true });
for (const id of ['xh1', 'xh2', 'xh3']) {
  cards[id] = { id, owner: 'p1', controller: 'p1', zone: 'Hand' };
  zones.p1.hand.push(id);
}
const players = {
  p0: { id: 'p0', name: 'Player', life: 20, opponents: ['p1'], zones: zones.p0 },
  p1: { id: 'p1', name: 'Goblins', isAI: true, life: 18, opponents: ['p0'], zones: zones.p1 },
};
const game = { gameType: 'Constructed', title: 'Lasting', turn: 6, phase: 'COMBAT_DECLARE_ATTACKERS', playerTurn: 'p0', priority: 'p0', stack: [] };

const lines = [
  { t: 'snapshot', seq: 0, viewer: 'p0', game, players, cards, asks: [], stops: { p0: ['MAIN1', 'COMBAT_DECLARE_BLOCKERS', 'MAIN2'], p1: ['COMBAT_DECLARE_ATTACKERS', 'END_OF_TURN'] } },
  { t: 'notice', kind: 'autoPass', autoSkip: true, untilEndOfTurn: false, snoozed: [] },
  { t: 'prompt', seq: 1, pid: 1, kind: 'priority', seat: 'p0', message: '', ok: { label: 'OK', enabled: true }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak: {} },
];

writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`${OUT}: ${lines.length} messages (Undercity ${undercity.id}, The Monarch ${monarch.id})`);

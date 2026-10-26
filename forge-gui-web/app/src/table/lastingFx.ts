/**
 * Lasting effects ("be able to look at dungeons and other lasting effects like emblems or things like Spirit Water
 * Revival's permanent effect"): what sits in a player's command zone besides their commander. Forge puts all of it
 * there as cards: emblems, effects that last (Duration$ Permanent, "for the rest of the game"), dungeons with the room
 * the player is in, and the player markers (The Monarch, The Initiative, City's Blessing…), which are effect cards with
 * those names. The bridge sends the whole zone already; the HUD shows these as small cards beside each plate
 * (hud/LastingRail.tsx). Pure functions, no wire change.
 */
import type { Card, CardId, GameModel, PlayerId } from '@forge-table/protocol';

export type LastingKind = 'marker' | 'dungeon' | 'emblem' | 'effect';

export interface Lasting {
  id: CardId;
  kind: LastingKind;
  /** The card's name ("Emblem — Ajani", "Spirit Water Revival's Effect", "The Monarch"). */
  name: string;
  /** A short line for its preview: "Emblem", "Effect", "Dungeon · In room: Forge", "The Monarch". */
  label: string;
  /** What it does: the effect's ability text, else its oracle text. */
  text: string;
  /** A marker's glyph (no art of its own): crown, torch… */
  glyph?: string;
  /** A dungeon: the room the player is in. */
  room?: string;
}

/** The player markers, by the name Forge gives their effect card, with a glyph each. */
const MARKERS: Record<string, string> = {
  'The Monarch': '♛',
  'The Initiative': '⚑',
  "City's Blessing": '✦',
  'The Ring': '◯',
  Radiation: '☢',
  'Start Your Engines!': '➤',
};

const RANK: Record<LastingKind, number> = { marker: 0, dungeon: 1, emblem: 2, effect: 3 };

/** What a lasting effect says: Forge's ability text for it, else its oracle text (one line per paragraph). */
export function lastingText(card: Card | undefined): string {
  const face = card?.state;
  const t = (typeof face?.abilityText === 'string' && face.abilityText.trim()) || (typeof face?.oracleText === 'string' && face.oracleText.trim()) || '';
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Sort one command-zone card into a kind, or null for one that isn't a lasting effect (a commander). */
export function classifyLasting(card: Card | undefined): Lasting | null {
  if (!card || card.isCommander) return null;
  const name = card.state?.name ?? '';
  const text = lastingText(card);
  const glyph = MARKERS[name];
  if (glyph) return { id: card.id, kind: 'marker', name, label: name, text, glyph };
  if (card.gamePieceType === 'DUNGEON') {
    const room = typeof card.currentRoom === 'string' && card.currentRoom ? card.currentRoom : undefined;
    return { id: card.id, kind: 'dungeon', name, label: room ? `Dungeon · In room: ${room}` : 'Dungeon', text, ...(room ? { room } : {}) };
  }
  if (card.isEmblem === true) return { id: card.id, kind: 'emblem', name, label: 'Emblem', text };
  // Player keywords Forge keeps on a hidden effect ("Keyword Effects"): only worth a card while it says something.
  if (name === 'Keyword Effects' && !text) return null;
  return { id: card.id, kind: 'effect', name, label: 'Effect', text };
}

/** A player's lasting effects, markers first, then dungeons, emblems and effects (each in command-zone order). */
export function lastingEffects(model: GameModel, player: PlayerId): Lasting[] {
  const p = model.players[player];
  const out: Array<{ at: number; l: Lasting }> = [];
  (p?.zones?.command ?? []).forEach((id, at) => {
    if (p?.commander?.includes(id)) return;
    const l = classifyLasting(model.cards[id]);
    if (l) out.push({ at, l });
  });
  out.sort((a, b) => RANK[a.l.kind] - RANK[b.l.kind] || a.at - b.at);
  return out.map((o) => o.l);
}

export interface DungeonRoom {
  name: string;
  text: string;
  leadsTo: string[];
  /** Steps from the entrance (the first room): rooms at one depth sit side by side. */
  depth: number;
}

/**
 * A dungeon's rooms from its oracle text, one per line: `Room — what it does. (Leads to: A, B)`. A line without the
 * dash (Undercity's "You can't enter this dungeon unless…") is not a room.
 */
export function dungeonRooms(oracle: string | undefined): DungeonRoom[] {
  const rooms: DungeonRoom[] = [];
  for (const raw of (oracle ?? '').split(/\\n|\r?\n/)) {
    const line = raw.trim();
    const m = /^(.+?)\s+[—–]\s+(.*)$/.exec(line);
    if (!m) continue;
    const lead = /\(Leads to: ([^)]*)\)\s*$/.exec(m[2]!);
    rooms.push({
      name: m[1]!,
      text: (lead ? m[2]!.slice(0, lead.index) : m[2]!).trim(),
      leadsTo: lead ? lead[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [],
      depth: 0,
    });
  }
  // Breadth-first from the entrance.
  const byName = new Map(rooms.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const queue = rooms.length ? [rooms[0]!] : [];
  if (rooms[0]) seen.add(rooms[0].name);
  while (queue.length) {
    const r = queue.shift()!;
    for (const n of r.leadsTo) {
      const next = byName.get(n);
      if (!next || seen.has(n)) continue;
      seen.add(n);
      next.depth = r.depth + 1;
      queue.push(next);
    }
  }
  return rooms;
}

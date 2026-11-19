/**
 * The game history panel's logic: the log lines the server streams (`t: 'log'`), kept per game, grouped by turn and
 * step, filtered, and written out as plain text for Copy and Download. Pure: HistoryPanel.tsx draws it.
 */
import type { LogEntry, LogMsg, Phase, PlayerId } from '@forge-table/protocol';

/** One game's lines, oldest first. */
export interface History {
  game: number;
  entries: LogEntry[];
}

/** Add a `log` message: a new game or `from` 0 starts over, anything else goes on from `from`. */
export function appendLog(prev: History | null, m: LogMsg): History {
  if (!prev || prev.game !== m.game || m.from === 0) return { game: m.game, entries: m.entries };
  return { game: m.game, entries: prev.entries.slice(0, m.from).concat(m.entries) };
}

/** The icon family a line is drawn with. */
export type Category = 'info' | 'land' | 'stack' | 'zone' | 'combat' | 'life';

const CATEGORY: Record<string, Category> = {
  land: 'land',
  stackAdd: 'stack',
  stackResolve: 'stack',
  zoneChange: 'zone',
  discard: 'zone',
  combat: 'combat',
  damage: 'life',
  life: 'life',
};

export function category(kind: string): Category {
  return CATEGORY[kind] ?? 'info';
}

export type Filter = 'all' | 'mine' | 'opp' | 'zone' | 'combat' | 'life';

export const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'opp', label: 'Opponent' },
  { key: 'zone', label: 'Cards moved' },
  { key: 'combat', label: 'Combat' },
  { key: 'life', label: 'Life' },
];

/** Whether a line passes the filter chip and the search box (case-insensitive, on the line's text). */
export function matches(e: LogEntry, filter: Filter, query: string, viewer: PlayerId): boolean {
  const q = query.trim().toLowerCase();
  if (q && !e.text.toLowerCase().includes(q)) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'mine':
      return e.player === viewer;
    case 'opp':
      return e.player !== undefined && e.player !== viewer;
    default:
      return category(e.kind) === filter;
  }
}

const PHASE_LABEL: Record<Phase, string> = {
  UNTAP: 'Untap',
  UPKEEP: 'Upkeep',
  DRAW: 'Draw',
  MAIN1: 'Main 1',
  COMBAT_BEGIN: 'Beginning of combat',
  COMBAT_DECLARE_ATTACKERS: 'Attackers',
  COMBAT_DECLARE_BLOCKERS: 'Blockers',
  COMBAT_FIRST_STRIKE_DAMAGE: 'First strike damage',
  COMBAT_DAMAGE: 'Combat damage',
  COMBAT_END: 'End of combat',
  MAIN2: 'Main 2',
  END_OF_TURN: 'End step',
  CLEANUP: 'Cleanup',
};

export function phaseLabel(phase: Phase | undefined): string {
  return phase ? PHASE_LABEL[phase] : 'Before the game';
}

/** One step's run of lines; `index` is each line's place in the whole history (a stable React key). */
export interface StepGroup {
  phase?: Phase;
  lines: Array<{ entry: LogEntry; index: number }>;
}

export interface TurnGroup {
  turn: number;
  active?: PlayerId;
  steps: StepGroup[];
}

/** Lines that pass `keep`, grouped by turn, then by step within it (a step that comes back gets a new group). */
export function groupByTurn(entries: readonly LogEntry[], keep: (e: LogEntry) => boolean): TurnGroup[] {
  const turns: TurnGroup[] = [];
  entries.forEach((entry, index) => {
    if (!keep(entry)) return;
    let t = turns[turns.length - 1];
    if (!t || t.turn !== entry.turn) {
      t = { turn: entry.turn, ...(entry.active ? { active: entry.active } : {}), steps: [] };
      turns.push(t);
    }
    let s = t.steps[t.steps.length - 1];
    if (!s || s.phase !== entry.phase) {
      s = { ...(entry.phase ? { phase: entry.phase } : {}), lines: [] };
      t.steps.push(s);
    }
    s.lines.push({ entry, index });
  });
  return turns;
}

/** A turn's heading: "Your turn" or "Alphu's turn"; turn 0 is before the game. */
export function turnTitle(t: { turn: number; active?: PlayerId }, viewer: PlayerId, nameOf: (p: PlayerId) => string): string {
  if (t.turn === 0 || !t.active) return 'Before the game';
  return t.active === viewer ? 'Your turn' : `${nameOf(t.active)}’s turn`;
}

/** The whole game as plain text, a line each ("Turn 3 (Alphu), Main 1: Alphu cast Candy Trail"), for a bug report. */
export function historyText(entries: readonly LogEntry[], nameOf: (p: PlayerId) => string): string {
  return entries
    .map((e) => {
      const when = e.turn === 0 ? 'Before the game' : `Turn ${e.turn}${e.active ? ` (${nameOf(e.active)})` : ''}, ${phaseLabel(e.phase)}`;
      return `${when}: ${e.text}`;
    })
    .join('\n') + (entries.length ? '\n' : '');
}

/** Splits a line around its card's name, so the name can be drawn as a link to its preview. */
export function splitCard(e: LogEntry): Array<{ text: string; card: boolean }> {
  const card = e.card;
  if (!card) return [{ text: e.text, card: false }];
  const parts = e.text.split(card);
  const out: Array<{ text: string; card: boolean }> = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push({ text: card, card: true });
    if (p) out.push({ text: p, card: false });
  });
  return out;
}

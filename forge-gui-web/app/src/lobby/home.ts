/**
 * The lobby home's words, no React: who a game card says it is against, a starting game's stage checklist,
 * and the friend tiles' status lines.
 */
import type { MatchInfo, Person, WinLoss } from './api';

/** The AI on a game card: the server's name for Neural, "Forge AI" for Forge's own, a profile by name, "AI" when unknown. */
export function aiName(ai: string | undefined, neuralLabel = 'Neural'): string {
  return ai === 'Neural' ? neuralLabel : ai === 'Default' ? 'Forge AI' : ai || 'AI';
}

/** A starting game's stages, as the router names them, and what the card calls them. */
export const BOOT_STAGES = [
  { id: 'java', label: 'Engine' },
  { id: 'cards', label: 'Cards' },
  { id: 'ai', label: 'AI' },
  { id: 'table', label: 'Table' },
] as const;

export interface BootStep {
  label: string;
  state: 'done' | 'now' | 'todo';
}

/** The checklist under a starting game's bar: stages before the current one done, it in progress, the rest to come. */
export function bootSteps(m: Pick<MatchInfo, 'progress'>): BootStep[] {
  const at = BOOT_STAGES.findIndex((s) => s.id === m.progress?.stage);
  return BOOT_STAGES.map((s, i) => ({ label: s.label, state: at < 0 ? (i === 0 ? 'now' : 'todo') : i < at ? 'done' : i === at ? 'now' : 'todo' }));
}

/** "3–2". */
export function recordText(r: WinLoss): string {
  return `${r.w}–${r.l}`;
}

const DAY = 86_400_000;

/** "today", "yesterday", "Tue" within the week, else "Oct 3". */
export function dayText(ms: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ms >= today) return 'today';
  if (ms >= today - DAY) return 'yesterday';
  if (ms >= today - 6 * DAY) return new Date(ms).toLocaleDateString([], { weekday: 'short' });
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "5 min ago", "3 hours ago", "2 days ago". */
export function agoText(ms: number, now: number): string {
  const min = Math.floor(Math.max(0, now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** A friend tile's status line: "Online · you're 3–2", "Online · last played Tue", "In a game · will see it after", "Away · 2 days ago". */
export function personLine(p: Person, now: number): string {
  if (p.state === 'playing') return 'In a game · will see it after';
  if (p.state === 'away') return p.seen !== undefined ? `Away · ${agoText(p.seen, now)}` : 'Away';
  if (p.record && p.record.w + p.record.l > 0) return `Online · you’re ${recordText(p.record)}`;
  if (p.last !== undefined) return `Online · last played ${dayText(p.last, now)}`;
  return 'Online now';
}

/** Search the friend tiles by name. */
export function findPeople(people: Person[], query: string): Person[] {
  const q = query.trim().toLowerCase();
  return q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
}

/** The avatar's colour, steady per name: one of a few muted hues. */
export function avatarHue(name: string): string {
  const hues = ['#7a4b2a', '#2f5a4a', '#4b3a6b', '#3a4a6b', '#6b3a4a', '#4a5a2f'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return hues[h % hues.length]!;
}

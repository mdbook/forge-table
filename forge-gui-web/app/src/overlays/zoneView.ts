/**
 * Graveyard / exile viewer logic (no React): which cards a pile holds, how to show them, which ones the
 * player can act on from inside the viewer, and what a closed pile's "playable" badge says.
 */
import { knownFace } from '../store/model';
import type { Card, CardId, GameModel, PlayerId, PromptBody, ZoneRef } from '@forge-table/protocol';
import { lastingEffects } from '../table/lastingFx';

/** A pile the viewer opens; `command` is a player's lasting effects (table/lastingFx.ts), their commander left out. */
export type PileZone = 'graveyard' | 'exile' | 'command';

export interface ZoneViewRef {
  player: PlayerId;
  zone: PileZone;
}

/** The pile's cards, top (most recent) first. */
export function zoneCards(model: GameModel, ref: ZoneViewRef): CardId[] {
  if (ref.zone === 'command') return lastingEffects(model, ref.player).map((l) => l.id);
  const ids = model.players[ref.player]?.zones?.[ref.zone] ?? [];
  return [...ids].reverse();
}

/**
 * Whether the viewer must show the card's back: a face-down card the viewer may not identify (`f…`), an
 * opaque slot (`x…`), a card with no face, or one whose current face is the engine's FaceDown state.
 */
export function showsBack(id: CardId, card: Card | undefined): boolean {
  if (id.startsWith('f') || id.startsWith('x')) return true;
  const face = knownFace(card);
  return !face || face.face === 'FaceDown';
}

export function zoneTitle(ref: ZoneViewRef, viewer: PlayerId): string {
  return `${ref.player === viewer ? 'Your' : 'Opponent’s'} ${ref.zone === 'command' ? 'lasting effects' : ref.zone}`;
}

/** "9 cards", "1 card", "Empty". */
export function countLabel(n: number): string {
  return n === 0 ? 'Empty' : `${n} ${n === 1 ? 'card' : 'cards'}`;
}

/** What clicking a card in the viewer does: answer the prompt with it (selectable), play it (weak), or nothing. */
export function viewerAction(id: CardId, prompt: PromptBody | null, blocked: boolean): 'select' | 'play' | null {
  if (!prompt || blocked || prompt.kind === 'waiting') return null;
  if (prompt.selectable.includes(id)) return 'select';
  if ((prompt.weak?.[id] ?? 0) > 0) return 'play';
  return null;
}

/** How many of a pile's cards are playable right now (the closed pile's glow badge), 0 while blocked. */
export function playableCount(ids: readonly CardId[], prompt: PromptBody | null, blocked: boolean): number {
  if (!prompt || blocked) return 0;
  const weak = prompt.weak ?? {};
  return ids.reduce((n, id) => n + ((weak[id] ?? 0) > 0 ? 1 : 0), 0);
}

// ------------------------------------------------------------------- the zone strip (a reveal, ZoneStrip.tsx)

/** Sync new bridges' reveals at the playhead, with their choices and settled model, not on notice arrival. */
export function syncZoneStrip(prompt: PromptBody | null, previous: { prompt: PromptBody | null; zoneStrip: ZoneRef[] | null }) {
  if (!prompt?.zones) return previous.prompt?.zones ? { zoneStrip: null } : {};
  const zones = prompt.zones;
  const same = previous.zoneStrip?.length === zones.length && zones.every((z, i) => {
    const old = previous.zoneStrip![i]!;
    return z.player === old.player && z.zone === old.zone;
  });
  const reopen = zones.length > 0 && (!same || prompt.pid !== previous.prompt?.pid);
  return { zoneStrip: zones, ...(reopen ? { zoneStripDismissed: false, pinned: null, preview: null } : {}) };
}

/** The zone strip is up: the engine shows a zone while a prompt is up, and the player hasn't put it away. */
export function stripOpen(s: { zoneStrip: readonly unknown[] | null; prompt: PromptBody | null; zoneStripDismissed: boolean }): boolean {
  return !!s.zoneStrip && s.zoneStrip.length > 0 && !!s.prompt && s.prompt.kind !== 'waiting' && !s.zoneStripDismissed;
}

/** How the strip's cards are laid out: their height (CSS px), rows × columns, and the hover zoom. */
export interface RevealFit {
  h: number;
  rows: number;
  cols: number;
  zoom: number;
}

/**
 * The largest cards (up to `maxH` tall) that fit `n` across `w` × `h` CSS px with `gap` between them: one row if
 * that is about as big (a wrap must win by over 10%: a row reads as a hand), else as many rows as make them
 * biggest. The hover zoom takes a card to about `zoomH` tall (at least a 1.08 lift, at most 1.9×).
 */
export function revealFit(n: number, w: number, h: number, gap: number, maxH: number, zoomH: number): RevealFit {
  const aspect = 63 / 88;
  let best: RevealFit | null = null;
  for (let rows = 1; rows <= Math.max(1, n); rows++) {
    const cols = Math.ceil(Math.max(1, n) / rows);
    const ch = Math.floor(Math.min(maxH, (w - gap * (cols - 1)) / cols / aspect, (h - gap * (rows - 1)) / rows));
    if (!best || ch > best.h * 1.1) best = { h: ch, rows, cols, zoom: 1 };
    if (cols === 1) break;
  }
  const fit = best!;
  fit.h = Math.max(40, fit.h);
  fit.zoom = Math.max(1.08, Math.min(1.9, zoomH / fit.h));
  return fit;
}

/**
 * A card's slot in a one-row strip: a gentle fan (rotation in degrees, and a drop in px toward the ends, as a held
 * hand); flat when the cards wrap into rows.
 */
export function fanSlot(i: number, n: number, rows: number, h: number): { rot: number; dy: number } {
  if (rows > 1 || n < 2) return { rot: 0, dy: 0 };
  const mid = (n - 1) / 2;
  const k = (i - mid) / Math.max(1, mid);
  const spread = Math.min(8, 1.6 * mid);
  return { rot: k * spread, dy: k * k * h * 0.04 };
}

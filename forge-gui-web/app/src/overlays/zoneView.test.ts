import { describe, expect, it } from 'vitest';
import type { Card, GameModel, PromptBody } from '@forge-table/protocol';
import { knownFace, modelOf, peeked } from '../store/model';
import { countLabel, fanSlot, playableCount, revealFit, showsBack, stripOpen, syncZoneStrip, viewerAction, zoneCards, zoneTitle } from './zoneView';

const card = (id: string, face = 'Original'): Card => ({ id, zone: 'Graveyard', state: { face, name: id } });

const model: GameModel = modelOf(
  { stack: [] },
  {
    p0: { id: 'p0', life: 20, zones: { graveyard: ['c1', 'c2', 'c3'], exile: ['c4', 'f9'] } },
    p1: { id: 'p1', life: 20, zones: {} },
  },
  { c1: card('c1'), c2: card('c2'), c3: card('c3'), c4: card('c4', 'FaceDown') },
);

const prompt = (over: Partial<PromptBody> = {}): PromptBody => ({
  pid: 1,
  kind: 'priority',
  message: '',
  ok: { label: 'OK', enabled: true },
  cancel: { label: '', enabled: false },
  focusOk: true,
  selectable: [],
  highlighted: [],
  weak: {},
  ...over,
});

describe('graveyard / exile viewer', () => {
  it('lists a pile top first, and an empty or unknown pile as empty', () => {
    expect(zoneCards(model, { player: 'p0', zone: 'graveyard' })).toEqual(['c3', 'c2', 'c1']);
    expect(zoneCards(model, { player: 'p1', zone: 'exile' })).toEqual([]);
    expect(zoneCards(model, { player: 'p7', zone: 'graveyard' })).toEqual([]);
  });

  it('shows the back for face-down cards: f… ids, the FaceDown face, or no face at all', () => {
    expect(showsBack('c1', model.cards.c1)).toBe(false);
    expect(showsBack('c4', model.cards.c4)).toBe(true);
    expect(showsBack('f9', undefined)).toBe(true);
    expect(showsBack('c5', { id: 'c5' })).toBe(true);
  });

  it('titles and counts', () => {
    expect(zoneTitle({ player: 'p0', zone: 'graveyard' }, 'p0')).toBe('Your graveyard');
    expect(zoneTitle({ player: 'p1', zone: 'exile' }, 'p0')).toBe('Opponent’s exile');
    expect(countLabel(0)).toBe('Empty');
    expect(countLabel(1)).toBe('1 card');
    expect(countLabel(9)).toBe('9 cards');
  });

  it('acts on a card only when the live prompt can take it', () => {
    const p = prompt({ selectable: ['c1'], weak: { c2: 1 } });
    expect(viewerAction('c1', p, false)).toBe('select');
    expect(viewerAction('c2', p, false)).toBe('play');
    expect(viewerAction('c3', p, false)).toBeNull();
    expect(viewerAction('c2', p, true)).toBeNull(); // a blocking overlay is up
    expect(viewerAction('c2', prompt({ kind: 'waiting', weak: { c2: 1 } }), false)).toBeNull();
    expect(viewerAction('c2', null, false)).toBeNull();
  });

  it('counts playable cards for a closed pile’s badge (none while blocked, none without weak)', () => {
    const ids = ['c1', 'c2', 'c3'];
    expect(playableCount(ids, prompt({ weak: { c1: 1, c3: 2, c9: 1 } }), false)).toBe(2);
    expect(playableCount(ids, prompt({ weak: { c1: 1 } }), true)).toBe(0);
    expect(playableCount(ids, prompt({ weak: undefined as unknown as Record<string, number> }), false)).toBe(0);
    expect(playableCount(ids, null, false)).toBe(0);
  });
});

describe('foretold faces (handoff 5)', () => {
  it('my face-down card in exile shows its real face (alt); the opponent only ever has an f id', () => {
    const mine: Card = { id: 'c7', zone: 'Exile', state: { face: 'FaceDown', name: '' }, alt: { face: 'Original', name: 'Saw It Coming' } };
    expect(showsBack('c7', mine)).toBe(false);
    expect(knownFace(mine)?.name).toBe('Saw It Coming');
    expect(peeked(mine)).toBe(true);
    expect(showsBack('f12', { id: 'f12', zone: 'Exile', state: { face: 'FaceDown', name: '' } })).toBe(true);
    // A face-down creature on the battlefield (morph) keeps its face-down face.
    expect(knownFace({ ...mine, zone: 'Battlefield' })?.face).toBe('FaceDown');
  });
});

describe('the zone strip (a reveal)', () => {
  it('is up while the engine shows a zone and a prompt is up, until the player puts it away', () => {
    const z = [{ player: 'p1', zone: 'Hand' }];
    expect(stripOpen({ zoneStrip: z, prompt: prompt(), zoneStripDismissed: false })).toBe(true);
    expect(stripOpen({ zoneStrip: z, prompt: prompt(), zoneStripDismissed: true })).toBe(false);
    expect(stripOpen({ zoneStrip: z, prompt: null, zoneStripDismissed: false })).toBe(false);
    expect(stripOpen({ zoneStrip: z, prompt: prompt({ kind: 'waiting' }), zoneStripDismissed: false })).toBe(false);
    expect(stripOpen({ zoneStrip: [], prompt: prompt(), zoneStripDismissed: false })).toBe(false);
    expect(stripOpen({ zoneStrip: null, prompt: prompt(), zoneStripDismissed: false })).toBe(false);
  });

  it('syncs reveals with the prompt, preserving dismissal across selection updates but not new prompts', () => {
    const zones = [{ player: 'p0', zone: 'Graveyard' }];
    const p = prompt({ kind: 'chooseTargets', zones });
    const state = { prompt: p, zoneStrip: zones };
    expect(syncZoneStrip(p, { prompt: null, zoneStrip: null })).toEqual({ zoneStrip: zones, zoneStripDismissed: false, pinned: null, preview: null });
    expect(syncZoneStrip({ ...p, zones: [...zones], highlighted: ['c1'] }, state)).toEqual({ zoneStrip: zones });
    expect(syncZoneStrip({ ...p, pid: 2 }, state)).toHaveProperty('zoneStripDismissed', false);
    expect(syncZoneStrip({ ...p, zones: [{ player: 'p1', zone: 'Exile' }] }, state)).toHaveProperty('zoneStripDismissed', false);
    expect(syncZoneStrip({ ...p, zones: [] }, state)).toEqual({ zoneStrip: [] });
    expect(syncZoneStrip(null, state)).toEqual({ zoneStrip: null });
    // Old recordings still use notice{zones}.
    expect(syncZoneStrip(prompt(), { prompt: prompt(), zoneStrip: zones })).toEqual({});
  });

  it('desktop: five cards in one big row, capped; the hover zoom is a modest lift', () => {
    const f = revealFit(5, 1700, 640, 24, 340, 420);
    expect(f).toMatchObject({ rows: 1, cols: 5, h: 340 });
    expect(f.zoom).toBeCloseTo(420 / 340, 5);
    // Many cards: still one row while that keeps them big enough; they shrink to fit the width.
    const many = revealFit(10, 1700, 640, 24, 340, 420);
    expect(many.rows).toBe(2);
    expect(revealFit(7, 1700, 640, 24, 340, 420)).toMatchObject({ rows: 1, cols: 7 });
  });

  it('phone portrait: five cards wrap into rows that fit the width and the height; the zoom makes them readable', () => {
    const f = revealFit(5, 366, 500, 10, 300, 380);
    expect(f.rows).toBe(2);
    expect(f.cols).toBe(3);
    expect(f.cols * f.h * (63 / 88) + (f.cols - 1) * 10).toBeLessThanOrEqual(366);
    expect(f.rows * f.h + (f.rows - 1) * 10).toBeLessThanOrEqual(500);
    expect(f.h).toBeGreaterThan(150);
    expect(f.zoom).toBeLessThanOrEqual(1.9);
    expect(f.zoom * f.h).toBeGreaterThan(280);
    // One card: as big as allowed.
    expect(revealFit(1, 366, 500, 10, 300, 380)).toMatchObject({ rows: 1, cols: 1, h: 300 });
  });

  it('a one-row strip is a gentle, symmetric fan; wrapped rows are flat', () => {
    const n = 5;
    const slots = Array.from({ length: n }, (_, i) => fanSlot(i, n, 1, 340));
    expect(slots[2]).toEqual({ rot: 0, dy: 0 });
    expect(slots[0]!.rot).toBeCloseTo(-slots[4]!.rot, 9);
    expect(slots[0]!.dy).toBeCloseTo(slots[4]!.dy, 9);
    expect(Math.abs(slots[0]!.rot)).toBeLessThanOrEqual(8);
    expect(slots[1]!.dy).toBeLessThan(slots[0]!.dy);
    expect(fanSlot(0, 5, 2, 160)).toEqual({ rot: 0, dy: 0 });
    expect(fanSlot(0, 1, 1, 340)).toEqual({ rot: 0, dy: 0 });
  });
});

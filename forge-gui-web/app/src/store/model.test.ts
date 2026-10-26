import { describe, expect, it } from 'vitest';
import type { Card, GameModel } from '@forge-table/protocol';
import { applyPatch, canAttack, emptyModel, isSummoningSick, modelOf, opponentOf, previewsOnHover, zone } from './model';

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, zone: 'Hand', state: { face: 'Original', name: id }, ...extra });

describe('patch application', () => {
  const base: GameModel = modelOf(
    { turn: 1, phase: 'MAIN1', stack: [] },
    { p0: { id: 'p0', life: 20, zones: { hand: ['c1', 'c2'] } }, p1: { id: 'p1', life: 20, zones: { hand: ['xa'] } } },
    { c1: card('c1'), c2: card('c2') },
  );

  it('replaces objects wholesale and removes cards set to null', () => {
    const next = applyPatch(base, {
      players: { p0: { id: 'p0', life: 18, zones: { hand: ['c2'], battlefield: ['c1'] } } },
      cards: { c1: card('c1', { zone: 'Battlefield', tapped: true }), c2: null },
    });
    expect(next.players.p0!.life).toBe(18);
    expect(next.players.p0!.zones.battlefield).toEqual(['c1']);
    expect(next.cards.c1).toMatchObject({ zone: 'Battlefield', tapped: true });
    expect(next.cards.c2).toBeUndefined();
    // Untouched objects are shared, touched ones are new: cheap change detection.
    expect(next.players.p1).toBe(base.players.p1);
    expect(next.game).toBe(base.game);
    expect(base.cards.c2).toBeDefined(); // the input is never mutated
  });

  it('replaces the game object and normalises a missing stack', () => {
    const next = applyPatch(base, { game: { turn: 2, phase: 'UPKEEP' } as never });
    expect(next.game.turn).toBe(2);
    expect(next.game.stack).toEqual([]);
  });

  it('treats an empty or missing patch as a no-op', () => {
    expect(applyPatch(base, undefined)).toBe(base);
    expect(applyPatch(base, {})).toEqual(base);
  });

  it('queries zones, opponents and attack readiness', () => {
    expect(zone(base, 'p0', 'hand')).toEqual(['c1', 'c2']);
    expect(zone(base, 'p9', 'hand')).toEqual([]);
    expect(opponentOf(base, 'p0')).toBe('p1');
    const creature = card('c3', { zone: 'Battlefield', state: { face: 'Original', type: { super: [], core: ['Creature'], sub: [] } } });
    expect(canAttack(creature)).toBe(true);
    expect(canAttack({ ...creature, sickness: true })).toBe(false);
    expect(canAttack({ ...creature, tapped: true })).toBe(false);
    const hasty = { ...creature, sickness: true, state: { ...creature.state!, keywords: [{ title: 'Haste' }] } };
    expect(canAttack(hasty)).toBe(true);
  });

  it('marks summoning sick creatures only: not hasty ones, lands, or cards off the battlefield', () => {
    const creature = card('c3', { zone: 'Battlefield', sickness: true, state: { face: 'Original', type: { super: [], core: ['Creature'], sub: [] } } });
    expect(isSummoningSick(creature)).toBe(true);
    expect(isSummoningSick({ ...creature, sickness: false })).toBe(false);
    expect(isSummoningSick({ ...creature, zone: 'Graveyard' })).toBe(false);
    expect(isSummoningSick({ ...creature, state: { ...creature.state!, keywords: [{ title: 'Haste' }] } })).toBe(false);
    expect(isSummoningSick({ ...creature, state: { face: 'Original', type: { super: ['Basic'], core: ['Land'], sub: ['Island'] } } })).toBe(false);
    expect(isSummoningSick(undefined)).toBe(false);
    expect(emptyModel().game.stack).toEqual([]);
  });
});

describe('hover preview', () => {
  const m: GameModel = modelOf(
    { turn: 1, phase: 'MAIN1', stack: [] },
    {
      p0: { id: 'p0', life: 20, zones: { hand: ['c1'], battlefield: ['c2'], graveyard: ['c4'] } },
      p1: { id: 'p1', life: 20, zones: { hand: ['xa'], battlefield: ['c3'] } },
    },
    { c1: card('c1'), c2: card('c2', { zone: 'Battlefield' }), c3: card('c3', { zone: 'Battlefield' }), c4: card('c4', { zone: 'Graveyard' }) },
  );
  const plain = { alt: false, handRaised: false };

  it('skips my hand cards, which already grow on hover', () => {
    expect(previewsOnHover(m, 'p0', 'c1', plain)).toBe(false);
  });

  it('keeps it for everything else', () => {
    expect(previewsOnHover(m, 'p0', 'c2', plain)).toBe(true);
    expect(previewsOnHover(m, 'p0', 'c3', plain)).toBe(true);
    expect(previewsOnHover(m, 'p0', 'c4', plain)).toBe(true);
    expect(previewsOnHover(m, 'p1', 'c1', plain)).toBe(true); // another viewer's hand is not mine
  });

  it('shows it for a hand card with Alt held, or while the hand is raised (no hover lift then)', () => {
    expect(previewsOnHover(m, 'p0', 'c1', { alt: true, handRaised: false })).toBe(true);
    expect(previewsOnHover(m, 'p0', 'c1', { alt: false, handRaised: true })).toBe(true);
  });

  it('never for a hidden slot', () => {
    expect(previewsOnHover(m, 'p0', 'xa', { alt: true, handRaised: false })).toBe(false);
  });
});

describe('a dying card keeps its face (it turned generic mid-animation)', () => {
  it('a bare {id, state: {face}} patch keeps the card we had; a real update replaces it', () => {
    const bear: Card = { id: 'c1', zone: 'Battlefield', controller: 'p0', state: { face: 'Original', name: 'Grizzly Bears', imageKey: 'c:Grizzly Bears|SLZ|1' } };
    const m0 = modelOf({ stack: [] }, {}, { c1: bear });
    const m1 = applyPatch(m0, { cards: { c1: { id: 'c1', state: { face: 'Original' } } } });
    expect(m1.cards.c1).toBe(bear);
    const gy: Card = { ...bear, zone: 'Graveyard' };
    expect(applyPatch(m1, { cards: { c1: gy } }).cards.c1).toBe(gy);
  });
});

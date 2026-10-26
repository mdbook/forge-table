import { describe, expect, it } from 'vitest';
import { GLOW_BLUR, GLOW_PAD } from '../cards/textures';
import { cardWidth } from '../layout/geometry';
import { pickSpot, RING_STYLE } from './cardSprite';
import { BOTTOM_TAG, NO_PICKS, PICK_CHECK, pickBadge, pickLabel, picksOf, ringFor, type RingInput } from './selection';

const prompt = (kind: string, highlighted: string[], selMax?: number) => ({ kind, highlighted, ...(selMax !== undefined ? { selMax } : {}) });

function ring(over: Partial<RingInput>) {
  return ringFor({ id: 'c1', blocked: false, selectable: new Set(), picks: NO_PICKS, stackTop: null, ...over });
}

describe('picks (prompt highlighted in a selection prompt)', () => {
  it('numbers picks in the order the engine highlighted them', () => {
    const p = picksOf(prompt('selectEntities', ['c7', 'c2', 'c9'], 3));
    expect([...p.order]).toEqual([
      ['c7', 1],
      ['c2', 2],
      ['c9', 3],
    ]);
    expect(p.numbered).toBe(true);
    expect(pickBadge('c2', p)).toBe('2');
    expect(pickBadge('c3', p)).toBeNull();
  });

  it('shows numbers as soon as more than one can be picked, even with one picked so far', () => {
    expect(pickBadge('c1', picksOf(prompt('selectEntities', ['c1'], 2)))).toBe('1');
  });

  it('shows a check when only one can be picked', () => {
    const p = picksOf(prompt('selectEntities', ['c1'], 1));
    expect(p.numbered).toBe(false);
    expect(pickBadge('c1', p)).toBe(PICK_CHECK);
  });

  it('numbers several chosen targets even without selMax (chooseTargets sends none)', () => {
    const p = picksOf(prompt('chooseTargets', ['p2', 'c4']));
    expect(pickBadge('p2', p)).toBe('1');
    expect(pickBadge('c4', p)).toBe('2');
  });

  it('counts a repeated id once', () => {
    const p = picksOf(prompt('selectEntities', ['c1', 'c1', 'c2'], 2));
    expect(p.order.size).toBe(2);
    expect(pickBadge('c2', p)).toBe('2');
  });

  it('treats combat highlights as engine focus, not picks', () => {
    for (const kind of ['declareAttackers', 'declareBlockers']) {
      const p = picksOf(prompt(kind, ['c5']));
      expect(p.order.size).toBe(0);
      expect(p.focus.has('c5')).toBe(true);
      expect(pickBadge('c5', p)).toBeNull();
    }
  });

  it('has no picks without a prompt or highlights', () => {
    expect(picksOf(null)).toBe(NO_PICKS);
    expect(picksOf(prompt('priority', []))).toBe(NO_PICKS);
  });

  it('labels', () => {
    expect(pickLabel(3, true)).toBe('3');
    expect(pickLabel(3, false)).toBe(PICK_CHECK);
  });
});

describe('ring priority', () => {
  const sel = new Set(['c1']);
  it('picked wins over selectable (a picked card stays clickable to un-pick)', () => {
    expect(ring({ selectable: sel, picks: picksOf(prompt('selectEntities', ['c1'], 2)) })).toBe('selected');
  });

  it('selectable when not picked', () => {
    expect(ring({ selectable: sel, picks: picksOf(prompt('selectEntities', ['c9'], 2)) })).toBe('selectable');
  });

  it('a blocking ask hides selectable but keeps picks', () => {
    expect(ring({ selectable: sel, blocked: true })).toBe('none');
    expect(ring({ selectable: sel, blocked: true, picks: picksOf(prompt('selectEntities', ['c1'])) })).toBe('selected');
  });

  it('selectable > combat focus > attacking > blocking > stack top', () => {
    const focus = picksOf(prompt('declareBlockers', ['c1']));
    expect(ring({ selectable: sel, picks: focus })).toBe('selectable');
    expect(ring({ picks: focus, card: { attacking: true } })).toBe('highlight');
    expect(ring({ card: { attacking: true, blocking: true } })).toBe('attacking');
    expect(ring({ card: { blocking: true }, stackTop: 'c1' })).toBe('blocking');
    expect(ring({ stackTop: 'c1' })).toBe('stackTop');
    expect(ring({})).toBe('none');
  });
});

describe('ring and glow geometry', () => {
  it('selectable is tighter than before and picked is thicker than selectable', () => {
    const outer = (s: { halo: number; haloW: number }) => s.halo + s.haloW / 2;
    expect(outer(RING_STYLE.selectable)).toBeLessThan(outer(RING_STYLE.strong));
    expect(RING_STYLE.selectable.alpha).toBe(1);
    expect(RING_STYLE.selected.line).toBeGreaterThan(RING_STYLE.selectable.line);
  });

  it('the pick badge straddles the card top-left corner', () => {
    const s = pickSpot(150);
    expect(s.x - s.r).toBeLessThan(-cardWidth(150) / 2);
    expect(s.y - s.r).toBeLessThan(-75);
    expect(s.y + s.r).toBeLessThan(-75 + 150 * 0.13); // clear of the art (and the zZ tag below the name bar)
  });

  it('the playable glow is tighter than before', () => {
    expect(GLOW_PAD).toBeLessThan(36);
    expect(GLOW_BLUR).toBeLessThan(24);
  });
});

describe('the mulligan tuck (B5)', () => {
  it('tags the cards picked for the bottom "Bottom", not a check or a number', () => {
    const p = picksOf(prompt('mulliganTuck', ['c1', 'c2'], 2));
    expect(pickBadge('c1', p)).toBe(BOTTOM_TAG);
    expect(pickBadge('c2', p)).toBe(BOTTOM_TAG);
    expect(pickBadge('c3', p)).toBeNull();
  });
});

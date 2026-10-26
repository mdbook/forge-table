import { describe, expect, it, vi } from 'vitest';
import type { CardFace } from '@forge-table/protocol';
import { faceKey, type Ctx2D } from '../face';
import { costSpec } from '../../table/cardSprite';
import { framedAbility, framedCard, framedKey, ptHighlight, PT_TONE } from './framed';
import { M15_H, M15_W, PW, STD } from './geometry';
import { costPatchBox, costSlotOf, costSlotPx, layoutFor, pipCentre, ptPlate, toCardRect } from './layouts';
import { costPips, paintM15CostPatch } from './paint';

const face = (over: Partial<CardFace> = {}) =>
  ({ name: 'Goblin Guide', manaCost: '{R}', colors: 'R', setCode: 'ZEN', rarity: 'Rare', oracleText: 'Haste', power: 2, toughness: 2, type: { super: [], core: ['Creature'], sub: ['Goblin'] }, ...over }) as unknown as CardFace;

/** A canvas context that records its calls and every style it is given. */
function recorder() {
  const calls: Array<[string, unknown[]]> = [];
  const styles: string[] = [];
  const stops: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (t, name: string) => {
      if (name === 'measureText') return (text: string) => ({ width: text.length * 5, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 5, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 0 });
      if (name === 'getTransform') return () => ({ a: 2, d: 2 });
      if (name === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (name === 'createLinearGradient' || name === 'createRadialGradient') return () => ({ addColorStop: (_o: number, c: string) => stops.push(c) });
      if (name in t) return t[name];
      return (...args: unknown[]) => void calls.push([name, args]);
    },
    set: (t, name: string, v) => {
      if (name === 'fillStyle' || name === 'strokeStyle') styles.push(String(v));
      t[name] = v;
      return true;
    },
  }) as unknown as Ctx2D;
  const count = (n: string) => calls.filter(([c]) => c === n).length;
  return { ctx, calls, styles, stops, count };
}

describe('the M15 cost slot', () => {
  it('sits at the right end of the name plate, and the pips run leftward from it', () => {
    const std = costSlotOf(layoutFor({ typeLine: 'Creature — Goblin' }));
    expect(std).toEqual({ right: STD.name.x + STD.name.w - 11, cy: STD.name.y + STD.name.h / 2 - 0.5 + 1, d: 32, pitch: 35.2 });
    // the last pip's right edge is the slot's right; the first of three is two pitches to its left
    expect(pipCentre(std, 2, 3).x + 16).toBeCloseTo(std.right, 9);
    expect(pipCentre(std, 0, 3).x).toBeCloseTo(std.right - 16 - 2 * 35.2, 9);
    const pw = costSlotOf(layoutFor({ typeLine: 'Legendary Planeswalker — Jace' }));
    expect(pw.cy).toBeCloseTo(PW.name.y + PW.name.h / 2 - 0.5, 9);
    expect(pw.right).toBe(PW.name.x + PW.name.w - 11);
  });

  it('is scaled to a canvas for the shared cost painters', () => {
    const l = layoutFor({ typeLine: 'Creature' });
    const s = costSlotPx(l, M15_W / 2, M15_H / 2);
    expect(s.right).toBeCloseTo(costSlotOf(l).right / 2, 9);
    expect(s.r).toBeCloseTo(8, 9);
    expect(s.barBottom).toBeCloseTo((STD.name.y + STD.name.h) / 2, 9);
  });

  it('counts pips in a cost text', () => {
    expect(costPips('{2}{U/B}{G}')).toEqual(['2', 'U/B', 'G']);
    expect(costPips(undefined)).toEqual([]);
  });
});

describe('the changed-cost patch box', () => {
  const l = layoutFor({ typeLine: 'Instant' });
  const slot = costSlotOf(l);

  it('covers the longer of the printed and the new cost, and never the plate end', () => {
    const shorter = costPatchBox(l, 3, 1);
    const longer = costPatchBox(l, 1, 4);
    // the leftmost pip of the longer run lies inside the box, past the feather
    expect(longer.x + longer.feather).toBeLessThan(pipCentre(slot, 0, 4).x - slot.d / 2);
    expect(shorter.x + shorter.feather).toBeLessThan(pipCentre(slot, 0, 3).x - slot.d / 2);
    // one more pip (3 vs 4) is one more pitch of box
    expect(longer.w - shorter.w).toBeCloseTo(slot.pitch, 9);
    for (const b of [shorter, longer]) {
      expect(b.x + b.w).toBeLessThan(STD.name.x + STD.name.w);
      expect(b.x + b.w).toBeGreaterThan(slot.right);
      expect(b.y).toBeGreaterThan(STD.name.y);
      expect(b.y + b.h).toBeLessThan(STD.name.y + STD.name.h);
    }
  });

  it('is at least one pip wide for a free spell', () => {
    expect(costPatchBox(l, 0, 0)).toEqual(costPatchBox(l, 1, 1));
  });
});

describe('the cost patch painter', () => {
  const card = framedCard(face({ manaCost: '{3}{R}', type: { super: [], core: ['Instant'], sub: [] } } as Partial<CardFace>), undefined, null);

  it('paints one halo, ring and pip per new pip in the tone colour', () => {
    const r = recorder();
    paintM15CostPatch(r.ctx, card, { cost: '{1}{R}', tone: 'down' }, 'pips');
    // 2 halos (fill arcs) + 2 ring pairs (stroke arcs): 4 arcs for the tone, plus whatever the pips draw themselves
    expect(r.count('arc')).toBeGreaterThanOrEqual(4);
    expect(r.stops.some((s) => s.startsWith('rgba(60,224,143,'))).toBe(true);
    expect(r.styles).toContain('rgba(60,224,143,1)');
    expect(r.count('drawImage')).toBe(0);
  });

  it('uses red for a tax and amber for the same mana in other symbols', () => {
    const up = recorder();
    paintM15CostPatch(up.ctx, card, { cost: '{5}{R}', tone: 'up' }, 'pips');
    expect(up.styles).toContain('rgba(255,84,72,1)');
    const same = recorder();
    paintM15CostPatch(same.ctx, card, { cost: '{R}{R}{R}{R}', tone: 'same' }, 'pips');
    expect(same.styles).toContain('rgba(251,191,36,1)');
  });

  /** Run `fn` with OffscreenCanvas standing in: every layer canvas it makes hands back its own recorder. */
  function withLayers(fn: () => void) {
    const layers: Array<{ w: number; h: number; rec: ReturnType<typeof recorder>; ctx: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(public width: number, public height: number) {
          layers.push({ w: width, h: height, rec: recorder(), ctx: {} });
        }
        getContext() {
          return layers[layers.length - 1]!.rec.ctx;
        }
      },
    );
    try {
      fn();
    } finally {
      vi.unstubAllGlobals();
    }
    // (the mottle's 256×256 noise tile is a canvas too, made once)
    return layers.filter((l) => l.w !== 256 || l.h !== 256);
  }

  it('redraws the name plate on a layer of its own, feathers that layer, and lays it over the cost box', () => {
    const r = recorder();
    const layers = withLayers(() => paintM15CostPatch(r.ctx, card, { cost: '{1}{R}', tone: 'down' }, 'plate'));
    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    const box = costPatchBox(layoutFor(card), 2, 2);
    // the layer is the box at the canvas's scale (the recorder reports a 2× transform)
    expect([layer.w, layer.h]).toEqual([Math.ceil(box.w * 2), Math.ceil(box.h * 2)]);
    // the feather: a transparent-to-opaque ramp, applied with destination-in, on the layer, never on the face
    expect(layer.rec.stops).toContain('rgba(0,0,0,0)');
    expect(layer.rec.stops).toContain('rgba(0,0,0,1)');
    expect(layer.rec.count('arc')).toBe(0);
    expect(r.stops).toEqual([]);
    expect(r.styles).toEqual([]);
    // ...and composited over the face once, in the box
    const draws = r.calls.filter(([n]) => n === 'drawImage');
    expect(draws).toHaveLength(1);
    expect((draws[0]![1] as number[]).slice(1)).toEqual([box.x, box.y, box.w, box.h]);
  });

  it('paints both layers by default', () => {
    const both = recorder();
    const layers = withLayers(() => paintM15CostPatch(both.ctx, card, { cost: '{1}{R}', tone: 'down' }));
    expect(layers).toHaveLength(1);
    expect(both.count('drawImage')).toBe(1);
    expect(both.count('arc')).toBeGreaterThanOrEqual(4);
  });

  it('skips the plate where there are no canvases to paint it on', () => {
    const r = recorder();
    paintM15CostPatch(r.ctx, card, { cost: '{1}{R}', tone: 'down' }, 'plate');
    expect(r.count('drawImage')).toBe(0);
  });
});

describe('costSpec for the M15 face', () => {
  const f = face({ manaCost: '{2}{U}', type: { super: [], core: ['Sorcery'], sub: [] } } as Partial<CardFace>);
  const W = 100;
  const H = Math.round((100 * M15_H) / M15_W);

  it('scales the design grid onto the card and pivots on the middle of the new pips', () => {
    const s = costSpec('{U}', f, W, H, 'm15', null);
    expect(s.kx).toBeCloseTo(W / M15_W, 9);
    expect(s.ky).toBeCloseTo(H / M15_H, 9);
    const slot = costSlotOf(layoutFor({ typeLine: 'Sorcery' }));
    // one pip: its centre is the slot's last pip centre
    expect(s.pivot.x).toBeCloseTo(pipCentre(slot, 0, 1).x * s.kx, 9);
    expect(s.pivot.y).toBeCloseTo(slot.cy * s.ky, 9);
    // the texture reaches a pip radius past the patch box on every side
    const box = costPatchBox(layoutFor({ typeLine: 'Sorcery' }), 2, 1);
    expect(s.x0).toBeCloseTo(box.x - 16, 9);
    expect(s.tw).toBeCloseTo(box.w + 32, 9);
  });

  it('keeps the old card-px geometry for scans and the plain face', () => {
    const scan = costSpec('{U}', f, 488, 680, 'scan', [200, 200, 200]);
    expect([scan.kx, scan.ky]).toEqual([1, 1]);
    expect(scan.pivot.y).toBeCloseTo(50.5, 9);
    const plain = costSpec('{U}', f, 252, 352, 'plain', null);
    expect(plain.kx).toBe(1);
    expect(plain.pivot.x).toBeLessThan(252);
  });
});

describe('the framed face', () => {
  it("is the client face as an M15 card, with the crop's artist (the wire has none)", () => {
    const c = framedCard(face(), undefined, 'Chris Rahn');
    expect(c.artist).toBe('Chris Rahn');
    expect(c.typeLine).toBe('Creature — Goblin');
    expect(c.power).toBe('2');
    expect(framedCard(face(), undefined, null).artist).toBe('');
  });

  it('caches apart from the plain face, by art and artist, and repaints when the P/T changes', () => {
    const f = face();
    expect(framedKey(f, undefined, undefined)).not.toBe(faceKey(f));
    expect(framedKey(f, undefined, 'k1', 'A')).not.toBe(framedKey(f, undefined, undefined));
    expect(framedKey(f, undefined, 'k1', 'A')).not.toBe(framedKey(f, undefined, 'k1', 'B'));
    expect(framedKey(f, undefined, 'k1', 'A')).toBe(framedKey(face(), undefined, 'k1', 'A'));
    expect(framedKey(face({ power: 5 }), undefined, undefined)).not.toBe(framedKey(f, undefined, undefined));
  });

  it('is the token layout for a token card, the type line prefixed as before', () => {
    const c = framedCard(face(), { token: true }, null);
    expect(c.token).toBe(true);
    expect(c.typeLine).toBe('Token Creature — Goblin');
    expect(layoutFor(c).id).toBe('token');
    expect(framedCard(face(), { token: false }, null).token).toBe(false);
  });
});

describe('the P/T highlight', () => {
  it('lies over the M15 P/T plate, scaled to the card and centred on its middle', () => {
    const w = 126;
    const h = 176;
    const { rect } = ptHighlight({ typeLine: 'Creature — Goblin', power: '3', toughness: '3', defense: '' }, 'up', w, h);
    expect(rect).toEqual(toCardRect(STD.pt, w, h));
    // bottom-right of a card whose origin is its centre
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThan(0);
    expect(rect.x + rect.w).toBeLessThan(w / 2);
    expect(rect.y + rect.h).toBeLessThan(h / 2);
    expect(rect.w / w).toBeCloseTo(STD.pt.w / M15_W, 9);
  });

  it('follows the layout (a planeswalker keeps its loyalty shield elsewhere) and the tone', () => {
    const std = ptHighlight({ typeLine: 'Creature', power: '2', toughness: '2', defense: '' }, 'up', 100, 140);
    const pw = ptHighlight({ typeLine: 'Planeswalker — Jace', power: '', toughness: '', defense: '' }, 'down', 100, 140);
    expect(pw.rect).toEqual(toCardRect(PW.pt, 100, 140));
    expect(pw.rect).not.toEqual(std.rect);
    expect(std.color).toBe(PT_TONE.up);
    expect(pw.color).toBe(PT_TONE.down);
    expect(new Set(Object.values(PT_TONE)).size).toBe(4);
  });

  it('grows the plate to the left for long numbers, its right edge fixed', () => {
    const c = (power: string, toughness: string) => ({ typeLine: 'Creature', power, toughness, defense: '' });
    expect(ptPlate(c('3', '3'), '3/3')).toEqual(STD.pt);
    for (const [p, t] of [['99', '99'], ['1000', '1000'], ['-4', '3']]) {
      const r = ptPlate(c(p!, t!), `${p}/${t}`);
      expect(r.x + r.w).toBe(STD.pt.x + STD.pt.w);
      expect(r.y).toBe(STD.pt.y);
      expect(r.x).toBeGreaterThan(0);
    }
    expect(ptPlate(c('99', '99'), '99/99').w).toBeGreaterThan(STD.pt.w);
    expect(ptPlate(c('1000', '1000'), '1000/1000').w).toBeGreaterThan(ptPlate(c('99', '99'), '99/99').w);
    // The highlight hugs the grown plate.
    expect(ptHighlight(c('1000', '1000'), 'up', 100, 140).rect).toEqual(toCardRect(ptPlate(c('1000', '1000'), '1000/1000'), 100, 140));
  });
});

describe('framedAbility', () => {
  it('is its source in the M15 frame, minus cost and stats, with the ability on the type line and in the box', () => {
    const src = { state: face(), token: false } as never;
    const m = framedAbility({ name: 'Goblin Guide', kind: 'Triggered', text: 'Defending player reveals the top card.' }, src, 'Some Artist');
    expect(m).toMatchObject({ name: 'Goblin Guide', colors: 'R', manaCost: '', typeLine: 'Triggered Ability', rules: 'Defending player reveals the top card.', power: '', toughness: '', loyalty: '', artist: 'Some Artist' });
    expect(layoutFor(m).geo).toBe(STD);
  });

  it('a planeswalker\'s loyalty ability is a standard card, not a planeswalker one', () => {
    const pw = { state: face({ name: 'Chandra', power: undefined, toughness: undefined, loyalty: 4, type: { super: ['Legendary'], core: ['Planeswalker'], sub: ['Chandra'] } } as never), token: false } as never;
    const m = framedAbility({ name: 'Chandra', kind: 'Activated', text: '+1: Chandra deals 2 damage to any target.' }, pw, null);
    expect(m.loyalty).toBe('');
    expect(layoutFor(m).geo).toBe(STD);
  });

  it('a hidden source still gives a card: colourless, named by the ability', () => {
    expect(framedAbility({ name: 'Ability', kind: 'Activated', text: 'Draw a card.' }, undefined, null)).toMatchObject({ name: 'Ability', colors: '', typeLine: 'Activated Ability' });
  });

  it("is never a token's own tall-art frame, even off a token source", () => {
    const src = { state: face(), token: true } as never;
    const m = framedAbility({ name: 'Goblin Guide', kind: 'Triggered', text: 'Draw a card.' }, src, null);
    expect(m.token).toBe(false);
    expect(layoutFor(m).id).toBe('std');
  });
});

/** A pile of identical modified creatures (layout.ts groupUnits) shows one set of badges, the top card's (ticket 3376). */
import { describe, expect, it } from 'vitest';
import { Texture, type Container } from 'pixi.js';
import type { Card, GameModel, Player } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { computeLayout } from '../layout/layout';
import * as sprites from './cardSprite';
import { CardSprite, poseToTransform } from './cardSprite';

/** A pumped 2/2 Otter token (printed 1/1), the QA pile: its M15 P/T plate lights green. */
const otter = (id: string): Card => ({
  id,
  controller: 'p0',
  zone: 'Battlefield',
  token: true,
  state: { face: 'Original', name: 'Otter Token', power: 2, toughness: 2, type: { super: [], core: ['Creature'], sub: ['Otter'] } },
});

function pile(): GameModel {
  const cards = [otter('c1'), otter('c2'), otter('c3')];
  return modelOf(
    { turn: 1, phase: 'MAIN1', playerTurn: 'p0', stack: [] },
    {
      p0: { id: 'p0', life: 20, zones: { battlefield: ['c1', 'c2', 'c3'] } as Player['zones'] },
      p1: { id: 'p1', life: 20, zones: {} as Player['zones'] },
    },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}

/** The badge layer's children (private to the sprite). */
const badges = (s: CardSprite) => (s as unknown as { badges: Container }).badges.children;

describe('a stacked pile of modified creatures', () => {
  const poses = computeLayout({ model: pile(), viewer: 'p0' }).cards;
  const top = [...poses.values()].find((p) => p.count === 3)!;
  const under = [...poses.values()].filter((p) => p.under);
  const chip = { text: '2/2', tone: 'up' as const };

  /** A sprite showing its M15 face, as in Framed art mode. */
  function framed(pose: typeof top): CardSprite {
    const s = new CardSprite(pose.id, Texture.EMPTY, poseToTransform(pose), true);
    s.setTextures(Texture.WHITE, Texture.EMPTY, true, true);
    return s;
  }

  it('lays out as one top card and two copies peeking out under it', () => {
    expect(top).toBeDefined();
    expect(under).toHaveLength(2);
    for (const u of under) expect(u.z).toBeLessThan(top.z);
  });

  it('lights the P/T plate once, on the top card, at every card size', () => {
    for (const h of [150, 210, 320]) {
      const t = framed(top);
      // count 0: the ×N coin is a canvas-painted marks sprite (no DOM here); the plate is what a copy would repeat.
      t.setBadges(otter(top.id), h, chip, false, 0, false, false);
      expect(badges(t).map((c) => c.label)).toContain('pt-highlight');
      t.destroy();
      for (const pose of under) {
        const s = framed(pose);
        s.setBadges(otter(pose.id), h, chip, false, 0, false, true);
        expect(badges(s).map((c) => c.label)).toEqual([]);
        s.destroy();
      }
    }
  });

  it("keeps each copy's chrome under the card on top of it, so nothing it draws lands on the top card", () => {
    const chromeZ = (sprites as Record<string, unknown>).chromeZ as ((z: number, under: boolean, lifted: boolean) => number) | undefined;
    expect(chromeZ).toBeTypeOf('function');
    const zs = [top, ...under].sort((a, b) => b.z - a.z);
    for (let i = 1; i < zs.length; i++) {
      expect(chromeZ!(zs[i]!.z, true, false)).toBeLessThan(zs[i - 1]!.z);
      expect(chromeZ!(zs[i]!.z, true, false)).toBeGreaterThan(zs[i]!.z);
    }
    // A lone row card's chrome still sits half a step up, under the next card (rows step z by 2).
    expect(chromeZ!(top.z, false, false)).toBe(top.z + 0.5);
  });
});

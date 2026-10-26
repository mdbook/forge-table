import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import type { Card } from '@forge-table/protocol';
import { PRESS_REST, SHEEN_EVERY_MS, SHEEN_MS, STOMP_MS, ambientKeywords, clipToRect, drawAmbientKeywords, drawSteelRest, pressAt, sheenAt } from './ambientFx';
import { cardWidth } from '../layout/geometry';

const card = (titles: string[], extra: Partial<Card> = {}): Card =>
  ({ id: 'c1', zone: 'Battlefield', state: { name: 'X', keywords: titles.map((title) => ({ title })) }, ...extra }) as unknown as Card;

describe('ambientKeywords', () => {
  it('reads indestructible, trample, deathtouch and lifelink off a face-up battlefield card', () => {
    expect(ambientKeywords(card(['Flying', 'Lifelink']))).toEqual({ indestructible: false, trample: false, deathtouch: false, lifelink: true });
    expect(ambientKeywords(card(['Indestructible', 'Deathtouch', 'Trample']))).toEqual({ indestructible: true, trample: true, deathtouch: true, lifelink: false });
  });
  it('is null for none of them, off the battlefield, or face down', () => {
    expect(ambientKeywords(card(['Flying']))).toBeNull();
    expect(ambientKeywords(card(['Lifelink'], { zone: 'Hand' }))).toBeNull();
    expect(ambientKeywords(card(['Lifelink'], { facedown: true }))).toBeNull();
    expect(ambientKeywords(undefined)).toBeNull();
  });
});

describe('sheenAt', () => {
  it('plays one pass per period, staggered by phase', () => {
    expect(sheenAt(0, 0)).toBe(0);
    expect(sheenAt(SHEEN_MS / 2, 0)).toBeCloseTo(0.5);
    expect(sheenAt(SHEEN_MS + 1, 0)).toBeNull();
    expect(sheenAt(SHEEN_EVERY_MS + 10, 0)).toBeCloseTo(10 / SHEEN_MS);
    // A card half a period along is mid-gap when the first is mid-pass.
    expect(sheenAt(SHEEN_MS / 2, 0.5)).toBeNull();
    expect(sheenAt(SHEEN_EVERY_MS / 2, 0.5)).toBe(0);
  });
});

describe('drawAmbientKeywords', () => {
  const none = { indestructible: false, trample: false, deathtouch: false, lifelink: false };
  it('keeps a resting sheen in the light layer at all times, calm too; a pass adds to it mid-pass only when not calm', () => {
    // "indestructible should have a permanent faint sheen (not the temporary animation)".
    const g = new Graphics();
    const light = new Graphics();
    const k = { ...none, indestructible: true };
    const count = (now: number, calm: boolean) => {
      light.clear();
      drawAmbientKeywords(g, light, k, 150, 0, now, calm);
      return light.context.instructions.length;
    };
    const rest = new Graphics();
    drawSteelRest(rest, cardWidth(150), 150);
    const resting = rest.context.instructions.length;
    expect(resting).toBeGreaterThan(0);
    expect(count(SHEEN_MS * 2, false)).toBe(resting);
    expect(count(SHEEN_MS / 2, true)).toBe(resting);
    expect(count(SHEEN_MS * 2, true)).toBe(resting);
    expect(count(SHEEN_MS / 2, false)).toBeGreaterThan(resting);
    expect(g.context.instructions.length).toBe(0);
  });
  it('draws no sheen for a card without indestructible', () => {
    const g = new Graphics();
    const light = new Graphics();
    drawAmbientKeywords(g, light, { ...none, lifelink: true }, 150, 0, SHEEN_MS / 2, false);
    expect(light.context.instructions.length).toBe(0);
  });
  it('keeps deathtouch and lifelink on screen when calm', () => {
    const g = new Graphics();
    const light = new Graphics();
    drawAmbientKeywords(g, light, { ...none, deathtouch: true, lifelink: true }, 150, 0, 1234, true);
    expect(g.context.instructions.length).toBe(10); // lifelink's feathered ring (7 strokes), deathtouch's two haze rings and line
  });
});

describe('clipToRect', () => {
  it('cuts a slanted stripe flush to the rect', () => {
    const pts = clipToRect([{ x: -1, y: -10 }, { x: 1, y: -10 }, { x: 1, y: 10 }, { x: -1, y: 10 }], 5, 3);
    expect(pts.every((p) => Math.abs(p.x) <= 5 + 1e-9 && Math.abs(p.y) <= 3 + 1e-9)).toBe(true);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-3);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(3);
  });
  it('drops a stripe wholly outside', () => {
    expect(clipToRect([{ x: 8, y: -1 }, { x: 9, y: -1 }, { x: 9, y: 1 }, { x: 8, y: 1 }], 5, 3)).toEqual([]);
  });
});

describe('pressAt', () => {
  it('rests partway down, stomps all the way at the hit, and is still when calm', () => {
    expect(pressAt(STOMP_MS * 0.05, 0, false)).toBeCloseTo(1);
    expect(pressAt(STOMP_MS * 0.8, 0, false)).toBeCloseTo(PRESS_REST);
    expect(pressAt(STOMP_MS * 0.3, 0, false)).toBeGreaterThan(PRESS_REST);
    expect(pressAt(STOMP_MS * 0.3, 0, false)).toBeLessThan(1);
    expect(pressAt(STOMP_MS * 0.05, 0, true)).toBe(PRESS_REST);
  });
});

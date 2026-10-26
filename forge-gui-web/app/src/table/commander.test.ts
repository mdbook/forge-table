import { describe, expect, it } from 'vitest';
import type { Card, CardFace, GameModel, Player, PromptBody } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { castsOf, commanderCost, hasCommanders, taxedCost } from './commander';
import { altCastables, withMyCommanders, type AltCard } from './altZone';
import { CARD_ASPECT, GAP, PROMPT_W_P, geometry, hudScale, worldSize } from '../layout/geometry';
import { computeLayout } from '../layout/layout';

describe('taxedCost: commander tax as a modified cost', () => {
  it('adds the tax to the generic part', () => {
    expect(taxedCost('{2}{R}', 2)).toBe('{4}{R}');
    expect(taxedCost('{3}{U}{U}', 4)).toBe('{7}{U}{U}');
    expect(taxedCost('{0}', 2)).toBe('{2}');
  });

  it('prepends {2N} when there is no generic part, after any X', () => {
    expect(taxedCost('{R}{R}', 2)).toBe('{2}{R}{R}');
    expect(taxedCost('{X}{R}', 2)).toBe('{X}{2}{R}');
    expect(taxedCost('{X}{X}{G}', 4)).toBe('{X}{X}{4}{G}');
    expect(taxedCost('{X}{1}{G}', 2)).toBe('{X}{3}{G}');
  });

  it('colourless-only and hybrid costs keep their symbols', () => {
    expect(taxedCost('{C}{C}', 2)).toBe('{2}{C}{C}');
    expect(taxedCost('{8}{C}{C}', 2)).toBe('{10}{C}{C}');
    expect(taxedCost('{W/U}{W/U}', 2)).toBe('{2}{W/U}{W/U}');
    expect(taxedCost('{2/W}{B/G/P}', 2)).toBe('{2}{2/W}{B/G/P}');
    expect(taxedCost('{1}{W/U}', 6)).toBe('{7}{W/U}');
  });

  it('no cost stays none, no tax changes nothing', () => {
    expect(taxedCost(undefined, 2)).toBeUndefined();
    expect(taxedCost('', 2)).toBe('');
    expect(taxedCost('no cost', 2)).toBe('no cost');
    expect(taxedCost('{2}{R}', 0)).toBe('{2}{R}');
  });
});

const face = (name: string, manaCost: string): CardFace => ({ face: 'Original', name, manaCost, type: { super: ['Legendary'], core: ['Creature'], sub: [] } });
const card = (id: string, zone: string, owner: string, f: CardFace): Card => ({ id, zone, owner, controller: owner, state: f, isCommander: true });

function brawl(cast: Record<string, number> = {}, mineZone = 'command', opts: { opp?: boolean } = {}): GameModel {
  const p0: Player = { id: 'p0', life: 25, zones: { hand: [], battlefield: mineZone === 'battlefield' ? ['c10'] : [], command: mineZone === 'command' ? ['c10'] : [] }, commander: ['c10'], commanderCast: cast };
  const p1: Player = { id: 'p1', life: 25, zones: { hand: [], battlefield: [], command: ['c20', 'c21'] }, ...(opts.opp === false ? {} : { commander: ['c20'] }) };
  return modelOf(
    { turn: 3, phase: 'MAIN1', playerTurn: 'p0', stack: [] },
    { p0, p1 },
    {
      c10: card('c10', mineZone === 'command' ? 'Command' : 'Battlefield', 'p0', face('Krenko, Mob Boss', '{2}{R}{R}')),
      c20: card('c20', 'Command', 'p1', face('Eluge', '{2}{U}{U}{U}')),
      // An emblem in the command zone: not a commander, never on the table.
      c21: { id: 'c21', zone: 'Command', owner: 'p1', controller: 'p1', state: face('Emblem', '') },
    },
  );
}

describe('commander tax from the wire', () => {
  it('reads commanderCast by the bare engine id', () => {
    const m = brawl({ '10': 2 });
    expect(castsOf(m.players.p0, 'c10')).toBe(2);
    expect(castsOf(m.players.p0, 'c99')).toBe(0);
    expect(commanderCost(m, 'c10', '{2}{R}{R}')).toBe('{6}{R}{R}');
    expect(commanderCost(brawl(), 'c10', '{2}{R}{R}')).toBeUndefined();
  });

  it('a constructed game has no commanders', () => {
    expect(hasCommanders(brawl())).toBe(true);
    expect(hasCommanders(modelOf({ stack: [] }, { p0: { id: 'p0', life: 20, zones: {} } }, {}))).toBe(false);
  });

  it('the alt-zone strip shows a castable commander at its taxed cost', () => {
    const prompt: PromptBody = { pid: 1, kind: 'priority', message: '', ok: { label: 'OK', enabled: true }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak: { c10: 1 } };
    expect(altCastables(brawl({ '10': 1 }), 'p0', prompt)).toEqual([{ id: 'c10', label: 'Command zone', tone: 'command', cost: '{4}{R}{R}' }]);
    expect(altCastables(brawl(), 'p0', prompt)).toEqual([{ id: 'c10', label: 'Command zone', tone: 'command' }]);
  });

  it('my waiting commander is always first in the strip: glowing when castable, idle (taxed cost shown) when not', () => {
    const flash: AltCard = { id: 'c30', label: 'Graveyard · Flashback', tone: 'graveyard', cost: '{1}{R}' };
    expect(withMyCommanders([], brawl(), 'p0')).toEqual([{ id: 'c10', label: 'Command zone', tone: 'command', idle: true }]);
    expect(withMyCommanders([flash], brawl({ '10': 1 }), 'p0')).toEqual([{ id: 'c10', label: 'Command zone', tone: 'command', cost: '{4}{R}{R}', idle: true }, flash]);
    const castable: AltCard = { id: 'c10', label: 'Command zone', tone: 'command', cost: '{4}{R}{R}' };
    expect(withMyCommanders([flash, castable], brawl({ '10': 1 }), 'p0')).toEqual([castable, flash]);
    // Elsewhere (battlefield), or the opponent's: the strip as is.
    const alt = [flash];
    expect(withMyCommanders(alt, brawl({}, 'battlefield'), 'p0')).toBe(alt);
    expect(withMyCommanders(alt, brawl(), 'p1').map((a) => a.id)).toEqual(['c20', 'c30']);
  });
});

/** Boxes in tu: [x0, y0, x1, y1]. */
type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const cardBox = (x: number, y: number, h: number): Box => [x - (h * CARD_ASPECT) / 2, y - h / 2, x + (h * CARD_ASPECT) / 2, y + h / 2];

/** The geometry for a viewport, as the scene computes it. */
function geoFor(w: number, h: number, command: boolean) {
  const ws = worldSize(w, h);
  const s = Math.min(w / ws.w, h / ws.h);
  return { g: geometry(ws.w, 1, hudScale(s) / s, ws.h, command), ws, hudK: hudScale(s) / s };
}

describe('the command-zone piles (geometry COMMAND)', () => {
  const VIEWPORTS: Array<[number, number]> = [[1920, 1080], [2560, 1080], [1366, 768], [1180, 820], [844, 390], [667, 375], [390, 844], [430, 932], [820, 1180]];

  it('a constructed game keeps its geometry exactly', () => {
    for (const [w, h] of VIEWPORTS) {
      const ws = worldSize(w, h);
      const s = Math.min(w / ws.w, h / ws.h);
      const k = hudScale(s) / s;
      expect(geometry(ws.w, 1, k, ws.h, false)).toEqual(geometry(ws.w, 1, k, ws.h));
      expect(geometry(ws.w, 1, k, ws.h).COMMAND).toBeNull();
    }
  });

  it("the opponent's sits beside their plate, clear of it, their fan, the rows and the other piles; my hand keeps its span", () => {
    for (const [w, h] of VIEWPORTS) {
      const { g, hudK, ws } = geoFor(w, h, true);
      const at = `${w}x${h}`;
      const cmd = g.COMMAND!;
      expect(cmd, at).not.toBeNull();
      const box = cardBox(cmd.opp.x, cmd.opp.y, cmd.h);
      const p = g.PLATES.opp;
      const plate: Box = [p.x, p.y, p.x + g.PLATES.w, p.y + g.PLATES.h];
      expect(overlaps(box, plate), `${at} plate`).toBe(false);
      if (g.portrait) {
        // Portrait: last in their strip, level with the plate, after the other piles; their fan right of it.
        expect(cmd.opp.y, at).toBeCloseTo(p.y + g.PLATES.h / 2);
        expect(box[0], at).toBeGreaterThan(g.PILES_X.exile + (g.SIZE.pile * CARD_ASPECT) / 2);
        expect(g.X.oppHandX - 90, at).toBeGreaterThan(box[2]);
      } else {
        // Landscape: just right of the plate, flush with its top; their fan right of it.
        expect(box[0] - plate[2], at).toBeGreaterThan(0);
        expect(box[0] - plate[2], at).toBeLessThan(20);
        expect(box[1], at).toBeCloseTo(plate[1]);
        expect(g.X.oppHandX - 90, at).toBeGreaterThan(box[2]);
      }
      for (const band of [g.BAND.oppFront, g.BAND.myFront]) expect(box[3] <= band[0] || box[1] >= band[1], `${at} front row`).toBe(true);
      expect(box[0], at).toBeGreaterThanOrEqual(0);
      expect(box[1], at).toBeGreaterThanOrEqual(0);
      for (const z of ['library', 'graveyard', 'exile'] as const) {
        expect(overlaps(box, cardBox(g.PILES_X[z], g.PILES.opp.library, g.SIZE.pile)), `${at} ${z}`).toBe(false);
      }
      expect(overlaps(box, [g.X.rowStart, g.BAND.oppBack[0], g.X.oppBackRowEnd, g.BAND.oppBack[1]]), `${at} back row`).toBe(false);
      // Mine has no pile: my hand (and, landscape, my piles) stand exactly as in a constructed game; portrait piles
      // only shrink to fit the opponent's four.
      const plain = geometry(ws.w, 1, hudK, ws.h, false);
      expect([g.X.handMin, g.X.handMax], at).toEqual([plain.X.handMin, plain.X.handMax]);
      if (!g.portrait) expect(g.PILES_X.library, at).toBe(plain.PILES_X.library);
      // Portrait: my piles still fit my strip before the prompt bar.
      if (g.portrait) expect(g.PILES_X.exile + (g.SIZE.pile * CARD_ASPECT) / 2, at).toBeLessThanOrEqual(g.X.actionsX - PROMPT_W_P * hudK);
    }
  });

  it('my waiting commander sits in the alt-zone strip beside my hand, the opponent\'s on their pile, an emblem nowhere', () => {
    for (const [w, h] of VIEWPORTS) {
      const { ws, hudK, g } = geoFor(w, h, true);
      const at = `${w}x${h}`;
      const m = brawl();
      m.players.p0!.zones.hand = Array.from({ length: 9 }, (_, i) => `c${100 + i}`);
      for (const id of m.players.p0!.zones.hand!) m.cards[id] = card(id, 'Hand', 'p0', face('Bolt', '{R}'));
      const alt = withMyCommanders([], m, 'p0').map((a) => a.id);
      const l = computeLayout({ model: m, viewer: 'p0', worldW: ws.w, worldH: ws.h, hudK, alt });
      const mine = l.cards.get('c10')!;
      expect(mine.region, at).toBe('alt');
      expect(mine.h, at).toBeCloseTo(g.ALT.h);
      expect(mine.x, at).toBeLessThanOrEqual(g.X.handMax);
      // Landscape: clear of the action row with a secondary button (Mulligan · Keep: ≤120 + 10 + 250 HUD units).
      if (!g.portrait) expect(cardBox(mine.x, mine.y, mine.h)[2], at).toBeLessThanOrEqual(g.X.actionsX - 380 * hudK);
      expect(l.cards.get('c20')!.region).toBe('command');
      expect(l.cards.has('c21')).toBe(false);
      expect(l.piles.filter((p) => p.zone === 'command').map((p) => [p.player, p.topId])).toEqual([['p1', 'c20']]);
      // Never in the fan: every hand card is left of it.
      const strip = cardBox(mine.x, mine.y, mine.h);
      for (const id of m.players.p0!.zones.hand!) {
        const p = l.cards.get(id)!;
        expect(p.region).toBe('hand');
        const half = Math.abs(Math.cos(p.rot)) * (p.h * CARD_ASPECT) / 2 + Math.abs(Math.sin(p.rot)) * p.h / 2;
        expect(p.x - half, `${at} ${id}`).toBeLessThan(strip[0]);
      }
    }
    const away = computeLayout({ model: brawl({}, 'battlefield'), viewer: 'p0', alt: withMyCommanders([], brawl({}, 'battlefield'), 'p0').map((a) => a.id) });
    expect(away.cards.get('c10')!.region).toBe('myFront');
    expect(away.piles.some((p) => p.zone === 'command' && p.player === 'p0')).toBe(false);
  });

  it("the opponent's Partner commanders both show on their pile, the second cascaded in front", () => {
    const m = brawl();
    m.players.p1!.commander = ['c20', 'c22'];
    m.players.p1!.zones.command = ['c20', 'c21', 'c22'];
    m.cards.c22 = card('c22', 'Command', 'p1', face('Kraum', '{3}{U}{R}'));
    const l = computeLayout({ model: m, viewer: 'p0' });
    const [a, b] = [l.cards.get('c20')!, l.cards.get('c22')!];
    expect([a.region, b.region]).toEqual(['command', 'command']);
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThan(a.y);
    expect(b.y - a.y).toBeLessThan(a.h / 2);
    expect(b.z).toBeGreaterThan(a.z);
    expect(l.piles.filter((p) => p.zone === 'command').map((p) => [p.player, p.count, p.topId])).toEqual([['p1', 2, 'c22']]);
    // One cast: the other still waits alone, where the first sat.
    m.players.p1!.zones.command = ['c22'];
    m.players.p1!.zones.battlefield = ['c20'];
    m.cards.c20 = { ...m.cards.c20!, zone: 'Battlefield' };
    expect(computeLayout({ model: m, viewer: 'p0' }).cards.get('c22')).toMatchObject({ region: 'command', x: a.x, y: a.y });
  });

  it('a commander-less opponent gets no pile; my command-zone anchor is the strip', () => {
    const l = computeLayout({ model: brawl({}, 'command', { opp: false }), viewer: 'p0' });
    expect(l.piles.filter((p) => p.zone === 'command')).toEqual([]);
    const g = geometry(1920, 1, 1, 1080, true);
    expect(l.anchor({ player: 'p0', zone: 'Command' })).toMatchObject({ x: g.X.handMax - GAP - g.ALT.clear - (g.ALT.h * CARD_ASPECT) / 2, h: g.ALT.h });
    expect(l.anchor({ player: 'p1', zone: 'Command' })).toMatchObject({ x: g.COMMAND!.opp.x, y: g.COMMAND!.opp.y });
  });
});

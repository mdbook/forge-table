import { describe, expect, it } from 'vitest';
import type { Card, GameModel, Player, PromptBody } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { AimController, type AimHost } from './controller';
import type { AimAct } from './interaction';

const card = (id: string, controller: string): Card => ({ id, controller, zone: 'Battlefield', state: { face: 'Original', name: id } });

function setup(promptBody: Partial<PromptBody> & { kind: string }) {
  const m: GameModel = modelOf(
    { turn: 2, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p1', stack: [], combat: [{ attacker: 'a1', defender: 'p0', blockers: [] }, { attacker: 'a2', defender: 'p0', blockers: [] }] },
    { p0: { id: 'p0', life: 20, zones: {} as Player['zones'] }, p1: { id: 'p1', life: 20, zones: {} as Player['zones'] } },
    Object.fromEntries([card('a1', 'p1'), card('a2', 'p1'), card('b1', 'p0'), card('b2', 'p0')].map((c) => [c.id, c])),
  );
  const prompt: PromptBody = { pid: 3, message: '', ok: { label: '', enabled: true }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {}, ...promptBody };
  // Cards at fixed table points (1 client px = 1 tu); `under` is what cardAt returns.
  const state = { prompt: prompt as PromptBody | null, live: true, under: null as string | null };
  const sent: AimAct[] = [];
  const host: AimHost = {
    model: () => m,
    viewer: () => 'p0',
    prompt: () => state.prompt,
    inputLive: () => state.live,
    send: (a) => sent.push(a),
    toTable: (x, y) => ({ x, y }),
    cardAt: () => state.under,
    visible: () => true,
    hovered: () => null,
    canvas: () => null,
  };
  return { aim: new AimController(host), sent, state };
}

const blockPrompt = { kind: 'declareBlockers', blockable: { b1: ['a1', 'a2'], b2: ['a2'] }, selectable: ['b1', 'b2'] };

describe('aim controller: blocking', () => {
  it('click a blocker, the arrow follows the cursor and snaps to a legal attacker; click it to block', () => {
    const { aim, sent, state } = setup(blockPrompt);
    expect(aim.tap('b2')).toBe(true);
    expect(aim.selected).toBe('b2');
    aim.move(300, 400);
    let f = aim.frame();
    expect(f.focus).toMatchObject({ lifted: 'b2', source: 'b2' });
    expect([...f.focus.legal]).toEqual(['a2']);
    expect([...f.focus.dim]).toEqual(['a1']);
    expect(f.arrows.find((a) => a.pending)).toMatchObject({ kind: 'block', from: { card: 'b2' }, to: { point: { x: 300, y: 400 } } });
    state.under = 'a2';
    aim.move(310, 200);
    f = aim.frame();
    expect(f.arrows.find((a) => a.pending)).toMatchObject({ to: { card: 'a2' } });
    // a1 isn't legal for b2: the arrow stays on the cursor.
    state.under = 'a1';
    expect(aim.frame().arrows.find((a) => a.pending)).toMatchObject({ to: { point: { x: 310, y: 200 } } });
    expect(aim.tap('a2')).toBe(true);
    expect(sent).toEqual([{ kind: 'block', blocker: 'b2', attacker: 'a2' }]);
    expect(aim.selected).toBeNull();
  });

  it('drag a blocker onto an attacker blocks; the tap during the drag is swallowed', () => {
    const { aim, sent, state } = setup(blockPrompt);
    aim.cardDown('b1', 100, 800);
    aim.move(103, 797);
    expect(aim.dragging).toBeNull();
    aim.move(140, 600);
    expect(aim.dragging).toBe('b1');
    expect(aim.frame().focus.lifted).toBe('b1');
    expect(aim.tap('b1')).toBe(true);
    state.under = 'a1';
    aim.release(150, 300);
    expect(sent).toEqual([{ kind: 'block', blocker: 'b1', attacker: 'a1' }]);
    expect(aim.dragging).toBeNull();
  });

  it('a drag dropped on nothing does nothing; dropped back on itself selects', () => {
    const { aim, sent, state } = setup(blockPrompt);
    aim.cardDown('b1', 100, 800);
    aim.move(200, 600);
    aim.release(200, 600);
    expect(sent).toEqual([]);
    expect(aim.selected).toBeNull();
    aim.cardDown('b1', 100, 800);
    aim.move(200, 600);
    state.under = 'b1';
    aim.release(101, 800);
    expect(aim.selected).toBe('b1');
  });

  it('a new prompt, or input going dead, drops the selection', () => {
    const { aim, state } = setup(blockPrompt);
    aim.frame();
    aim.tap('b1');
    aim.frame();
    expect(aim.selected).toBe('b1');
    state.prompt = { ...state.prompt!, pid: 4 };
    aim.frame();
    expect(aim.selected).toBeNull();
    aim.tap('b1');
    state.live = false;
    aim.frame();
    expect(aim.selected).toBeNull();
  });

  it('an older server (no blockable) gets plain card clicks', () => {
    const { aim } = setup({ kind: 'declareBlockers', selectable: ['b1'] });
    expect(aim.tap('b1')).toBe(false);
    aim.cardDown('b1', 0, 0);
    aim.move(100, 100);
    expect(aim.dragging).toBeNull();
  });
});

describe('aim controller: attacking and targeting', () => {
  it('attack clicks stay plain; a drag onto a defender sends attack', () => {
    const { aim, sent, state } = setup({ kind: 'declareAttackers', selectable: ['b1'], defenders: ['p1'] });
    expect(aim.tap('b1')).toBe(false);
    aim.cardDown('b1', 100, 800);
    aim.move(100, 700);
    expect(aim.frame().arrows.find((a) => a.pending)).toMatchObject({ kind: 'attack', from: { card: 'b1' } });
    state.under = null;
    aim.release(100, 100);
    expect(sent).toEqual([]);
    aim.cardDown('b1', 100, 800);
    aim.move(100, 700);
    state.under = 'p1';
    aim.release(100, 100);
    expect(sent).toEqual([{ kind: 'attack', attacker: 'b1', defender: 'p1' }]);
  });

  it('chooseTargets: a yellow pending arrow from the source follows the cursor, others dim', () => {
    const { aim } = setup({ kind: 'chooseTargets', card: 'b1', selectable: ['a1'] });
    expect(aim.frame().arrows.some((a) => a.pending)).toBe(false);
    aim.move(500, 500);
    const f = aim.frame();
    expect(f.arrows.find((a) => a.pending)).toMatchObject({ kind: 'target', from: { card: 'b1' }, to: { point: { x: 500, y: 500 } } });
    expect(f.focus.lifted).toBeNull();
    expect([...f.focus.dim].sort()).toEqual(['a2', 'b2']);
  });
});

describe('aim controller: protected targets (director/protection.ts)', () => {
  /** Choosing targets for p0's Lightning Bolt (red, on the stack) with a hexproof c1 and a plain c2 of p1's on the table. */
  function targeting() {
    const t = setup({ kind: 'chooseTargets', card: 's1', selectable: ['c2'] });
    const m = t.aim['host'].model();
    m.cards.s1 = { id: 's1', controller: 'p0', zone: 'Stack', state: { face: 'Original', name: 'Bolt', colors: 'R' } };
    m.cards.c1 = { id: 'c1', controller: 'p1', zone: 'Battlefield', state: { face: 'Original', name: 'c1', keywords: [{ title: 'Hexproof' }] } };
    m.cards.c2 = { id: 'c2', controller: 'p1', zone: 'Battlefield', state: { face: 'Original', name: 'c2' } };
    return t;
  }

  it('over a hexproof card that is not a legal end the arrow is turned away; over a legal one it snaps as before', () => {
    const { aim, state } = targeting();
    state.under = 'c1';
    aim.move(300, 200);
    let f = aim.frame();
    expect(f.focus.denied).toEqual({ card: 'c1', kind: 'hexproof' });
    expect(f.arrows.find((a) => a.pending)).toMatchObject({ kind: 'target', from: { card: 's1' }, to: { card: 'c1' }, deflect: true });
    state.under = 'c2';
    f = aim.frame();
    expect(f.focus.denied).toBeNull();
    expect(f.arrows.find((a) => a.pending)).toMatchObject({ to: { card: 'c2' } });
    expect(f.arrows.find((a) => a.pending)?.deflect).toBeUndefined();
  });

  it('a protected card the engine lists as legal is not denied, and bare table is not either', () => {
    const { aim, state } = targeting();
    aim['host'].prompt()!.selectable.push('c1');
    state.under = 'c1';
    aim.move(300, 200);
    expect(aim.frame().focus.denied).toBeNull();
    state.under = null;
    expect(aim.frame().focus.denied).toBeNull();
  });
});

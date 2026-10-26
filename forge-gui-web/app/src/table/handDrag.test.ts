import { describe, expect, it } from 'vitest';
import type { GameModel, Player, PromptBody } from '@forge-table/protocol';
import { geometry, worldSize } from '../layout/geometry';
import { modelOf } from '../store/model';
import {
  ARMED_SCALE,
  DRAG_LIFT,
  HOLD_MS,
  HandDragController,
  TILT_MAX,
  aboveLine,
  dropKind,
  handClick,
  playLine,
  playable,
  shakeOffset,
  stepPhysics,
  type DragPhysics,
  type HandDragHost,
} from './handDrag';

const prompt = (kind: string, extra: Partial<PromptBody> = {}): PromptBody => ({
  pid: 7,
  kind,
  message: '',
  ok: { label: 'OK', enabled: true },
  cancel: { label: '', enabled: false },
  focusOk: false,
  selectable: [],
  highlighted: [],
  weak: {},
  ...extra,
});

describe('the play line', () => {
  it('sits a quarter of a hand card above the resting hand, landscape and portrait', () => {
    const g = geometry();
    expect(playLine(g)).toBe(g.BAND.hand[0] - g.SIZE.hand / 4);
    // Above the resting fan, below my back row's bottom: a short drag up out of the hand crosses it.
    expect(playLine(g)).toBeLessThan(g.HAND.y - g.SIZE.hand / 2);
    expect(playLine(g)).toBeGreaterThan(g.BAND.myBack[0]);
    const ws = worldSize(390, 844);
    const p = geometry(ws.w, 1, 1, ws.h);
    expect(p.portrait).toBe(true);
    expect(playLine(p)).toBeLessThan(p.BAND.hand[0]);
    expect(playLine(p)).toBeGreaterThan(p.BAND.myBack[1] - p.SIZE.battlefield);
  });

  it('a card is out once its centre rises past the line, and a card picked up above it must still rise a little', () => {
    const line = 776;
    expect(aboveLine(800, 1016, line, 320)).toBe(false);
    expect(aboveLine(770, 1016, line, 320)).toBe(true);
    // A raised touch hand: picked up at 500, already above the line; it has to travel up 80 (a quarter card).
    expect(aboveLine(480, 500, line, 320)).toBe(false);
    expect(aboveLine(419, 500, line, 320)).toBe(true);
  });
});

describe('what can be played, and what a drop does', () => {
  it('playable: my priority, input live, marked by the server (weak), not a hidden card', () => {
    const p = prompt('priority', { weak: { c1: 1, c2: 0 } });
    expect(playable(p, true, 'c1')).toBe(true);
    expect(playable(p, true, 'c2')).toBe(false);
    expect(playable(p, false, 'c1')).toBe(false);
    expect(playable(prompt('selectEntities', { weak: { c1: 1 } }), true, 'c1')).toBe(false);
    expect(playable(prompt('priority', { weak: { xq: 1 } }), true, 'xq')).toBe(false);
    expect(playable(null, true, 'c1')).toBe(false);
  });

  it('above the line: play or reject; below: back into the hand', () => {
    expect(dropKind(true, true)).toBe('play');
    expect(dropKind(true, false)).toBe('reject');
    expect(dropKind(false, true)).toBe('return');
    expect(dropKind(false, false)).toBe('return');
  });
});

describe('clicks on a hand card', () => {
  const base = { touch: false, raised: false, handUp: false, focus: null, card: 'c1', playPath: true };
  it('mouse: a click picks the card up to carry it (no big preview); a choosing prompt still picks', () => {
    expect(handClick(base)).toBe('carry');
    expect(handClick({ ...base, focus: 'c2' })).toBe('carry');
    expect(handClick({ ...base, playPath: false })).toBe('select');
  });
  it('touch: raise, bring forward, then pin; never play', () => {
    const t = { ...base, touch: true };
    expect(handClick(t)).toBe('raise');
    expect(handClick({ ...t, raised: true, handUp: true, focus: 'c2' })).toBe('focus');
    expect(handClick({ ...t, raised: true, handUp: true, focus: 'c1' })).toBe('pin');
    // Mulligan raises the hand without handUp: a tap there picks.
    expect(handClick({ ...t, raised: true, playPath: false })).toBe('select');
  });
});

describe('drag physics', () => {
  const p0: DragPhysics = { x: 0, t: 0, vx: 0, rot: 0, h: 320, lift: 6 };
  const run = (p: DragPhysics, xs: number[], dt = 16, target = 400, calm = false) => xs.reduce((q, x) => stepPhysics(q, x, q.t + dt, target, calm), p);

  it('leans into the motion, clamped, and springs back upright when the pointer rests', () => {
    const right = run(p0, [10, 20, 30, 40, 50, 60]);
    expect(right.rot).toBeGreaterThan(0);
    const left = run(p0, [-10, -20, -30, -40]);
    expect(left.rot).toBeLessThan(0);
    const flick = run(p0, Array.from({ length: 30 }, (_, i) => (i + 1) * 120));
    expect(flick.rot).toBeLessThanOrEqual(TILT_MAX + 1e-9);
    expect(flick.rot).toBeGreaterThan(TILT_MAX * 0.9);
    const rested = run(flick, Array.from({ length: 40 }, () => flick.x));
    expect(Math.abs(rested.rot)).toBeLessThan(0.01);
  });

  it('grows to its drag size and lifts (deep shadow); reduced motion jumps there with no lean', () => {
    const grown = run(p0, Array.from({ length: 30 }, () => 0));
    expect(grown.h).toBeCloseTo(400, 0);
    expect(grown.lift).toBeCloseTo(DRAG_LIFT, 0);
    const calm = run(p0, [100, 300, 900], 16, 400, true);
    expect(calm).toMatchObject({ rot: 0, h: 400, lift: DRAG_LIFT });
  });

  it('the reject shake is small, firm and ends where it started', () => {
    for (let q = 0; q <= 1; q += 0.05) expect(Math.abs(shakeOffset(q, 14))).toBeLessThanOrEqual(14);
    expect(shakeOffset(0, 14)).toBe(0);
    expect(shakeOffset(1, 14)).toBeCloseTo(0, 9);
  });
});

/** My hand h1 h2 h3 at x 100 / 200 / 300, drawn at y 1000 (1 client px = 1 tu); landscape geometry (line 776). */
function setup(p: PromptBody | null = prompt('priority', { weak: { h1: 1 } })) {
  let hand = ['h1', 'h2', 'h3'];
  const model = (): GameModel =>
    modelOf({ turn: 2, phase: 'MAIN1', playerTurn: 'p0', stack: [] }, { p0: { id: 'p0', life: 20, zones: { hand } as Player['zones'] }, p1: { id: 'p1', life: 20, zones: {} as Player['zones'] } }, {});
  const xs: Record<string, number> = { h1: 100, h2: 200, h3: 300, a1: 1500 };
  const s = { now: 0, order: [] as string[], played: [] as string[], lifted: [] as string[], blocked: false };
  const host: HandDragHost = {
    model,
    viewer: () => 'p0',
    prompt: () => p,
    inputLive: () => !!p,
    toTable: (x, y) => ({ x, y }),
    spritePose: (id) => (xs[id] !== undefined ? { x: xs[id]!, y: 1000, h: 320, rot: 0.05, lift: 6 } : null),
    geo: () => geometry(),
    handX: () => (s.order.length ? s.order : hand).map((id) => ({ id, x: xs[id]! })),
    altIds: () => ['a1'],
    onHandOrder: (o) => (s.order = o),
    calm: () => false,
    now: () => s.now,
    onLift: (id) => s.lifted.push(id),
    play: (id) => s.played.push(id),
    blocked: () => s.blocked,
  };
  const leave = (id: string) => (hand = hand.filter((c) => c !== id));
  return { drag: new HandDragController(host), s, leave };
}

describe('hand drag controller', () => {
  it('a press that stays under the threshold is a tap, not a drag', () => {
    const { drag, s } = setup();
    drag.cardDown('h1', 100, 1000);
    drag.move(104, 997);
    expect(drag.dragging).toBeNull();
    drag.release(104, 997);
    expect(drag.takeDrops()).toEqual([]);
    expect(s.played).toEqual([]);
    expect(s.lifted).toEqual([]);
    // Only my hand's cards are dragged.
    drag.cardDown('b1', 100, 600);
    drag.move(100, 400);
    expect(drag.dragging).toBeNull();
  });

  it('dragged sideways in the hand, it reorders and drops back (no act)', () => {
    const { drag, s } = setup();
    drag.cardDown('h1', 100, 1000);
    drag.move(250, 1000);
    expect(drag.dragging).toBe('h1');
    expect(s.lifted).toEqual(['h1']);
    expect(s.order).toEqual(['h2', 'h1', 'h3']);
    drag.move(350, 1000);
    expect(s.order).toEqual(['h2', 'h3', 'h1']);
    expect(drag.frame()).toMatchObject({ id: 'h1', cue: 'none', out: false });
    drag.release(350, 1000);
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    expect(s.played).toEqual([]);
  });

  it('follows the pointer 1:1 from where it was grabbed, and a playable card over the line is released to play', () => {
    const { drag, s, leave } = setup();
    drag.cardDown('h1', 110, 1020);
    drag.move(110, 1010);
    // Grabbed 10 right of its centre and 20 below it: it moves with the pointer from there.
    let v = drag.frame()!;
    expect(v.x).toBeCloseTo(100, 0);
    expect(v.y - v.lift * 0.35).toBeCloseTo(990, 0);
    drag.move(140, 700);
    s.now = 16;
    v = drag.frame()!;
    expect(v).toMatchObject({ cue: 'play', out: true });
    // The grab point stays under the pointer as the card grows (offset scales with the height).
    const k = v.h / 320;
    expect(v.x).toBeCloseTo(140 - 10 * k, 5);
    expect(v.y - v.lift * 0.35).toBeCloseTo(700 - 20 * k, 5);
    for (let i = 0; i < 40; i++) {
      s.now += 16;
      v = drag.frame()!;
    }
    expect(v.h).toBeCloseTo(320 * 1.25 * ARMED_SCALE, 0);
    drag.release(140, 700);
    expect(s.played).toEqual(['h1']);
    expect(drag.dragging).toBeNull();
    // Held where it was dropped, out of the fan, until its flight picks it up (it leaves my hand).
    expect(drag.frame()).toMatchObject({ id: 'h1', cue: 'held', out: true, x: v.x, y: v.y });
    expect(drag.takeDrops()).toEqual([]);
    leave('h1');
    expect(drag.frame()).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'gone' }]);
  });

  it('a held card that nothing comes of goes back to its old place (timeout, or an ask covers the table)', () => {
    const { drag, s } = setup();
    drag.cardDown('h1', 100, 1000);
    drag.move(100, 600);
    drag.frame();
    drag.release(100, 600);
    expect(s.order).toEqual(['h2', 'h3', 'h1']);
    s.now = HOLD_MS - 1;
    expect(drag.frame()?.cue).toBe('held');
    s.now = HOLD_MS + 1;
    expect(drag.frame()).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    expect(s.order).toEqual(['h1', 'h2', 'h3']);

    const b = setup();
    b.drag.cardDown('h1', 100, 1000);
    b.drag.move(100, 600);
    b.drag.release(100, 600);
    b.s.blocked = true;
    expect(b.drag.frame()).toBeNull();
    expect(b.drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
  });

  it('a card that cannot be played shows muted over the table and is shaken back to its place; nothing is sent', () => {
    const { drag, s } = setup();
    drag.cardDown('h2', 200, 1000);
    drag.move(200, 600);
    expect(drag.frame()).toMatchObject({ id: 'h2', cue: 'cant', out: true });
    drag.release(200, 600);
    expect(s.played).toEqual([]);
    expect(s.order).toEqual(['h1', 'h2', 'h3']);
    expect(drag.takeDrops()).toEqual([{ id: 'h2', kind: 'reject' }]);
    // Not my priority (a discard choice): nothing is playable.
    const d = setup(prompt('selectEntities', { weak: { h1: 1 }, selectable: ['h1'] }));
    d.drag.cardDown('h1', 100, 1000);
    d.drag.move(100, 600);
    expect(d.drag.frame()?.cue).toBe('cant');
  });

  it('a castable card from the alt-zone strip drags and plays like a hand card, and never touches the hand order', () => {
    const { drag, s } = setup(prompt('priority', { weak: { a1: 1 } }));
    drag.cardDown('a1', 1500, 1000);
    drag.move(1400, 1000); // sideways: no reorder of the hand
    expect(drag.dragging).toBe('a1');
    expect(s.order).toEqual([]);
    drag.move(1400, 600);
    expect(drag.frame()).toMatchObject({ id: 'a1', cue: 'play', out: true });
    expect(s.order).toEqual([]);
    drag.release(1400, 600);
    expect(s.played).toEqual(['a1']);
    expect(drag.frame()).toMatchObject({ id: 'a1', cue: 'held' });
    // The strip still lists it (the server hasn't answered): after the hold it goes back, the hand untouched.
    s.now = HOLD_MS + 1;
    expect(drag.frame()).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'a1', kind: 'return' }]);
    expect(s.order).toEqual([]);
    // A click carries it (mouse), and the next click above the line plays.
    const c = setup(prompt('priority', { weak: { a1: 1 } }));
    c.drag.cardDown('a1', 1500, 1000);
    c.drag.pickUp('a1');
    expect(c.drag.carrying).toBe('a1');
  });

  it('dragged up and back down into the hand, it drops back (no act); a lost pointer drops it back too', () => {
    const { drag, s } = setup();
    drag.cardDown('h1', 100, 1000);
    drag.move(100, 600);
    drag.move(320, 1000);
    expect(drag.frame()).toMatchObject({ cue: 'none', out: false });
    expect(s.order).toEqual(['h2', 'h3', 'h1']);
    drag.release(320, 1000);
    expect(s.played).toEqual([]);
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    drag.cardDown('h3', 300, 1000);
    drag.move(300, 700);
    drag.cancel();
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h3', kind: 'return' }]);
  });

});

/** Fakes the window a controller attaches to: dispatch pointer / key events straight to its listeners. */
function fakeWindow() {
  const ls = new Map<string, ((e: any) => void)[]>();
  const win = {
    addEventListener: (t: string, f: (e: any) => void) => ls.set(t, [...(ls.get(t) ?? []), f]),
    removeEventListener: (t: string, f: (e: any) => void) => ls.set(t, (ls.get(t) ?? []).filter((g) => g !== f)),
  } as unknown as Window;
  const fire = (t: string, e: Record<string, unknown> = {}) => {
    const ev = { stopped: false, prevented: false, preventDefault() { ev.prevented = true; }, stopImmediatePropagation() { ev.stopped = true; }, target: null, button: 0, ...e };
    for (const f of ls.get(t) ?? []) f(ev);
    return ev;
  };
  return { win, fire };
}

describe('click to carry (mouse: a click picks a hand card up, the next click lets go)', () => {
  /** A click on a hand card the way the browser and Pixi deliver it: down on the sprite, Pixi's tap, then the window's up. */
  const click = (drag: HandDragController, id: string | null, x: number, y: number, tap?: () => void) => {
    if (id) drag.cardDown(id, x, y);
    tap?.();
    drag.release(x, y);
  };

  it('picks the card up without a button held: it rides the pointer, lifted, and a click over the line plays it', () => {
    const { drag, s, leave } = setup();
    click(drag, 'h1', 110, 1020, () => drag.pickUp('h1'));
    // Still carried after its own button-up, lifted (previews go away) and grabbed where the click was.
    expect(drag.dragging).toBe('h1');
    expect(drag.carrying).toBe('h1');
    expect(s.lifted).toEqual(['h1']);
    const v = drag.frame()!;
    expect(v).toMatchObject({ id: 'h1', cue: 'none', out: false });
    expect(v.x).toBeCloseTo(100, 0);
    // Moving with no button: it follows, and over the line it is armed like a drag.
    drag.move(140, 700);
    s.now = 16;
    expect(drag.frame()).toMatchObject({ cue: 'play', out: true });
    expect(s.played).toEqual([]);
    // The next click lets go: played, held where it was let go until its flight takes it.
    click(drag, 'h1', 140, 700);
    expect(s.played).toEqual(['h1']);
    expect(drag.dragging).toBeNull();
    expect(drag.frame()).toMatchObject({ id: 'h1', cue: 'held' });
    leave('h1');
    expect(drag.frame()).toBeNull();
  });

  it('let go below the line it goes back to the hand (reordered where it was put); an unplayable one is shaken back', () => {
    const { drag, s } = setup();
    click(drag, 'h1', 100, 1000, () => drag.pickUp('h1'));
    drag.move(350, 1000);
    expect(s.order).toEqual(['h2', 'h3', 'h1']);
    click(drag, null, 350, 1000);
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    expect(s.played).toEqual([]);
    // Two clicks in place (what was a double-click): picked up and put straight back, nothing sent.
    click(drag, 'h3', 300, 1000, () => drag.pickUp('h3'));
    click(drag, 'h3', 300, 1000);
    expect(drag.takeDrops()).toEqual([{ id: 'h3', kind: 'return' }]);
    expect(s.played).toEqual([]);
    // h2 is not playable: over the table it is muted, let go it shakes back.
    click(drag, 'h2', 200, 1000, () => drag.pickUp('h2'));
    drag.move(200, 600);
    expect(drag.frame()?.cue).toBe('cant');
    click(drag, null, 200, 600);
    expect(drag.takeDrops()).toEqual([{ id: 'h2', kind: 'reject' }]);
    expect(s.played).toEqual([]);
  });

  it('works whichever comes first, the tap or the button-up; a press on another card while carrying is not a new drag', () => {
    const { drag } = setup();
    // The button-up first, then the tap: carried from the last pointer position.
    drag.cardDown('h1', 100, 1000);
    drag.release(100, 1000);
    drag.pickUp('h1');
    expect(drag.carrying).toBe('h1');
    drag.move(100, 990);
    expect(drag.carrying).toBe('h1');
    drag.cardDown('h2', 200, 1000);
    drag.move(260, 1000);
    expect(drag.dragging).toBe('h1');
    drag.release(260, 1000);
    expect(drag.dragging).toBeNull();
    // Only my hand's cards, and never while one is carried or held.
    drag.pickUp('b1');
    expect(drag.dragging).toBeNull();
  });

  it('Esc, a right-click, a click on the HUD or losing the window put it back; the right-click is no snooze', () => {
    const { drag, s } = setup();
    const { win, fire } = fakeWindow();
    drag.attach(win);
    click(drag, 'h1', 100, 1000, () => drag.pickUp('h1'));
    drag.move(100, 600);
    const esc = fire('keydown', { key: 'Escape' });
    expect(esc.stopped && esc.prevented).toBe(true);
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    // Esc with nothing carried is the table's.
    expect(fire('keydown', { key: 'Escape' }).stopped).toBe(false);

    click(drag, 'h1', 100, 1000, () => drag.pickUp('h1'));
    fire('pointerdown', { button: 2 });
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);
    expect(drag.swallowSnooze()).toBe(true);
    expect(drag.swallowSnooze()).toBe(false);
    fire('pointerdown', { button: 2 });
    expect(drag.swallowSnooze()).toBe(false);

    // A click on the table's canvas lets go as usual (release); one on a HUD control just puts it back.
    click(drag, 'h1', 100, 1000, () => drag.pickUp('h1'));
    fire('pointerdown', { button: 0, target: { tagName: 'CANVAS' } });
    expect(drag.carrying).toBe('h1');
    fire('pointerdown', { button: 0, target: { tagName: 'BUTTON' } });
    expect(drag.dragging).toBeNull();
    expect(drag.takeDrops()).toEqual([{ id: 'h1', kind: 'return' }]);

    click(drag, 'h1', 100, 1000, () => drag.pickUp('h1'));
    fire('blur');
    expect(drag.dragging).toBeNull();
    expect(s.played).toEqual([]);
    drag.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import type { BeatMsg, Card, PromptMsg, SnapshotMsg } from '@forge-table/protocol';
import { VirtualClock } from '../util/clock';
import { DUR, beatCosts, choreograph, combatSteps, lethalHit, nominalLead, shakeFor, stackThud, timelineFor } from './choreography';
import { COLLAPSE_OVER_MS, COMPRESS_OVER_MS, COMPRESS_TARGET_MS, Director, IMPACT_PACE } from './director';

const card = (id: string, zone: string, extra: Partial<Card> = {}): Card => ({ id, zone, controller: 'p0', state: { face: 'Original', name: id }, ...extra });

function snapshot(seq = 0): SnapshotMsg {
  return {
    t: 'snapshot',
    seq,
    viewer: 'p0',
    game: { turn: 1, phase: 'MAIN1', playerTurn: 'p0', stack: [] },
    players: { p0: { id: 'p0', life: 20, zones: { library: ['xa', 'xb'] } }, p1: { id: 'p1', life: 20, zones: {} } },
    cards: {},
    asks: [],
    stops: { p0: ['MAIN1'] },
  };
}

let seq = 0;
const draw = (id: string): BeatMsg => ({
  t: 'beat',
  seq: ++seq,
  kind: 'draw',
  card: id,
  from: { player: 'p0', zone: 'Library' },
  to: { player: 'p0', zone: 'Hand' },
  patch: { cards: { [id]: card(id, 'Hand') } },
});
const tap = (id: string): BeatMsg => ({ t: 'beat', seq: ++seq, kind: 'tap', card: id, tapped: true, patch: { cards: { [id]: card(id, 'Battlefield', { tapped: true }) } } });
const phase = (): BeatMsg => ({ t: 'beat', seq: ++seq, kind: 'phase', patch: { game: { turn: 1, phase: 'MAIN2', playerTurn: 'p0', stack: [] } } });
const prompt = (kind = 'priority'): PromptMsg => ({
  t: 'prompt',
  seq: ++seq,
  pid: seq,
  kind,
  message: '',
  ok: { label: 'OK', enabled: true },
  cancel: { label: 'End Turn', enabled: true },
  focusOk: true,
  selectable: [],
  highlighted: [],
  weak: {},
});

function setup(speed = 1) {
  seq = 0;
  const clock = new VirtualClock(1000);
  const d = new Director({ clock, speed });
  d.snapshot(snapshot());
  const step = (ms: number, frame = 16) => {
    for (let t = 0; t < ms; t += frame) {
      clock.advance(Math.min(frame, ms - t));
      d.update();
    }
  };
  return { clock, d, step };
}

describe('Director: two stores', () => {
  it('applies patches to `received` at once and to `shown` at the playhead', () => {
    const { d, step } = setup();
    d.receive(draw('c1'));
    d.receive(draw('c2'));
    expect(d.received.cards.c1).toBeDefined();
    expect(d.received.cards.c2).toBeDefined();
    expect(d.shown.cards.c1).toBeUndefined();
    d.update();
    expect(d.shown.cards.c1).toBeDefined(); // draw applies its patch at t=0…
    expect(d.shown.cards.c2).toBeUndefined(); // …and the next waits for its lead (draws in a row: the stagger)
    step(DUR.drawStagger - 20);
    expect(d.shown.cards.c2).toBeUndefined();
    step(40);
    expect(d.shown.cards.c2).toBeDefined();
  });

  it('plays beats strictly in seq order and reports playedSeq once each has finished', () => {
    const { d, step } = setup();
    const a = draw('c1');
    const b = phase();
    const c = draw('c2');
    d.receive(a);
    d.receive(b);
    d.receive(c);
    d.update();
    expect(d.playedSeq).toBe(0);
    step(DUR.draw + 16);
    expect(d.playedSeq).toBe(b.seq); // draw finished, the instant phase beat with it; c still running
    step(DUR.draw + 16);
    expect(d.playedSeq).toBe(c.seq);
    expect(d.busy).toBe(false);
  });

  it('gates a prompt until the playhead reaches its seq', () => {
    const { d, step } = setup();
    d.receive(draw('c1'));
    d.receive(draw('c2'));
    const p = prompt('priority');
    d.receive(p);
    d.update();
    expect(d.prompt).toBeNull();
    step(DUR.draw);
    expect(d.prompt).toBeNull();
    step(DUR.draw + 16);
    expect(d.prompt?.pid).toBe(p.pid);
  });

  it('publishes zone reveals and legal choices together, after their settled zone contents', () => {
    const { d, step } = setup();
    const old = prompt();
    old.selectable = ['c1'];
    old.zones = [];
    d.receive(old);
    d.update();
    d.receive(draw('c1'));
    d.receive(draw('c2'));
    d.receive({ t: 'settle', seq: ++seq, patch: {
      players: { p0: { id: 'p0', life: 20, zones: { graveyard: ['c1', 'c2'] } } },
      cards: { c1: card('c1', 'Graveyard'), c2: card('c2', 'Graveyard') },
    } });
    const choice = prompt('chooseTargets');
    choice.selectable = ['c2'];
    choice.zones = [{ player: 'p0', zone: 'Graveyard' }];
    d.receive(choice);
    d.update();
    expect(d.prompt?.zones).toEqual([]); // no early reveal using old.selectable
    step(DUR.draw * 2 + 32);
    expect(d.prompt?.zones).toEqual(choice.zones);
    expect(d.prompt?.selectable).toEqual(['c2']);
    expect(d.shown.players.p0?.zones.graveyard).toEqual(['c1', 'c2']);
    // A reconnect includes the reveal in its prompt, without needing a transient notice.
    d.snapshot({ ...snapshot(d.lastSeq), prompt: choice });
    expect(d.prompt?.zones).toEqual(choice.zones);
  });

  it('staggers consecutive taps by 40 ms instead of 180 ms each', () => {
    const { d, step } = setup();
    for (const id of ['c1', 'c2', 'c3']) d.receive(tap(id));
    d.update();
    step(48);
    expect(d.shown.cards.c2?.tapped).toBe(true);
    step(40);
    expect(d.shown.cards.c3?.tapped).toBe(true);
  });

  it('scales every duration by 1/speed, and Instant plays everything at once', () => {
    const fast = setup(2);
    fast.d.receive(draw('c1'));
    fast.d.receive(draw('c2'));
    fast.d.update();
    fast.step(DUR.draw / 2 + 16);
    expect(fast.d.shown.cards.c2).toBeDefined();

    const instant = setup(0);
    instant.d.receive(draw('c1'));
    instant.d.receive(draw('c2'));
    instant.d.receive(prompt());
    instant.d.update();
    expect(instant.d.shown.cards.c2).toBeDefined();
    expect(instant.d.prompt).not.toBeNull();
    expect(instant.d.busy).toBe(false);
  });
});

describe('Director: catch-up', () => {
  it('time-compresses a backlog over 3 s so it plays in ~1.5 s', () => {
    const { d, clock, step } = setup();
    const n = 10; // 10 draws = 4.2 s of play
    for (let i = 0; i < n; i++) d.receive(draw(`c${i}`));
    const backlog = d.backlogMs();
    expect(backlog).toBe(n * DUR.draw);
    expect(backlog).toBeGreaterThan(COMPRESS_OVER_MS);
    const t0 = clock.now();
    d.update();
    expect(d.timeCompression).toBeCloseTo(backlog / COMPRESS_TARGET_MS, 5);
    while (d.busy) step(16);
    // Compression is re-evaluated as each beat starts; the whole backlog plays far faster than 4.2 s.
    expect(clock.now() - t0).toBeLessThan(2 * COMPRESS_TARGET_MS);
  });

  it('does not compress a small backlog', () => {
    const { d } = setup();
    d.receive(draw('c1'));
    d.receive(draw('c2'));
    d.update();
    expect(d.timeCompression).toBe(1);
  });

  it('collapses a backlog over 10 s: everything applies at once and a crossfade starts', () => {
    const { d, clock } = setup();
    const count = Math.ceil(COLLAPSE_OVER_MS / DUR.draw) + 1;
    for (let i = 0; i < count; i++) d.receive(draw(`c${i}`));
    const p = prompt();
    d.receive(p);
    d.update();
    expect(d.busy).toBe(false);
    expect(Object.keys(d.shown.cards)).toHaveLength(count);
    expect(d.prompt?.pid).toBe(p.pid);
    expect(d.playedSeq).toBe(p.seq);
    expect(d.collapsedAt).toBe(clock.now());
  });

  it('Skip collapses immediately', () => {
    const { d } = setup();
    d.receive(draw('c1'));
    d.receive(draw('c2'));
    d.update();
    d.collapse();
    expect(d.shown.cards.c2).toBeDefined();
    expect(d.tracks).toHaveLength(0);
  });

  it('a snapshot replaces both stores and everything gated', () => {
    const { d } = setup();
    d.receive(draw('c1'));
    d.receive(prompt());
    const s = snapshot(50);
    s.cards = { c7: card('c7', 'Hand') };
    d.snapshot(s);
    expect(d.shown.cards).toEqual({ c7: card('c7', 'Hand') });
    expect(d.received).toBe(d.shown);
    expect(d.busy).toBe(false);
    expect(d.playedSeq).toBe(50);
  });
});

describe('choreography', () => {
  it('declares beatCosts equal to what it plays at 1x', () => {
    const costs = beatCosts();
    for (const kind of ['draw', 'toStack', 'etb', 'dies', 'discard', 'mill', 'exile', 'bounce', 'tap', 'untap', 'life', 'damage', 'token']) {
      const beat: BeatMsg = { t: 'beat', seq: 1, kind, card: 'c1', player: 'p0', oldLives: 20, newLives: 18, target: 'p0', amount: 2 };
      expect(costs[kind], kind).toBe(choreograph(beat, { reducedMotion: false }).lead);
      expect(costs[kind], kind).toBe(nominalLead(kind));
    }
    expect(costs.cast).toBe(0);
    expect(costs.turn).toBe(0);
  });

  it('uses the plan durations (draw 420, flight 300, etb 360 with settle, tap 180, life roll 400)', () => {
    const tl = (kind: string, extra: Partial<BeatMsg> = {}) => choreograph({ t: 'beat', seq: 1, kind, card: 'c1', ...extra }, { reducedMotion: false });
    expect(tl('draw').duration).toBe(420);
    expect(tl('toStack').duration).toBe(300);
    expect(tl('etb').tracks[0]).toMatchObject({ type: 'flight', settle: true, dur: 360 });
    expect(tl('tap').tracks[0]).toMatchObject({ type: 'retarget', dur: 180, overshoot: true });
    expect(tl('life', { player: 'p0', oldLives: 20, newLives: 17 }).tracks[0]).toMatchObject({ type: 'roll', from: 20, to: 17, dur: 400 });
    // A player's damage shows as the life chip of the life beat that follows (no pop, no wait); infect keeps its pop.
    expect(tl('damage', { card: undefined, target: 'p1', amount: 3 })).toMatchObject({ tracks: [], lead: 0 });
    expect(tl('damage', { card: undefined, target: 'p1', amount: 3, infect: true }).tracks[0]).toMatchObject({ type: 'pop', player: 'p1', text: '-3' });
    expect(tl('turn').duration).toBe(0);
  });

  it('has reduced-motion variants: crossfades and snaps, same pacing', () => {
    const r = choreograph({ t: 'beat', seq: 1, kind: 'draw', card: 'c1' }, { reducedMotion: true });
    expect(r.tracks[0]).toMatchObject({ crossfade: true });
    expect(r.lead).toBe(DUR.draw);
    const t = choreograph({ t: 'beat', seq: 1, kind: 'tap', card: 'c1' }, { reducedMotion: true });
    expect(t.tracks[0]).toMatchObject({ dur: 0 });
  });

  it('a click through a presented spell lets the next step start at once (release), and only for that beat', () => {
    const { d, step } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'toStack', from: { player: 'p1', zone: 'Hand' }, to: { zone: 'Stack' } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'cast', patch: { cards: { c9: card('c9', 'Stack', { controller: 'p1' }) } } });
    const cast = seq;
    d.receive({ t: 'beat', seq: ++seq, kind: 'tap', card: 'c1' });
    step(200);
    const tapped = () => d.tracks.some((t) => t.type === 'retarget' && t.card === 'c1');
    expect(tapped()).toBe(false);
    d.release(cast - 1);
    step(16);
    expect(tapped()).toBe(false);
    d.release(cast);
    step(16);
    expect(tapped()).toBe(true);
  });

  it('infers the hand → stack flight on the cast beat when toStack could not name its card', () => {
    const { d } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'toStack', from: { player: 'p1', zone: 'Hand' }, to: { zone: 'Stack' } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'cast', patch: { cards: { c9: card('c9', 'Stack', { controller: 'p1' }) } } });
    d.update();
    const flight = d.tracks.find((t) => t.type === 'flight');
    // The opponent's spell is presented big in the centre on its way (animation overhaul).
    expect(flight).toMatchObject({ card: 'c9', from: { player: 'p1', zone: 'Hand' }, dur: DUR.present, present: true });
  });

  it('my own spell flies straight to the stack', () => {
    const { d } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'toStack', from: { player: 'p0', zone: 'Hand' }, to: { zone: 'Stack' } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'cast', patch: { cards: { c9: card('c9', 'Stack') } } });
    d.update();
    const flight = d.tracks.find((t) => t.type === 'flight');
    expect(flight).toMatchObject({ card: 'c9', dur: DUR.toStack });
    expect(flight).not.toHaveProperty('present');
  });

  it('rolls the displayed life total during a life beat', () => {
    const { d, step } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'life', player: 'p0', oldLives: 20, newLives: 16, patch: { players: { p0: { id: 'p0', life: 16, zones: {} } } } });
    d.update();
    expect(d.displayLife('p0')).toBe(20);
    // A life beat is impactful: it plays at IMPACT_PACE.
    step(200 / IMPACT_PACE);
    expect(d.displayLife('p0')).toBe(18);
    step(240 / IMPACT_PACE);
    expect(d.displayLife('p0')).toBe(16);
  });
});

describe('leaving a match (the next match hung)', () => {
  it("plays the next match's steps although its seq starts again at 1", () => {
    const { d, step } = setup();
    for (let i = 0; i < 20; i++) d.receive(phase());
    step(5000);
    expect(d.playedSeq).toBe(20);
    d.reset();
    d.receive(phase()); // the left match's tail
    seq = 0;
    d.snapshot(snapshot(2));
    step(100); // a frame between the snapshot and the next step
    seq = 2;
    d.receive(prompt());
    step(100);
    expect(d.prompt?.pid).toBe(3);
  });

  // A Rematch that re-rolls a random seat's deck opens a brand-new bridge
  // TableSession (a fresh seq space, starting at 1 again), the same situation as leaving a match above, but
  // nextGame('NEW') (Rematch) called director.reset() nowhere -- only QUIT did. Without it, the stale high
  // lastSeq from the game just finished survives, an idle frame's retire() re-bases playedSeq up to it, and
  // the new game's first prompt (a low seq) is then dropped as "already played": the mulligan screen never
  // advances. (runtime.ts's nextGame() now calls reset() for 'NEW' too, same as 'QUIT'.)
  it("without a reset, a rematch's new table session hangs on a stale high seq", () => {
    const { d, step } = setup();
    for (let i = 0; i < 500; i++) d.receive(phase());
    step(20000);
    expect(d.playedSeq).toBe(500);
    // Broken: the new session's snapshot arrives with no reset() first (what nextGame('NEW') did before the fix).
    seq = 0;
    d.snapshot(snapshot(1));
    step(100); // idle frame: retire() re-bases playedSeq to the still-stale lastSeq (500)
    seq = 1;
    d.receive(prompt()); // the new game's own mulligan prompt, seq 2
    step(100);
    expect(d.prompt).toBeNull(); // dropped: seq(2) <= the stale playedSeq(500)
  });

  it("with a reset first, a rematch's new table session plays its first prompt (the fix)", () => {
    const { d, step } = setup();
    for (let i = 0; i < 500; i++) d.receive(phase());
    step(20000);
    expect(d.playedSeq).toBe(500);
    d.reset();
    seq = 0;
    d.snapshot(snapshot(1));
    step(100);
    seq = 1;
    d.receive(prompt());
    step(100);
    expect(d.prompt?.pid).toBe(2);
  });
});

describe('pace by action (animation timing)', () => {
  const oppTap = (): BeatMsg => ({ t: 'beat', seq: ++seq, kind: 'tap', card: 'o1', tapped: true, patch: { cards: { o1: { ...card('o1', 'Battlefield', { tapped: true }), controller: 'p1' } } } });
  const hitMe = (): BeatMsg => ({ t: 'beat', seq: ++seq, kind: 'damage', card: 'm1', amount: 3 });
  it('plays routine steps 3x while the table plays itself, but never what concerns me', () => {
    const { d, step } = setup();
    d.fast = true;
    d.receive(oppTap());
    step(DUR.tap / 1.2 / 3 + 20);
    expect(d.playedSeq).toBe(1);
    d.receive(hitMe());
    step(DUR.damageLead);
    expect(d.playedSeq).toBe(1); // damage is impactful: it holds longer than its 1x length
    step(DUR.damagePop / IMPACT_PACE);
    expect(d.playedSeq).toBe(2);
  });
  it('untaps a little quicker even at normal pace', () => {
    const { d, step } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'untap', card: 'o1', tapped: false });
    step(DUR.tap / 1.5 + 20);
    expect(d.playedSeq).toBe(1);
  });
});

describe('feel (shake scaled by damage, flash when I am hit)', () => {
  it('shakes harder the more damage; a creature takes half; a kill is always big', () => {
    expect(shakeFor(0, true, false)).toBe(0);
    const player = [1, 3, 5, 8, 10, 20].map((n) => shakeFor(n, true, false));
    for (let i = 1; i < player.length; i++) expect(player[i]).toBeGreaterThanOrEqual(player[i - 1]!);
    expect(player[0]).toBeGreaterThan(0);
    expect(player[4]).toBeCloseTo(1, 1);
    expect(player[5]).toBe(1);
    expect(shakeFor(4, false, false)).toBeCloseTo(shakeFor(4, true, false) / 2);
    expect(shakeFor(1, false, false)).toBe(0); // a 1-point creature hit shakes nothing
    expect(shakeFor(1, true, true)).toBe(1);
    expect(shakeFor(1, false, true)).toBeCloseTo(0.55);
  });

  it('an opponent’s spell lands on the stack with a light thud, harder the more it costs (batch 11)', () => {
    const thuds = [0, 1, 3, 5, 7, 12].map(stackThud);
    for (let i = 1; i < thuds.length; i++) expect(thuds[i]).toBeGreaterThanOrEqual(thuds[i - 1]!);
    expect(stackThud(1)).toBeCloseTo(0.2, 2);
    expect(stackThud(7)).toBeCloseTo(0.4, 1);
    expect(stackThud(20)).toBe(0.4);
    // Lighter than a 10-damage hit, in the range of a big creature landing (0.3).
    expect(stackThud(20)).toBeLessThan(shakeFor(10, true, false));
  });

  it('shakes at the hit and flashes when it is me; lethal marks the killing blow', () => {
    const { d, step } = setup();
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', target: 'p1', amount: 4 });
    step(20);
    expect(d.shake?.mag).toBeCloseTo(shakeFor(4, true, false));
    expect(d.hurtAt).toBe(-Infinity);
    expect(d.lethal).toBeNull();
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', target: 'p0', amount: 20 });
    step(20);
    expect(d.shake).toMatchObject({ mag: 1, lethal: true });
    expect(d.hurtAt).toBeGreaterThan(0);
    expect(d.lethal).toMatchObject({ player: 'p0' });
  });
});

describe('lethal hits (a distinct killing blow)', () => {
  const model = (cards: Record<string, Card>, life = 20) => ({ ...modelOfSnap(), players: { p0: { id: 'p0', life, zones: {} }, p1: { id: 'p1', life, zones: {} } }, cards });
  const modelOfSnap = () => ({ game: { turn: 1, phase: 'MAIN1', playerTurn: 'p0', stack: [] }, players: {}, cards: {} });
  const bear = (extra: Partial<Card> = {}, keywords: string[] = []) =>
    card('b1', 'Battlefield', { state: { face: 'Original', name: 'b1', power: 2, toughness: 2, keywords: keywords.map((title) => ({ title })) }, ...extra });
  const hit = (amount: number, extra: Partial<BeatMsg> = {}): BeatMsg => ({ t: 'beat', seq: 1, kind: 'damage', card: 'b1', source: 'a1', amount, ...extra });
  it('kills a creature at its toughness (marked damage counts), any hit from deathtouch; not indestructible', () => {
    const m = (b: Card, src?: Card) => model({ b1: b, ...(src ? { a1: src } : {}) }) as unknown as Parameters<typeof lethalHit>[1];
    expect(lethalHit(hit(1), m(bear()))).toBeNull();
    expect(lethalHit(hit(2), m(bear()))).toBe('creature');
    expect(lethalHit(hit(1), m(bear({ damage: 1 })))).toBe('creature');
    expect(lethalHit(hit(5), m(bear({}, ['Indestructible'])))).toBeNull();
    expect(lethalHit(hit(1), m(bear(), card('a1', 'Battlefield', { state: { face: 'Original', keywords: [{ title: 'Deathtouch' }] } })))).toBe('creature');
  });
  it('kills a player whose life it takes to 0; infect never', () => {
    const m = model({}, 3) as unknown as Parameters<typeof lethalHit>[1];
    expect(lethalHit({ t: 'beat', seq: 1, kind: 'damage', target: 'p1', amount: 2 }, m)).toBeNull();
    expect(lethalHit({ t: 'beat', seq: 1, kind: 'damage', target: 'p1', amount: 3 }, m)).toBe('player');
    expect(lethalHit({ t: 'beat', seq: 1, kind: 'damage', target: 'p1', amount: 3, infect: true }, m)).toBeNull();
  });
});

describe('hit-stop (MTGA juice)', () => {
  const before = (toughness: number) =>
    ({ game: { turn: 1, phase: 'COMBAT_DAMAGE', playerTurn: 'p0', stack: [] }, players: { p0: { id: 'p0', life: 20, zones: {} }, p1: { id: 'p1', life: 20, zones: {} } }, cards: { a1: card('a1', 'Battlefield'), b1: card('b1', 'Battlefield', { controller: 'p1', state: { face: 'Original', toughness } }) } }) as unknown as Parameters<typeof choreograph>[1]['before'];
  const lungeOf = (tl: ReturnType<typeof choreograph>) => tl.tracks.find((t) => t.type === 'lunge')!;
  it('freezes at contact, longer and with a slower return on a kill; the pop lands at contact', () => {
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'damage', card: 'b1', source: 'a1', amount: 2 };
    const plain = choreograph(beat, { reducedMotion: false, before: before(5) });
    const kill = choreograph(beat, { reducedMotion: false, before: before(2) });
    const l = lungeOf(plain);
    const k = lungeOf(kill);
    if (l.type !== 'lunge' || k.type !== 'lunge') throw new Error('no lunge');
    expect(l.dur).toBe(DUR.lungeIn + DUR.hitStop + DUR.lungeOut);
    expect(l.contact * l.dur).toBeCloseTo(DUR.lungeIn);
    expect((l.release - l.contact) * l.dur).toBeCloseTo(DUR.hitStop);
    expect((k.release - k.contact) * k.dur).toBeCloseTo(DUR.hitStopLethal);
    expect((1 - k.release) * k.dur).toBeCloseTo(DUR.lungeOut * DUR.lethalSlow);
    expect(k.lethal).toBe(true);
    expect(plain.tracks.find((t) => t.type === 'pop')).toMatchObject({ start: DUR.lungeIn });
    expect(kill.tracks.find((t) => t.type === 'pop')).toMatchObject({ big: true });
    expect(plain.lead).toBe(DUR.lungeIn + DUR.hitStop + DUR.damageLead);
  });
  it('an attacker hitting a player hands over to the life beat as the freeze lets go', () => {
    const tl = choreograph({ t: 'beat', seq: 1, kind: 'damage', target: 'p1', source: 'a1', amount: 3 }, { reducedMotion: false, before: before(2) });
    expect(tl.tracks.map((t) => t.type)).toEqual(['lunge']);
    expect(tl.lead).toBe(DUR.lungeIn + DUR.hitStop);
  });
  it('the director shakes at contact, not at the start of the lunge', () => {
    const { d } = setup();
    d.snapshot({ ...snapshot(0), cards: { a1: card('a1', 'Battlefield'), b1: card('b1', 'Battlefield', { controller: 'p1', state: { face: 'Original', toughness: 5 } }) } });
    const t0 = d.clock.now();
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 'a1', amount: 4 });
    d.update();
    expect(d.shake!.at - t0).toBeCloseTo(DUR.lungeIn / IMPACT_PACE);
    expect(d.lethal).toBeNull();
  });
  it('reduced motion: no lunge, no freeze', () => {
    const tl = choreograph({ t: 'beat', seq: 1, kind: 'damage', card: 'b1', source: 'a1', amount: 2 }, { reducedMotion: true, before: before(2) });
    expect(tl.tracks.map((t) => t.type)).toEqual(['pop']);
  });
});

describe('combat steps (attackers charge, blockers step out)', () => {
  const base = { game: { turn: 1, phase: 'COMBAT_DECLARE_ATTACKERS', playerTurn: 'p0', stack: [], combat: [] }, players: {}, cards: { a1: card('a1', 'Battlefield'), b1: card('b1', 'Battlefield', { controller: 'p1' }) } } as unknown as Parameters<typeof choreograph>[1]['before'];
  it('a newly declared attacker charges with a lean, replacing its tap', () => {
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'tap', card: 'a1', patch: { cards: { a1: card('a1', 'Battlefield', { tapped: true, attacking: true }) } } };
    const tl = timelineFor(beat, { reducedMotion: false, before: base });
    expect(tl.tracks).toEqual([{ type: 'retarget', card: 'a1', start: 0, dur: DUR.charge, overshoot: true, lean: 3 }]);
    // Decorative: the tap keeps its own lead.
    expect(tl.lead).toBe(DUR.tap);
  });
  it('a new blocker (planned or locked) steps out to its attacker; old ones do not move again', () => {
    const combat = [{ attacker: 'a1', blockers: ['b1'] }];
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'combatChanged', patch: { game: { ...base!.game, combat } } };
    expect(combatSteps(beat, { reducedMotion: false, before: base })).toMatchObject([{ card: 'b1', dur: DUR.blockStep, lean: 2 }]);
    const again = { ...base!, game: { ...base!.game, combat } } as typeof base;
    expect(combatSteps(beat, { reducedMotion: false, before: again })).toEqual([]);
  });
  it('reduced motion snaps them', () => {
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'attack', patch: { cards: { a1: card('a1', 'Battlefield', { attacking: true }) } } };
    expect(combatSteps(beat, { reducedMotion: true, before: base })).toEqual([{ type: 'retarget', card: 'a1', start: 0, dur: 0, overshoot: false }]);
  });
});

describe('stack exits (MTGA stack overhaul)', () => {
  const before = { game: { turn: 1, phase: 'MAIN1', playerTurn: 'p0', stack: [] }, players: {}, cards: { s1: card('s1', 'Stack') } } as unknown as Parameters<typeof choreograph>[1]['before'];
  it('a resolved spell moved off the stack in any patch arcs to its pile, without holding the playhead', () => {
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'stats', cards: [], patch: { cards: { s1: card('s1', 'Graveyard', { owner: 'p0' }) } } };
    const tl = timelineFor(beat, { reducedMotion: false, before });
    expect(tl.tracks).toMatchObject([{ type: 'flight', card: 's1', stackExit: 'resolve', to: { player: 'p0', zone: 'Graveyard' } }]);
    expect(tl.lead).toBe(0);
    expect(timelineFor(beat, { reducedMotion: true, before }).tracks).toEqual([]);
  });
  it('a toGraveyard beat from the stack resolves too; from the battlefield it flies', () => {
    const from = (zone: string): BeatMsg => ({ t: 'beat', seq: 1, kind: 'toGraveyard', card: 's1', from: { zone }, to: { player: 'p0', zone: 'Graveyard' } });
    expect(choreograph(from('Stack'), { reducedMotion: false }).tracks[0]).toMatchObject({ stackExit: 'resolve' });
    expect(choreograph(from('Battlefield'), { reducedMotion: false }).tracks[0]).not.toHaveProperty('stackExit');
    expect(choreograph(from('Stack'), { reducedMotion: true }).tracks[0]).not.toHaveProperty('stackExit');
  });
  it('a spell leaving the stack under another item is countered; a permanent spell lands; the lead is unchanged', () => {
    const deep = {
      ...before!,
      game: { ...before!.game, stack: [{ id: 'i2', text: 'Counterspell', source: 's2', ability: false, trigger: false, targets: ['i1'] }, { id: 'i1', text: 'Bolt', source: 's1', ability: false, trigger: false, targets: [] }] },
      cards: { s1: card('s1', 'Stack'), s2: card('s2', 'Stack') },
    } as unknown as NonNullable<typeof before>;
    const gy: BeatMsg = { t: 'beat', seq: 1, kind: 'toGraveyard', card: 's1', from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Graveyard' } };
    expect(choreograph(gy, { reducedMotion: false, before: deep }).tracks[0]).toMatchObject({ stackExit: 'countered' });
    const etb: BeatMsg = { t: 'beat', seq: 2, kind: 'etb', card: 's2', from: { zone: 'Stack' }, to: { player: 'p0', zone: 'Battlefield' } };
    const tl = choreograph(etb, { reducedMotion: false, before: deep });
    expect(tl.tracks[0]).toMatchObject({ stackExit: 'permanent', settle: true });
    expect(tl.lead).toBe(DUR.etb);
  });
});

describe('draws in a row overlap (opening hand)', () => {
  it('seven draws finish in about one draw plus six staggers', () => {
    const { d, step } = setup();
    for (let i = 0; i < 7; i++) d.receive(draw(`h${i}`));
    step(DUR.draw + 6 * DUR.drawStagger + 50);
    expect(d.playedSeq).toBe(7);
  });
});

describe('combat contact (overhaul)', () => {
  it('a creature dealing damage lunges at what it hits; a burn spell does not', () => {
    const { d } = setup();
    d.snapshot({ ...snapshot(0), cards: { a1: card('a1', 'Battlefield'), b1: { ...card('b1', 'Battlefield'), controller: 'p1' } } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 'a1', amount: 2 });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', target: 'p1', source: 'bolt', amount: 3 });
    d.update();
    expect(d.tracks.find((t) => t.type === 'lunge')).toMatchObject({ card: 'a1', atCard: 'b1', hit: 'b1' });
    expect(d.tracks.filter((t) => t.type === 'lunge')).toHaveLength(1);
  });
});

describe('spells hit their targets (overhaul)', () => {
  const bolt = { id: 'si1', text: 'Bolt', source: 's1', ability: false, trigger: false, targets: ['b1', 'p1'] };
  const withStack = () => ({
    ...snapshot(0),
    game: { ...snapshot(0).game, stack: [bolt] },
    cards: { s1: card('s1', 'Stack', { state: { face: 'Original', name: 's1', colors: 'UR' } }), b1: { ...card('b1', 'Battlefield'), controller: 'p1' } },
  });

  it('the first beat touching a target waits for a bolt in the spell colours; each target is hit once', () => {
    const { d } = setup();
    d.snapshot(withStack());
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 's1', amount: 2 });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', target: 'p1', source: 's1', amount: 2 });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 's1', amount: 1 });
    d.update();
    const impacts = d.tracks.filter((t) => t.type === 'impact');
    expect(impacts).toMatchObject([{ card: 's1', atCard: 'b1', colors: 'UR' }]);
    // The pop lands with the bolt.
    expect(d.tracks.find((t) => t.type === 'pop')!.start).toBeGreaterThanOrEqual(DUR.impact);
  });

  it('no stack item, no bolt; a fizzle dissolves the spell', () => {
    const { d } = setup();
    d.snapshot({ ...snapshot(0), cards: { s1: card('s1', 'Stack'), b1: card('b1', 'Battlefield') } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 's1', amount: 2 });
    d.receive({ t: 'beat', seq: ++seq, kind: 'fizzle', spell: { host: 's1' }, hasFizzled: true });
    d.update();
    expect(d.tracks.some((t) => t.type === 'impact')).toBe(false);
    expect(choreograph({ t: 'beat', seq: 1, kind: 'fizzle', spell: { host: 's1' } }, { reducedMotion: false }).tracks).toMatchObject([{ type: 'fizzle', card: 's1' }]);
    expect(choreograph({ t: 'beat', seq: 1, kind: 'fizzle', spell: { host: 's1' } }, { reducedMotion: true }).tracks).toEqual([]);
  });
});

describe('mana sparks (overhaul)', () => {
  it('mana added after a tap sparks from the tapped permanent to its controller; never holds the playhead', () => {
    const { d, step } = setup();
    d.snapshot({ ...snapshot(0), cards: { l1: card('l1', 'Battlefield') } });
    d.receive(tap('l1'));
    d.receive({ t: 'beat', seq: ++seq, kind: 'manaPool', player: 'p0', mode: 'Added', colors: ['RED', 'GREEN'] });
    d.receive({ t: 'beat', seq: ++seq, kind: 'manaPool', player: 'p0', mode: 'Removed', colors: ['RED'] });
    step(400);
    expect(d.tracks.filter((t) => t.type === 'sparks')).toMatchObject([{ card: 'l1', player: 'p0', colors: 'RG' }]);
    expect(choreograph({ t: 'beat', seq: 1, kind: 'manaPool', player: 'p0', mode: 'Added', colors: ['RED'] }, { reducedMotion: false, lastTap: 'l1' }).lead).toBe(0);
  });
});

describe('counter and P/T pops (overhaul)', () => {
  const bear = (power: number, toughness: number) => card('b1', 'Battlefield', { state: { face: 'Original', name: 'b1', power, toughness } });
  it('a pump pops its change at the card; P/T counters pop through stats only; other counters pop themselves', () => {
    const before = { ...snapshot(0), cards: { b1: bear(2, 2) } } as unknown as Parameters<typeof choreograph>[1]['before'];
    const stats = choreograph({ t: 'beat', seq: 1, kind: 'stats', cards: ['b1'], transform: false, patch: { cards: { b1: bear(5, 1) } } }, { reducedMotion: false, before });
    // A mixed change stays gold (no trend); the card pulses with it (keywords.test.ts covers up / down).
    expect(stats.tracks).toMatchObject([{ type: 'pop', card: 'b1', text: '+3/−1', tone: 'counter' }, { type: 'keyword', fx: 'pulse', card: 'b1' }]);
    expect(stats.tracks[0]).not.toHaveProperty('trend');
    expect(stats.lead).toBe(0);
    expect(choreograph({ t: 'beat', seq: 2, kind: 'counters', card: 'b1', type: '+1/+1', oldValue: 0, newValue: 1 }, { reducedMotion: false }).tracks).toEqual([]);
    expect(choreograph({ t: 'beat', seq: 3, kind: 'counters', card: 'b1', type: 'Loyalty', oldValue: 3, newValue: 1 }, { reducedMotion: false }).tracks).toMatchObject([{ text: '−2 Loyalty' }]);
  });
});

describe('effects setting (overhaul)', () => {
  it('lite drops the bolt and the shake but keeps the pop; off also plays cards reduced', () => {
    const { d } = setup();
    d.effects = 'lite';
    const bolt = { id: 'si1', text: 'Bolt', source: 's1', ability: false, trigger: false, targets: ['b1'] };
    d.snapshot({ ...snapshot(0), game: { ...snapshot(0).game, stack: [bolt] }, cards: { s1: card('s1', 'Stack'), b1: card('b1', 'Battlefield', { controller: 'p1' }) } });
    d.receive({ t: 'beat', seq: ++seq, kind: 'damage', card: 'b1', source: 's1', amount: 5 });
    d.update();
    expect(d.tracks.map((t) => t.type)).toEqual(['pop']);
    expect(d.shake).toBeNull();
    expect(d.calm).toBe(false);
    d.effects = 'off';
    expect(d.calm).toBe(true);
  });
});

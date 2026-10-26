import { describe, expect, it } from 'vitest';
import type { BeatMsg, Card, GameModel } from '@forge-table/protocol';
import { DUR, choreograph, combatSteps, keywordTracks, ptTrend, timelineFor, type KeywordTrack, type LungeTrack } from './choreography';
import { deathtouchHit, firstStrikeHit, gainedKeywords, lifelinkTo, phaseOf, rippleDelay, shrugsOff, trampleOver } from './keywords';

const kw = (...titles: string[]) => titles.map((title) => ({ title }));
const creature = (id: string, controller: string, extra: Partial<Card> = {}, keywords: string[] = [], toughness = 2): Card => ({
  id,
  zone: 'Battlefield',
  controller,
  state: { face: 'Original', name: id, power: 2, toughness, type: { super: [], core: ['Creature'], sub: [] }, keywords: kw(...keywords) },
  ...extra,
});

/** A trampler (c1, mine) double-blocked by c2 and c3 in the combat damage step. */
function board(over: { keywords?: string[]; phase?: string; blockers?: string[] } = {}): GameModel {
  return {
    game: { stack: [], phase: (over.phase ?? 'COMBAT_DAMAGE') as never, combat: [{ attacker: 'c1', defender: 'p1', blockers: over.blockers ?? ['c2', 'c3'] }] },
    players: { p0: { id: 'p0', life: 20, zones: {} }, p1: { id: 'p1', life: 20, zones: {} } },
    cards: {
      c1: creature('c1', 'p0', { attacking: true }, over.keywords ?? ['Trample'], 6),
      c2: creature('c2', 'p1', { blocking: true }),
      c3: creature('c3', 'p1', { blocking: true }),
    },
  };
}
const hitPlayer = (amount = 2): BeatMsg => ({ t: 'beat', seq: 1, kind: 'damage', target: 'p1', source: 'c1', amount, combat: true, infect: false });
const hitCard = (card: string, source = 'c1', amount = 2): BeatMsg => ({ t: 'beat', seq: 1, kind: 'damage', card, source, amount, type: 'Normal' });

describe('keyword detection (keywords.ts)', () => {
  it('trample: a blocked trampler hitting the player went through its live blockers', () => {
    expect(trampleOver(hitPlayer(), board())).toEqual({ attacker: 'c1', through: ['c2', 'c3'], player: 'p1' });
    // A blocker already dead (first strike) is not gone through.
    const m = board();
    m.cards.c3 = { ...m.cards.c3!, zone: 'Graveyard' };
    expect(trampleOver(hitPlayer(), m)?.through).toEqual(['c2']);
  });

  it('trample: nothing for an unblocked attacker, no trample, a non-combat hit, a card hit or no damage', () => {
    expect(trampleOver(hitPlayer(), board({ blockers: [] }))).toBeNull();
    expect(trampleOver(hitPlayer(), board({ keywords: [] }))).toBeNull();
    expect(trampleOver({ ...hitPlayer(), combat: false }, board())).toBeNull();
    expect(trampleOver(hitCard('c2'), board())).toBeNull();
    expect(trampleOver(hitPlayer(0), board())).toBeNull();
    expect(trampleOver(hitPlayer(), undefined)).toBeNull();
  });

  it('lifelink feeds the source controller; infect and other sources do not', () => {
    expect(lifelinkTo(hitPlayer(), board({ keywords: ['Lifelink'] }))).toBe('p0');
    expect(lifelinkTo(hitCard('c2'), board({ keywords: ['Lifelink'] }))).toBe('p0');
    expect(lifelinkTo(hitPlayer(), board())).toBeNull();
    expect(lifelinkTo({ ...hitPlayer(), infect: true }, board({ keywords: ['Lifelink'] }))).toBeNull();
  });

  it('deathtouch marks a creature it can kill, not an indestructible one or a player', () => {
    expect(deathtouchHit(hitCard('c2'), board({ keywords: ['Deathtouch'] }))).toBe('c2');
    expect(deathtouchHit(hitCard('c2'), board())).toBeNull();
    expect(deathtouchHit(hitPlayer(), board({ keywords: ['Deathtouch'] }))).toBeNull();
    const m = board({ keywords: ['Deathtouch'] });
    m.cards.c2 = creature('c2', 'p1', {}, ['Indestructible']);
    expect(deathtouchHit(hitCard('c2'), m)).toBeNull();
    // ... which shrugs it off instead.
    expect(shrugsOff(hitCard('c2'), m)).toBe('c2');
  });

  it('indestructible shrugs off only damage that would kill it', () => {
    const m = board();
    m.cards.c2 = creature('c2', 'p1', { damage: 1 }, ['Indestructible'], 3);
    expect(shrugsOff(hitCard('c2', 'c1', 1), m)).toBeNull();
    expect(shrugsOff(hitCard('c2', 'c1', 2), m)).toBe('c2');
    expect(shrugsOff(hitCard('c3', 'c1', 9), m)).toBeNull();
  });

  it('first strike is the first-strike damage step, whatever the keywords', () => {
    expect(firstStrikeHit(hitCard('c2'), board({ phase: 'COMBAT_FIRST_STRIKE_DAMAGE' }))).toBe(true);
    expect(firstStrikeHit(hitCard('c2'), board({ phase: 'COMBAT_DAMAGE', keywords: ['Double Strike'] }))).toBe(false);
  });

  it('ripples left to right by position, clamped to the spread', () => {
    const xs = [900, 100, 1500, 500];
    const order = [...xs].sort((a, b) => rippleDelay(a, 0, 1600, 260) - rippleDelay(b, 0, 1600, 260));
    expect(order).toEqual([100, 500, 900, 1500]);
    expect(rippleDelay(0, 0, 1600, 260)).toBe(0);
    expect(rippleDelay(1600, 0, 1600, 260)).toBe(260);
    expect(rippleDelay(-50, 0, 1600, 260)).toBe(0);
    expect(rippleDelay(2000, 0, 1600, 260)).toBe(260);
    expect(rippleDelay(5, 10, 10, 260)).toBe(0);
  });

  it('gives each card a stable bob phase', () => {
    expect(phaseOf('c12')).toBe(phaseOf('c12'));
    expect(phaseOf('c12')).not.toBe(phaseOf('c13'));
    for (const id of ['c1', 'c99', 'c1234']) expect(phaseOf(id)).toBeGreaterThanOrEqual(0), expect(phaseOf(id)).toBeLessThan(1);
  });
});

describe('keyword choreography', () => {
  const ctx = (before: GameModel, reducedMotion = false, fx = true) => ({ reducedMotion, fx, viewer: 'p0', before });

  it('trample: the attacker lunges at the blocker, the streak runs on to the player and the life chip waits for it', () => {
    const tl = choreograph(hitPlayer(), ctx(board()));
    const lunge = tl.tracks.find((t): t is LungeTrack => t.type === 'lunge')!;
    expect(lunge.atCard).toBe('c2');
    expect(lunge.atPlayer).toBeUndefined();
    const tr = tl.tracks.find((t): t is KeywordTrack => t.type === 'keyword' && t.fx === 'trample')!;
    expect(tr).toMatchObject({ from: ['c2', 'c3'], to: 'p1', start: DUR.lungeIn, dur: DUR.trample });
    expect(tl.lead).toBeGreaterThanOrEqual(DUR.lungeIn + DUR.trample);
    // Forge's life beat comes after every blocker's hit, so the number pops on the plate as the streak arrives.
    expect(tl.tracks.find((t) => t.type === 'pop')).toMatchObject({ player: 'p1', text: '-2', start: DUR.lungeIn + DUR.trample });
  });

  it('trample under reduced motion: a still streak, nothing waits', () => {
    const tl = choreograph(hitPlayer(), ctx(board(), true));
    expect(tl.tracks).toEqual([expect.objectContaining({ type: 'pop', still: true }), expect.objectContaining({ type: 'keyword', fx: 'trample', still: true, start: 0 })]);
    expect(tl.lead).toBe(0);
  });

  it('an unblocked trampler plays the plain hit', () => {
    const tl = choreograph(hitPlayer(), ctx(board({ blockers: [] })));
    expect(tl.tracks.find((t): t is LungeTrack => t.type === 'lunge')!.atPlayer).toBe('p1');
    expect(tl.tracks.some((t) => t.type === 'keyword')).toBe(false);
  });

  it('marks deathtouch, first strike and lifelink at the moment of contact; lifelink motes are full effects only', () => {
    const m = board({ keywords: ['Deathtouch', 'Lifelink'], phase: 'COMBAT_FIRST_STRIKE_DAMAGE' });
    const fxs = (t: KeywordTrack[]) => t.map((k) => k.fx).sort();
    expect(fxs(keywordTracks(hitCard('c2'), ctx(m), 112))).toEqual(['lifelink', 'slash', 'venom']);
    expect(keywordTracks(hitCard('c2'), ctx(m), 112).every((k) => k.start === 112)).toBe(true);
    expect(fxs(keywordTracks(hitCard('c2'), ctx(m, false, false), 0))).toEqual(['slash', 'venom']);
    expect(keywordTracks(hitCard('c2'), ctx(m, true), 0).every((k) => k.still)).toBe(true);
    expect(fxs(keywordTracks(hitCard('c2'), ctx(m, true), 0))).toEqual(['slash', 'venom']);
  });

  it('a trampling lifelinker sends its motes from the player, once the streak gets there', () => {
    const tracks = keywordTracks(hitPlayer(), ctx(board({ keywords: ['Trample', 'Lifelink'] })), 100);
    expect(tracks.find((t) => t.fx === 'lifelink')).toMatchObject({ player: 'p1', to: 'p0', start: 100 + DUR.trample });
  });

  it('the bolt of a spell delays the keyword marks with everything else', () => {
    const m = board({ keywords: ['Deathtouch'] });
    m.game = { ...m.game, stack: [{ id: 's1', text: '', source: 'c1', ability: true, trigger: false, targets: ['c2'] }] };
    const tl = timelineFor(hitCard('c2'), { ...ctx(m), impacted: new Set() });
    expect(tl.tracks[0]!.type).toBe('impact');
    expect(tl.tracks.find((t) => t.type === 'keyword')!.start).toBeGreaterThanOrEqual(DUR.impact);
  });

  it('a flyer charges higher and a vigilant attacker glints; untaps overshoot and ripple', () => {
    const m = board({ keywords: [] });
    m.cards.c1 = { ...m.cards.c1!, attacking: false };
    const patch = { cards: { c1: creature('c1', 'p0', { attacking: true }, ['Flying', 'Vigilance']) } };
    const steps = combatSteps({ t: 'beat', seq: 1, kind: 'attack', patch }, ctx(m));
    expect(steps[0]).toMatchObject({ card: 'c1', fly: true, glint: true });
    // Reduced motion: a snap, no flourish.
    expect(combatSteps({ t: 'beat', seq: 1, kind: 'attack', patch }, ctx(m, true))[0]).toEqual({ type: 'retarget', card: 'c1', start: 0, dur: 0, overshoot: false });
    const untap = choreograph({ t: 'beat', seq: 1, kind: 'untap', card: 'c1' }, ctx(m));
    expect(untap.tracks[0]).toMatchObject({ type: 'retarget', overshoot: true, untap: true });
  });

  it('a P/T change pulses and its number is green up, red down, gold when mixed', () => {
    expect(ptTrend(2, 2)).toBe('up');
    expect(ptTrend(0, 1)).toBe('up');
    expect(ptTrend(-1, -1)).toBe('down');
    expect(ptTrend(2, -1)).toBeUndefined();
    expect(ptTrend(0, 0)).toBeUndefined();
    const m = board();
    const beat: BeatMsg = { t: 'beat', seq: 1, kind: 'stats', cards: ['c2'], patch: { cards: { c2: creature('c2', 'p1', {}, [], 4) } } };
    const tl = choreograph(beat, ctx(m));
    expect(tl.tracks.map((t) => t.type)).toEqual(['pop', 'keyword']);
    expect(tl.tracks[0]).toMatchObject({ text: '+0/+2', trend: 'up' });
    expect(choreograph(beat, ctx(m, true)).tracks.map((t) => t.type)).toEqual(['pop']);
  });
});

describe('gainedKeywords', () => {
  const face = (oracleText: string | undefined, ...titles: string[]) => ({ face: 'Original', name: 'x', type: { super: [], core: ['Creature'], sub: [] }, oracleText, keywords: kw(...titles) });

  it('lists the keywords the printed text does not give, in icon order', () => {
    expect(gainedKeywords(face('Flying', 'Flying', 'Lifelink', 'First Strike'))).toEqual(['lifelink', 'first-strike']);
    expect(gainedKeywords(face('Reach\nWhen this enters, draw a card.', 'Reach', 'Deathtouch', 'Flying'))).toEqual(['flying', 'deathtouch']);
  });

  it('counts a keyword the card grants itself as printed, and a word inside another as not', () => {
    expect(gainedKeywords(face('{R}: This creature gains first strike until end of turn.', 'First Strike'))).toEqual([]);
    expect(gainedKeywords(face('When this reaches the top, draw.', 'Reach'))).toEqual(['reach']);
  });

  it('strips a number (Toxic 2) and skips keywords with no icon or a sigil of their own', () => {
    expect(gainedKeywords(face('Toxic 1', 'Toxic 1', 'Toxic 2'))).toEqual([]);
    expect(gainedKeywords(face('Bear.', 'Toxic 2', 'Hexproof', 'Ward {2}', 'Prowess', 'Flash'))).toEqual(['toxic']);
  });

  it('treats a vanilla face as printing nothing, and shows nothing when the oracle text is not on the wire', () => {
    expect(gainedKeywords(face('', 'Flying', 'Haste'))).toEqual(['flying', 'haste']);
    expect(gainedKeywords(face(undefined, 'Flying'))).toEqual([]);
    expect(gainedKeywords(undefined)).toEqual([]);
  });
});

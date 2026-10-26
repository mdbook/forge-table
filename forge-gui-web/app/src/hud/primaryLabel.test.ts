import { describe, expect, it } from 'vitest';
import type { ButtonState, Card, Game, Phase } from '@forge-table/protocol';
import { blockPromptText, nextStop, primaryLabel, type EngineLabels, type LabelState } from './primaryLabel';
import { mullInfo } from './mulligan';

const on = (label: string): ButtonState => ({ label, enabled: true });
const off = (label: string): ButtonState => ({ label, enabled: false });
const priorityEngine: EngineLabels = { ok: on('OK'), cancel: on('End Turn') };

function state(over: Partial<Game> = {}, cards: Record<string, Card> = {}, extra: Partial<LabelState> = {}): LabelState {
  return {
    game: { turn: 3, phase: 'MAIN1', playerTurn: 'p0', priority: 'p0', stack: [], ...over },
    viewer: 'p0',
    cards,
    myBattlefield: Object.keys(cards),
    myStops: ['MAIN1', 'COMBAT_DECLARE_BLOCKERS', 'MAIN2'],
    ...extra,
  };
}

const bear = (id: string, extra: Partial<Card> = {}): Card => ({
  id,
  controller: 'p0',
  zone: 'Battlefield',
  state: { face: 'Original', name: 'Bear', type: { super: [], core: ['Creature'], sub: ['Bear'] }, power: 2, toughness: 2 },
  ...extra,
});

const stackItem = { id: 's1', text: 'Lightning Bolt', activator: 'p1', ability: false, trigger: false, targets: [] };

describe('primaryLabel (PLAN §4.1 rows)', () => {
  it('no prompt on my turn → disabled "Waiting…" with spinner', () => {
    const b = primaryLabel(null, null, state());
    expect(b.primary).toMatchObject({ label: 'Waiting…', enabled: false, action: null, busy: true });
    expect(b.secondary).toBeNull();
  });

  it('waiting on the opponent\'s turn → disabled "Opponent\'s Turn"', () => {
    const b = primaryLabel('waiting', { ok: off(''), cancel: off('') }, state({ playerTurn: 'p1' }));
    expect(b.primary).toMatchObject({ label: "Opponent's Turn", enabled: false });
  });

  it('priority with a non-empty stack → "Resolve" (engine OK)', () => {
    const b = primaryLabel('priority', priorityEngine, state({ stack: [stackItem] }));
    expect(b.primary).toMatchObject({ label: 'Resolve', action: 'ok', enabled: true });
    // It names what resolves: the spell, or the source of an ability.
    const bolt = { id: 'c7', zone: 'Stack', state: { face: 'Original', name: 'Lightning Bolt' } };
    expect(primaryLabel('priority', priorityEngine, state({ stack: [{ ...stackItem, source: 'c7' }] }, { c7: bolt })).primary.subtitle).toBe('Lightning Bolt');
    const elf = { ...bolt, zone: 'Battlefield', state: { face: 'Original', name: 'Llanowar Elves' } };
    expect(primaryLabel('priority', priorityEngine, state({ stack: [{ ...stackItem, source: 'c7', ability: true }] }, { c7: elf })).primary.subtitle).toBe('Llanowar Elves ability');
  });

  it('priority, my turn, Main 1, a creature can attack → "To Combat"', () => {
    const b = primaryLabel('priority', priorityEngine, state({}, { c1: bear('c1') }));
    expect(b.primary).toMatchObject({ label: 'To Combat', action: 'ok' });
    // The engine's cancel ("End Turn") is the End Turn chip, not the secondary.
    expect(b.endTurn).toMatchObject({ label: 'End Turn', action: 'cancel' });
    expect(b.secondary).toBeNull();
  });

  it('priority, my turn, Main 1, only sick/tapped creatures → "Next → Main 2" (my next stop)', () => {
    const b = primaryLabel('priority', priorityEngine, state({}, { c1: bear('c1', { sickness: true }), c2: bear('c2', { tapped: true }) }));
    expect(b.primary).toMatchObject({ label: 'Next', subtitle: '→ Main 2', action: 'ok' });
  });

  it('priority, my turn, Main 1, no creature and no later stop → "End Turn"', () => {
    const b = primaryLabel('priority', priorityEngine, state({}, {}, { myStops: ['MAIN1'] }));
    expect(b.primary).toMatchObject({ label: 'End Turn', action: 'ok' });
  });

  it('priority, my turn, declare-attackers step → "To Blockers"', () => {
    const b = primaryLabel('priority', priorityEngine, state({ phase: 'COMBAT_DECLARE_ATTACKERS' }));
    expect(b.primary).toMatchObject({ label: 'To Blockers', subtitle: '→ opponent blocks', action: 'ok' });
  });

  it('priority, my turn, other combat steps → "Next" toward damage / Main 2', () => {
    expect(primaryLabel('priority', priorityEngine, state({ phase: 'COMBAT_DECLARE_BLOCKERS' })).primary).toMatchObject({ label: 'Next', subtitle: '→ Damage' });
    expect(primaryLabel('priority', priorityEngine, state({ phase: 'COMBAT_DAMAGE' })).primary).toMatchObject({ label: 'Next', subtitle: '→ Main 2' });
  });

  it('priority, my turn, upkeep / draw → "Next → Main 1"', () => {
    for (const phase of ['UPKEEP', 'DRAW'] as Phase[]) {
      expect(primaryLabel('priority', priorityEngine, state({ phase })).primary).toMatchObject({ label: 'Next', subtitle: '→ Main 1' });
    }
  });

  it('priority, my turn, Main 2 / End → "End Turn"', () => {
    for (const phase of ['MAIN2', 'END_OF_TURN'] as Phase[]) {
      expect(primaryLabel('priority', priorityEngine, state({ phase })).primary).toMatchObject({ label: 'End Turn', action: 'ok' });
    }
  });

  it('priority, opponent declared attackers, empty stack → "To Blockers"', () => {
    const b = primaryLabel('priority', priorityEngine, state({ playerTurn: 'p1', phase: 'COMBAT_DECLARE_ATTACKERS', combat: [{ attacker: 'c9', blockers: [] }] }));
    expect(b.primary).toMatchObject({ label: 'To Blockers', action: 'ok' });
  });

  it('priority on the opponent\'s turn otherwise → "Pass", no End Turn chip', () => {
    const b = primaryLabel('priority', priorityEngine, state({ playerTurn: 'p1', phase: 'MAIN1' }));
    expect(b.primary).toMatchObject({ label: 'Pass', action: 'ok' });
    expect(b.endTurn).toBeNull();
  });

  it('priority right after an undoable action: engine cancel "Undo (1)" becomes the secondary, the only Undo, not two', () => {
    const b = primaryLabel('priority', { ok: on('OK'), cancel: on('Undo (1)'), canUndo: true }, state({ phase: 'MAIN2' }));
    expect(b.secondary).toMatchObject({ label: 'Undo (1)', action: 'cancel' });
    expect(b.undo).toBeNull();
    expect(b.endTurn).toBeNull();
  });

  it('mulligan → engine Keep / Mulligan', () => {
    const b = primaryLabel('mulligan', { ok: on('Keep'), cancel: on('Mulligan') }, state({ turn: 0 }));
    expect(b.primary).toMatchObject({ label: 'Keep', action: 'ok' });
    expect(b.secondary).toMatchObject({ label: 'Mulligan', action: 'cancel' });
  });

  it('mulliganTuck → Done once the engine enables OK, else a disabled hint', () => {
    expect(primaryLabel('mulliganTuck', { ok: off('Done'), cancel: off('') }, state()).primary).toMatchObject({ enabled: false, action: null });
    expect(primaryLabel('mulliganTuck', { ok: on('Done'), cancel: off('') }, state()).primary).toMatchObject({ label: 'Done', action: 'ok' });
  });

  it('mulligan with the counts (B5) → Keep N / Mulligan to N-1; the tuck names the outcome', () => {
    const keep = mullInfo({ kind: 'mulligan', message: 'Player, you are going first!', highlighted: [] }, 7, { count: 1, seat: null }, 0);
    const b = primaryLabel('mulligan', { ok: on('Keep'), cancel: on('Mulligan') }, state({ turn: 0 }, {}, { mull: keep }));
    expect(b.primary).toMatchObject({ label: 'Keep 6', action: 'ok' });
    expect(b.secondary).toMatchObject({ label: 'Mulligan to 5', action: 'cancel' });
    const tuck = (chosen: string[], left: number) =>
      mullInfo({ kind: 'mulliganTuck', message: `Return ${left} card(s) to the bottom of your library`, highlighted: chosen }, 7, { count: 2, seat: 'draw' }, 0);
    expect(primaryLabel('mulliganTuck', { ok: off('OK'), cancel: on('Auto') }, state({}, {}, { mull: tuck(['a'], 1) })).primary).toMatchObject({ label: 'Choose 1 more', enabled: false });
    expect(primaryLabel('mulliganTuck', { ok: on('OK'), cancel: on('Auto') }, state({}, {}, { mull: tuck(['a', 'b'], 0) })).primary).toMatchObject({ label: 'Bottom 2, keep 5', action: 'ok' });
  });

  it('confirm → the engine\'s yes / no labels', () => {
    const b = primaryLabel('confirm', { ok: on('Play'), cancel: on('Draw') }, state());
    expect(b.primary).toMatchObject({ label: 'Play', action: 'ok' });
    expect(b.secondary).toMatchObject({ label: 'Draw', action: 'cancel' });
  });

  it('declareAttackers: none → "Attack All" + "No Attacks" (MTGA); n → "Attack ×n"', () => {
    const engine = { ok: on('OK'), cancel: on('Alpha Strike') };
    const none = primaryLabel('declareAttackers', engine, state({ phase: 'COMBAT_DECLARE_ATTACKERS' }, { c1: bear('c1') }));
    expect(none.primary).toMatchObject({ label: 'Attack All', action: 'alphaStrike' });
    expect(none.secondary).toMatchObject({ label: 'No Attacks', action: 'ok' });
    const two = primaryLabel(
      'declareAttackers',
      { ok: on('OK'), cancel: on('Call Back') },
      state({ phase: 'COMBAT_DECLARE_ATTACKERS', combat: [{ attacker: 'c1', blockers: [] }, { attacker: 'c2', blockers: [] }] }, { c1: bear('c1'), c2: bear('c2') }),
    );
    expect(two.primary.label).toBe('Attack ×2');
    expect(two.secondary).toMatchObject({ label: 'Clear', action: 'cancel' });
  });

  it('declareBlockers: "No Blocks" / "Block ×n"', () => {
    const engine = { ok: on('OK'), cancel: on('Cancel') };
    expect(primaryLabel('declareBlockers', engine, state({ playerTurn: 'p1' })).primary.label).toBe('No Blocks');
    const b = primaryLabel('declareBlockers', engine, state({ playerTurn: 'p1', combat: [{ attacker: 'c9', blockers: ['c1'] }] }));
    expect(b.primary.label).toBe('Block ×1');
  });

  it('declareBlockers: counts planned blocks while they are being declared', () => {
    const engine = { ok: on('OK'), cancel: on('Cancel') };
    const combat = [
      { attacker: 'c9', blockers: [], planned: ['c1', 'c2'] },
      { attacker: 'c8', blockers: [], planned: ['c3'] },
    ];
    const b = primaryLabel('declareBlockers', engine, state({ playerTurn: 'p1', combat }));
    expect(b.primary.label).toBe('Block ×3');
    expect(b.secondary).toMatchObject({ label: 'Clear', action: 'cancel' });
  });

  it('chooseTargets: disabled "Choose a target" until OK, Cancel when allowed', () => {
    const b = primaryLabel('chooseTargets', { ok: off('OK'), cancel: on('Cancel') }, state());
    expect(b.primary).toMatchObject({ label: 'Choose a target', enabled: false });
    expect(b.secondary).toMatchObject({ label: 'Cancel', action: 'cancel' });
    expect(primaryLabel('chooseTargets', { ok: on('OK'), cancel: off('Cancel') }, state()).primary).toMatchObject({ label: 'Done', action: 'ok' });
  });

  it('payMana: "Auto Pay" when the engine has a plan', () => {
    expect(primaryLabel('payMana', { ok: on('Auto'), cancel: on('Cancel') }, state()).primary).toMatchObject({ label: 'Auto Pay', action: 'ok' });
    expect(primaryLabel('payMana', { ok: off('Auto'), cancel: on('Cancel') }, state()).primary).toMatchObject({ enabled: false });
  });

  it('selectEntities: engine Done / Cancel', () => {
    const b = primaryLabel('selectEntities', { ok: on('OK'), cancel: on('Cancel') }, state());
    expect(b.primary).toMatchObject({ label: 'OK', action: 'ok' });
    expect(b.secondary).toMatchObject({ label: 'Cancel' });
  });

  it('generic and unknown kinds pass the engine labels through', () => {
    const b = primaryLabel('someFutureInput', { ok: on('Exile it'), cancel: on('Keep it') }, state());
    expect(b.primary).toMatchObject({ label: 'Exile it', action: 'ok' });
    expect(b.secondary).toMatchObject({ label: 'Keep it', action: 'cancel' });
  });

  it('nextStop finds my next stop in this turn only', () => {
    expect(nextStop('MAIN1', ['MAIN1', 'MAIN2'])).toBe('MAIN2');
    expect(nextStop('MAIN2', ['MAIN1', 'MAIN2'])).toBeNull();
    expect(nextStop('UPKEEP', ['COMBAT_DAMAGE'])).toBe('COMBAT_DAMAGE');
  });
});

describe('blocker-first prompt text', () => {
  const cards = { b1: { id: 'b1', state: { face: 'Original', name: 'Giant Spider' } }, a1: { id: 'a1' } } as unknown as Record<string, Card>;
  const blockable = { b1: ['a1'], b2: [] };

  it('tells the player to pick a blocker, then an attacker for it', () => {
    expect(blockPromptText({ kind: 'declareBlockers', blockable }, cards, null)).toBe('Pick a creature, then the attacker it blocks');
    expect(blockPromptText({ kind: 'declareBlockers', blockable }, cards, null, 1)).toBe('Pick a creature, then the attacker it blocks · click a blocker to pull it back');
    expect(blockPromptText({ kind: 'declareBlockers', blockable }, cards, 'b1')).toBe('Now pick an attacker for Giant Spider');
    expect(blockPromptText({ kind: 'declareBlockers', blockable }, cards, 'b2')).toBe("that creature can't block any of the attackers");
  });

  it('says so when nothing can block', () => {
    expect(blockPromptText({ kind: 'declareBlockers', blockable: { b1: [] } }, cards, null)).toBe('None of your creatures can block');
    expect(blockPromptText({ kind: 'declareBlockers', blockable: {} }, cards, null, 2)).toBe('No other creature can block · click a blocker to pull it back');
  });

  it("keeps the engine's message for older servers and other prompts", () => {
    expect(blockPromptText({ kind: 'declareBlockers' }, cards, null)).toBeNull();
    expect(blockPromptText({ kind: 'declareAttackers', blockable }, cards, null)).toBeNull();
    expect(blockPromptText(null, cards, null)).toBeNull();
  });
});

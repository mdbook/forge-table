import { describe, expect, it } from 'vitest';
import type { Card, CardFace, GameModel, Phase, Player, PromptBody } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { altCastables, altHeld, describeAlt, keywordCost, keywordCostText, swapCue } from './altZone';

const face = (name: string, keywords: string[] = [], extra: Partial<CardFace> = {}): CardFace => ({
  face: 'Original',
  name,
  manaCost: '{3}{R}',
  type: { super: [], core: ['Instant'], sub: [] },
  keywords: keywords.map((title) => ({ title })),
  ...extra,
});
const card = (id: string, zone: string, f: CardFace, extra: Partial<Card> = {}): Card => ({ id, zone, owner: 'p0', controller: 'p0', state: f, ...extra });

function game(zones: Record<string, string[]>, cards: Card[], opp: Record<string, string[]> = {}, g: Partial<GameModel['game']> = {}): GameModel {
  return modelOf(
    { turn: 4, phase: 'MAIN1', playerTurn: 'p0', stack: [], ...g },
    { p0: { id: 'p0', life: 20, zones: zones as Player['zones'] }, p1: { id: 'p1', life: 20, zones: opp as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}
const prompt = (weak: Record<string, number>, kind = 'priority'): PromptBody => ({ pid: 1, kind, message: '', ok: { label: 'OK', enabled: true }, cancel: { label: 'End Turn', enabled: true }, focusOk: false, selectable: [], highlighted: [], weak });

describe('keywordCost', () => {
  it('reads the mana cost after the keyword name, with or without a dash, and nothing for other costs', () => {
    expect(keywordCost(face('x', ['Flashback {2}{R}']), ['Flashback'])).toBe('{2}{R}');
    expect(keywordCost(face('x', ['Escape—{R}{R}, Exile two other cards from your graveyard.']), ['Escape'])).toBe('{R}{R}');
    expect(keywordCost(face('x', ['Flashback—Sacrifice a Mountain']), ['Flashback'])).toBeUndefined();
    expect(keywordCost(face('x', ['Commander ninjutsu {1}{U}']), ['Ninjutsu'])).toBeUndefined();
    expect(keywordCost(face('x', ['Commander ninjutsu {1}{U}']), ['Commander ninjutsu', 'Ninjutsu'])).toBe('{1}{U}');
    expect(keywordCost(face('x', ['Flying']), ['Flashback'])).toBeUndefined();
    expect(keywordCost(undefined, ['Flashback'])).toBeUndefined();
  });
});

describe('describeAlt: where it waits (the preview line) and the alternate cost per zone', () => {
  it('graveyard: the mechanic and its cost; a plain graveyard card is just Graveyard', () => {
    const fb = card('g1', 'Graveyard', face('Lava Dart', ['Flashback {2}{R}']));
    expect(describeAlt('g1', fb, 'graveyard', true)).toEqual({ id: 'g1', label: 'Graveyard · Flashback', tone: 'graveyard', cost: '{2}{R}' });
    const sac = card('g2', 'Graveyard', face('Lava Dart', ['Flashback—Sacrifice a Mountain']));
    expect(describeAlt('g2', sac, 'graveyard', true)).toEqual({ id: 'g2', label: 'Graveyard · Flashback', tone: 'graveyard' });
    expect(describeAlt('g3', card('g3', 'Graveyard', face('Bolt')), 'graveyard', true)).toEqual({ id: 'g3', label: 'Graveyard', tone: 'graveyard' });
    expect(describeAlt('g4', card('g4', 'Graveyard', face('Bolt')), 'graveyard', false).label).toBe("Opponent's graveyard");
  });

  it('exile: foretold (face down, its face in alt), plotted, suspended, warped, adventure, else Exile', () => {
    const down = card('c11', 'Exile', { face: 'FaceDown', imageKey: 't:hidden' }, { facedown: true, alt: face('Demon Bolt', ['Foretell {R}'], { manaCost: '{2}{R}' }) });
    expect(describeAlt('c11', down, 'exile', true)).toEqual({ id: 'c11', label: 'Exile · Foretold', tone: 'foretold', cost: '{R}' });
    const flagged = card('e2', 'Exile', face('Saw It Coming', ['Foretell {1}{U}']), { foretold: true });
    expect(describeAlt('e2', flagged, 'exile', true)).toMatchObject({ label: 'Exile · Foretold', cost: '{1}{U}' });
    expect(describeAlt('e3', card('e3', 'Exile', face('Slickshot', ['Plot {1}{R}'])), 'exile', true)).toEqual({ id: 'e3', label: 'Exile · Plotted', tone: 'plotted', cost: '{0}' });
    expect(describeAlt('e4', card('e4', 'Exile', face('Rift Bolt', ['Suspend 1—{R}']), { counters: { TIME: 2 } }), 'exile', true)).toEqual({ id: 'e4', label: 'Exile · Suspended, 2 time counters', tone: 'suspended', cost: '{0}' });
    expect(describeAlt('e8', card('e8', 'Exile', face('Rift Bolt', ['Suspend 1—{R}']), { counters: { TIME: 1 } }), 'exile', true).label).toBe('Exile · Suspended, 1 time counter');
    expect(describeAlt('e9', card('e9', 'Exile', face('Full Bore', ['Warp {R}'])), 'exile', false).label).toBe("Opponent's exile · Warped");
    expect(describeAlt('e5', card('e5', 'Exile', face('Full Bore', ['Warp {R}'])), 'exile', true)).toEqual({ id: 'e5', label: 'Exile · Warped', tone: 'warped' });
    const adv = card('e6', 'Exile', face('Bonecrusher Giant', []), { alt: face('Stomp', [], { type: { super: [], core: ['Instant'], sub: ['Adventure'] } }) });
    expect(describeAlt('e6', adv, 'exile', true)).toEqual({ id: 'e6', label: 'Exile · On an adventure', tone: 'adventure' });
    expect(describeAlt('e7', card('e7', 'Exile', face('Bolt')), 'exile', true)).toEqual({ id: 'e7', label: 'Exile', tone: 'exile' });
  });

  it('command zone and library keep their printed cost', () => {
    expect(describeAlt('c1', card('c1', 'Command', face('Atraxa')), 'command', true)).toEqual({ id: 'c1', label: 'Command zone', tone: 'command' });
    expect(describeAlt('l1', card('l1', 'Library', face('Bolt')), 'library', true)).toEqual({ id: 'l1', label: 'Top of library', tone: 'library' });
    expect(describeAlt('l2', card('l2', 'Library', face('Bolt')), 'library', false).label).toBe("Top of opponent's library");
  });
});

describe('altCastables', () => {
  const cards = [
    card('h1', 'Hand', face('Bolt')),
    card('b1', 'Battlefield', face('Mountain')),
    card('g1', 'Graveyard', face('Lava Dart', ['Flashback {2}{R}'])),
    card('g2', 'Graveyard', face('Looting', ['Flashback {2}{R}'])),
    card('g3', 'Graveyard', face('Dead')),
    card('e1', 'Exile', face('Slickshot', ['Plot {1}{R}'])),
    card('c1', 'Command', face('Atraxa')),
    card('o1', 'Graveyard', face('Opp thing'), { owner: 'p1', controller: 'p1' }),
  ];
  const m = game({ hand: ['h1'], battlefield: ['b1'], graveyard: ['g1', 'g2', 'g3'], exile: ['e1'], command: ['c1'], library: ['xaaa'] }, cards, { graveyard: ['o1'] });

  it('lists the playable cards outside hand and battlefield: command, graveyard, exile, in zone order', () => {
    const alt = altCastables(m, 'p0', prompt({ h1: 1, b1: 1, g2: 1, g1: 1, e1: 1, c1: 1, xaaa: 1 }));
    expect(alt.map((a) => a.id)).toEqual(['c1', 'g1', 'g2', 'e1']);
    expect(alt.map((a) => a.label)).toEqual(['Command zone', 'Graveyard · Flashback', 'Graveyard · Flashback', 'Exile · Plotted']);
  });

  it('an opponent card I can play is labelled as theirs; a weak of 0 and a non-priority prompt list nothing', () => {
    expect(altCastables(m, 'p0', prompt({ o1: 1 }))[0]).toMatchObject({ id: 'o1', label: "Opponent's graveyard" });
    expect(altCastables(m, 'p0', prompt({ g1: 0 }))).toEqual([]);
    expect(altCastables(m, 'p0', prompt({ g1: 1 }, 'payMana'))).toEqual([]);
    expect(altCastables(m, 'p0', null)).toEqual([]);
  });

  it('keeps my snoozed castables (Forge drops them from weak) so they can be woken; never a plain dead card or theirs', () => {
    // "can't unsnooze flashback card": snoozed, it left the strip, and the strip card was the one to right-click.
    const alt = altCastables(m, 'p0', prompt({ g2: 1 }), ['g1', 'g3', 'e1', 'o1']);
    expect(alt.map((a) => [a.id, a.snoozed])).toEqual([
      ['g1', true],
      ['g2', undefined],
      ['e1', true],
    ]);
    expect(alt[0]).toMatchObject({ label: 'Graveyard · Flashback', cost: '{2}{R}' });
    // Not on a non-priority prompt, and a card the prompt still marks playable is listed once, unflagged.
    expect(altCastables(m, 'p0', prompt({}, 'payMana'), ['g1'])).toEqual([]);
    expect(altCastables(m, 'p0', prompt({ g1: 1 }), ['g1']).map((a) => a.snoozed)).toEqual([undefined]);
  });

  it('altHeld keeps what was listed, minus cards that left their zone', () => {
    const before = altCastables(m, 'p0', prompt({ g1: 1, e1: 1 }));
    const after = game({ graveyard: ['g2'], exile: ['e1'] }, cards);
    expect(altHeld(before, after).map((a) => a.id)).toEqual(['e1']);
  });
});

describe('swapCue: a hand card that can swap with an unblocked attacker', () => {
  const ninja = card('n1', 'Hand', face('Ninja', ['Ninjutsu {1}{U}']));
  const sneak = card('s1', 'Hand', face('Turtle', ['Sneak {2}{G}']));
  const cmd = card('k1', 'Hand', face('Yuriko', ['Commander ninjutsu {U}{B}']));
  const plain = card('p1', 'Hand', face('Bolt'));
  const at = (phase: Phase, turn = 'p0') => game({ hand: ['n1', 's1', 'k1', 'p1'] }, [ninja, sneak, cmd, plain], {}, { phase, playerTurn: turn });
  const weak = prompt({ n1: 1, s1: 1, k1: 1, p1: 1 });

  it('shows in the blockers and damage steps of my turn with its cost', () => {
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS'), 'p0', weak, 'n1')).toEqual({ label: 'Ninjutsu', cost: '{1}{U}' });
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS'), 'p0', weak, 's1')).toEqual({ label: 'Sneak', cost: '{2}{G}' });
    expect(swapCue(at('COMBAT_DAMAGE'), 'p0', weak, 'k1')).toEqual({ label: 'Ninjutsu', cost: '{U}{B}' });
    expect(swapCue(at('COMBAT_END'), 'p0', weak, 'n1')).not.toBeNull();
  });

  it('not before blockers, not on the opponent\'s turn, not unless playable, not for other cards', () => {
    expect(swapCue(at('COMBAT_DECLARE_ATTACKERS'), 'p0', weak, 'n1')).toBeNull();
    expect(swapCue(at('MAIN1'), 'p0', weak, 'n1')).toBeNull();
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS', 'p1'), 'p0', weak, 'n1')).toBeNull();
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS'), 'p0', prompt({}), 'n1')).toBeNull();
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS'), 'p0', prompt({ n1: 1 }, 'declareBlockers'), 'n1')).toBeNull();
    expect(swapCue(at('COMBAT_DECLARE_BLOCKERS'), 'p0', weak, 'p1')).toBeNull();
  });
});

describe('keywordCostText', () => {
  it('reads a cost in words after the keyword (the zone viewer’s Play button), nothing for mana or none', () => {
    expect(keywordCostText(face('x', ['Flashback—Sacrifice a Mountain']), 'Flashback')).toBe('Sacrifice a Mountain');
    expect(keywordCostText(face('x', ['Flashback {2}{R}']), 'Flashback')).toBeUndefined();
    expect(keywordCostText(face('x', ['Flashback']), 'Flashback')).toBeUndefined();
  });
});

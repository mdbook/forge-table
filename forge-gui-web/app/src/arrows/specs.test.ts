import { describe, expect, it } from 'vitest';
import type { Card, GameModel, Player, PromptBody } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { arrowSpecs, blockerMap, defenderOf, targetSource } from './specs';

const card = (id: string, controller: string, zone = 'Battlefield'): Card => ({ id, controller, zone, state: { face: 'Original', name: id } });

function model(game: Partial<GameModel['game']>, cards: Card[]): GameModel {
  return modelOf(
    { turn: 3, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p1', stack: [], ...game },
    { p0: { id: 'p0', life: 20, zones: {} as Player['zones'] }, p1: { id: 'p1', life: 20, zones: {} as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}
const all = () => true;
const prompt = (kind: string, extra: Partial<PromptBody> = {}): PromptBody => ({
  pid: 1,
  kind,
  message: '',
  ok: { label: '', enabled: true },
  cancel: { label: '', enabled: false },
  focusOk: false,
  selectable: [],
  highlighted: [],
  weak: {},
  ...extra,
});

describe('combat arrows', () => {
  const m = model(
    {
      combat: [
        { attacker: 'a1', defender: 'p0', blockers: ['b1'], planned: ['b1', 'b2'] },
        { attacker: 'a2', blockers: [] },
        { attacker: 'a3', defender: 'w1', blockers: [] },
      ],
    },
    [card('a1', 'p1'), card('a2', 'p1'), card('a3', 'p1'), card('b1', 'p0'), card('b2', 'p0'), card('w1', 'p0')],
  );

  it('maps blockers (locked and planned) to their attacker; a band without a defender attacks the other player', () => {
    expect([...blockerMap(m.game.combat)]).toEqual([
      ['b1', 'a1'],
      ['b2', 'a1'],
    ]);
    expect(defenderOf(m, m.game.combat![1]!)).toBe('p0');
  });

  it('draws red attacker → defender (player or planeswalker) and blue blocker → attacker, for both players', () => {
    const specs = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all });
    // a1 is blocked: its blockers' arrows replace its own.
    expect(specs.map((s) => s.key)).toEqual(['attack:a2', 'attack:a3', 'block:b1:a1', 'block:b2:a1']);
    expect(specs[0]).toMatchObject({ kind: 'attack', from: { card: 'a2' }, to: { player: 'p0' } });
    expect(specs[1]).toMatchObject({ to: { card: 'w1' } });
    expect(specs[2]).toMatchObject({ kind: 'block', from: { card: 'b1' }, to: { card: 'a1' } });
    // The same from the attacker's side of the table.
    expect(arrowSpecs({ model: m, viewer: 'p1', prompt: null, visible: all }).length).toBe(4);
  });

  it('skips ends that are not on the table', () => {
    const specs = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: (id) => id !== 'b2' && id !== 'w1' });
    expect(specs.map((s) => s.key)).toEqual(['attack:a2', 'block:b1:a1']);
  });
});

it('a swarm at a player draws only the hovered attacker\'s arrow', () => {
  const ids = ['s0', 's1', 's2'];
  const m = model({ combat: ids.map((attacker) => ({ attacker, blockers: [] })) }, ids.map((id) => card(id, 'p1')));
  expect(arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all })).toEqual([]);
  expect(arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, hoverStack: 's2' }).map((s) => s.key)).toEqual(['attack:s2']);
});

describe('target arrows', () => {
  const stack = [
    { id: 's2', text: 'Shock', source: 'c2', activator: 'p1', ability: false, trigger: false, targets: ['c9'] },
    { id: 's1', text: 'Bolt', source: 'c1', activator: 'p0', ability: false, trigger: false, targets: ['p1', 'c8'] },
  ];
  const m = model({ stack }, [card('c1', 'p0', 'Stack'), card('c2', 'p1', 'Stack'), card('c8', 'p1'), card('c9', 'p0')]);

  it('draws the top stack item’s targets always and a hovered item’s too', () => {
    expect(arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all }).map((s) => s.key)).toEqual(['target:c2:c9']);
    const hovered = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, hoverStack: 's1' });
    expect(hovered.map((s) => s.key)).toEqual(['target:c2:c9', 'target:c1:p1', 'target:c1:c8']);
    // Hovering the item's card works the same.
    expect(arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, hoverStack: 'c1' }).length).toBe(3);
  });

  it('a hovered item’s arrows stand out (the others dim); hovering a target lights the items aiming at it', () => {
    const hovered = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, hoverStack: 's1' });
    expect(hovered.find((s) => s.key === 'target:c2:c9')).toMatchObject({ dim: true });
    expect(hovered.find((s) => s.key === 'target:c1:p1')).not.toHaveProperty('dim');
    // c8 is Bolt's target: hovering it shows Bolt's arrows.
    expect(arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, hoverStack: 'c8' }).map((s) => s.key)).toEqual(['target:c2:c9', 'target:c1:p1', 'target:c1:c8']);
  });

  it('an ability’s arrows start at its ability card on the stack, else at its source', () => {
    const ab = { id: 's3', text: 'Pinger: deal 1 damage', source: 'c7', activator: 'p0', ability: true, trigger: false, targets: ['c9'] };
    const m2 = model({ stack: [ab] }, [card('c7', 'p0'), card('c9', 'p1')]);
    expect(arrowSpecs({ model: m2, viewer: 'p0', prompt: null, visible: all }).map((s) => s.key)).toEqual(['target:ab:s3:c9']);
    expect(arrowSpecs({ model: m2, viewer: 'p0', prompt: null, visible: (id) => id !== 'ab:s3' }).map((s) => s.key)).toEqual(['target:c7:c9']);
    // Hovering the ability card is hovering the item.
    expect(arrowSpecs({ model: { ...m2, game: { ...m2.game, stack: [{ ...ab, id: 's4', targets: [] }, ab] } }, viewer: 'p0', prompt: null, visible: all, hoverStack: 'ab:s3' }).map((s) => s.key)).toEqual(['target:ab:s3:c9']);
  });

  it('locks in the targets chosen so far, and draws the pending arrow from the source to the cursor', () => {
    const p = prompt('chooseTargets', { card: 'c1', highlighted: ['p1'] });
    expect(targetSource(m, p)).toBe('c1');
    expect(targetSource(m, prompt('chooseTargets'))).toBe('c2');
    const specs = arrowSpecs({ model: m, viewer: 'p0', prompt: p, visible: all, pending: { kind: 'target', from: 'c1', to: { point: { x: 10, y: 20 } } } });
    expect(specs.map((s) => s.key)).toEqual(['target:c2:c9', 'target:c1:p1', 'pending:target:c1']);
    expect(specs[2]).toMatchObject({ pending: true, to: { point: { x: 10, y: 20 } } });
  });
});

describe('ward arrows (director/protection.ts)', () => {
  const warded: Card = { id: 'w1', controller: 'p1', zone: 'Battlefield', state: { face: 'Original', name: 'Warded', keywords: [{ title: 'Ward {2}' }] } };
  const trigger = (text: string) => ({ id: 's5', text, source: 'w1', ability: true, trigger: true, targets: [] as string[] });

  it('a ward trigger on the stack links its ability card to the permanent it guards', () => {
    const m = model({ stack: [trigger('Ward {2} (counter it unless that player pays {2}.)')] }, [warded]);
    const ward = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all }).filter((a) => a.kind === 'ward');
    expect(ward).toEqual([{ key: 'ward:ab:s5:w1', kind: 'ward', from: { card: 'ab:s5' }, to: { card: 'w1' } }]);
  });

  it('other triggers of a warded card and ward-less cards link nothing', () => {
    const other = model({ stack: [trigger('Draw a card.')] }, [warded]);
    expect(arrowSpecs({ model: other, viewer: 'p0', prompt: null, visible: all }).filter((a) => a.kind === 'ward')).toEqual([]);
  });

  it('a pending arrow turned away carries deflect', () => {
    const m = model({}, [warded, card('s1', 'p0', 'Stack')]);
    const specs = arrowSpecs({ model: m, viewer: 'p0', prompt: null, visible: all, pending: { kind: 'target', from: 's1', to: { card: 'w1' }, deflect: true } });
    expect(specs.find((a) => a.pending)).toMatchObject({ deflect: true });
  });
});

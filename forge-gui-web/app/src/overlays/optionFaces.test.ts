import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CardFace, ChooseAsk, GameModel } from '@forge-table/protocol';
import { OptionCards } from './OptionCards';

// The cards paint on a canvas (no canvas in a server render): stand-ins that say what they would paint.
vi.mock('../cards/OptionCardView', () => ({
  OptionCardView: ({ text, cost }: { text: string; cost?: string }) => createElement('i', { 'data-text': text, 'data-cost': cost }),
  useArtBox: () => null,
}));
import { optionCardFit, optionFaces, optionHost } from './optionFaces';

const LAND_GRANT: CardFace = { face: 'Original', name: 'Land Grant', manaCost: '{1}{G}', colors: 'G', type: { super: [], core: ['Sorcery'], sub: [] }, oracleText: '' };
const COMMAND: CardFace = { face: 'Original', name: "Kolaghan's Command", manaCost: '{1}{B}{R}', colors: 'BR', type: { super: [], core: ['Instant'], sub: [] } };
const model = (cards: Record<string, CardFace>) => ({ cards: Object.fromEntries(Object.entries(cards).map(([id, state]) => [id, { id, state }])) }) as unknown as GameModel;
const M = model({ c1: LAND_GRANT, c7: COMMAND, c8: COMMAND });

const SEARCH = 'Search your library for a Forest card, reveal that card, put it into your hand, then shuffle.';
// As BridgeGuiGame.getAbilityToPlay sends Land Grant's two ways to cast it (StaticAbilityAlternativeCost's description).
const GRANT: ChooseAsk = {
  t: 'ask', seq: 1, id: 'q1', kind: 'ability', message: 'Choose an ability', min: 0, max: 1, card: 'c1',
  items: [
    { idx: 0, label: SEARCH, card: 'c1', enabled: true },
    { idx: 1, label: `${SEARCH} (If you have no land cards in hand, you may reveal your hand rather than pay this spell's mana cost.) `, card: 'c1', enabled: true },
  ],
};
// As PlayerControllerHuman.chooseModeForAbility asks: one mode per ask, every item the host card.
const MODES: ChooseAsk = {
  t: 'ask', seq: 1, id: 'm1', kind: 'choose', message: "Player activated Kolaghan's Command - Choose a mode", min: 1, max: 1,
  items: [
    { idx: 0, label: 'Return target creature card from your graveyard to your hand.', card: 'c7' },
    { idx: 1, label: 'Target player discards a card.', card: 'c7' },
    { idx: 2, label: 'Destroy target artifact.', card: 'c7' },
  ],
};

describe('optionHost (which asks are one card\'s options)', () => {
  it('takes an ability menu, a mode choice and several items on one card', () => {
    expect(optionHost(GRANT, M)).toBe('c1');
    expect(optionHost(MODES, M)).toBe('c7');
    expect(optionHost({ ...MODES, message: 'Choose abilities to copy', max: 2 }, M)).toBe('c7');
    // A lone mode (the last one left) is still a mode.
    expect(optionHost({ ...MODES, items: MODES.items.slice(0, 1) }, M)).toBe('c7');
  });

  it('leaves card choices, several cards, players, unknown faces and reveals alone', () => {
    expect(optionHost({ ...MODES, message: 'Choose a card', items: MODES.items.slice(0, 1) }, M)).toBeNull();
    expect(optionHost({ ...MODES, items: [MODES.items[0]!, { ...MODES.items[1]!, card: 'c8' }] }, M)).toBeNull();
    expect(optionHost({ ...MODES, items: [...MODES.items, { idx: 3, label: 'Opponent', player: 'p1' }] }, M)).toBeNull();
    expect(optionHost({ ...MODES, items: MODES.items.map((it) => ({ ...it, card: 'c99' })) }, M)).toBeNull();
    expect(optionHost({ ...MODES, reveal: true }, M)).toBeNull();
    expect(optionHost({ ...GRANT, items: GRANT.items.map(({ card: _c, ...it }) => it), card: undefined }, M)).toBeNull();
  });
});

describe('optionFaces (what each option card says)', () => {
  it('puts an alternative cost first, out of its parentheses, with no mana on the plate', () => {
    const [cast, alt] = optionFaces(GRANT, LAND_GRANT);
    expect(cast).toEqual({ idx: 0, enabled: true, text: SEARCH, caption: 'Cast' });
    expect(alt!.text).toBe(`If you have no land cards in hand, you may reveal your hand rather than pay this spell's mana cost.\n${SEARCH}`);
    expect(alt!.cost).toBe('');
    expect(alt!.caption).toBe('Alternative cost');
  });

  it('shows a paid alternative cost on the plate', () => {
    const ask = { ...GRANT, items: [GRANT.items[0]!, { ...GRANT.items[0]!, idx: 1, label: `${SEARCH} (by paying {2}{U} instead of its mana cost)` }] };
    const alt = optionFaces(ask, LAND_GRANT)[1]!;
    expect(alt.cost).toBe('{2}{U}');
    expect(alt.text.split('\n')[0]).toBe('You may cast this spell by paying {2}{U} instead of its mana cost.');
  });

  it('reads a keyword cost (flashback) onto the plate and captions the set', () => {
    const ask: ChooseAsk = { ...GRANT, items: [{ idx: 0, label: 'Lava Dart deals 1 damage to any target.', card: 'c1' }, { idx: 1, label: 'Flashback {2}{R} (You may cast this card from your graveyard)', card: 'c1' }] };
    const [cast, fb] = optionFaces(ask, LAND_GRANT);
    expect(cast).toMatchObject({ caption: 'Cast' });
    expect(cast!.cost).toBeUndefined();
    expect(fb).toMatchObject({ caption: 'Flashback', cost: '{2}{R}', text: 'Flashback {2}{R} (You may cast this card from your graveyard)' });
  });

  it('keeps modes and abilities as their own text, printed cost, no caption', () => {
    expect(optionFaces(MODES, COMMAND)).toEqual(MODES.items.map((it) => ({ idx: it.idx, enabled: true, text: it.label })));
    const off = optionFaces({ ...GRANT, items: [{ idx: 0, label: '{T}: Add {G}.', card: 'c1', enabled: false }, { idx: 1, label: '{2}: Draw a card.', card: 'c1' }] }, LAND_GRANT);
    expect(off.map((o) => [o.enabled, o.caption])).toEqual([[false, undefined], [true, undefined]]);
  });
});

describe('optionCardFit (as large as fits)', () => {
  const A = 0.716;
  it('keeps a few options in one row, capped', () => {
    expect(optionCardFit(2, 1300, 600, A, 16, 400)).toEqual({ height: 400, cols: 2 });
    // Two rows of three would be only a little bigger: one row.
    const six = optionCardFit(6, 1300, 600, A, 16, 400);
    expect(six.cols).toBe(6);
    expect(6 * six.height * A + 5 * 16).toBeLessThanOrEqual(1300);
  });

  it('stays readable on a phone: one wide column that scrolls, the next card peeking out', () => {
    const phone = optionCardFit(2, 270, 430, A, 16, 440, 240, 44);
    expect(phone.cols).toBe(1);
    expect(phone.height).toBeGreaterThanOrEqual(240);
    expect(phone.height).toBeLessThanOrEqual(430 * 0.8);
  });

  it('wraps to rows on a narrow screen when that makes the cards bigger', () => {
    const phone = optionCardFit(4, 320, 560, A, 12, 400);
    expect(phone.cols).toBe(2);
    expect(phone.height).toBeGreaterThan(2 * Math.floor((320 - 36) / (4 * A))); // twice one row's
    expect(2 * phone.height + 12).toBeLessThanOrEqual(560);
    expect(2 * phone.height * A + 12).toBeLessThanOrEqual(320);
  });
});

describe('OptionCards', () => {
  it('draws a card per option under the frame, no side preview, no engine sentence for modes', () => {
    const html = renderToStaticMarkup(createElement(OptionCards, { ask: MODES, host: 'c7', model: M, onReply: () => {} }));
    expect(html).toContain('data-testid="ask-option-cards"');
    expect(html).toContain('Choose a mode');
    expect(html).not.toContain('Player activated');
    expect(html.match(/class="option-card /g)).toHaveLength(3);
    expect(html).not.toContain('ask-preview');
    expect(html).not.toContain('pf-source');
    expect(html).not.toContain('No more modes');
    expect(renderToStaticMarkup(createElement(OptionCards, { ask: { ...MODES, min: 0 }, host: 'c7', model: M, onReply: () => {} }))).toContain('No more modes');
  });

  it('captions ways to cast and offers Cancel in an ability menu', () => {
    const html = renderToStaticMarkup(createElement(OptionCards, { ask: GRANT, host: 'c1', model: M, onReply: () => {} }));
    expect(html).toContain('Alternative cost');
    expect(html).toContain('>Cast<');
    expect(html).toContain('Cancel');
  });

  it('counts a multi-pick and names the options on the button', () => {
    const html = renderToStaticMarkup(createElement(OptionCards, { ask: { ...MODES, message: 'Choose two', min: 2, max: 2 }, host: 'c7', model: M, onReply: () => {} }));
    expect(html).toContain('data-testid="pf-count"');
    expect(html).toContain('Choose 2 options');
  });
});

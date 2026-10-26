import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChooseAsk } from '@forge-table/protocol';
import type { GameModel } from '@forge-table/protocol';
import { chooseLabel, confirmWords, PromptFrame, sourceCard, type PromptFrameProps } from './PromptFrame';

const ASK: ChooseAsk = { t: 'ask', seq: 1, id: 'a1', kind: 'choose', items: [], min: 1, max: 2, title: 'Choose two', message: 'Pick the modes' };

const render = (p: Partial<PromptFrameProps>) =>
  renderToStaticMarkup(createElement(PromptFrame, { ask: ASK, testId: 'ask-test', children: createElement('i', null, 'body'), ...p }));

describe('prompt frame (B1)', () => {
  it('is a labelled modal dialog with the title, the instruction and the body', () => {
    const html = render({});
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    expect(html).toContain('data-testid="ask-test"');
    expect(html).toContain('Choose two');
    expect(html).toContain('Pick the modes');
    expect(html).toContain('<i>body</i>');
  });

  it('counts picks with one meter segment per pick, a bar past ten, and "1 of 1" for a single pick (B3)', () => {
    const two = render({ count: { n: 1, of: 2 } });
    expect(two).toContain('<em>1</em> of 2');
    expect(two.match(/<i class="f"><\/i>/g)).toHaveLength(1);
    expect(two.match(/<i><\/i>/g)).toHaveLength(1);
    expect(render({ count: { n: 3, of: 12 } })).toContain('pf-meter bar');
    expect(render({ count: { n: 0, of: 1 } })).toContain('<em>0</em> of 1');
    expect(render({ count: { n: 0, of: 0 } })).not.toContain('pf-count');
  });

  it('puts key hints, secondaries and the named primary in the footer', () => {
    const html = render({
      keys: [['1 – 4', 'pick'], ['Enter', 'confirm']],
      secondary: [false, { label: 'Cancel', onClick: () => {}, testId: 'ask-none' }],
      primary: { label: 'Cast with these modes', onClick: () => {}, disabled: true },
    });
    expect(html).toContain('<kbd>1</kbd><span>–</span><kbd>4</kbd> pick');
    expect(html).toContain('data-testid="ask-none"');
    expect(html).toMatch(/<button class="btn primary pf-primary" disabled="" data-testid="ask-done">Cast with these modes<\/button>/);
  });

  it('falls back to its own title when the engine sends none', () => {
    const { title: _t, ...bare } = ASK;
    expect(render({ ask: bare, title: 'Top or bottom' })).toContain('Top or bottom');
  });

  it('names the pick count on the primary', () => {
    expect(chooseLabel(0)).toBe('Done');
    expect(chooseLabel(1)).toBe('Choose 1 card');
    expect(chooseLabel(3, 'option')).toBe('Choose 3 options');
  });

  it('turns a confirm question into a title and a note (B6)', () => {
    expect(confirmWords('Use triggered ability of Sentinel (12)?\n(Whenever Sentinel attacks, draw a card.)')).toEqual({
      title: 'Use triggered ability of Sentinel?',
      message: '(Whenever Sentinel attacks, draw a card.)',
    });
    expect(confirmWords('Put Ponder on the bottom?')).toEqual({ title: 'Put Ponder on the bottom?' });
    expect(confirmWords('x'.repeat(91))).toEqual({ message: 'x'.repeat(91) });
    expect(confirmWords(undefined)).toEqual({});
  });
});

describe('prompt frame head (B1)', () => {
  it('makes a short engine instruction the title when there is none', () => {
    const html = render({ ask: { ...ASK, title: undefined, message: 'Choose a creature to sacrifice\n(Its controller loses 2 life.)' } });
    expect(html).toMatch(/<h2[^>]*>.*Choose a creature to sacrifice/);
    expect(html).toContain('(Its controller loses 2 life.)');
  });

  it('names the asking card: the one the engine sends, else the top of the stack for a choice', () => {
    const model = { game: { stack: [{ id: 's1', text: '', source: 'c9', ability: false, trigger: false, targets: [] }] }, players: {}, cards: { c1: { id: 'c1' }, c9: { id: 'c9' } } } as unknown as GameModel;
    expect(sourceCard({ ...ASK, card: 'c1' }, model)?.id).toBe('c1');
    expect(sourceCard(ASK, model)?.id).toBe('c9');
    expect(sourceCard({ t: 'ask', seq: 1, id: 'x', kind: 'confirm', options: [], default: 0 }, model)).toBeUndefined();
  });
});

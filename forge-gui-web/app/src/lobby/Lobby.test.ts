import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bootView, type DeckList, type DirectInvite, type MatchInfo, type OpenGame } from './api';
import { Boot, InviteCard, Sheet, Waiting } from './Lobby';

const starting = (progress?: MatchInfo['progress']): MatchInfo => ({ id: 'a1', status: 'starting', created: 1, ...(progress ? { progress } : {}) });

describe('starting row', () => {
  it('shows the stage, its percent and the seconds so far', () => {
    const v = bootView(starting({ stage: 'cards', label: 'Loading card database', pct: 63, elapsed: 7.8 }));
    expect(v).toEqual({ text: 'Loading card database… 63%', label: 'Loading card database…', pct: 63, elapsed: '7 s' });
  });

  it('falls back to a bare "Starting…" when the server sends no progress', () => {
    expect(bootView(starting())).toEqual({ text: 'Starting…', label: 'Starting…', pct: 0, elapsed: null });
  });

  it('keeps the percent inside 0–100', () => {
    expect(bootView(starting({ stage: 'table', label: 'Setting the table', pct: 140, elapsed: -3 })).pct).toBe(100);
    expect(bootView(starting({ stage: 'java', label: 'Starting Java', pct: -5, elapsed: 0 })).text).toBe('Starting Java… 0%');
  });

  it('renders an accessible progress bar', () => {
    const html = renderToStaticMarkup(
      createElement(Boot, { match: starting({ stage: 'ai', label: 'Preparing the AI opponent', pct: 81, elapsed: 14 }) }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="81"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuetext="Preparing the AI opponent… 81%"');
    expect(html).toContain('>Preparing the AI opponent…</span>');
    expect(html).toContain('>81%</span>');
    expect(html).toContain('14 s');
    expect(html).toContain('width:81%');
    expect(html).not.toContain('boot-hint');
  });

  it('says what happens next, in the same block, only where this tab opens the game', () => {
    const html = renderToStaticMarkup(
      createElement(Boot, { match: starting({ stage: 'ai', label: 'Preparing the AI opponent', pct: 80, elapsed: 8 }), hint: 'It opens by itself when it’s ready.' }),
    );
    expect(html).toMatch(/class="boot-meta"><span class="boot-hint">It opens by itself when it’s ready.<\/span><span class="boot-elapsed">8 s<\/span>/);
  });

  it('renders text, never markup, from the label', () => {
    const html = renderToStaticMarkup(createElement(Boot, { match: starting({ stage: 'cards', label: '<b>x</b>', pct: 10, elapsed: 1 }) }));
    expect(html).not.toContain('<b>');
  });
});

describe('an invite card', () => {
  const list = (names: string[]): DeckList => ({ names, details: { Burn: { cards: 60, colors: 'R', key: 'Lightning Bolt' } } });
  const card = (disabled = false, decks: DeckList | null | 'loading' = list(['Burn', 'Faeries'])) =>
    renderToStaticMarkup(
      createElement(InviteCard, {
        invite: { game: 'g1', from: 'Alice', expires: 1_000 + 754_000, format: 'brawl' },
        decks: decks === 'loading' ? undefined : decks,
        now: 1_000,
        disabled,
        cropUrl: (c: string) => `/crop/${c}`,
        onAccept: async () => {},
        onDecline: async () => {},
      }),
    );

  it('says who invited me, the format and for how long, with my last deck as a chip, Accept and Decline', () => {
    const html = card();
    expect(html).toContain('<strong>Alice</strong> invited you');
    expect(html).toContain('Brawl · expires in 12:34');
    expect(html).toContain('data-testid="deck-chip"');
    expect(html).toContain('aria-label="Your deck: Burn. Change"');
    expect(html).toContain('src="/crop/Lightning Bolt"');
    expect(html).not.toContain('<option');
    expect(html).toContain('data-testid="invite-accept"');
    expect(html).toContain('data-testid="invite-decline"');
    expect(html).not.toContain('g1');
  });

  it('falls back to the deck field while loading or where the server can’t list decks', () => {
    expect(card(false, 'loading')).toContain('Loading your decks');
    expect(card(false, null)).toContain('placeholder="Deck name"');
  });

  it('can’t accept at the cap or without a deck, but can always decline', () => {
    expect(card(true)).toMatch(/disabled=""[^>]*data-testid="invite-accept"/);
    expect(card(false, list([]))).toMatch(/disabled=""[^>]*data-testid="invite-accept"/);
    expect(card(true)).not.toMatch(/disabled=""[^>]*data-testid="invite-decline"/);
    expect(card(false)).not.toMatch(/disabled=""[^>]*data-testid="invite-accept"/);
  });
});

describe('waiting for you', () => {
  const html = (invites: DirectInvite[], games: OpenGame[]) =>
    renderToStaticMarkup(
      createElement(Waiting, {
        invites,
        games,
        decksFor: () => ({ names: ['Burn'], details: {} }),
        cropUrl: (c: string) => c,
        now: 400_000,
        disabled: false,
        onAccept: async () => {},
        onDecline: async () => {},
        onJoin: async () => {},
      }),
    );

  it('lists invites first, then open tables with host, format and age, in one list', () => {
    const out = html([{ game: 'g1', from: 'Alice', expires: 900_000 }], [{ id: 'o1', host: '<b>Sam</b>', created: 100_000, format: 'brawl' }]);
    expect(out.indexOf('invite-card')).toBeLessThan(out.indexOf('open-o1'));
    expect(out).toContain('&lt;b&gt;Sam&lt;/b&gt;</strong>’s open table');
    expect(out).toContain('Brawl · 5 min ago');
    expect(out).toContain('data-testid="open-join"');
    expect(out).toContain('>2</span>');
  });

  it('says nothing is waiting when it is empty', () => {
    expect(html([], [])).toContain('Nothing waiting');
    expect(html([], [])).not.toContain('data-testid="waiting"');
  });
});

describe('a bottom sheet (phones)', () => {
  it('is a labelled modal dialog with a grab handle, its title, a close X and its content', () => {
    const html = renderToStaticMarkup(createElement(Sheet, { title: 'Play a friend', className: 'friend-sheet', onClose: () => {}, children: createElement('p', null, 'form') }));
    expect(html).toContain('class="sheet-layer friend-sheet"');
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Play a friend"/);
    expect(html).toContain('class="sheet-grab"');
    expect(html).toContain('<h2 class="sheet-title">Play a friend</h2>');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<div class="sheet-body"><p>form</p></div>');
  });
});

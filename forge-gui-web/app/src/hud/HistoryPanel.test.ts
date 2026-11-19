import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntry, Player } from '@forge-table/protocol';

vi.mock('../runtime', () => ({ runtime: () => ({ toast: () => {} }) }));
vi.mock('./Panels', () => ({ FloatingCard: () => null }));

import { useUi, type UiState } from '../store/uiStore';
import { HistoryPanel } from './HistoryPanel';

/** A server render reads the store's initial state (useSyncExternalStore's server snapshot), so seed that. */
const seed = (patch: Partial<UiState>) => Object.assign(useUi.getInitialState(), patch);

const entries: LogEntry[] = [
  { turn: 0, kind: 'mulligan', text: 'Alphu has kept a hand of 7 cards', player: 'p0' },
  { turn: 1, phase: 'MAIN1', active: 'p0', kind: 'stackAdd', text: 'Alphu cast Candy Trail', player: 'p0', card: 'Candy Trail' },
  { turn: 2, phase: 'COMBAT_DAMAGE', active: 'p1', kind: 'damage', text: 'Delver deals 1 combat damage to Alphu.', player: 'p1' },
];

describe('HistoryPanel', () => {
  it('renders nothing while closed', () => {
    seed({ historyOpen: false, history: { game: 1, entries } });
    expect(renderToStaticMarkup(createElement(HistoryPanel))).toBe('');
  });

  it('draws the lines under turn and step headings, with the card named and a line count', () => {
    const shown = useUi.getInitialState().shown;
    seed({
      historyOpen: true,
      viewer: 'p0',
      history: { game: 1, entries },
      shown: { ...shown, players: { p0: { id: 'p0', name: 'Alphu', life: 20, zones: {} as Player['zones'] }, p1: { id: 'p1', name: 'Blue Terror', life: 20, zones: {} as Player['zones'] } } },
    });
    const html = renderToStaticMarkup(createElement(HistoryPanel));
    expect(html).toContain('Before the game');
    expect(html).toContain('Your turn');
    expect(html).toContain('Blue Terror’s turn');
    expect(html).toContain('Main 1');
    expect(html).toContain('<span class="hist-card">Candy Trail</span>');
    expect(html).toContain('3 lines');
    expect(html.match(/data-testid="hist-line"/g)).toHaveLength(3);
  });
});

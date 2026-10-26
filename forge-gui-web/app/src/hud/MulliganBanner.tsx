/**
 * The mulligan banner over the raised hand. Where you stand (on the play or the draw), the question,
 * how many you'd keep, and quick hand facts (lands, spells, top mana value), which a click hides for good. During
 * the London tuck: how many go to the bottom, with a counter. The buttons (Actions.tsx) say the outcome.
 */
import { useState } from 'react';
import { loadPref, savePref } from '../config';
import { zone } from '../store/model';
import { useUi } from '../store/uiStore';
import { hasCommanders } from '../table/commander';
import { handFacts, mullInfo, type MullInfo } from './mulligan';
import { ManaText } from './ManaText';

const FACTS_PREF = 'handFacts';

/** The banner's counts for the prompt on screen (also the buttons' labels); null when it isn't a mulligan. */
export function useMullInfo(): MullInfo | null {
  const prompt = useUi((s) => s.prompt);
  const mull = useUi((s) => s.mull);
  const hand = useUi((s) => zone(s.shown, s.viewer, 'hand').length);
  // Brawl's first mulligan is free: the sidecar's format, or the commanders on the table (a replay has no welcome).
  const free = useUi((s) => (s.welcome?.format === 'brawl' || hasCommanders(s.shown) ? 1 : 0));
  return mullInfo(prompt, hand, mull, free);
}

export function MulliganBanner() {
  const info = useMullInfo();
  const shown = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const blocked = useUi((s) => s.asks.length > 0);
  const [facts, setFacts] = useState(() => loadPref(FACTS_PREF) !== '0');
  if (!info || blocked) return null;
  const f = handFacts(zone(shown, viewer, 'hand').map((id) => shown.cards[id]));
  const showFacts = info.kind === 'keep' && f.lands + f.spells > 0;
  const toggle = () => {
    savePref(FACTS_PREF, facts ? '0' : '1');
    setFacts(!facts);
  };
  return (
    <div className="mull-banner" data-testid="mull-banner" role="status">
      {info.seat && (
        <span className={`mull-seat ${info.seat}`} data-testid="mull-seat">
          {info.seat === 'play' ? 'On the play' : 'On the draw'}
        </span>
      )}
      <div className="mull-text">
        <div className="mull-title">{info.title}</div>
        <div className="mull-sub">{info.sub}</div>
      </div>
      {showFacts &&
        (facts ? (
          <button className="mull-facts" title="Hide hand facts" onClick={toggle} data-testid="mull-facts">
            {f.lands} {f.lands === 1 ? 'land' : 'lands'} · {f.spells} {f.spells === 1 ? 'spell' : 'spells'}
            {f.top !== null && (
              <span className="mull-top">
                all ≤ <ManaText text={`{${f.top}}`} />
              </span>
            )}
          </button>
        ) : (
          <button className="mull-facts off" title="Show hand facts" onClick={toggle} data-testid="mull-facts">
            Hand facts
          </button>
        ))}
      {(info.tuck || info.kind === 'start') && <span className="mull-hint">Tap a card to toggle it</span>}
      {info.tuck && (
        <div className="pf-count mull-count" data-testid="mull-count">
          <div className="big num">
            <em>{info.tuck.chosen}</em> of {info.tuck.n}
          </div>
          <div className="pf-meter" aria-hidden="true">
            {Array.from({ length: Math.min(info.tuck.n, 10) }, (_, i) => (
              <i key={i} className={i < info.tuck!.chosen ? 'f' : undefined} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A choice among one card's options (its abilities, its modes, the ways to cast it) as a row of cards: each option is
 * the source card with only that option in its text box (optionFaces.ts, cards/OptionCardView.tsx), so there is no
 * separate preview. Click a card to pick it (cyan ring), click it again or press Enter to confirm; 1–9 pick; Esc backs
 * out when the engine allows none. Several picks (max > 1) count up to the most allowed, with numbered badges.
 * Forge asks for one mode at a time (PlayerControllerHuman.chooseModeForAbility, "<player> activated <card> - Choose a
 * mode"), so a "choose two" is two asks, the second over the modes left.
 */
import { useEffect, useState } from 'react';
import type { ChooseAsk, GameModel } from '@forge-table/protocol';
import { OptionCardView } from '../cards/OptionCardView';
import { CARD_ASPECT } from '../layout/geometry';
import { pickLabel } from '../table/selection';
import { hudScale, useHotkeys } from './askCards';
import { isModeTitle, optionCardFit, optionFaces } from './optionFaces';
import { PickBadge } from './PickBadge';
import { chooseLabel, PromptFrame } from './PromptFrame';

/** The room the cards get: the frame's width less its padding, its height less the head and foot. */
function useFit(n: number, captions: boolean) {
  const [size, setSize] = useState(() => (typeof window === 'undefined' ? { w: 1440, h: 900 } : { w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const hs = hudScale();
  const w = Math.min(size.w * 0.92, 1500 * hs) - 48 * hs - 40;
  const h = size.h * 0.88 - 64 * hs - 200 * hs;
  // Each row: the key flag and the lift (and the caption) besides the card. Under 240 px a card's text is too small.
  return optionCardFit(n, w, h, CARD_ASPECT, Math.round(16 * hs), Math.round(440 * hs), Math.round(240 * hs), Math.round((captions ? 44 : 22) * hs));
}

export function OptionCards({ ask, host, model, onReply }: { ask: ChooseAsk; host: string; model: GameModel; onReply: (v: unknown) => void }) {
  const card = model.cards[host]!;
  const options = optionFaces(ask, card.state!);
  const mode = isModeTitle(ask);
  const ways = options.some((o) => o.caption);
  const [sel, setSel] = useState<number[]>(ask.selected ?? []);
  const need = Math.max(1, ask.min);
  const ok = sel.length >= need && sel.length <= ask.max;
  const submit = () => ok && onReply(sel);
  const pick = (idx: number) => {
    const o = options.find((x) => x.idx === idx);
    if (!o?.enabled) return;
    if (sel.includes(idx)) {
      // A second click on the only pick confirms it.
      if (ask.max === 1) onReply([idx]);
      else setSel(sel.filter((x) => x !== idx));
    } else if (ask.max === 1) setSel([idx]);
    else if (sel.length < ask.max) setSel([...sel, idx]);
  };
  const keyed = options.slice(0, 9);
  useHotkeys(
    (e) => {
      const k = Number.parseInt(e.key, 10);
      if (k >= 1 && k <= keyed.length) {
        e.preventDefault();
        const idx = keyed[k - 1]!.idx;
        // A key picks (never confirms: Enter does).
        if (!sel.includes(idx) || ask.max > 1) pick(idx);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && ask.min === 0) {
        e.preventDefault();
        onReply([]);
      }
    },
    [sel, ok],
  );
  const fit = useFit(options.length, ways);
  // A mode choice: "Choose a mode" is the title, the engine's "<player> activated <card> - Choose a mode" goes.
  const { message: _engine, ...rest } = ask;
  const framed: ChooseAsk = mode ? { ...rest, title: 'Choose a mode', card: host } : { ...ask, card: host };
  const none = ask.min === 0 && sel.length === 0 && { label: mode ? 'No more modes' : ask.kind === 'ability' ? 'Cancel' : 'None', onClick: () => onReply([]), testId: 'ask-none' };
  const label = ask.max > 1 ? chooseLabel(Math.max(sel.length, need), 'option') : ways ? 'Cast' : mode ? 'Choose mode' : ask.kind === 'ability' ? 'Activate' : 'Choose';
  return (
    <PromptFrame
      ask={framed}
      model={model}
      testId="ask-option-cards"
      className="option-ask"
      noThumb
      count={ask.max > 1 ? { n: sel.length, of: ask.max } : null}
      keys={[
        [keyed.length > 1 ? `1 – ${keyed.length}` : '1', 'pick'],
        ['Enter', 'confirm'],
        ...(ask.min === 0 ? ([['Esc', mode ? 'no more' : ask.kind === 'ability' ? 'cancel' : 'none']] as [string, string][]) : []),
        ['V', 'table'],
      ]}
      secondary={[none]}
      primary={{ label, onClick: submit, disabled: !ok }}
    >
      <div className="option-cards" style={{ gridTemplateColumns: `repeat(${fit.cols}, auto)` }}>
        {options.map((o, i) => {
          const picked = sel.includes(o.idx);
          return (
            <button
              key={o.idx}
              className={`option-card carousel-item${picked ? ' selected' : ''}${o.enabled ? '' : ' off'}`}
              aria-disabled={!o.enabled || undefined}
              aria-pressed={picked}
              aria-label={o.caption ? `${o.caption}: ${o.text}` : o.text}
              data-testid={`ask-item-${o.idx}`}
              onClick={() => pick(o.idx)}
            >
              <span className="pick-anchor">
                <OptionCardView card={card} text={o.text} cost={o.cost} height={fit.height} />
                {picked && <PickBadge label={pickLabel(sel.indexOf(o.idx) + 1, ask.max > 1)} testId={`ask-pick-${o.idx}`} />}
                {i < 9 && <span className="grid-key num">{i + 1}</span>}
              </span>
              {o.caption && <span className="oc-caption">{o.caption}</span>}
            </button>
          );
        })}
      </div>
    </PromptFrame>
  );
}

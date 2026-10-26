/**
 * Ordering simultaneous triggers. One row per trigger (its source card, name and what it does), the top
 * row resolves first (Forge puts the list on the stack last to first). Big up / down buttons for touch, ↑ ↓ to pick
 * a row and Alt + ↑ ↓ to move it on a keyboard. Beside the list, the stack it builds, above whatever is already on
 * it. "Suggested order" is the engine's own order; "Always use this order" is Forge's remember, as a labelled switch.
 */
import { useState } from 'react';
import type { GameModel, OrderAsk } from '@forge-table/protocol';
import { CropArt } from '../cards/CropArt';
import { ManaText } from '../hud/ManaText';
import { stackTopName } from '../hud/primaryLabel';
import { AskPreview, hudScale, itemFace, previewHeight, useHotkeys, usePeek } from './askCards';
import { initialOrder } from './lanes';
import { PromptFrame } from './PromptFrame';

/** Forge's simultaneous-trigger order (the only order ask that offers "remember"). */
export function isTriggerOrder(ask: OrderAsk): boolean {
  const n = ask.items.length;
  return n > 1 && ask.min === n && ask.max === n && (!!ask.remember || /simultaneous abilit/i.test(ask.title ?? ''));
}

const Arrow = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={up ? 'M8 13V3M3.5 7.5L8 3l4.5 4.5' : 'M8 3v10M3.5 8.5L8 13l4.5-4.5'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ORDINAL = ['1st', '2nd', '3rd'];
const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}th`;

/** Move the item at `from` by `by` places (clamped). */
export function moveBy(order: number[], from: number, by: number): number[] {
  const to = Math.max(0, Math.min(order.length - 1, from + by));
  if (to === from) return order;
  const out = order.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** The trigger's text without its source's name in front ("Ragavan - Whenever …" → "Whenever …"). */
export function triggerText(label: string, name: string | undefined): string {
  if (!name) return label;
  const m = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-—:]\\s*`).exec(label);
  return m ? label.slice(m[0].length) : label;
}

export function TriggerOrder({ ask, model, onReply }: { ask: OrderAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const given = ask.items.map((i) => i.idx);
  const [order, setOrder] = useState<number[]>(() => initialOrder(given, ask.selected));
  const [at, setAt] = useState(0);
  const [remember, setRemember] = useState(false);
  const { peek, bind, leave } = usePeek(ask.items, model, order[at]);
  const submit = () => onReply(ask.remember ? { order, remember } : { order });
  const move = (i: number, by: number) => {
    setOrder((o) => moveBy(o, i, by));
    setAt(Math.max(0, Math.min(order.length - 1, i + by)));
  };
  useHotkeys(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const by = e.key === 'ArrowUp' ? -1 : 1;
        if (e.altKey) move(at, by);
        else setAt((a) => Math.max(0, Math.min(order.length - 1, a + by)));
      }
    },
    [order, at, remember],
  );
  const byIdx = new Map(ask.items.map((it) => [it.idx, it]));
  const rows = order.map((idx) => {
    const it = byIdx.get(idx)!;
    const f = itemFace(it, model);
    const name = f?.card?.state?.name ?? f?.face?.name;
    return { it, f, name, text: triggerText(it.label, name) };
  });
  const hs = hudScale();
  const below = model.game.stack.length;
  const under = below > 0 ? stackTopName(model.game, model.cards) : undefined;
  const suggested = order.every((x, i) => x === given[i]);
  return (
    <PromptFrame
      // Our own title and hint: Forge's ("Select order for simultaneous abilities", "Resolve first") say less.
      ask={{ ...ask, title: undefined, message: undefined }}
      model={model}
      testId="ask-trigger-order"
      className="trigger-order"
      title="Order your triggers"
      keys={[['↑ ↓', 'select'], ['Alt ↑ ↓', 'move'], ['Enter', 'confirm'], ['V', 'table']]}
      headAction={
        <button className="btn secondary trig-suggest" disabled={suggested} data-testid="trigger-suggested" onClick={() => setOrder(given)}>
          Suggested order
        </button>
      }
      primary={{ label: 'Put on the stack', onClick: submit }}
    >
      <div className="ask-body">
        <div className="trig-col">
          <div className="trig-hint">
            {rows.length} triggers at once. <b>The top one resolves first.</b>
          </div>
          <ol className="trig-list" onMouseLeave={leave}>
            {rows.map(({ it, name, text }, i) => (
              <li key={it.idx} className={`trig-row${i === at ? ' at' : ''}`} data-testid={`trigger-row-${it.idx}`} onClick={() => setAt(i)} {...bind(it.idx)}>
                <span className="trig-pos num">{i + 1}</span>
                {name && (
                  <span className="trig-thumb">
                    <CropArt name={name} className="trig-art" width={Math.round(64 * hs)} height={Math.round(46 * hs)} />
                  </span>
                )}
                <span className="trig-words">
                  {name && <b>{name}</b>}
                  <span className="trig-text">
                    <ManaText text={text} />
                  </span>
                </span>
                <button className="btn secondary trig-ud" aria-label={`Move ${name ?? 'trigger'} up`} disabled={i === 0} data-testid={`trigger-up-${it.idx}`} onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                  <Arrow up />
                </button>
                <button
                  className="btn secondary trig-ud"
                  aria-label={`Move ${name ?? 'trigger'} down`}
                  disabled={i === rows.length - 1}
                  data-testid={`trigger-down-${it.idx}`}
                  onClick={(e) => (e.stopPropagation(), move(i, 1))}
                >
                  <Arrow up={false} />
                </button>
              </li>
            ))}
          </ol>
          {ask.remember && (
            <label className="trig-remember">
              <input type="checkbox" role="switch" className="switch" checked={remember} data-testid="trigger-remember" onChange={(e) => setRemember(e.target.checked)} />
              Always use this order for these {rows.length} cards
            </label>
          )}
        </div>
        <div className="trig-stack" data-testid="trigger-stack" aria-label="The stack this builds">
          <div className="trig-stack-head">The stack this builds</div>
          {rows.map(({ it, name, text }, i) => (
            <div key={it.idx} className={`trig-stk${i === 0 ? ' first' : ''}`}>
              {name && <CropArt name={name} className="trig-stk-art" width={Math.round(36 * hs)} height={Math.round(26 * hs)} />}
              <span className="trig-stk-words">
                <span className="trig-stk-name">{name ?? it.label}</span>
                {name && (
                  <span className="trig-stk-text">
                    <ManaText text={text} />
                  </span>
                )}
              </span>
              <em>{i === 0 ? 'resolves 1st' : ordinal(i)}</em>
            </div>
          ))}
          <div className="trig-stack-rest">{below === 0 ? 'Nothing else on the stack' : `Then ${under ?? 'what was there'}${below > 1 ? ` and ${below - 1} more` : ''}`}</div>
        </div>
        <AskPreview peek={peek} height={Math.round(previewHeight() * 0.8)} />
      </div>
    </PromptFrame>
  );
}

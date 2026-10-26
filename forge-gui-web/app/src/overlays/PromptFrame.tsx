/**
 * The one shell every modal ask sits in. Head: the card that's asking (thumbnail + name + type), the
 * title and the engine's instruction, and a counter with a meter when several picks are needed. Body: the layout.
 * Foot: key hints on the left, then any secondary buttons, then the primary, which names the action. Focus stays
 * inside (Tab wraps); the keys themselves stay with each layout (Enter confirms, Esc only backs out when legal).
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AskMsg, Card, GameModel } from '@forge-table/protocol';
import { useArtBox } from '../cards/OptionCardView';
import { ManaText } from '../hud/ManaText';
import { hudScale } from './askCards';

export interface FrameButton {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}

export interface PromptFrameProps {
  ask: AskMsg;
  model?: GameModel | undefined;
  testId: string;
  className?: string;
  /** Used when the engine sends no title. */
  title?: string;
  /** "n of m chosen"; the meter is segmented for up to 10, a bar beyond. */
  count?: { n: number; of: number; label?: string } | null;
  /** [keys, what they do], e.g. ['Enter', 'confirm']. */
  keys?: [string, string][];
  /** Left of the key hints (a status line, a "Remember" box). */
  status?: ReactNode;
  secondary?: (FrameButton | false | null | undefined)[];
  /** The body draws the card itself: no source tile in the head. */
  noSource?: boolean;
  /** The body draws the card's art (option cards): the head names the card without its art tile. */
  noThumb?: boolean;
  /** At the right of the head (the trigger order's "Suggested order"). */
  headAction?: ReactNode;
  primary?: FrameButton | null | undefined;
  children: ReactNode;
}

/**
 * The card the ask is about: the one the engine names, else (a choice or an order, which the engine sends without
 * its card) the source of the top of the stack, the spell or ability that is usually resolving and asking.
 * ponytail: the stack top is a stand-in until the bridge forwards the asking card for every choice.
 */
export function sourceCard(ask: AskMsg, model: GameModel | undefined) {
  if (!model) return undefined;
  const id = 'card' in ask ? ask.card : undefined;
  if (id) return model.cards[id];
  if (ask.kind !== 'choose' && ask.kind !== 'order') return undefined;
  const top = model.game.stack[0]?.source;
  return top ? model.cards[top] : undefined;
}

function typeLine(t: { super: string[]; core: string[]; sub: string[] } | undefined): string {
  if (!t) return '';
  const main = [...t.super, ...t.core].join(' ').toLowerCase();
  return t.sub.length ? `${main} — ${t.sub.join(' ')}` : main;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function PromptFrame(p: PromptFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    // A layout that focuses its own field (text entry) keeps it.
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length === 0) return;
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const { ask } = p;
  const card = p.noSource ? undefined : sourceCard(ask, p.model);
  const name = card?.state?.name;
  // No title: a short first line of the engine's instruction is the title, the rest stays under it.
  const words = ask.title || p.title || !ask.message ? null : confirmWords(ask.message);
  const title = ask.title ?? p.title ?? words?.title;
  const message = words ? words.message : ask.message;
  const count = p.count && p.count.of >= 1 ? p.count : null;
  const hs = name ? hudScale() : 1;
  const secondary = (p.secondary ?? []).filter((b): b is FrameButton => !!b);
  return (
    <div
      className={`overlay pf${p.className ? ` ${p.className}` : ''}`}
      data-testid={p.testId}
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title || name ? titleId : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="pf-head">
        {name && !p.noThumb && (
          <span className="pf-src" data-testid="pf-source">
            <SourceThumb card={card!} width={Math.round(88 * hs)} height={Math.round(64 * hs)} />
          </span>
        )}
        <div className="pf-text">
          {title && (
            <h2 id={titleId}>
              <ManaText text={title} />
            </h2>
          )}
          {name && (
            <div className="pf-ins" id={title ? undefined : titleId}>
              <b>{name}</b>
              {typeLine(card?.state?.type) && <> · {typeLine(card?.state?.type)}</>}
            </div>
          )}
          {message && (
            <div className="msg">
              <ManaText text={message} />
            </div>
          )}
          {ask.error && (
            <div className="error" role="alert">
              {ask.error}
            </div>
          )}
        </div>
        {p.headAction}
        {count && (
          <div className="pf-count" data-testid="pf-count">
            <div className="big num">
              <em>{count.n}</em> of {count.of}
            </div>
            <div className="lbl">{count.label ?? 'chosen'}</div>
            {count.of <= 10 ? (
              <div className="pf-meter" aria-hidden="true">
                {Array.from({ length: count.of }, (_, i) => (
                  <i key={i} className={i < count.n ? 'f' : undefined} />
                ))}
              </div>
            ) : (
              <div className="pf-meter bar" aria-hidden="true">
                <i className="f" style={{ width: `${Math.min(100, (100 * count.n) / count.of)}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
      {p.children}
      <div className="row pf-foot">
        {p.status}
        {p.keys && p.keys.length > 0 && (
          <span className="pf-keys">
            {p.keys.map(([k, what]) => (
              <span key={k + what}>
                {k.split(' ').map((part, i) => (part === '/' || part === '–' ? <span key={i}>{part}</span> : <kbd key={i}>{part}</kbd>))} <ManaText text={what} />
              </span>
            ))}
          </span>
        )}
        <span className="spacer" />
        {secondary.map((b, i) => (
          <button key={i} className="btn secondary" disabled={b.disabled} data-testid={b.testId} onClick={b.onClick}>
            {b.label}
          </button>
        ))}
        {p.primary && (
          <button className="btn primary pf-primary" disabled={p.primary.disabled} data-testid={p.primary.testId ?? 'ask-done'} onClick={p.primary.onClick}>
            {p.primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** The asking card's art as a small tile (crop, scan or procedural, whichever the art mode draws). */
function SourceThumb({ card, width, height }: { card: Card; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useArtBox(card, width / height, width * 2);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || !box) return;
    ctx.clearRect(0, 0, width * 2, height * 2);
    ctx.drawImage(box, 0, 0, width * 2, height * 2);
  }, [box, width, height]);
  // Nothing to draw (a hidden card): no empty tile.
  if (!box) return null;
  return <canvas ref={ref} className="pf-src-art" width={width * 2} height={height * 2} style={{ width, height }} />;
}

/** "Choose 2 cards", "Choose 1 card"; "Done" when nothing is picked (an optional choice of none). */
export function chooseLabel(n: number, unit = 'card'): string {
  if (n === 0) return 'Done';
  return `Choose ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A confirm's question as the title: the engine's first line when short ("Use triggered ability of Sentinel (12)?",
 * the card's id dropped), the rest ("(Whenever …)") as the message under it.
 */
export function confirmWords(message: string | undefined): { title?: string; message?: string } {
  if (!message) return {};
  const [first = '', ...rest] = message.split('\n');
  if (first.length > 90) return { message };
  const more = rest.join('\n').trim();
  return { title: first.replace(/ \(\d+\)/g, ''), ...(more ? { message: more } : {}) };
}

/**
 * The toolbar over a big grid of cards (cardGrid.ts): a search box (/ focuses it), All and one chip
 * per type with its count, any extra chips the caller leads with ("Playable now"), a sort menu, and whatever the
 * caller puts on the right (Select all). Esc in the box clears it; Esc in an empty box leaves it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SORTS, sortLabel, type GridSort, type GridView, type TypeChip } from './cardGrid';

/** "Sort: Mana value ▾": a button whose menu lists the orders; Esc or a click outside closes it. */
function SortMenu({ value, given, onPick, testId }: { value: GridSort; given: string; onPick: (s: GridSort) => void; testId: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <span className="sort-menu" ref={box}>
      <button className="grid-chip sort" aria-haspopup="menu" aria-expanded={open} data-testid={testId} title="Change the order" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3L8.5 5.5M11 3l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {sortLabel(value, given)}
        <span className="chev" aria-hidden="true" />
      </button>
      {open && (
        <span className="sort-pop" role="menu">
          {SORTS.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={s === value}
              className={s === value ? 'on' : ''}
              data-testid={`${testId}-${s}`}
              onClick={() => {
                onPick(s);
                setOpen(false);
              }}
            >
              {sortLabel(s, given)}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** A chip the caller filters on itself: it is on while `view.type` is its key. */
export interface ExtraChip {
  key: string;
  label: string;
  n: number;
  tone?: 'ember';
}

export function CardGridBar({
  view,
  onView,
  chips,
  all,
  extra = [],
  given,
  right,
  info,
  onEnter,
  testId,
}: {
  view: GridView;
  onView: (v: GridView) => void;
  chips: TypeChip[];
  /** The All chip's count. */
  all: number;
  extra?: ExtraChip[];
  /** What the given order is called ("Newest first"). */
  given: string;
  right?: ReactNode;
  /** A fact chip at the head of the chips ("Can pick 3"), not a filter. */
  info?: ReactNode;
  onEnter?: () => void;
  testId: string;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.repeat || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const pick = (type: string) => onView({ ...view, type: view.type === type ? null : type });
  return (
    <div className="grid-bar" data-testid={testId}>
      <span className="grid-search-wrap">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      <input
        ref={box}
        className="grid-search"
        type="search"
        placeholder="Search name or text  ( / )"
        aria-label="Search the cards"
        value={view.query}
        data-testid={`${testId}-search`}
        onChange={(e) => onView({ ...view, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (view.query) onView({ ...view, query: '' });
            else box.current?.blur();
          } else if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      </span>
      {info && <span className="grid-chip info" data-testid={`${testId}-info`}>{info}</span>}
      {extra.map((c) => (
        <button
          key={c.key}
          className={`grid-chip${view.type === c.key ? ' on' : ''}${c.tone ? ` ${c.tone}` : ''}`}
          aria-pressed={view.type === c.key}
          data-testid={`grid-chip-${c.key}`}
          onClick={() => pick(c.key)}
        >
          {c.label} <span className="n num">{c.n}</span>
        </button>
      ))}
      <button className={`grid-chip${!view.type ? ' on' : ''}`} aria-pressed={!view.type} data-testid="grid-chip-all" onClick={() => onView({ ...view, type: null })}>
        All <span className="n num">{all}</span>
      </button>
      {chips.map((c) => (
        <button
          key={c.type}
          className={`grid-chip${view.type === c.type ? ' on' : ''}`}
          aria-pressed={view.type === c.type}
          data-testid={`grid-chip-${c.type.toLowerCase()}`}
          onClick={() => pick(c.type)}
        >
          {c.label} <span className="n num">{c.n}</span>
        </button>
      ))}
      <span className="spacer" />
      <SortMenu value={view.sort} given={given} testId={`${testId}-sort`} onPick={(sort) => onView({ ...view, sort })} />
      {right}
    </div>
  );
}

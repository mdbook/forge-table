/**
 * The game history panel: Forge's log of this game, live while it plays and still there on the game-over panel.
 * A floating window you can drag by its header (a bottom sheet on phones and touch screens), with the lines grouped
 * by turn and step, filter chips, a search box, card previews on hover, and Copy / Download for bug reports.
 * The logic is in history.ts; the corner menu's History button, the H key and the game-over panel open it.
 */
import type { Card, LogEntry, PlayerId } from '@forge-table/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { FloatingCard } from './Panels';
import { category, FILTERS, groupByTurn, historyText, matches, phaseLabel, splitCard, turnTitle, type Category, type Filter } from './history';

const icon = (body: ReactNode) => (
  <svg className="hist-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
);

/** One line drawing per kind of line, on the phase strip's 16-unit grid. */
const ICONS: Record<Category, ReactNode> = {
  info: icon(<><circle cx="8" cy="8" r="5.5" /><path d="M8 7.5v3.5M8 5v.01" /></>),
  land: icon(<path d="M2 13 6 6l2.5 3.5L10.5 7 14 13Z" />),
  stack: icon(<><path d="M2.5 6 8 3l5.5 3L8 9Z" /><path d="M2.5 9.5 8 12.5l5.5-3" /></>),
  zone: icon(<><path d="M2.5 8h9" /><path d="M8.5 4.5 12 8l-3.5 3.5" /><path d="M14 3.5v9" /></>),
  combat: icon(<><path d="M3 3l7.5 7.5M13 3 5.5 10.5" /><path d="M9 12l3-3M7 12 4 9" /></>),
  life: icon(<path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z" />),
};

/** A clock face with a back arrow: the corner menu's History button. */
export function HistoryIcon() {
  return icon(<><path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1" /><path d="M2.5 2.5v3h3" /><path d="M8 5.2V8l2 1.3" /></>);
}

/** The card a line names, if the viewer can see one by that name (a hidden card has no state to preview). */
function cardNamed(cards: Record<string, Card>, name: string): Card | undefined {
  for (const c of Object.values(cards)) if (c.state?.name === name) return c;
  return undefined;
}

export function HistoryPanel() {
  const open = useUi((s) => s.historyOpen);
  const history = useUi((s) => s.history);
  const viewer = useUi((s) => s.viewer);
  const players = useUi((s) => s.shown.players);
  const cards = useUi((s) => s.shown.cards);
  const turn = useUi((s) => s.shown.game.turn);
  const over = useUi((s) => !!s.gameOver);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // The window's drag offset from where CSS puts it (the bottom sheet ignores it).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ card: Card; x0: number; x1: number; cy: number } | null>(null);
  const [unseen, setUnseen] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  // Following the newest line (scrolled to the bottom); scrolled up, new lines raise the pill instead.
  const follow = useRef(true);
  const shownCount = useRef(0);

  const entries = history?.entries ?? [];
  const nameOf = (p: PlayerId) => players[p]?.name ?? p;
  const keep = (e: LogEntry) => matches(e, filter, query, viewer);
  const turns = useMemo(() => groupByTurn(entries, keep), [entries, filter, query, viewer]); // eslint-disable-line react-hooks/exhaustive-deps
  const kept = turns.reduce((n, t) => n + t.steps.reduce((m, s) => m + s.lines.length, 0), 0);

  const close = () => {
    setHover(null);
    useUi.setState({ historyOpen: false });
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc closes the panel, not whatever the table would do with it.
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  // Opening starts at the newest line.
  useLayoutEffect(() => {
    if (!open) return;
    follow.current = true;
    setUnseen(0);
    shownCount.current = entries.length;
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open) return;
    const added = entries.length - shownCount.current;
    shownCount.current = entries.length;
    if (follow.current) body.current?.scrollTo({ top: body.current.scrollHeight });
    else if (added > 0) setUnseen((n) => n + added);
  }, [open, entries.length, filter, query]);

  if (!open) return null;

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (follow.current) setUnseen(0);
  };

  const toNewest = () => {
    follow.current = true;
    setUnseen(0);
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' });
  };

  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => setPos({ x: m.clientX - start.x, y: Math.max(-60, m.clientY - start.y) });
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const text = () => historyText(entries, nameOf);
  const copy = () => {
    const rt = runtime();
    if (!navigator.clipboard) {
      rt.toast('error', 'Couldn’t copy', 'This browser won’t let the page copy. Use Download instead.');
      return;
    }
    navigator.clipboard.writeText(text()).then(
      () => rt.toast('info', undefined, 'Game history copied.'),
      () => rt.toast('error', 'Couldn’t copy', 'This browser won’t let the page copy. Use Download instead.'),
    );
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `forge-table-game-${history?.game ?? 0}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const line = (entry: LogEntry, index: number) => {
    const cat = category(entry.kind);
    const side = entry.player === undefined ? '' : entry.player === viewer ? ' mine' : ' opp';
    return (
      <div key={index} className={`hist-line ${cat}${side}`} data-testid="hist-line">
        {ICONS[cat]}
        <span>
          {splitCard(entry).map((p, i) => {
            if (!p.card) return p.text;
            const card = cardNamed(cards, p.text);
            if (!card) return <span key={i} className="hist-card">{p.text}</span>;
            return (
              <span
                key={i}
                className="hist-card live"
                onPointerEnter={(ev) => {
                  const r = ev.currentTarget.getBoundingClientRect();
                  setHover({ card, x0: r.left, x1: r.right, cy: r.top + r.height / 2 });
                }}
                onPointerLeave={() => setHover(null)}
              >
                {p.text}
              </span>
            );
          })}
        </span>
      </div>
    );
  };

  return (
    <>
      <section className="hist" role="dialog" aria-label="Game history" data-testid="history" style={{ '--hx': `${pos.x}px`, '--hy': `${pos.y}px` } as React.CSSProperties}>
        <div className="hist-grab" aria-hidden="true" />
        <div className="hist-head" onPointerDown={drag}>
          <h2>Game history</h2>
          <span className={`hist-state${over ? '' : ' live'}`}>{over ? 'Game over' : `Turn ${turn ?? 0}, live`}</span>
          <button className="hist-close" aria-label="Close history" title="Close (Esc)" onClick={close}>
            ×
          </button>
        </div>
        <div className="hist-tools">
          <input className="hist-search" type="search" placeholder="Find a card or player…" aria-label="Filter history" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="hist-filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} className={`btn chip${filter === f.key ? ' on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="hist-body" ref={body} onScroll={onScroll}>
          {kept === 0 && <div className="hist-empty">{entries.length ? 'No lines match.' : 'Nothing has happened yet.'}</div>}
          {turns.map((t, ti) => (
            <div key={`${t.turn}-${ti}`} className="hist-turn">
              <div className={`hist-turn-head${t.active === viewer ? ' mine' : ''}`}>
                {t.turn > 0 && <span className="num">Turn {t.turn}</span>}
                <span className="who">{turnTitle(t, viewer, nameOf)}</span>
              </div>
              {t.steps.map((s, si) => (
                <div key={si}>
                  {t.turn > 0 && <div className="hist-step">{phaseLabel(s.phase)}</div>}
                  {s.lines.map((l) => line(l.entry, l.index))}
                </div>
              ))}
            </div>
          ))}
          {unseen > 0 && (
            <button className="hist-new" onClick={toNewest}>
              {unseen === 1 ? '1 new line' : `${unseen} new lines`}
            </button>
          )}
        </div>
        <div className="hist-foot">
          <span className="hist-count">{kept === entries.length ? `${entries.length} lines` : `${kept} of ${entries.length} lines`}</span>
          <button className="btn chip" title="Copies the whole game as text, for a bug report" onClick={copy} disabled={!entries.length}>
            Copy
          </button>
          <button className="btn chip" onClick={download} disabled={!entries.length}>
            Download .txt
          </button>
        </div>
      </section>
      {hover && (
        <div className="hist-preview">
          <FloatingCard card={hover.card} x0={hover.x0} x1={hover.x1} cy={hover.cy} />
        </div>
      )}
    </>
  );
}

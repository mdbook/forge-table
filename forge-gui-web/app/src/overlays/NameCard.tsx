/**
 * Name a card by searching, with art and type lines, instead of a text box over a datalist. The
 * opponent's cards seen this game come first; ↑ ↓ move the highlight, Enter names it, and the primary repeats the
 * exact name.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskItem, ChooseAsk, GameModel, PlayerId } from '@forge-table/protocol';
import { CropArt } from '../cards/CropArt';
import { matchSpan, searchNames, seenNames } from './nameCard';
import { PromptFrame } from './PromptFrame';

function Marked({ text, q }: { text: string; q: string }) {
  const span = matchSpan(text, q);
  if (!span) return <>{text}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <b>{text.slice(span[0], span[1])}</b>
      {text.slice(span[1])}
    </>
  );
}

export function NameCard({ ask, model, viewer, onReply }: { ask: ChooseAsk; model: GameModel; viewer: PlayerId | null; onReply: (v: unknown) => void }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const seen = useMemo(() => seenNames(ask.items, model, viewer), [ask.items, model, viewer]);
  const res = useMemo(() => searchNames(ask.items, seen, query), [ask.items, seen, query]);
  const rows: { item: AskItem; where?: string }[] = [...res.seen.map((s) => ({ item: s.item, where: s.where })), ...res.all.map((item) => ({ item }))];
  const cur = rows[Math.min(at, rows.length - 1)];
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.nc-row.at')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const pick = (it: AskItem | undefined) => it && onReply([it.idx]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((i) => Math.max(0, Math.min(rows.length - 1, Math.min(i, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(cur?.item);
    } else if (e.key === 'Escape' && ask.min === 0) {
      e.preventDefault();
      onReply([]);
    }
  };

  const row = (r: { item: AskItem; where?: string }, i: number) => (
    <button
      key={r.item.idx}
      className={`nc-row${i === at ? ' at' : ''}`}
      data-testid="name-row"
      data-name={r.item.label}
      onMouseEnter={() => setAt(i)}
      onClick={() => pick(r.item)}
    >
      <CropArt name={r.item.label} className="nc-art" />
      <span className="nc-words">
        <span className="nc-name">
          <Marked text={r.item.label} q={q} />
        </span>
        <span className="nc-sub">
          {r.item.sub}
          {r.where ? ` · ${r.where}` : ''}
        </span>
      </span>
    </button>
  );

  return (
    <PromptFrame
      ask={ask}
      model={model}
      testId="ask-name"
      className="name-card"
      title="Name a card"
      keys={[
        ['↑ ↓', 'move'],
        ['Enter', 'name it'],
        ...(ask.min === 0 ? ([['Esc', 'none']] as [string, string][]) : []),
      ]}
      secondary={[ask.min === 0 && { label: 'None', onClick: () => onReply([]), testId: 'ask-none' }]}
      primary={{ label: cur ? `Name ${cur.item.label}` : 'Name a card', onClick: () => pick(cur?.item), disabled: !cur, testId: 'name-go' }}
    >
      <div className="nc" onKeyDown={onKey}>
        <div className="nc-bar">
          <input
            autoFocus
            className="grid-search nc-search"
            type="search"
            placeholder="Type a card name…"
            aria-label="Search card names"
            value={query}
            data-testid="name-search"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="nc-count" data-testid="name-count">
            {res.total === 1 ? '1 match' : `${res.total.toLocaleString()} matches`}
          </span>
        </div>
        <div className="nc-list" ref={listRef} role="listbox" aria-label="Card names">
          {res.seen.length > 0 && <div className="nc-head">Seen this game</div>}
          {res.seen.map((s, i) => row({ item: s.item, where: s.where }, i))}
          {res.all.length > 0 && res.seen.length > 0 && <div className="nc-head">All cards</div>}
          {res.all.map((it, i) => row({ item: it }, res.seen.length + i))}
          {rows.length === 0 && <div className="nc-empty">No card is called that.</div>}
          {res.total > rows.length && <div className="nc-more">Keep typing to narrow {(res.total - rows.length).toLocaleString()} more.</div>}
        </div>
      </div>
    </PromptFrame>
  );
}

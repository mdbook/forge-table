/**
 * Deck import on the start screen (in-page; never alert/prompt). Three ways in: paste a list, paste a
 * link the sidecar fetches, or a .txt/.dck/.dec file (also dropped anywhere on the start screen), plus an
 * optional name. Check parses without saving (`dryRun`) and shows what was recognized; Import saves,
 * refreshes the deck list and selects the new deck as the player's.
 *
 * A pasted list is checked live as you type, and the result is a preview: the cards grouped by type
 * with art and a mana curve, the commander as a callout with its colour identity and Brawl legality, and unknown
 * lines with a one-click "did you mean" fix.
 *
 * Keys: Esc closes (asks first when there's a pasted list), Ctrl/Cmd+Enter imports.
 */
import type { DeckImportResult } from '@forge-table/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CropArt } from '../cards/CropArt';
import { runtime } from '../runtime';
import { ManaText } from './ManaText';
import {
  applyFix,
  deckFileProblem,
  groupLabel,
  importLabel,
  manaCurve,
  previewGroups,
  importError,
  importParams,
  importSummary,
  readFileText,
  unknownHeading,
  unknownLines,
  type ImportMode,
} from './start';

/** A pasted list is checked this long after the last keystroke. */
const LIVE_CHECK_MS = 600;
/** Preview tiles shown before "+ N more". */
const MAX_TILES = 40;

export interface ImportPanelProps {
  /** A file dropped on the start screen: the panel opens on it and checks it straight away. */
  initialFile?: { name: string; text: string } | null;
  /** A problem with a dropped file, shown inline. */
  initialError?: string | null;
  onClose(): void;
  onImported(name: string): void;
}

const MODES: Array<{ mode: ImportMode; label: string }> = [
  { mode: 'paste', label: 'Paste' },
  { mode: 'link', label: 'Link' },
  { mode: 'file', label: 'File' },
];

const PASTE_HINT = '4 Lightning Bolt\n4 Monastery Swiftspear (KTK) 118\n20 Mountain\n\nSideboard\n2 Abrade';

export function ImportPanel({ initialFile = null, initialError = null, onClose, onImported }: ImportPanelProps) {
  const [mode, setMode] = useState<ImportMode>(initialFile || initialError ? 'file' : 'paste');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(initialFile);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [result, setResult] = useState<DeckImportResult | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Only the latest check's answer is shown (live checks overlap typing). */
  const seq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstField = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const input = { mode, text, url, file, name };
  /** Any edit makes the last check stale. */
  const edited = () => {
    setResult(null);
    setError(null);
    setConfirmClose(false);
  };

  const run = async (dryRun: boolean, live = false) => {
    if (busy === 'import') return;
    const p = importParams(input, dryRun);
    if ('error' in p) {
      if (live) return;
      setError(p.error);
      setResult(null);
      return;
    }
    const mine = ++seq.current;
    setBusy(dryRun ? 'check' : 'import');
    setError(null);
    try {
      const r = await runtime().importDeck(p.params);
      if (!alive.current || mine !== seq.current) return;
      if (dryRun) {
        setResult(r);
      } else if (r.saved) {
        onImported(r.name);
        onClose();
        return;
      } else {
        setResult(r);
        setError('Nothing was saved: no cards were recognized.');
      }
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setResult(null);
      setError(importError(e));
    } finally {
      if (alive.current && mine === seq.current) setBusy(null);
    }
  };

  // A pasted list is checked live, a moment after typing stops.
  useEffect(() => {
    if (mode !== 'paste' || !text.trim()) return;
    const t = window.setTimeout(() => void runRef.current(true, true), LIVE_CHECK_MS);
    return () => window.clearTimeout(t);
  }, [mode, text]);

  // A dropped file is checked as soon as the panel opens on it.
  useEffect(() => {
    if (initialFile) void run(true);
    else firstField.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  // Esc closes and Ctrl/Cmd+Enter imports, wherever focus is while the panel is open.
  const runRef = useRef(run);
  runRef.current = run;
  const dirty = (mode === 'paste' && !!text.trim()) || (mode === 'link' && !!url.trim());
  const closeRef = useRef(() => {});
  closeRef.current = () => {
    if (dirty && !confirmClose) setConfirmClose(true);
    else onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        void runRef.current(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    edited();
    const problem = deckFileProblem(f);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    try {
      const body = await readFileText(f);
      if (alive.current) setFile({ name: f.name, text: body });
    } catch (e) {
      if (alive.current) setError(importError(e));
    }
  };

  const unknown = result ? unknownLines(result) : null;
  const heading = result ? unknownHeading(result) : null;
  const cards = useMemo(() => result?.cards ?? [], [result]);
  const groups = useMemo(() => previewGroups(cards), [cards]);
  const curve = useMemo(() => manaCurve(cards), [cards]);
  const curveTop = Math.max(1, ...curve);
  const lead = cards.find((c) => c.section === 'commander');
  const tiles = (group ? groups.filter((g) => g.type === group) : groups).flatMap((g) => g.cards);
  const fixes = result?.fixes ?? {};
  const toFix = result && result.recognized > 0 ? result.unknown.length : 0;
  const preview = cards.length > 0;
  const fix = (line: string, to: string) => {
    setText((t) => applyFix(t, line, to));
    setConfirmClose(false);
  };
  return (
    <div className="import-scrim" data-testid="import-panel" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div className={`overlay pf import-panel${preview ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="pf-head import-head">
          <span className="pf-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <rect x="4" y="3" width="11" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M9 21h9a2 2 0 0 0 2-2V8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M9.5 7.5v6M7 11l2.5 2.5L12 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="pf-text">
            <h2 id="import-title">Import a deck</h2>
            <div className="pf-ins">Paste a list, a Moxfield / Archidekt / TappedOut / MTGGoldfish link, or drop a file.</div>
          </div>
          <button className="btn secondary zv-close" onClick={() => closeRef.current()} data-testid="import-close" aria-label="Close">
            <kbd>Esc</kbd> close
          </button>
        </div>
        <div className="pf-tabs import-modes" role="tablist" aria-label="Import from">
          {MODES.map((m) => (
            <button
              key={m.mode}
              role="tab"
              aria-selected={mode === m.mode}
              className={mode === m.mode ? 'on' : ''}
              data-testid={`import-mode-${m.mode}`}
              onClick={() => {
                setMode(m.mode);
                edited();
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="import-body">
          <div className="import-input">
          {mode === 'paste' && (
            <label>
              <span className="pf-field-label">Deck list</span>
              <textarea
                ref={firstField}
                className="field"
                rows={10}
                spellCheck={false}
                placeholder={PASTE_HINT}
                value={text}
                data-testid="import-text"
                onChange={(e) => {
                  setText(e.target.value);
                  // Keep the last preview while typing; the live check replaces it.
                  setError(null);
                  setConfirmClose(false);
                }}
              />
              <span className="hint">Arena, MTGO and Moxfield exports or .dck content. A “Sideboard” line starts the sideboard.</span>
            </label>
          )}
          {mode === 'link' && (
            <label>
              <span className="pf-field-label">Deck link</span>
              <input
                ref={firstField}
                className="field"
                type="url"
                placeholder="https://www.moxfield.com/decks/…"
                value={url}
                data-testid="import-url"
                onChange={(e) => {
                  setUrl(e.target.value);
                  edited();
                }}
              />
              <span className="hint">Moxfield, Archidekt, TappedOut or MTGGoldfish. The server fetches the list.</span>
            </label>
          )}
          {mode === 'file' && (
            <div className="import-file">
              <button className="btn secondary" onClick={() => fileInput.current?.click()} data-testid="import-choose-file">
                Choose file…
              </button>
              <span className="file-name">{file ? file.name : 'or drop a .txt, .dck or .dec file anywhere here'}</span>
              <input
                ref={fileInput}
                type="file"
                accept=".txt,.dck,.dec,text/plain"
                hidden
                data-testid="import-file-input"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          <label>
            <span className="pf-field-label">Name (optional)</span>
            <input
              className="field"
              type="text"
              maxLength={80}
              placeholder={result?.name || (mode === 'file' && file ? file.name.replace(/\.(txt|dck|dec)$/i, '') : 'Named from the list if left blank')}
              value={name}
              data-testid="import-name"
              onChange={(e) => {
                setName(e.target.value);
                edited();
              }}
            />
          </label>

          </div>

          {preview && result && (
            <div className="import-preview" data-testid="import-preview">
              {lead && (
                <div className="import-cmdr" data-testid="import-commander">
                  <CropArt name={lead.name} className="import-cmdr-art" width={208} height={152} />
                  <div className="import-cmdr-words">
                    <div className="import-cmdr-tag">Commander</div>
                    <div className="import-cmdr-name">{lead.name}</div>
                    <div className="import-cmdr-id">
                      Colour identity <ManaText text={result.identity ? [...result.identity].map((c) => `{${c}}`).join('') : '{C}'} />
                    </div>
                    <div className="import-chips">
                      <span className="ichip">{result.main + (result.commander ?? 0)} cards</span>
                      {result.brawlProblem ? (
                        <span className="ichip bad" data-testid="import-brawl">
                          {result.brawlProblem}
                        </span>
                      ) : (
                        <span className="ichip ok" data-testid="import-brawl">
                          ✓ Legal in Brawl
                        </span>
                      )}
                      {toFix > 0 && <span className="ichip warn">{toFix === 1 ? '1 line to fix' : `${toFix} lines to fix`}</span>}
                    </div>
                  </div>
                </div>
              )}
              <div className="import-filter">
                <button className={`ichip${group === null ? ' on' : ''}`} onClick={() => setGroup(null)}>
                  All <span className="c">{result.main}</span>
                </button>
                {groups.map((g) => (
                  <button key={g.type} className={`ichip${group === g.type ? ' on' : ''}`} onClick={() => setGroup(group === g.type ? null : g.type)}>
                    {groupLabel(g.type)} <span className="c">{g.count}</span>
                  </button>
                ))}
                <span className="sp" />
                <span className="import-curve" title="Mana curve (nonland cards by mana value, 6+ last)" data-testid="import-curve">
                  {curve.map((n, v) => (
                    <i key={v} style={{ height: `${Math.max(4, (100 * n) / curveTop)}%` }} title={`${v === 6 ? '6+' : v}: ${n}`} />
                  ))}
                </span>
              </div>
              <div className="import-tiles">
                {tiles.slice(0, MAX_TILES).map((c) => (
                  <div className="import-tile" key={c.name} title={c.name}>
                    <CropArt name={c.name} className="import-tile-art" width={120} height={88} />
                    <span className="import-tile-name">{c.name}</span>
                    {c.n > 1 && <span className="qty">×{c.n}</span>}
                  </div>
                ))}
                {tiles.length > MAX_TILES && <div className="import-tile more">+ {tiles.length - MAX_TILES} more</div>}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="error" role="alert" data-testid="import-error">
            {error}
          </div>
        )}
        {result && (
          <div className="import-result" data-testid="import-result">
            {/* The preview's chips say the counts; without a preview (nothing recognised) the line says it. */}
            {!preview && (
              <div className={`summary${result.recognized > 0 ? ' ok' : ''}`} data-testid="import-summary">
                {importSummary(result)}
              </div>
            )}
            {heading && unknown && (
              <div className="unknown" data-testid="import-unknown">
                <div className="unknown-head">{heading}</div>
                <ul>
                  {unknown.shown.map((l, i) => (
                    <li key={i}>
                      {l}
                      {fixes[l] && (
                        <span className="did-you-mean">
                          Did you mean <b>{fixes[l]}</b>?
                          {mode === 'paste' && (
                            <button className="btn chip" data-testid="import-fix" onClick={() => fix(l, fixes[l]!)}>
                              Fix
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                  {unknown.more > 0 && <li className="more">…and {unknown.more} more</li>}
                </ul>
              </div>
            )}
            {result.warnings.length > 0 && (
              <ul className="warnings" data-testid="import-warnings">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {confirmClose && (
          <div className="import-confirm" role="alert" data-testid="import-confirm">
            Close and lose the pasted list? Press Esc again to close.
            <button className="btn chip" onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
          </div>
        )}

        <div className="row pf-foot">
          <span className="pf-keys">
            {toFix > 0 ? (
              <span>{toFix === 1 ? 'Fix the line or import without it' : 'Fix the lines or import without them'}</span>
            ) : (
              <span>
                <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>Enter</kbd> import
              </span>
            )}
            <span>
              <kbd>Esc</kbd> close
            </span>
          </span>
          <span className="spacer" />
          <button className="btn secondary" disabled={!!busy} onClick={() => void run(true)} data-testid="import-check">
            {busy === 'check' ? <span className="spinner" /> : null}Check
          </button>
          <button className="btn primary import-go" disabled={busy === 'import'} onClick={() => void run(false)} data-testid="import-submit">
            {busy === 'import' ? <span className="spinner" /> : null}
            {toFix > 0 ? (toFix === 1 ? 'Import without it' : 'Import without them') : importLabel(result)}
          </button>
        </div>
      </div>
    </div>
  );
}

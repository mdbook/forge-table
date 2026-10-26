/**
 * Blocking prompts: the top ask renders modally over a 30% scrim; the board and the prompt
 * bar beneath it are disabled. Never a browser dialog.
 *
 * - CardCarousel: choose / ability over cards (faces, click to pick, Done within min..max); `reveal` is
 *   view-only with OK. Also a partial `order` over cards (pick some, in order).
 * - OptionCards: a choice among one card's options (abilities, modes, ways to cast it), each option drawn as that card
 *   with only the option's text (OptionCards.tsx).
 * - OptionList: any other non-card choice and `options` (text rows).
 * - Order: "put them back in any order" over cards is one card lane (drag / ‹ › / ←→); anything else
 *   picks items in order (numbered badges). Optional "Remember". Simultaneous triggers are TriggerOrder.tsx.
 * - Arrange: `arrange` (scry) shows top and bottom lanes; surveil shows top and graveyard lanes.
 * - Split: `split` (combat damage or a divided amount), a tile per target with its amount; click adds, right-click takes
 *   back, Shift-click fills to lethal (or the maximum), then everything left.
 * - ConfirmBar: `confirm`, the question as the title, the card big on the left, one answer per row, 1–9 hotkeys.
 * - TextEntry: `text`.
 * - A mana ability menu or a colour choice is not modal: the mana picker fans over the source card (ManaPicker.tsx).
 *   A choice of a number (X, "how many") and a numeric `text` ask are the X picker (XPicker.tsx).
 *
 * Every overlay that lists cards docks a large preview of the hovered (or focused) card beside the choices.
 */
import { motion } from 'motion/react';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { ArrangeAsk, AskItem, ChooseAsk, ConfirmAsk, GameModel, OrderAsk, SplitAsk, TextAsk } from '@forge-table/protocol';
import { CardFaceView } from '../cards/CardFaceView';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { AskPreview, faceTiles, hudScale, itemFace, LaneBoard, previewHeight, useHotkeys, usePeek, type LaneSpec } from './askCards';
import { isTriggerOrder, TriggerOrder } from './TriggerOrder';
import { initialOrder, type Lanes } from './lanes';
import { PickBadge } from './PickBadge';
import { pickLabel } from '../table/selection';
import * as split from './split';
import { ManaText } from '../hud/ManaText';
import { manaPickForAsk } from './manaChoice';
import { ManaPicker } from './ManaPicker';
import { numberSpec, pendingAnswer, setPendingNumber } from './numberChoice';
import { XPicker } from './XPicker';
import { useBattlefieldPeek } from './BattlefieldPeek';
import { askPeekLabel } from './peek';
import { chooseLabel, confirmWords, PromptFrame } from './PromptFrame';
import { OptionCards } from './OptionCards';
import { optionHost } from './optionFaces';
import { ALL, typeChips, viewEntries, type GridView } from './cardGrid';
import { CardGridBar } from './CardGridBar';
import { isNameAsk } from './nameCard';
import { NameCard } from './NameCard';

/** Selection within [min, max]; a single pick replaces the previous one. */
function useSelection(initial: number[] | undefined, max: number) {
  const [sel, setSel] = useState<number[]>(initial ?? []);
  const toggle = (idx: number) =>
    setSel((cur) => {
      if (cur.includes(idx)) return cur.filter((x) => x !== idx);
      if (max === 1) return [idx];
      if (cur.length >= max) return cur;
      return [...cur, idx];
    });
  return { sel, toggle, setSel };
}

/** A big card choice gets the search / type / sort bar from this many cards with faces. */
const GRID_BAR_MIN = 20;
/** The "can't pick" shelf starts folded when it holds more than this many cards. */
const SHELF_OPEN_MAX = 6;

function CardCarousel({ ask, model, onReply }: { ask: ChooseAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const reveal = !!ask.reveal;
  const { sel, toggle, setSel } = useSelection(ask.selected, ask.max);
  // The preview shows the last pick, else the first card you can pick (not a dimmed one off the shelf).
  const { peek, bind, leave } = usePeek(ask.items, model, sel[sel.length - 1] ?? ask.items.find((it) => it.enabled !== false)?.idx);
  const ok = reveal || (sel.length >= ask.min && sel.length <= ask.max);
  const entries = useMemo(
    () =>
      ask.items.map((it) => {
        const f = itemFace(it, model);
        return { key: it, face: f?.card?.state ?? f?.face };
      }),
    [ask.items, model],
  );
  const bar = entries.filter((e) => e.face).length >= GRID_BAR_MIN;
  const [view, setView] = useState<GridView>(ALL);
  // The cards you can pick come first, full size; the rest fold into a dimmed shelf. A reveal shows them all.
  const can = entries.filter((e) => reveal || e.key.enabled !== false);
  const cant = entries.filter((e) => !reveal && e.key.enabled === false);
  const shown = viewEntries(can.length > 0 ? can : cant, view).map((e) => e.key);
  const shelf = can.length > 0 ? viewEntries(cant, view).map((e) => e.key) : [];
  const [shelfOpen, setShelfOpen] = useState(cant.length <= SHELF_OPEN_MAX);
  const keyed = reveal ? [] : shown.filter((it) => it.enabled !== false).slice(0, 9);
  const n = shown.length;
  const h = Math.round((n <= 5 ? 250 : n <= 10 ? 200 : 160) * hudScale());
  const submit = () => ok && onReply(reveal ? [] : sel);
  // Enter only: Space is "hold to peek at the battlefield", and on a focused card it would also click it.
  useHotkeys(
    (e) => {
      const k = Number.parseInt(e.key, 10);
      if (k >= 1 && k <= 9 && keyed[k - 1]) {
        e.preventDefault();
        toggle(keyed[k - 1]!.idx);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && (ask.min === 0 || reveal)) {
        e.preventDefault();
        onReply([]);
      }
    },
    [sel, ok, keyed.map((it) => it.idx).join()],
  );
  const canNone = !reveal && ask.min === 0 && sel.length === 0;
  // One card picked: the button names it.
  const pickedName = sel.length === 1 ? (() => { const it = ask.items.find((i) => i.idx === sel[0]); const f = it && itemFace(it, model); return f?.card?.state?.name ?? f?.face?.name; })() : undefined;
  // Select all takes the cards in view (up to the most allowed); when they are all taken it lets them go.
  const pickable = shown.filter((it) => it.enabled !== false).map((it) => it.idx);
  const allIn = pickable.length > 0 && pickable.slice(0, ask.max).every((i) => sel.includes(i));
  const selectAll = () => setSel(allIn ? sel.filter((i) => !pickable.includes(i)) : [...sel, ...pickable.filter((i) => !sel.includes(i))].slice(0, ask.max));
  const tile = (it: AskItem, th: number, off: boolean) => {
    const f = itemFace(it, model);
    const picked = sel.includes(it.idx);
    const key = keyed.indexOf(it);
    return (
      // Not `disabled`: a disabled button gets no hover, and the preview should still show the card.
      <button
        key={it.idx}
        className={`carousel-item${picked ? ' selected' : ''}${it.enabled === false ? ' off' : ''}${reveal ? ' view' : ''}`}
        aria-disabled={off || undefined}
        aria-label={f ? it.label : undefined}
        data-testid={`ask-item-${it.idx}`}
        onClick={() => !off && toggle(it.idx)}
        {...bind(it.idx)}
      >
        {/* The badge anchors to the card, not the item (a long label can be wider than the card). */}
        <span className="pick-anchor">
          {f ? <CardFaceView card={f.card} face={f.face} height={th} /> : <div className="option"><ManaText text={it.label} /></div>}
          {picked && <PickBadge label={pickLabel(sel.indexOf(it.idx) + 1, ask.max > 1)} testId={`ask-pick-${it.idx}`} />}
          {key >= 0 && <span className="grid-key num">{key + 1}</span>}
        </span>
        {/* The name is on the card and on the preview: only an item without a face says it under the tile. */}
        {!f && <span className="label"><ManaText text={it.label} /></span>}
      </button>
    );
  };
  return (
    <PromptFrame
      ask={ask}
      model={model}
      testId="ask-carousel"
      count={reveal ? null : { n: sel.length, of: ask.max }}
      keys={[
        ...(bar ? ([['/', 'search']] as [string, string][]) : []),
        ...(keyed.length > 0 ? ([[keyed.length > 1 ? `1 – ${keyed.length}` : '1', 'pick']] as [string, string][]) : []),
        ['Enter', reveal ? 'close' : 'confirm'],
        ...(ask.min === 0 || reveal ? ([['Esc', reveal ? 'close' : cant.length > 0 ? 'find nothing' : 'none']] as [string, string][]) : []),
        ['V', 'table'],
      ]}
      secondary={[canNone && { label: ask.kind === 'ability' ? 'Cancel' : shelf.length > 0 || cant.length > 0 ? 'Find nothing' : 'None', onClick: () => onReply([]), testId: 'ask-none' }]}
      primary={{ label: reveal ? 'OK' : ask.kind === 'ability' && sel.length > 0 ? 'Activate' : pickedName ? `Choose ${pickedName}` : chooseLabel(sel.length), onClick: submit, disabled: !ok }}
    >
      {bar && (
        <CardGridBar
          testId="ask-grid-bar"
          view={view}
          onView={setView}
          chips={typeChips(entries.map((e) => e.face))}
          all={entries.length}
          given="As listed"
          onEnter={submit}
          {...(!reveal && cant.length > 0 ? { info: <>Can pick <span className="n num">{can.length}</span></> } : {})}
          right={
            !reveal &&
            ask.max > 1 && (
              <button className="grid-chip" disabled={pickable.length === 0} onClick={selectAll} data-testid="ask-select-all">
                {allIn ? 'Clear' : 'Select all'}
              </button>
            )
          }
        />
      )}
      <div className="ask-body">
        <div className="carousel-col" onMouseLeave={leave}>
          <div className="carousel">
            {shown.map((it) => tile(it, h, reveal || it.enabled === false))}
            {shown.length === 0 && <div className="zv-empty">No cards match.</div>}
          </div>
          {shelf.length > 0 && (
            <div className="carousel-shelf" data-testid="ask-shelf">
              <button className="shelf-head" aria-expanded={shelfOpen} onClick={() => setShelfOpen(!shelfOpen)} data-testid="ask-shelf-toggle">
                <span className={`shelf-chev${shelfOpen ? ' open' : ''}`} aria-hidden="true">›</span>
                {shelf.length} {shelf.length === 1 ? 'card' : 'cards'} you can’t pick here
              </button>
              {shelfOpen && <div className="carousel shelf">{shelf.map((it) => tile(it, Math.round(h * 0.55), true))}</div>}
            </div>
          )}
        </div>
        <AskPreview peek={peek} height={previewHeight()} />
      </div>
    </PromptFrame>
  );
}

function OptionList({ ask, model, onReply }: { ask: ChooseAsk; model?: GameModel; onReply: (v: unknown) => void }) {
  const single = ask.max === 1;
  const { sel, toggle } = useSelection(ask.selected, ask.max);
  const own = model && ask.card ? itemFace({ idx: -1, label: '', card: ask.card }, model) : null;
  const { peek, bind, leave } = usePeek(ask.items, model ?? NO_CARDS, null, own);
  const ok = !!ask.reveal || (sel.length >= ask.min && sel.length <= ask.max);
  const pick = (idx: number) => {
    if (single && ask.min === 1) onReply([idx]);
    else toggle(idx);
  };
  useHotkeys(
    (e) => {
      const k = Number.parseInt(e.key, 10);
      if (k >= 1 && k <= 9 && ask.items[k - 1] && ask.items[k - 1]!.enabled !== false) {
        e.preventDefault();
        pick(ask.items[k - 1]!.idx);
      } else if (e.key === 'Enter' && ok) {
        e.preventDefault();
        onReply(ask.reveal ? [] : sel);
      } else if (e.key === 'Escape' && ask.min === 0) {
        e.preventDefault();
        onReply([]);
      }
    },
    [sel, ok],
  );
  const n = ask.items.length;
  return (
    <PromptFrame
      ask={ask}
      model={model}
      testId="ask-options"
      count={single || ask.reveal ? null : { n: sel.length, of: ask.max }}
      keys={[[n > 1 ? `1 – ${Math.min(n, 9)}` : '1', 'pick'], ...(single && ask.min === 1 ? [] : ([['Enter', 'confirm']] as [string, string][])), ...(ask.min === 0 ? ([['Esc', 'none']] as [string, string][]) : []), ['V', 'table']]}
      secondary={[ask.min === 0 && sel.length === 0 && !ask.reveal && { label: ask.kind === 'ability' ? 'Cancel' : 'None', onClick: () => onReply([]), testId: 'ask-none' }]}
      primary={
        !single || ask.min !== 1 || ask.reveal
          ? { label: ask.reveal ? 'OK' : chooseLabel(sel.length, 'option'), onClick: () => onReply(ask.reveal ? [] : sel), disabled: !ok }
          : null
      }
    >
      <div className="ask-body">
        <div className="option-list" onMouseLeave={leave}>
          {ask.items.map((it, i) => (
            <button
              key={it.idx}
              className={`option${sel.includes(it.idx) ? ' selected' : ''}`}
              disabled={!!ask.reveal || it.enabled === false}
              data-testid={`ask-item-${it.idx}`}
              onClick={() => pick(it.idx)}
              {...bind(it.idx)}
            >
              <span className="key">{i < 9 ? i + 1 : ''}</span>
              <ManaText text={it.label} />
              {sel.includes(it.idx) && !single && <PickBadge label={pickLabel(sel.indexOf(it.idx) + 1, true)} />}
            </button>
          ))}
        </div>
        <AskPreview peek={peek} height={Math.round(previewHeight() * 0.85)} />
      </div>
    </PromptFrame>
  );
}

/** For option lists with no game model (`options` asks): nothing to preview. */
const NO_CARDS = { cards: {} } as unknown as GameModel;

function OrderList({ ask, model, onReply }: { ask: OrderAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const [order, setOrder] = useState<number[]>(ask.selected ?? []);
  const [remember, setRemember] = useState(false);
  const own = ask.card ? itemFace({ idx: -1, label: '', card: ask.card }, model) : null;
  const { peek, bind, leave } = usePeek(ask.items, model, null, own);
  const ok = order.length >= ask.min && order.length <= ask.max;
  const toggle = (idx: number) => setOrder((cur) => (cur.includes(idx) ? cur.filter((x) => x !== idx) : cur.length < ask.max ? [...cur, idx] : cur));
  const submit = () => ok && onReply(ask.remember ? { order, remember } : { order });
  useHotkeys(
    (e) => {
      if (e.key === 'Enter' && ok) {
        e.preventDefault();
        submit();
      }
    },
    [order, ok, remember],
  );
  return (
    <PromptFrame
      ask={ask}
      model={model}
      testId="ask-order"
      count={{ n: order.length, of: ask.max, label: 'ordered' }}
      keys={[['Enter', 'confirm'], ['V', 'table']]}
      status={ask.remember && <RememberBox checked={remember} onChange={setRemember} />}
      secondary={[{ label: 'Auto', onClick: () => setOrder(ask.items.slice(0, ask.max).map((i) => i.idx)) }]}
      primary={{ label: 'Confirm order', onClick: submit, disabled: !ok }}
    >
      <div className="ask-body">
        <div className="option-list" onMouseLeave={leave}>
          {ask.items.map((it) => {
            const pos = order.indexOf(it.idx);
            const name = it.card ? model.cards[it.card]?.state?.name : undefined;
            return (
              <button key={it.idx} className={`option${pos >= 0 ? ' selected' : ''}`} data-testid={`ask-item-${it.idx}`} onClick={() => toggle(it.idx)} {...bind(it.idx)}>
                <span className={pos >= 0 ? 'order' : 'key'}>{pos >= 0 ? pos + 1 : '·'}</span>
                <ManaText text={name && name !== it.label ? `${name} — ${it.label}` : it.label} />
              </button>
            );
          })}
        </div>
        <AskPreview peek={peek} height={Math.round(previewHeight() * 0.85)} />
      </div>
    </PromptFrame>
  );
}

/** Forge's "remember this order", as the labelled switch the trigger order uses. */
function RememberBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="trig-remember">
      <input type="checkbox" role="switch" className="switch" checked={checked} data-testid="order-remember" onChange={(e) => onChange(e.target.checked)} />
      Always use this order for these cards
    </label>
  );
}

/** Lane tiles: big for a few cards, smaller for more, and two lanes always fit on a short screen. */
function laneTileHeight(n: number, laneCount: number): number {
  const base = (n <= 3 ? 220 : n <= 6 ? 180 : 140) * hudScale();
  const fit = Math.floor((window.innerHeight * 0.62 - laneCount * 78) / laneCount);
  return Math.round(Math.max(110, Math.min(base, fit)));
}

/** Order over cards, every card ordered ("put them back in any order"): one lane, first card on the left. */
function OrderLanes({ ask, model, onReply }: { ask: OrderAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const [lanes, setLanes] = useState<Lanes>(() => [initialOrder(ask.items.map((i) => i.idx), ask.selected)]);
  const [remember, setRemember] = useState(false);
  const order = lanes[0]!;
  const { peek, bind, leave } = usePeek(ask.items, model, order[0]);
  const submit = () => onReply(ask.remember ? { order, remember } : { order });
  useHotkeys(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
    [lanes, remember],
  );
  const specs: LaneSpec[] = [{ key: 'order', title: ask.message ? `1 = ${ask.message}` : 'First on the left', hint: 'drag, or use ‹ › (← →), to reorder' }];
  // The message names the first slot, so it heads the lane instead of the frame.
  return (
    <PromptFrame
      ask={{ ...ask, message: undefined }}
      model={model}
      testId="ask-order-lanes"
      keys={[['← →', 'move'], ['Enter', 'confirm'], ['V', 'table']]}
      status={ask.remember && <RememberBox checked={remember} onChange={setRemember} />}
      primary={{ label: 'Confirm order', onClick: submit }}
    >
      <div className="ask-body">
        <LaneBoard items={ask.items} model={model} lanes={lanes} specs={specs} tileH={laneTileHeight(order.length, 1)} onChange={setLanes} bind={bind} leave={leave} />
        <AskPreview peek={peek} height={previewHeight()} />
      </div>
    </PromptFrame>
  );
}

/** Scry: top and bottom lanes, each from the top of the library down. Everything starts on top. */
function ArrangeLanes({ ask, model, onReply }: { ask: ArrangeAsk; model: GameModel; onReply: (v: unknown) => void }) {
  type Key = 'top' | 'bottom' | 'graveyard';
  const keys = [ask.top ? 'top' : null, ask.bottom ? 'bottom' : null, ask.graveyard ? 'graveyard' : null].filter((k): k is Key => k !== null);
  const [lanes, setLanes] = useState<Lanes>(() => keys.map((_, i) => (i === 0 ? ask.items.map((it) => it.idx) : [])));
  const { peek, bind, leave } = usePeek(ask.items, model, lanes.find((l) => l.length > 0)?.[0]);
  const lane = (k: Key) => lanes[keys.indexOf(k)] ?? [];
  const submit = () => onReply(ask.graveyard ? { top: lane('top'), graveyard: lane('graveyard') } : { top: lane('top'), bottom: lane('bottom') });
  useHotkeys(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
    [lanes],
  );
  const n = ask.items.length;
  const specs: LaneSpec[] = keys.map((k) =>
    k === 'top'
      ? { key: 'top', title: 'Top of library', ...(n > 1 ? { hint: 'the left card is drawn first' } : {}) }
      : k === 'bottom'
        ? { key: 'bottom', title: 'Bottom of library', ...(n > 1 ? { hint: 'the right card ends up at the very bottom' } : {}) }
        : { key: 'graveyard', title: 'Graveyard' },
  );
  const onTop = lane('top').length;
  const other = ask.graveyard ? `${lane('graveyard').length} in the graveyard` : `${lane('bottom').length} on the bottom`;
  return (
    <PromptFrame
      ask={ask}
      model={model}
      testId="ask-arrange"
      title={ask.graveyard ? 'Top or graveyard' : 'Top or bottom'}
      keys={[['Enter', 'confirm'], ['V', 'table']]}
      status={
        <span className="msg" data-testid="arrange-count">
          {keys.length === 2 ? `${onTop} on top · ${other} · click a card to switch` : 'Drag, or use ‹ ›, to reorder'}
        </span>
      }
      primary={{ label: 'Confirm', onClick: submit }}
    >
      <div className="ask-body">
        <LaneBoard items={ask.items} model={model} lanes={lanes} specs={specs} tileH={laneTileHeight(n, keys.length)} onChange={setLanes} bind={bind} leave={leave} />
        <AskPreview peek={peek} height={previewHeight()} />
      </div>
    </PromptFrame>
  );
}

/** Each target's colour in the distribution bar and on its tile (a player is ember). */
const SPLIT_COLOURS = ['#5b8def', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'];

/**
 * One tile per target (card face, or the player's plate) with 48 px − / + and one action button:
 * "Lethal" (up to lethal) or "Rest here" (everything left). A bar shows where every point goes; each tile says
 * what it needs ("needs 2 for lethal", "after the blockers have lethal"), so Done is never disabled for no reason.
 * Tapping a card adds 1; right-click takes back and Shift-click fills stay as desktop shortcuts. A auto, R reset.
 */
function SplitBoard({ ask, model, onReply }: { ask: SplitAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const n = ask.items.length;
  const [a, setA] = useState<number[]>(() => split.initial(ask, n));
  const { peek, bind, leave } = usePeek(ask.items, model, null, ask.card ? itemFace({ idx: -1, label: '', card: ask.card }, model) : null);
  const ok = split.valid(ask, a);
  const rest = split.left(ask, a);
  const submit = () => ok && onReply(a);
  const reset = () => setA(Array.from({ length: n }, (_, i) => ask.min?.[i] ?? 0));
  useHotkeys(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setA(split.auto(ask, n));
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        reset();
      }
    },
    [a, ok],
  );
  const h = Math.round((n <= 3 ? 190 : n <= 6 ? 150 : 115) * hudScale());
  const colour = (i: number) => (ask.items[i]!.player ? 'var(--ember)' : SPLIT_COLOURS[i % SPLIT_COLOURS.length]!);
  const unit = ask.label;
  // Combat damage (blockers in order, lethal first): our own title and the rule in a sentence.
  const combat = !!ask.lethal;
  const rule = !combat ? undefined : ask.defender ? 'Blockers need lethal before the player can take any.' : 'Each blocker needs lethal before the next one takes any.';
  // "Rest here" (everything left) only on the last target that can still take some.
  const lastOpen = ask.items.reduce((last, _it, i) => (split.open(ask, a, i) ? i : last), -1);
  return (
    <PromptFrame
      ask={combat ? { ...ask, title: undefined, ...(rule ? { message: rule } : {}) } : ask}
      model={model}
      testId="ask-split"
      {...(combat ? { title: `Assign ${ask.amount} combat ${unit}` } : {})}
      count={{ n: rest, of: ask.amount, label: `${unit} left` }}
      keys={[['Enter', 'confirm'], ['A', 'auto'], ['R', 'reset'], ['V', 'table']]}
      status={
        <span className="msg" data-testid="split-left">
          {rest === 0 ? `All ${ask.amount} ${unit} assigned` : 'Tap a card = +1'}
        </span>
      }
      secondary={[
        ask.skip && { label: 'Another attacker first', onClick: () => onReply(null), testId: 'split-skip' },
        { label: 'Reset', onClick: reset, testId: 'split-reset' },
        { label: 'Auto', onClick: () => setA(split.auto(ask, n)), testId: 'split-auto' },
      ]}
      primary={{ label: rest > 0 ? `Assign ${rest} more` : `Assign ${ask.amount} ${unit}`, onClick: submit, disabled: !ok }}
    >
      <div className="split-bar" data-testid="split-bar" aria-hidden="true">
        {a.map((x, i) => x > 0 && <i key={i} style={{ flex: x, background: colour(i) }} />)}
        {rest > 0 && <i className="rest" style={{ flex: rest }} />}
      </div>
      <div className="ask-body">
        <div className="carousel split" onMouseLeave={leave}>
          {ask.items.map((it, i) => {
            const f = itemFace(it, model);
            const p = it.player ? model.players[it.player] : undefined;
            // The player trampled over: its "lethal" is its life, not a target to fill first.
            const lethal = ask.defender && i === n - 1 ? undefined : ask.lethal?.[i];
            const has = lethal !== undefined && lethal > 0 && a[i]! >= lethal;
            const shut = !split.open(ask, a, i);
            const max = ask.max?.[i] ?? ask.amount;
            // One action: up to lethal while short of it; once it has lethal, the rest goes on the last target only.
            const toLethal = lethal !== undefined && !has ? Math.min(lethal - a[i]!, rest) : 0;
            const toRest = i !== lastOpen ? 0 : Math.min(rest, max - a[i]!);
            const action =
              toLethal > 0 ? { label: `Lethal (+${toLethal})`, add: toLethal, rest: false } : toRest > 0 ? { label: `Rest here (+${toRest})`, add: toRest, rest: true } : { label: has ? 'Lethal ✓' : i === lastOpen ? 'Rest here' : 'Lethal', add: 0, rest: false };
            const hint = shut
              ? ask.defender && i === n - 1
                ? 'only once every blocker has lethal'
                : 'after the ones before it have lethal'
              : lethal !== undefined
                ? has
                  ? 'lethal ✓'
                  : `needs ${lethal} for lethal`
                : it.player && ask.defender
                  ? 'tramples over'
                  : a[i] === max
                    ? 'max'
                    : '';
            return (
              <div key={it.idx} className={`carousel-item split-item${a[i]! > 0 ? ' selected' : ''}${shut ? ' off' : ''}`} data-testid={`split-item-${it.idx}`}>
                <span className="split-sw" style={{ background: colour(i) }} />
                <button
                  className="split-target"
                  aria-disabled={shut || undefined}
                  onClick={(e) => setA((cur) => (e.shiftKey ? split.fill(ask, cur, i) : split.add(ask, cur, i, 1)))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setA((cur) => split.add(ask, cur, i, e.shiftKey ? -cur[i]! : -1));
                  }}
                  {...bind(it.idx)}
                >
                  {f ? (
                    <CardFaceView card={f.card} face={f.face} height={h} />
                  ) : (
                    <div className="split-player" style={{ height: h, width: Math.round(h * 0.72) }}>
                      <span className="name">{p?.name ?? it.label}</span>
                      {p && <span className="life num">{p.life}</span>}
                    </div>
                  )}
                </button>
                <span className="label">
                  <ManaText text={it.label} />
                </span>
                <span className={`split-mark${has ? ' on' : ''}`} data-testid={`split-hint-${it.idx}`}>
                  {hint || ' '}
                </span>
                <div className="split-dial">
                  <button className="btn secondary" aria-label={`Less ${unit} to ${it.label}`} data-testid={`split-less-${it.idx}`} disabled={a[i]! <= (ask.min?.[i] ?? 0)} onClick={() => setA((cur) => split.add(ask, cur, i, -1))}>
                    −
                  </button>
                  <span className="amount num" data-testid={`split-amount-${it.idx}`}>
                    {a[i]}
                  </span>
                  <button className="btn secondary" aria-label={`More ${unit} to ${it.label}`} data-testid={`split-more-${it.idx}`} disabled={shut || rest === 0 || a[i]! >= max} onClick={() => setA((cur) => split.add(ask, cur, i, 1))}>
                    +
                  </button>
                </div>
                <button className={`btn chip split-act${action.rest ? ' rest' : ''}`} disabled={shut || action.add <= 0} data-testid={`split-act-${it.idx}`} onClick={() => setA((cur) => split.add(ask, cur, i, action.add))}>
                  {action.label}
                </button>
              </div>
            );
          })}
        </div>
        <AskPreview peek={peek} height={previewHeight()} />
      </div>
    </PromptFrame>
  );
}

/**
 * A confirm reads as a question (the engine's question is the title when it is short), the card it is
 * about large on the left, and one answer per row: 1–9 picks, Enter takes the default, which wears the primary style
 * and an Enter badge. Space no longer answers (too easy to double-fire after a click).
 */
function ConfirmBar({ ask, model, onReply }: { ask: ConfirmAsk; model: GameModel; onReply: (v: unknown) => void }) {
  const card = ask.card ? model.cards[ask.card] : undefined;
  const face = card?.state ? undefined : ask.cardData?.state;
  const hs = hudScale();
  const def = ask.default ?? 0;
  useHotkeys(
    (e) => {
      const k = Number.parseInt(e.key, 10);
      if (k >= 1 && k <= 9 && k <= ask.options.length) {
        e.preventDefault();
        onReply(k - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onReply(def);
      }
    },
    [ask.id],
  );
  // The head names the card (art tile and name); the body draws it large.
  const { cardData: _face, message: _msg, ...words } = ask;
  const framed: ConfirmAsk = ask.title ? { ...words, ...(ask.message ? { message: ask.message } : {}) } : { ...words, ...confirmWords(ask.message) };
  const n = ask.options.length;
  return (
    <PromptFrame
      ask={framed}
      model={model}
      testId="ask-confirm"
      className="confirm-ask"
      keys={[[n > 1 ? `1 – ${Math.min(n, 9)}` : '1', 'answer'], ['Enter', ask.options[def] ?? 'default'], ['V', 'table']]}
    >
      <div className="confirm-body">
        {(card?.state || face) && <CardFaceView card={card} face={face} height={Math.round(260 * hs)} />}
        <div className="answers">
          {ask.options.map((label, i) => (
            <button key={i} className={`answer${i === def ? ' default' : ''}`} data-testid={`ask-option-${i}`} onClick={() => onReply(i)}>
              <span className="lbl">
                <ManaText text={label} />
              </span>
              {i === def ? <kbd>Enter</kbd> : i < 9 && <kbd className="key">{i + 1}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </PromptFrame>
  );
}

function OptionsAsk({ ask, onReply }: { ask: ConfirmAsk; onReply: (v: unknown) => void }) {
  const asChoose: ChooseAsk = useMemo(
    () => ({
      t: 'ask',
      seq: ask.seq,
      id: ask.id,
      kind: 'choose',
      items: ask.options.map((label, idx) => ({ idx, label })),
      min: 1,
      max: 1,
      ...(ask.title ? { title: ask.title } : {}),
      ...(ask.message ? { message: ask.message } : {}),
      ...(ask.error ? { error: ask.error } : {}),
    }),
    [ask],
  );
  return <OptionList ask={asChoose} onReply={(v) => onReply((v as number[])[0] ?? ask.default)} />;
}

/** A partial order over cards (pick some of them, in order) reads as a carousel with numbered picks. */
function orderAsChoose(ask: OrderAsk): ChooseAsk {
  return {
    t: 'ask',
    seq: ask.seq,
    id: ask.id,
    kind: 'choose',
    items: ask.items,
    min: ask.min,
    max: ask.max,
    ...(ask.selected ? { selected: ask.selected } : {}),
    ...(ask.title ? { title: ask.title } : {}),
    ...(ask.message ? { message: ask.message } : {}),
    ...(ask.error ? { error: ask.error } : {}),
  };
}

/** Typed text. With options (a short fixed list), the matches as a list under the field: ↑ ↓ move, Enter takes the highlight. */
function TextEntry({ ask, onReply }: { ask: TextAsk; onReply: (v: unknown) => void }) {
  const [value, setValue] = useState(ask.initial ?? '');
  const [hi, setHi] = useState(0);
  const q = value.trim().toLowerCase();
  const matches = ask.options ? ask.options.filter((o) => o.toLowerCase().includes(q)).slice(0, 50) : [];
  const valid = ask.numeric ? /^-?\d+$/.test(value) : value.length > 0;
  const take = matches[Math.min(hi, matches.length - 1)];
  const submit = () => {
    if (take !== undefined && take.toLowerCase() !== value.toLowerCase() && !ask.options!.some((o) => o.toLowerCase() === value.toLowerCase())) onReply(take);
    else if (valid) onReply(value);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onReply(null);
    } else if (matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHi((h) => (e.key === 'ArrowDown' ? Math.min(h + 1, matches.length - 1) : Math.max(h - 1, 0)));
    }
  };
  return (
    <PromptFrame
      ask={ask}
      testId="ask-text"
      className="text-entry"
      keys={[...(matches.length > 0 ? ([['↑ ↓', 'move']] as [string, string][]) : []), ['Enter', 'confirm'], ['Esc', 'cancel']]}
      secondary={[{ label: 'Cancel', onClick: () => onReply(null), testId: 'ask-text-cancel' }]}
      primary={{ label: take !== undefined && ask.options ? `Choose ${take}` : 'Confirm', onClick: submit, disabled: !valid && take === undefined }}
    >
      <form
        className="te-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="te-field">
          {ask.options && (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}
          <input
            autoFocus
            className="field"
            type={ask.numeric ? 'number' : 'text'}
            value={value}
            onKeyDown={onKey}
            onChange={(e) => {
              setValue(e.target.value);
              setHi(0);
            }}
            role={ask.options ? 'combobox' : undefined}
            aria-expanded={ask.options ? matches.length > 0 : undefined}
            aria-controls={ask.options ? `te-${ask.id}` : undefined}
            data-testid="ask-input"
          />
        </span>
        {ask.options && (
          <div className="te-list" id={`te-${ask.id}`} role="listbox" data-testid="ask-text-options">
            {matches.map((o, i) => (
              <button type="button" key={o} role="option" aria-selected={i === hi} className={`te-opt${i === hi ? ' on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => onReply(o)}>
                {q && o.toLowerCase().includes(q) ? (
                  <>
                    {o.slice(0, o.toLowerCase().indexOf(q))}
                    <u>{o.slice(o.toLowerCase().indexOf(q), o.toLowerCase().indexOf(q) + q.length)}</u>
                    {o.slice(o.toLowerCase().indexOf(q) + q.length)}
                  </>
                ) : (
                  o
                )}
              </button>
            ))}
            {matches.length === 0 && <span className="hint">No match. Enter uses what you typed.</span>}
          </div>
        )}
      </form>
    </PromptFrame>
  );
}

/** The text ask Forge raises after the X picker's "Other..." pick: answered with the number already chosen. */
function AutoReply({ value, onReply }: { value: string; onReply: (v: unknown) => void }) {
  useLayoutEffect(() => {
    setPendingNumber(null);
    onReply(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function AskLayer() {
  const asks = useUi((s) => s.asks);
  const model = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const [sent, setSent] = useState<string | null>(null);
  const top = asks[asks.length - 1];
  // Mana choices (a mana ability menu, a colour): the picker fanned over the source card, no modal list.
  const mana = top ? manaPickForAsk(top) : null;
  const auto = top?.kind === 'text' ? pendingAnswer(top) : null;
  // Numbers (X, how many…): the X picker instead of a list of numbers.
  const num = top ? numberSpec(top) : null;
  // "Show battlefield" puts the modal away (the mana picker registers itself).
  const peek = useBattlefieldPeek(!!top && !mana && auto === null, top ? askPeekLabel(top, !!num) : '', top?.id);
  if (!top) return null;
  const answered = sent === top.id;
  const onReply = (v: unknown) => {
    if (answered) return;
    setSent(top.id);
    runtime().reply(top, v);
  };
  if (mana) {
    if (answered) return null;
    return <ManaPicker key={top.id} pick={mana} onPick={(o) => 'ask' in o.reply && onReply(o.reply.ask)} onCancel={mana.cancel ? () => onReply([]) : null} />;
  }
  if (auto !== null) return answered ? null : <AutoReply key={top.id} value={auto} onReply={onReply} />;
  let body: React.ReactNode;
  switch (top.kind) {
    case 'choose':
    case 'ability':
      body = num ? (
        <XPicker key={top.id} ask={top} spec={num} model={model} viewer={viewer} onReply={onReply} />
      ) : isNameAsk(top) ? (
        <NameCard key={top.id} ask={top} model={model} viewer={viewer} onReply={onReply} />
      ) : optionHost(top, model) ? (
        <OptionCards key={top.id} ask={top} host={optionHost(top, model)!} model={model} onReply={onReply} />
      ) : faceTiles(top.items, model) ? (
        <CardCarousel key={top.id} ask={top} model={model} onReply={onReply} />
      ) : (
        <OptionList key={top.id} ask={top} model={model} onReply={onReply} />
      );
      break;
    case 'order': {
      const n = top.items.length;
      if (isTriggerOrder(top)) body = <TriggerOrder key={top.id} ask={top} model={model} onReply={onReply} />;
      else if (!faceTiles(top.items, model)) body = <OrderList key={top.id} ask={top} model={model} onReply={onReply} />;
      else if (top.min === n && top.max === n) body = <OrderLanes key={top.id} ask={top} model={model} onReply={onReply} />;
      else body = <CardCarousel key={top.id} ask={orderAsChoose(top)} model={model} onReply={(v) => onReply({ order: v })} />;
      break;
    }
    case 'arrange':
      body = <ArrangeLanes key={top.id} ask={top} model={model} onReply={onReply} />;
      break;
    case 'split':
      body = <SplitBoard key={top.id} ask={top} model={model} onReply={onReply} />;
      break;
    case 'confirm':
      body = <ConfirmBar key={top.id} ask={top} model={model} onReply={onReply} />;
      break;
    case 'options':
      body = <OptionsAsk key={top.id} ask={top} onReply={onReply} />;
      break;
    case 'text':
      body = num ? <XPicker key={top.id} ask={top} spec={num} model={model} viewer={viewer} onReply={onReply} /> : <TextEntry key={top.id} ask={top} onReply={onReply} />;
      break;
    default:
      body = null;
  }
  return (
    <div className={`scrim ask-scrim${peek.className}`} inert={peek.inert} data-testid="ask-layer" style={answered ? { pointerEvents: 'none', opacity: 0.85 } : undefined}>
      <motion.div
        key={top.id}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0, 0, 0.2, 1] }}
      >
        {body}
      </motion.div>
    </div>
  );
}

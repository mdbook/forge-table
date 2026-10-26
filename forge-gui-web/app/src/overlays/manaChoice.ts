/**
 * Mana choices ("a selector for mana that's not just a dropdown", MTGA-style), as the bridge sends them. The
 * picker (ManaPicker.tsx) replaces the list for these; everything else keeps it. The shapes:
 *
 * - Which mana ability of a source (a dual land, a painland's two abilities):
 *   - while paying (InputPayMana.activateManaAbility, only when the express choice can't decide): a `choose` ask,
 *     message "Choose a mana ability:", `min` 1 / `max` 1, one item per ability labelled with its description
 *     ("{T}: Add {W}.", "{T}: Add {W} or {B}. Caves of Koilos deals 1 damage to you.") and `card` = the source;
 *   - at priority, clicking the land (getAbilityToPlay): an `ability` ask, message "Choose an ability", `min` 0 /
 *     `max` 1, the same labels with `enabled`, and the ask's `card` = the source.
 * - Which colour (PlayerControllerHuman.chooseColor, "Select Mana to Produce" for any-colour sources, "Choose a
 *   color"…): three or more colours are a `choose` ask over Forge's colour enum, labels "WHITE" "BLUE" "BLACK" "RED"
 *   "GREEN" "COLORLESS", `min` 1 / `max` 1, no card; two colours are a `confirm` PROMPT (InputConfirm, not an ask)
 *   with the colour names on its buttons ("White" / "Blue"), the source as the prompt's card.
 *
 * The reply is what the list (or the prompt's buttons) would send.
 */
import type { AskMsg, CardId, PromptBody } from '@forge-table/protocol';
import { tokenizeMana } from '../cards/mana';

export type ManaLetter = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

export interface ManaOption {
  key: string;
  /** An ask's reply (`[idx]`), or the prompt act to send (`ok` / `cancel`). */
  reply: { ask: number[] } | { act: 'ok' | 'cancel' };
  /** What it adds: mana symbols as written inside the braces ("W", "C", "2"), or `any` for any colour. */
  symbols: string[];
  /** One of the symbols, not all of them ("Add {W} or {U}"). */
  or: boolean;
  /** The rest of the ability: its cost beyond {T}, and anything it does besides adding mana. */
  note: string | null;
  /** Screen readers: "Add blue mana". */
  label: string;
  enabled: boolean;
  /** W U B R G C, when the option adds just that colour. */
  hotkey: ManaLetter | null;
}

export interface ManaPick {
  options: ManaOption[];
  /** The source on the table, to anchor the picker at. */
  card: CardId | null;
  title: string;
  /** The choice may be declined (an ability menu at priority). */
  cancel: boolean;
}

const COLOR_WORDS: Record<string, ManaLetter> = { WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C' };
const NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

export function colorWord(label: string): ManaLetter | null {
  return COLOR_WORDS[label.trim().toUpperCase()] ?? null;
}

/** "{T}, Pay 1 life: Add {B}." → its parts; null when the text doesn't add mana. */
export function parseManaAbility(label: string): { symbols: string[]; or: boolean; note: string | null } | null {
  const m = /^(?:(.+?):\s*)?Add\s+(.+?)(?:\.(?:\s+(.*))?)?$/is.exec(label.trim());
  if (!m) return null;
  const [, cost, what, rest] = m;
  if (cost && cost.includes('.')) return null; // "Add" inside a longer text, not an ability's effect
  const symbols = tokenizeMana(what!).map((t) => t.raw.toUpperCase());
  if (symbols.length === 0 && !/\bany\b.*\bcolou?rs?\b/i.test(what!)) return null;
  if (symbols.some((s) => !/^(\d+|[WUBRGCS])$/.test(s))) return null;
  const costRest = (cost ?? '').replace(/\{T\}\s*,?\s*/i, '').trim();
  const note = [costRest, (rest ?? '').trim()].filter(Boolean).join(' · ');
  return { symbols: symbols.length > 0 ? symbols : ['any'], or: symbols.length > 1 && /\bor\b/i.test(what!), note: note || null };
}

function spoken(symbols: string[], or: boolean): string {
  if (symbols[0] === 'any') return 'Add one mana of any color';
  const words = symbols.map((s) => (/^\d+$/.test(s) ? `${s} generic` : (NAMES[s] ?? s)));
  if (or) return `Add ${words.join(' or ')} mana`;
  const same = words.every((w) => w === words[0]);
  return same && words.length > 1 ? `Add ${words.length} ${words[0]} mana` : `Add ${words.join(' and ')} mana`;
}

/** A single colour letter for the option's hotkey, if it adds just that. */
function soleLetter(symbols: string[], or: boolean): ManaLetter | null {
  if (or || symbols.length === 0) return null;
  const s = symbols[0]!;
  return /^[WUBRGC]$/.test(s) && symbols.every((x) => x === s) ? (s as ManaLetter) : null;
}

function withHotkeys(options: Omit<ManaOption, 'hotkey'>[]): ManaOption[] {
  const used = new Set<string>();
  return options.map((o) => {
    const l = soleLetter(o.symbols, o.or);
    const hotkey = l && !used.has(l) ? l : null;
    if (hotkey) used.add(hotkey);
    return { ...o, hotkey };
  });
}

/** The mana picker for an ask, or null when the ask is not a mana choice (it keeps its list). */
export function manaPickForAsk(ask: AskMsg): ManaPick | null {
  if ((ask.kind !== 'choose' && ask.kind !== 'ability') || ask.max !== 1 || ask.reveal || ask.items.length < 2) return null;
  if (ask.items.some((it) => it.player || it.cardData)) return null;
  const title = ask.message ?? ask.title ?? '';
  const cancel = ask.min === 0;
  const colors = ask.items.map((it) => colorWord(it.label));
  if (colors.every((c) => c !== null)) {
    // A colour for mana says so; any other colour choice (protection, "choose a color") is just the colour.
    const say = (l: ManaLetter) => (/mana/i.test(title) ? spoken([l], false) : NAMES[l]!.replace(/^./, (c) => c.toUpperCase()));
    return {
      options: withHotkeys(ask.items.map((it, i) => ({ key: `i${it.idx}`, reply: { ask: [it.idx] }, symbols: [colors[i]!], or: false, note: null, label: say(colors[i]!), enabled: it.enabled !== false }))),
      card: ask.card ?? null,
      title,
      cancel,
    };
  }
  const parsed = ask.items.map((it) => parseManaAbility(it.label));
  if (parsed.some((p) => p === null)) return null;
  return {
    options: withHotkeys(
      ask.items.map((it, i) => {
        const p = parsed[i]!;
        return { key: `i${it.idx}`, reply: { ask: [it.idx] }, symbols: p.symbols, or: p.or, note: p.note, label: spoken(p.symbols, p.or) + (p.note ? ` (${p.note})` : ''), enabled: it.enabled !== false };
      }),
    ),
    card: ask.card ?? ask.items.find((it) => it.card)?.card ?? null,
    title,
    cancel,
  };
}

/** Two colours to choose from arrive as a confirm prompt with the colour names on its buttons. */
export function manaPickForPrompt(p: PromptBody | null): ManaPick | null {
  if (!p || p.kind !== 'confirm' || !p.ok.enabled || !p.cancel.enabled) return null;
  const a = colorWord(p.ok.label);
  const b = colorWord(p.cancel.label);
  if (!a || !b || a === b) return null;
  const opt = (l: ManaLetter, act: 'ok' | 'cancel') => ({ key: act, reply: { act }, symbols: [l], or: false, note: null, label: spoken([l], false), enabled: true });
  return { options: withHotkeys([opt(a, 'ok'), opt(b, 'cancel')]), card: p.card ?? null, title: p.message.trim(), cancel: false };
}

// ------------------------------------------------------------------------------------------ cost tracker

/** The cost still to pay in a payMana prompt ("Pay Mana Cost: {1}{U}{B}", "…: 0" when done), as symbols. */
export function payCost(message: string | undefined): string[] | null {
  const m = /Pay Mana Cost:\s*((?:\{[^{}\s]+\})+|0)/.exec(message ?? '');
  if (!m) return null;
  return m[1] === '0' ? [] : tokenizeMana(m[1]!).map((t) => t.raw.toUpperCase());
}

/**
 * A stable key per pip, so a paid pip leaves and the rest stay put: the generic part (one symbol, or one per digit
 * past {20}) keys by position among the generic symbols, every other symbol by its kind and count ("U#0", "U#1").
 * The generic pip keeps its key as its number drops.
 */
export function pipKeys(symbols: string[]): string[] {
  const seen = new Map<string, number>();
  return symbols.map((s) => {
    const kind = /^\d+$/.test(s) ? 'generic' : s;
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    return `${kind}#${n}`;
  });
}

/** The pips paid between two states of the cost (keys gone from `next`), for the pop. */
export function paidKeys(prev: string[], next: string[]): string[] {
  const keep = new Set(pipKeys(next));
  return pipKeys(prev).filter((k) => !keep.has(k));
}

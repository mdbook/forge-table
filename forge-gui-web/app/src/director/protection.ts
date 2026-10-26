/**
 * Hexproof / shroud / protection / ward.
 * Pure reads of the card model's keyword titles (`state.keywords[].title`, Forge's own wording: "Hexproof", "Hexproof
 * from blue", "Shroud", "Protection from red", "Ward {2}", "Ward—Pay 3 life."), never rules text. The scene draws the
 * sigils and auras (table/protectionFx.ts); the aim controller asks {@link illegalTarget} what a pointer over a
 * protected card should do; the arrows ask {@link wardTrigger} which stack item is a ward trigger.
 *
 * What is NOT on the wire and so not done: "Hexproof from <other>" / "Protection from <other>" qualifiers beyond colours,
 * everything, card types and (mono|multi)coloured are shown as a sigil but never judged illegal (no false deflects).
 */
import type { Card, CardId, GameModel, PlayerId, StackItem } from '@forge-table/protocol';

export type ShieldKind = 'hexproof' | 'shroud' | 'protection';

/** One hexproof / shroud / protection keyword. `from` is the lowercase qualifier ("blue", "everything"), null if unqualified. */
export interface Shield {
  kind: ShieldKind;
  from: string | null;
}

/** What a ward costs, as far as the title says: mana text (`{2}`), life, or a word for the rest. */
export type WardCost = { kind: 'mana'; text: string } | { kind: 'life'; n: number } | { kind: 'discard' } | { kind: 'sacrifice' } | { kind: 'other'; text: string };

export interface Protections {
  shields: Shield[];
  wards: WardCost[];
  /** Changes whenever what is drawn would (badge rebuild key). */
  key: string;
}

const COLOR_LETTER: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** The sigils a battlefield card wears, or null (nothing to draw; also for any card off the battlefield). */
export function protectionOf(card: Card | undefined): Protections | null {
  if (!card || card.zone !== 'Battlefield' || card.facedown) return null;
  const shields: Shield[] = [];
  const wards: WardCost[] = [];
  for (const k of card.state?.keywords ?? []) {
    const t = k.title.trim();
    let m: RegExpMatchArray | null;
    if (/^shroud$/i.test(t)) shields.push({ kind: 'shroud', from: null });
    else if (/^hexproof$/i.test(t)) shields.push({ kind: 'hexproof', from: null });
    else if ((m = t.match(/^hexproof from (.+)$/i))) shields.push({ kind: 'hexproof', from: m[1]!.toLowerCase() });
    else if ((m = t.match(/^protection from (.+)$/i))) shields.push({ kind: 'protection', from: m[1]!.toLowerCase() });
    else if ((m = t.match(/^ward(.*)$/i))) wards.push(wardCostOf(m[1]!));
  }
  if (shields.length === 0 && wards.length === 0) return null;
  const key = [...shields.map((s) => `${s.kind}:${s.from ?? ''}`), ...wards.map(wardLabel)].join('|');
  return { shields, wards, key };
}

/** Parse what follows "Ward" in a title: " {2}", "—Pay 3 life.", "—Discard a card." */
export function wardCostOf(rest: string): WardCost {
  const s = rest.replace(/^[\s—-]+/, '').replace(/\.$/, '').trim();
  let m: RegExpMatchArray | null;
  if (/^(\{[^}]+\})+$/.test(s)) return { kind: 'mana', text: s };
  if ((m = s.match(/^pay (\d+) life$/i))) return { kind: 'life', n: Number(m[1]) };
  if (/^discard\b/i.test(s)) return { kind: 'discard' };
  if (/^sacrifice\b/i.test(s)) return { kind: 'sacrifice' };
  return { kind: 'other', text: s };
}

/** A short label for a ward cost (the sigil's text, tests). */
export function wardLabel(c: WardCost): string {
  switch (c.kind) {
    case 'mana':
      return c.text;
    case 'life':
      return `${c.n} life`;
    case 'discard':
      return 'discard';
    case 'sacrifice':
      return 'sacrifice';
    default:
      return c.text;
  }
}

/** Does `source` match a "from X" qualifier? true / false, or null when we can't tell (never deflect on null). */
function matches(from: string, source: Card | undefined): boolean | null {
  if (from === 'everything' || from === 'all') return true;
  const s = source?.state;
  if (!s) return null;
  const colors = s.colors ?? '';
  const letter = COLOR_LETTER[from];
  if (letter) return colors.includes(letter);
  if (from === 'monocolored') return colors.length === 1;
  if (from === 'multicolored') return colors.length > 1;
  if (from === 'colorless') return colors.length === 0;
  const core = s.type?.core ?? [];
  const single = from.replace(/ies$/, 'y').replace(/s$/, '');
  const hit = core.find((c) => c.toLowerCase() === single);
  if (hit) return true;
  if (['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'instant', 'sorcery', 'battle'].includes(single)) return false;
  return null;
}

/**
 * Why `source` (the card whose spell or ability is being aimed) cannot target `target`, or null when it can (or we
 * can't tell). Shroud stops everyone; hexproof stops the target's opponents; protection stops a matching source.
 */
export function illegalTarget(target: Card | undefined, source: Card | undefined, by: PlayerId | undefined): ShieldKind | null {
  const p = protectionOf(target);
  if (!p || !target) return null;
  const opposing = !!by && !!target.controller && target.controller !== by;
  for (const s of p.shields) {
    if (s.kind === 'shroud') return 'shroud';
    if (s.kind === 'hexproof' && opposing && (s.from === null || matches(s.from, source) === true)) return 'hexproof';
    if (s.kind === 'protection' && s.from !== null && matches(s.from, source) === true) return 'protection';
  }
  return null;
}

/**
 * The permanent a stack item's ward trigger belongs to, or null if the item is not one: a triggered ability whose
 * source wears ward and whose text says ward / "counter … unless".
 */
export function wardTrigger(model: GameModel, item: StackItem): CardId | null {
  if (!item.trigger || !item.source) return null;
  const src = model.cards[item.source];
  if (!protectionOf(src)?.wards.length) return null;
  return /\bward\b|counter\b.*\bunless\b/i.test(item.text) ? item.source : null;
}

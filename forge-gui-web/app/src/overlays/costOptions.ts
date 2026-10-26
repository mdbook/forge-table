/**
 * "How do you want to cast this?": when Forge's ability menu offers several ways to play ONE card (cast normally /
 * flashback / bestow / mutate / dash…), each option's heading and cost are read off its label, for the option cards'
 * captions and cost plates (optionFaces.ts). Presentation only: the reply is the same item index. Nothing is guessed
 * about the wire: an ask that doesn't look like that (several cards, no alternative-cost keyword in a label) returns null.
 */
import type { AskMsg } from '@forge-table/protocol';

/** Alternative-cost and mode keywords Forge puts in a spell ability's description. */
const MODES = [
  'Flashback', 'Escape', 'Disturb', 'Bestow', 'Mutate', 'Prototype', 'Dash', 'Blitz', 'Evoke', 'Warp', 'Overload', 'Madness',
  'Foretell', 'Plot', 'Cleave', 'Emerge', 'Spectacle', 'Surge', 'Prowl', 'Sneak', 'Ninjutsu', 'Squad', 'Offspring', 'Adventure',
] as const;
const MODE_RE = new RegExp(`\\b(${MODES.join('|')})\\b`, 'i');
const COST_RE = /(?:\{[^}]+\})+/;

export interface CostOption {
  idx: number;
  enabled: boolean;
  /** "Flashback", "Cast", "Ability"… the option's heading. */
  mode: string;
  /** The first mana cost in the label as Forge text ("{2}{R}"), when it has one. */
  cost?: string;
  /** What is left of the label once the heading and the cost are taken out, shortened. */
  detail: string;
}

/** The options for an ability menu over one card with an alternative way to play it; null for anything else. */
export function costOptions(ask: AskMsg): CostOption[] | null {
  if (ask.kind !== 'ability' || ask.max !== 1 || ask.items.length < 2 || ask.items.length > 4) return null;
  const cards = new Set(ask.items.map((i) => i.card ?? ask.card ?? ''));
  if (cards.size !== 1 || cards.has('')) return null;
  if (!ask.items.some((i) => MODE_RE.test(i.label))) return null;
  return ask.items.map((it) => {
    const m = MODE_RE.exec(it.label);
    const cost = COST_RE.exec(it.label)?.[0];
    const mode = m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() : /^(cast|play)\b/i.test(it.label) ? 'Cast' : 'Ability';
    let detail = it.label.replace(m?.[0] ?? '', '').replace(cost ?? '', '').replace(/\s+/g, ' ').replace(/^[\s:—–-]+|[\s:—–-]+$/g, '');
    if (detail.length > 90) detail = `${detail.slice(0, 87)}…`;
    return { idx: it.idx, enabled: it.enabled !== false, mode, ...(cost ? { cost } : {}), detail };
  });
}

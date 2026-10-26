/**
 * The data the M15 face painter draws, and the two adapters that fill it: the client's card model (a `CardFace` from the
 * wire) and Scryfall card JSON (the comparison harness's references). Pure; no canvas.
 */
import type { Card, CardFace } from '@forge-table/protocol';

export type M15Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus' | '';

export interface M15Card {
  name: string;
  /** Forge/Scryfall mana-cost text, `{2}{R}{R}`. */
  manaCost: string;
  /** The whole type line, em-dash and all ("Legendary Creature — Goblin Warrior"). */
  typeLine: string;
  /** WUBRG letters of the card's colour (its frame), '' for colourless. */
  colors: string;
  /** Rules text, paragraphs separated by `\n`; reminder text in parentheses is set in italics. */
  rules: string;
  flavor: string;
  power: string;
  toughness: string;
  loyalty: string;
  /** Battle defence. */
  defense: string;
  rarity: M15Rarity;
  /** Lowercase set code ("fdn"). */
  set: string;
  collectorNumber: string;
  artist: string;
  /** What a land can produce, WUBRG letters (+ 'C'), for its frame. */
  produced: string;
  /** The copyright year on the bottom line. */
  year: string;
  /** An extra licensor line above the Wizards one ("© 2026 CBS."). */
  licensor: string;
  /** Whether the card is a token (layoutFor gives it a tall art window instead of the standard frame's). */
  token: boolean;
}

export interface M15Types {
  legendary: boolean;
  basic: boolean;
  creature: boolean;
  land: boolean;
  artifact: boolean;
  enchantment: boolean;
  planeswalker: boolean;
  instant: boolean;
  sorcery: boolean;
  battle: boolean;
  vehicle: boolean;
  snow: boolean;
}

/** The card's types, read off its type line. */
export function parseTypes(typeLine: string): M15Types {
  const has = (w: string) => new RegExp(`\\b${w}\\b`, 'i').test(typeLine.split('—')[0] ?? '');
  return {
    legendary: has('Legendary'),
    basic: has('Basic'),
    creature: has('Creature'),
    land: has('Land'),
    artifact: has('Artifact'),
    enchantment: has('Enchantment'),
    planeswalker: has('Planeswalker'),
    instant: has('Instant'),
    sorcery: has('Sorcery'),
    battle: has('Battle'),
    vehicle: /\bVehicle\b/i.test(typeLine),
    snow: has('Snow'),
  };
}

const BASIC_SUBTYPE: Record<string, string> = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };

/**
 * The colour letter (W/U/B/R/G, C for Wastes) of the big mana-symbol watermark a basic land prints behind its text, or
 * null for anything that is not a basic land. The basic subtype decides; a basic without one (Wastes) falls back to
 * the single colour it produces, else colourless.
 */
export function landWatermark(card: Pick<M15Card, 'typeLine' | 'produced'>): string | null {
  if (!parseTypes(card.typeLine).basic) return null;
  const subs = (card.typeLine.split('—')[1] ?? '').toLowerCase().split(/\s+/);
  for (const s of subs) if (BASIC_SUBTYPE[s]) return BASIC_SUBTYPE[s]!;
  const prod = [...new Set(card.produced.split('').filter((c) => 'WUBRGC'.includes(c)))];
  return prod.length === 1 ? prod[0]! : 'C';
}

/**
 * The rules text a card actually prints: a basic land's `({T}: Add {G}.)` reminder is rules-engine text, not printed
 * (the box shows only flavor, set larger).
 */
export function printedRules(card: Pick<M15Card, 'rules' | 'typeLine'>): string {
  if (parseTypes(card.typeLine).basic && /^\s*\(\{T\}: Add \{[WUBRGC]\}\.\)\s*$/.test(card.rules)) return '';
  return card.rules;
}

export function blankCard(): M15Card {
  return {
    name: '',
    manaCost: '',
    typeLine: '',
    colors: '',
    rules: '',
    flavor: '',
    power: '',
    toughness: '',
    loyalty: '',
    defense: '',
    rarity: '',
    set: '',
    collectorNumber: '',
    artist: '',
    produced: '',
    year: String(new Date().getFullYear()),
    licensor: '',
    token: false,
  };
}

const RARITY: Record<string, M15Rarity> = {
  common: 'common',
  basicland: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  mythic: 'mythic',
  mythicrare: 'mythic',
  special: 'special',
  bonus: 'bonus',
};

export function normRarity(r: string | undefined): M15Rarity {
  return RARITY[(r ?? '').toLowerCase().replace(/[\s_-]/g, '')] ?? '';
}

/** The bottom line's rarity letter: C, U, R, M (T for tokens is the caller's business). */
export function rarityLetter(r: M15Rarity): string {
  return r === 'mythic' ? 'M' : r === 'special' ? 'S' : r === 'bonus' ? 'B' : r ? r.charAt(0).toUpperCase() : '';
}

/** The frame colours a card shows: its colour letters in WUBRG order. */
export function colorLetters(colors: string | string[] | undefined): string {
  const s = Array.isArray(colors) ? colors.join('') : (colors ?? '');
  return 'WUBRG'.split('').filter((c) => s.toUpperCase().includes(c)).join('');
}

// ------------------------------------------------------------------------------------------ Scryfall

/** The bits of a Scryfall card object the adapter reads (all optional: faces of split/double cards live in `card_faces`). */
export interface ScryfallCard {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  flavor_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
  rarity?: string;
  set?: string;
  collector_number?: string;
  artist?: string;
  produced_mana?: string[];
  released_at?: string;
  card_faces?: ScryfallCard[];
  /** 'token' / 'double_faced_token' for a token printing (the paper tokens that ship with a set, not a card). */
  layout?: string;
}

/** A Scryfall card (its front face) as an M15Card. */
export function fromScryfall(json: ScryfallCard, face = 0): M15Card {
  const f = json.card_faces?.[face] ?? json;
  const c = blankCard();
  c.name = f.name ?? json.name ?? '';
  c.manaCost = f.mana_cost ?? '';
  c.typeLine = f.type_line ?? json.type_line ?? '';
  c.colors = colorLetters(f.colors ?? json.colors);
  c.rules = f.oracle_text ?? '';
  c.flavor = f.flavor_text ?? '';
  c.power = f.power ?? '';
  c.toughness = f.toughness ?? '';
  c.loyalty = f.loyalty ?? '';
  c.defense = f.defense ?? '';
  c.rarity = normRarity(json.rarity);
  c.set = (json.set ?? '').toLowerCase();
  c.collectorNumber = (json.collector_number ?? '').replace(/^.*-/, '');
  c.artist = f.artist ?? json.artist ?? '';
  c.produced = colorLetters(json.produced_mana) + (json.produced_mana?.includes('C') ? 'C' : '');
  c.year = (json.released_at ?? '').slice(0, 4) || c.year;
  c.token = json.layout === 'token' || json.layout === 'double_faced_token';
  return c;
}

// ------------------------------------------------------------------------------------------ client

/** A client card face (the wire model) as an M15Card. Flavor text, artist and collector number aren't on the wire. */
export function fromClientFace(face: CardFace, card?: Pick<Card, 'token'>): M15Card {
  const c = blankCard();
  const t = face.type;
  const left = [...(t?.super ?? []), ...(t?.core ?? [])].join(' ');
  const sub = (t?.sub ?? []).join(' ');
  c.name = face.name ?? '';
  c.manaCost = face.manaCost ?? '';
  c.typeLine = (sub ? `${left} — ${sub}` : left) || '';
  c.token = !!card?.token;
  if (c.token && c.typeLine) c.typeLine = `Token ${c.typeLine}`;
  c.colors = colorLetters(face.colors);
  c.rules = face.oracleText ?? (face.keywords ?? []).map((k) => k.title).join(', ');
  const pt = (n: number | undefined, printed: number | undefined) => (typeof n === 'number' ? String(n) : typeof printed === 'number' ? String(printed) : '');
  if (t?.core?.includes('Creature') || typeof face.power === 'number') {
    c.power = pt(face.power, face.printedPower) || '0';
    c.toughness = pt(face.toughness, face.printedToughness) || '0';
  }
  if (face.loyalty && face.loyalty !== '0') c.loyalty = face.loyalty;
  if (face.defense && face.defense !== '0') c.defense = face.defense;
  c.rarity = normRarity(face.rarity);
  c.set = (face.setCode ?? '').toLowerCase();
  c.produced = typeof face.origProduceMana === 'string' ? face.origProduceMana.replace(/[^WUBRGC]/g, '') : '';
  return c;
}

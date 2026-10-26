/**
 * Start-screen logic that doesn't need React: the AI picker (Neural is the default opponent when the
 * sidecar can run it), the opponent-deck picker, and the deck-import panel's parameters and result text.
 */
import type { DeckImportParams, DeckImportResult, DeckProblems, ImportedCard, GameFormat, NeuralStatus, WelcomeMsg } from '@forge-table/protocol';
import type { DeckDetail } from '../lobby/api';

// ------------------------------------------------------------------------------------------ AI picker

export const NEURAL = 'Neural';

let neuralLabel = NEURAL;

/** The server's name for the Neural AI (`welcome.neural.label`, the server's FT_NEURAL_LABEL); absent = "Neural". */
export function setNeuralLabel(label: string | undefined): void {
  neuralLabel = label?.trim() || NEURAL;
}

/**
 * What the UI calls an AI profile: Neural by the server's label, Default is Forge AI. Display only: the wire keeps
 * the profile names ('Neural', 'Default').
 */
export function aiLabel(name: string): string {
  return name === NEURAL ? neuralLabel : name === 'Default' ? 'Forge AI' : name;
}

/**
 * Whether a seat's plate shows the Neural AI's picture: the AI's seat in a match against Neural (`matchAi`, the
 * server's word, never guessed from names), when the sidecar has a picture (`welcome.neural.avatar`).
 */
export function showsNeuralPhoto(welcome: Pick<WelcomeMsg, 'neural'> | null, matchAi: string | null, isAI: boolean | undefined): boolean {
  return !!welcome?.neural?.avatar && matchAi === NEURAL && !!isAI;
}

/** The same renames in server-written text (the bridge's "Neural opponent unavailable … Default Forge AI" toast). */
export function aiCopy(text: string): string {
  return text.replace(/\bDefault Forge AI\b/g, 'Forge AI').replace(/\bNeural\b/g, () => neuralLabel);
}

export interface AiOption {
  name: string;
  label: string;
  disabled: boolean;
}

/**
 * The AI profiles as picker options. Neural stays listed when it can't run, but disabled; with no Neural AI plugin
 * installed it isn't listed.
 */
export function aiOptions(ais: string[], neural: NeuralStatus | undefined): AiOption[] {
  return ais.filter((name) => name !== NEURAL || neural?.plugin !== false).map((name) => {
    const off = name === NEURAL && neural?.ok === false;
    return { name, label: off ? `${aiLabel(name)} (unavailable)` : aiLabel(name), disabled: off };
  });
}

/** The profile to preselect: the server's default unless it is disabled, then the first enabled one. */
export function defaultAi(ais: string[], preferred: string | undefined, neural: NeuralStatus | undefined): string | undefined {
  const opts = aiOptions(ais, neural);
  if (opts.length === 0) return preferred;
  const want = opts.find((o) => o.name === preferred && !o.disabled);
  if (want) return want.name;
  return (opts.find((o) => o.name === 'Default' && !o.disabled) ?? opts.find((o) => !o.disabled))?.name;
}

/** "Lyra unavailable: …" under the picker, or null when Neural is fine (or unknown, or not installed at all). */
export function neuralNote(neural: NeuralStatus | undefined): string | null {
  if (!neural || neural.ok || neural.plugin === false) return null;
  const why = neural.reason?.trim();
  return why ? `${aiLabel(NEURAL)} unavailable: ${why}` : `${aiLabel(NEURAL)} unavailable`;
}

// ------------------------------------------------------------------------------------------ opponent deck

/** The opponent-deck picker's two groups: the decks Neural was trained on (strongest first), then the rest. */
export function oppDeckGroups(decks: string[], neural: NeuralStatus | undefined): { trained: string[]; other: string[] } {
  const trained = (neural?.decks ?? []).filter((n, i, all) => decks.includes(n) && all.indexOf(n) === i);
  return { trained, other: decks.filter((n) => !trained.includes(n)) };
}

/**
 * The opponent deck when the user hasn't picked one: against Neural its strongest trained deck, otherwise the
 * usual default (the server's, else the player's own deck).
 */
export function defaultOppDeck(ai: string | undefined, trained: string[], usual: string | undefined): string | undefined {
  return ai === NEURAL && trained[0] ? trained[0] : usual;
}

// ------------------------------------------------------------------------------------------ format

/** The start screen's format line: "Competitive Brawl", "Standard", or "Constructed" when the game has no format. */
export function formatLabel(format: GameFormat | undefined): string {
  return format === 'brawl' ? 'Competitive Brawl' : format === 'standard' ? 'Standard' : 'Constructed';
}

export interface IllegalDeck {
  name: string;
  /** Why, without the deck's name ("has 60 cards…"). */
  why: string;
}

/**
 * A format game's decks: those that can be played (the only ones the pickers list), and those that can't with
 * why (the server's `decks.problems` says "<deck> has …"). Without problems every deck is legal.
 */
export function deckGroups(decks: string[], problems: DeckProblems | undefined): { legal: string[]; illegal: IllegalDeck[] } {
  const legal: string[] = [];
  const illegal: IllegalDeck[] = [];
  for (const name of decks) {
    // Own keys only: a deck named "constructor" or "toString" is not a problem.
    const p = problems && Object.hasOwn(problems, name) ? problems[name] : undefined;
    if (p === undefined) legal.push(name);
    else illegal.push({ name, why: p.startsWith(`${name} `) ? p.slice(name.length + 1) : p });
  }
  return { legal, illegal };
}

/** The deck pickers' "Random deck" choice: one of the decks the picker lists, drawn when Start is pressed. */
export const RANDOM_DECK = '\u0000random';

/** The deck to send for a picker's value: for {@link RANDOM_DECK} one of `pool` at random (none if it is empty). */
export function resolveDeck(value: string | undefined, pool: string[], rand: () => number = Math.random): string | undefined {
  if (value !== RANDOM_DECK) return value;
  return pool.length > 0 ? pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] : undefined;
}

/** The deck to preselect in a format game: the wanted one if it can be played there, else the first that can. */
export function legalDeck(want: string | undefined, decks: string[], problems: DeckProblems | undefined): string | undefined {
  const { legal } = deckGroups(decks, problems);
  return want && legal.includes(want) ? want : legal[0];
}

/** What the deck picker's tiles show: each deck's details (colours, key card) and where a card's art crop is. */
export interface PickerArt {
  details: Record<string, DeckDetail>;
  cropUrl: (card: string) => string;
}

/** Names only: blank tiles. */
export const NO_PICKER_ART: PickerArt = { details: {}, cropUrl: () => '' };

/**
 * Where the deck picker gets its art: a player's game behind the router asks the lobby's `/api` (the proxy login
 * identifies the player); a guest's table has no `/api` access and a plain sidecar lists names only.
 */
export function pickerArtSource(router: boolean, guest: boolean): 'lobby' | 'none' {
  return router && !guest ? 'lobby' : 'none';
}

/** The picker's art: the lobby's details once loaded (null until then, or when they couldn't be), else none. */
export function pickerArt(source: 'lobby' | 'none', details: Record<string, DeckDetail> | null, cropUrl: (card: string) => string): PickerArt {
  return source === 'lobby' && details ? { details, cropUrl } : NO_PICKER_ART;
}

// ------------------------------------------------------------------------------------------ deck import

export type ImportMode = 'paste' | 'link' | 'file';

export const DECK_FILE_EXTENSIONS = ['.txt', '.dck', '.dec'] as const;
/** Deck lists are a few KB; anything this big is not one. */
export const MAX_DECK_FILE_BYTES = 1024 * 1024;

export function isDeckFileName(name: string): boolean {
  const n = name.toLowerCase();
  return DECK_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

/** A deck name from a file name: the extension dropped. */
export function deckNameFromFile(name: string): string {
  return name.replace(/\.(txt|dck|dec)$/i, '').trim();
}

export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

export interface ImportInput {
  mode: ImportMode;
  text: string;
  url: string;
  /** File mode: the file's contents and name (null until a file is read). */
  file: { name: string; text: string } | null;
  /** Optional deck name typed by the user. */
  name: string;
}

/** The rpc params for the panel's current input, or an error to show inline. */
export function importParams(input: ImportInput, dryRun: boolean): { params: DeckImportParams } | { error: string } {
  const params: DeckImportParams = {};
  const name = input.name.trim();
  switch (input.mode) {
    case 'paste': {
      if (!input.text.trim()) return { error: 'Paste a deck list first.' };
      params.text = input.text;
      break;
    }
    case 'link': {
      const url = input.url.trim();
      if (!url) return { error: 'Paste a deck link first.' };
      if (!looksLikeUrl(url)) return { error: 'That doesn’t look like a link (it should start with https://).' };
      params.url = url;
      break;
    }
    case 'file': {
      if (!input.file) return { error: 'Choose a .txt, .dck or .dec file first.' };
      if (!input.file.text.trim()) return { error: `${input.file.name} is empty.` };
      params.text = input.file.text;
      break;
    }
  }
  // A .dck file names itself ([metadata] Name=); other files are named after the file.
  const fileName = input.mode === 'file' && input.file && !/\.dck$/i.test(input.file.name) ? deckNameFromFile(input.file.name) : '';
  if (name) params.name = name;
  else if (fileName) params.name = fileName;
  if (dryRun) params.dryRun = true;
  return { params };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "N cards recognized (main M · side S)", plus "· commander C" when the list has one. */
export function importSummary(r: Pick<DeckImportResult, 'recognized' | 'main' | 'side' | 'commander'>): string {
  const cmd = r.commander ? ` · commander ${r.commander}` : '';
  return `${plural(r.recognized, 'card', 'cards')} recognized (main ${r.main} · side ${r.side}${cmd})`;
}

/** Heading over the unknown lines, or null when every line was recognized. */
export function unknownHeading(r: Pick<DeckImportResult, 'unknown'>): string | null {
  const n = r.unknown.length;
  return n === 0 ? null : `${plural(n, 'line', 'lines')} not recognized`;
}

/** Show at most this many unknown lines; the rest are summarised. */
export const MAX_UNKNOWN_SHOWN = 12;

export function unknownLines(r: Pick<DeckImportResult, 'unknown'>): { shown: string[]; more: number } {
  return { shown: r.unknown.slice(0, MAX_UNKNOWN_SHOWN), more: Math.max(0, r.unknown.length - MAX_UNKNOWN_SHOWN) };
}

/** The preview's type groups, in deck-list order. */
const GROUP_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];

export interface PreviewGroup {
  type: string;
  /** Copies in the group. */
  count: number;
  cards: ImportedCard[];
}

/** Main-deck cards grouped by type (empty groups dropped), each group by mana value then name. */
export function previewGroups(cards: ImportedCard[]): PreviewGroup[] {
  const main = cards.filter((c) => c.section === 'main');
  return GROUP_ORDER.map((type) => {
    const cs = main.filter((c) => (GROUP_ORDER.includes(c.type) ? c.type : 'Other') === type);
    cs.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name));
    return { type, count: cs.reduce((n, c) => n + c.n, 0), cards: cs };
  }).filter((g) => g.cards.length > 0);
}

/** Plural group label: "Creatures", "Sorceries", "Other". */
export function groupLabel(type: string): string {
  if (type === 'Sorcery') return 'Sorceries';
  if (type === 'Other') return 'Other';
  return `${type}s`;
}

/** Copies of nonland main-deck cards at mana value 0, 1, … 6+ (seven buckets). */
export function manaCurve(cards: ImportedCard[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const c of cards) if (c.section === 'main' && c.type !== 'Land') out[Math.min(6, Math.max(0, Math.floor(c.cmc)))]! += c.n;
  return out;
}

const QTY = /^(\s*\d{1,4}\s*x?\s+)/i;

/**
 * The deck list with one unknown line replaced by its fix, keeping the line's quantity ("1 Lighting Bolt" →
 * "1 Lightning Bolt"). Every line that reads the same is fixed; the text is unchanged if none does.
 */
export function applyFix(text: string, unknown: string, fix: string): string {
  const want = unknown.trim();
  return text
    .split('\n')
    .map((l) => (l.trim() === want ? `${QTY.exec(l)?.[1] ?? ''}${fix}` : l))
    .join('\n');
}

/** The primary button: "Import 60 cards" once a check has counted them, else "Import". */
export function importLabel(r: Pick<DeckImportResult, 'recognized'> | null): string {
  return r && r.recognized > 0 ? `Import ${plural(r.recognized, 'card', 'cards')}` : 'Import';
}

/** An rpc failure as one readable line ("rpc failed" and transport noise get a friendlier text). */
export function importError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (!msg || msg === 'rpc failed') return 'The deck could not be imported.';
  if (msg === 'connection closed') return 'Lost the connection to the server. Try again once it reconnects.';
  return msg;
}

/** Read a dropped or chosen file as text (FileReader, UTF-8). */
export function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsText(file);
  });
}

/** Validate a file before reading it; null when it's fine. */
export function deckFileProblem(file: { name: string; size: number }): string | null {
  if (!isDeckFileName(file.name)) return `${file.name} isn’t a deck file (use .txt, .dck or .dec).`;
  if (file.size > MAX_DECK_FILE_BYTES) return `${file.name} is too large to be a deck list.`;
  return null;
}

/** "Forge Table 23fd3994 (built 2026-10-05) · Neural v9681 (released 2026-10-04)": what is running here. */
export function versionLine(w: Pick<WelcomeMsg, 'build' | 'neural' | 'forgeVersion'>): string {
  const day = (iso: string) => iso.slice(0, 10);
  const table = w.build ? `Forge Table ${w.build.sha} (built ${day(w.build.builtAt)})` : `Forge Table dev (Forge ${w.forgeVersion})`;
  const n = w.neural?.version;
  if (n === undefined) return table;
  return `${table} · ${aiLabel(NEURAL)} v${n}${w.neural?.releasedAt ? ` (released ${day(w.neural.releasedAt)})` : ''}`;
}

/** Wizards of the Coast's Fan Content Policy line: card images and the Mana font's symbols are theirs. */
export const FAN_CONTENT =
  'Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.';

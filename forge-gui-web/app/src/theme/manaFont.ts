/**
 * The Mana font (Andrew Gioia, SIL OFL 1.1; github.com/andrewgioia/mana): real mana, tap and card-type symbols for the
 * procedural faces and the HUD ("a LOT of stuff can be improved with it"). mana.css is never imported: the fonts
 * are loaded with FontFace from their asset URLs. This file loads the Mana font; the M15 face's own two fonts are
 * loaded by cards/m15/fonts.ts. The symbols are Wizards of the Coast's, used as fan content (lobby footer disclaimer).
 */
import manaUrl from 'mana-font/fonts/mana.woff2?url';

export const MANA_FONT = 'Mana';

/** Codepoints from mana-font 1.18.0's mana.css (`.ms-<name>::before`). */
const CP: Record<string, number> = {
  'w': 0xe600,
  'u': 0xe601,
  'b': 0xe602,
  'r': 0xe603,
  'g': 0xe604,
  'c': 0xe904,
  's': 0xe619,
  'x': 0xe615,
  'y': 0xe616,
  'z': 0xe617,
  'p': 0xe618,
  'e': 0xe907,
  'tap': 0xe61a,
  'untap': 0xe61b,
  'infinity': 0xe903,
  '1-2': 0xe902,
  '100': 0xe900,
  '1000000': 0xe901,
  '0': 0xe605,
  '1': 0xe606,
  '2': 0xe607,
  '3': 0xe608,
  '4': 0xe609,
  '5': 0xe60a,
  '6': 0xe60b,
  '7': 0xe60c,
  '8': 0xe60d,
  '9': 0xe60e,
  '10': 0xe60f,
  '11': 0xe610,
  '12': 0xe611,
  '13': 0xe612,
  '14': 0xe613,
  '15': 0xe614,
  '16': 0xe62a,
  '17': 0xe62b,
  '18': 0xe62c,
  '19': 0xe62d,
  '20': 0xe62e,
  'creature': 0xe61f,
  'planeswalker': 0xe623,
  'battle': 0xe9d1,
  'instant': 0xe621,
  'sorcery': 0xe624,
  'artifact': 0xe61e,
  'enchantment': 0xe620,
  'land': 0xe622,
  'token': 0xe96d,
  'saga': 0xe92a,
  'loyalty-up': 0xe627,
  'loyalty-down': 0xe625,
  'loyalty-zero': 0xe626,
  'loyalty-start': 0xe628,
  'multicolor': 0xe985,
  'counter-arrow': 0xe92b,
  'counter-brick': 0xe92c,
  'counter-charge': 0xe92d,
  'counter-damage': 0xe9dd,
  'counter-deathtouch': 0xea51,
  'counter-devotion': 0xe92e,
  'counter-doom': 0xe92f,
  'counter-echo': 0xe930,
  'counter-finality': 0xea54,
  'counter-flame': 0xe931,
  'counter-flood': 0xe932,
  'counter-fungus': 0xe933,
  'counter-goad': 0xe9c9,
  'counter-gold': 0xe934,
  'counter-ki': 0xe935,
  'counter-lore': 0xe936,
  'counter-loyalty': 0xe937,
  'counter-mining': 0xe938,
  'counter-minus': 0xe939,
  'counter-minus-uneven': 0xe943,
  'counter-muster': 0xe93a,
  'counter-paw': 0xe93b,
  'counter-pin': 0xe93c,
  'counter-plus': 0xe93d,
  'counter-plus-uneven': 0xe944,
  'counter-rad': 0xea50,
  'counter-scream': 0xe93e,
  'counter-shield': 0xe9c3,
  'counter-skeleton': 0xe93f,
  'counter-skull': 0xe940,
  'counter-slime': 0xe941,
  'counter-stun': 0xe9c2,
  'counter-time': 0xe942,
  'counter-verse': 0xe945,
  'counter-void': 0xe9ec,
  'counter-vortex': 0xe946,
  // Keyword-ability symbols (keyword counters: a flying counter, a deathtouch counter…).
  'ability-deathtouch': 0xe94b,
  'ability-defender': 0xe94c,
  'ability-double-strike': 0xe94d,
  'ability-first-strike': 0xe950,
  'ability-flash': 0xe951,
  'ability-flying': 0xe952,
  'ability-haste': 0xe953,
  'ability-hexproof': 0xe954,
  'ability-indestructible': 0xe95a,
  'ability-lifelink': 0xea4b,
  'ability-menace': 0xe95d,
  'ability-reach': 0xe960,
  'ability-toxic': 0xe9bf,
  'ability-trample': 0xe964,
  'ability-vigilance': 0xe968,
  'ability-ward': 0xe992,
  'ability-undying': 0xea8f,
};

/** The glyph for a mana-font name (`w`, `tap`, `12`, `creature`…), or null if the font has none. */
export function msGlyph(name: string): string | null {
  const cp = CP[name.toLowerCase()];
  return cp === undefined ? null : String.fromCharCode(cp);
}

let face: FontFace | null = null;

/** Register the font (once) and load it; resolves either way. */
export async function loadManaFont(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return;
  if (!face) {
    face = new FontFace(MANA_FONT, `url(${manaUrl}) format('woff2')`);
    document.fonts.add(face);
  }
  await face.load().catch(() => undefined);
}

/** Whether canvas text can use the font now (faces painted before it loads keep their letters). */
export function manaReady(): boolean {
  return face?.status === 'loaded';
}

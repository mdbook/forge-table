/**
 * The M15 face's two fonts: a title face (name, type line, P/T, badges) and a body face (rules and flavor text; flavor
 * and reminder text are its italic, which the browser slants from the roman face). Loaded with FontFace.
 *
 * The bundle ships open (SIL OFL 1.1) stand-ins, vendored unmodified in src/theme/fonts/ with their licences:
 * Faustina (Omnibus-Type), used at weight 700, for the title face, and Splentinex Regular (a digitization of Plantin)
 * for the body face. The printed cards' own Beleren and MPlantin are not bundled.
 *
 * An operator who has the real fonts can serve them with the router's --fonts DIR (docs/forge-table/RUNBOOK.md): each
 * face tries `<base>/fonts/beleren.woff2`, `beleren.ttf` (title) or `mplantin.woff2`, `mplantin.woff` (body) first and
 * falls back to the bundled face when those are missing (404) or don't decode.
 */
import faustinaUrl from '../../theme/fonts/faustina-wght.ttf?url';
import splentinexUrl from '../../theme/fonts/splentinex-regular.otf?url';
import { basePath } from '../../net/token';
import { loadManaFont, manaReady } from '../../theme/manaFont';

export const TITLE_FONT = 'M15 Title';
export const BODY_FONT = 'M15 Body';

const faces: FontFace[] = [];
let loading: Promise<void> | null = null;

/** Register and load both fonts (once) plus the Mana font; resolves either way. Every call returns the same promise. */
export function loadM15Fonts(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return Promise.resolve();
  if (!loading) {
    // Same base as the card images (`/`, `/m/<id>/`, `/g/<id>/`), so the router can answer for the page's own game.
    const op = `${basePath()}fonts/`;
    faces.push(
      // Faustina is a variable font (wght 300-800): a 700-only face makes the canvas's normal-weight text render at 700.
      new FontFace(TITLE_FONT, `url(${op}beleren.woff2) format('woff2'), url(${op}beleren.ttf) format('truetype'), url(${faustinaUrl}) format('truetype')`, { weight: '700' }),
      // An operator's MPlantin as .woff: mana-font's mplantin.ttf is rejected by Chromium's font sanitizer (OTS: bad
      // table directory rangeShift, bad cmap), its .woff decodes.
      new FontFace(BODY_FONT, `url(${op}mplantin.woff2) format('woff2'), url(${op}mplantin.woff) format('woff'), url(${splentinexUrl}) format('opentype')`),
    );
    for (const f of faces) document.fonts.add(f);
    loading = Promise.all([...faces.map((f) => f.load().catch(() => undefined)), loadManaFont()]).then(() => undefined);
  }
  return loading;
}

/** Whether both faces and the Mana font can all be used by canvas text now (a face painted before then falls back to serif). */
export function m15FontsReady(): boolean {
  return faces.length === 2 && faces.every((f) => f.status === 'loaded') && manaReady();
}

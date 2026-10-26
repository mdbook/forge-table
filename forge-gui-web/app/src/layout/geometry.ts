/**
 * Table geometry in table units (tu): a logical space 1080 tu high and worldW wide, scaled by
 * s = min(W/worldW, H/1080). worldW is 1920 at 16:9 and wider; narrower windows narrow the world
 * down to 1440 (4:3) so the table keeps scaling by height (see worldWidth). Everything that depends on the
 * world width, the card-size setting or the HUD scale comes from geometry(); the exported SIZE / ROW_Y /
 * BAND / HAND / PILES / X constants are geometry() at 1920 tu, size M, HUD ×1.
 */

export const TABLE_W = 1920;
export const TABLE_H = 1080;
/** The narrowest world (4:3); below that the table fits the width again, letterboxed. */
export const TABLE_W_MIN = 1440;

/**
 * The DOM HUD's scale for table scale s. Never below s; floored at 0.9 on laptops for legibility, the
 * floor easing down (s + 0.2) on phones and small tablets so the HUD doesn't swamp the table there.
 */
export function hudScale(s: number): number {
  return Math.max(s, Math.min(0.9, s + 0.2));
}

/** World width in tu for a W×H viewport: 1920 at 16:9 and wider, else W/H × 1080 clamped to 1440–1920. */
export function worldWidth(w: number, h: number): number {
  if (!(w > 0 && h > 0) || w * TABLE_H >= h * TABLE_W) return TABLE_W;
  return Math.max(TABLE_W_MIN, Math.min(TABLE_W, (w / h) * TABLE_H));
}

/**
 * Portrait (a phone or tablet held upright, H ≥ 1.2 W): its own table, PORTRAIT_W tu wide and as tall as the screen's
 * aspect (clamped), opponent on top, me below, plates and piles in a strip at each end (geometry() portrait).
 */
export const PORTRAIT_W = 880;
const PORTRAIT_ASPECT = 1.2;
const PORTRAIT_H: [number, number] = [1300, 2200];

/** The world in tu for a W×H viewport: worldWidth × 1080 in landscape, PORTRAIT_W × the screen's aspect upright. */
export function worldSize(w: number, h: number): { w: number; h: number } {
  if (w > 0 && h >= w * PORTRAIT_ASPECT) return { w: PORTRAIT_W, h: Math.max(PORTRAIT_H[0], Math.min(PORTRAIT_H[1], (h / w) * PORTRAIT_W)) };
  return { w: worldWidth(w, h), h: TABLE_H };
}

/** Card aspect 63:88 and corner radius 4.5% of width. */
export const CARD_ASPECT = 63 / 88;
export const CARD_RADIUS = 0.045;

/** The card-size setting: a multiplier on the hand and battlefield card heights. */
export type CardSize = 'S' | 'M' | 'L' | 'XL';
export const CARD_SIZES: readonly CardSize[] = ['S', 'M', 'L', 'XL'];
export const CARD_SCALE: Record<CardSize, number> = { S: 0.85, M: 1, L: 1.15, XL: 1.3 };

/** Card heights in tu at size M. The battlefield height is a target: rows that don't fit 1080 tu give way. */
const BASE = { battlefield: 210, hand: 320 } as const;

/** Attacking creatures step toward the centre line by this fraction of their height. */
export const ATTACK_STEP = 0.22;

/**
 * Lands are out of the way (MTGA): the back rows hold them at this fraction of the battlefield card height,
 * so creatures and the other nonland permanents in the front rows are the biggest cards on the table.
 */
export const LAND = 0.72;

/**
 * Vertical budget, top to bottom: the status line's strip (the opponent's hand fan peeks into it), the
 * opponent's back row (lands, LAND high) and front row, the centre gap (an attacker's step plus a margin), my
 * front and back rows, then my hand's resting peek. Back rows sit ROW_GAP from their front row; when the rows
 * don't fit, the back rows tuck behind the front rows, by up to MAX_TUCK of a land, and past that the
 * battlefield height shrinks. Spare height is shared by the two row gaps and the centre gap.
 */
const TOP = 42;
const ROW_GAP = 6;
const CENTRE_PAD = 8;
const HAND_GAP = 4;
/** My hand at rest shows this much of a card, at most PEEK_MAX tu (hover lifts a card fully into view). */
const PEEK = 0.7;
const PEEK_MAX = 250;
const MAX_TUCK = 0.4;
/** Widest edge-card tilt of the hand fan (HAND.maxFanDeg / 2), for its horizontal extent. */
const FAN_EDGE_TILT = (12 * Math.PI) / 180;
/** The prompt bar's maximum width in HUD units (styles.css .prompt-bar); the hand stays left of it. */
export const PROMPT_W = 300;
/** How far (HUD units) the action row with a secondary button reaches left of PROMPT_W (primary 250 + 10 + ≤120). */
const ACTION_OVERHANG = 70;
/** Portrait: the prompt bar's width, in HUD units. */
export const PROMPT_W_P = 240;
/** Portrait card heights at size M (the world is narrower, so a tu is bigger), the hand's resting peek, strip padding. */
const BASE_P = { battlefield: 270, hand: 270 } as const;
const PEEK_P = 0.62;
const STRIP_PAD = 8;

export const GAP = 12;

export function cardWidth(h: number): number {
  return h * CARD_ASPECT;
}

/**
 * Player plates (MTGA-style, HUD units; styles.css .plate): a round avatar disc with the life total in a shield
 * on its lower edge, name and counts beside it. Landscape: mine at the bottom left with my hand right of it, the
 * opponent's at the top centre. Portrait: a compact plate at the left of each strip (PLATE_P).
 */
export const PLATE = {
  w: 236,
  h: 104,
  disc: 88,
  /** Landscape: my plate's left edge and its gap above the bottom edge; the opponent's gap below the top edge. */
  x: 24,
  bottom: 10,
  top: 8,
} as const;
const PLATE_P = { w: 170, h: 76, disc: 60 } as const;
/** Brawl's command-zone pile beside a plate (landscape): at most this tall (tu), clear of the front rows on a phone. */
const CMD_H = 130;
/** The opponent's hand: a fan of card backs this wide (tu), right of their plate. */
export const OPP_FAN_W = 180;
/**
 * The stack zone's cascade (MTGA-style): the newest item in front at SIZE.stackTop, each older one
 * up and to the left of it, smaller, with its name bar peeking above the card in front. At most `depth` show (the
 * rest are counted). Landscape / portrait: the size of the first older card and the step down per level after it
 * (fractions of the top card), how much of each peeks out (fraction of the top card), the step left (tu), and the
 * zone's inset from the right edge.
 *
 * Batch 11 (the stack louder): the front card is ~1.5× what it was (portrait 1.25×, all a phone's centre gap
 * holds) while the older ones keep their size, so the fractions are of the bigger front card: older cards are
 * 187 tu as before (0.52 × 360), peeking ~29 tu, and step further left so the cascade still reads as one.
 */
export const STACK_CASCADE = {
  landscape: { depth: 5, first: 0.52, shrink: 0.033, peek: 0.08, dx: 22, inset: 48 },
  portrait: { depth: 4, first: 0.64, shrink: 0.04, peek: 0.12, dx: 8, inset: 12 },
} as const;

/** One level of the cascade, relative to the front card's centre (x, its top edge for y): offset and height in tu. */
export function stackLevel(depth: number, topH: number, portrait: boolean): { dx: number; top: number; h: number } {
  const c = portrait ? STACK_CASCADE.portrait : STACK_CASCADE.landscape;
  if (depth <= 0) return { dx: 0, top: 0, h: topH };
  return { dx: -c.dx * depth, top: -c.peek * topH * depth, h: topH * (c.first - c.shrink * (depth - 1)) };
}

/** The `Stack · N` pill's size in HUD units (styles.css .stack-head): under the front card (portrait: above the cascade). */
export const STACK_PILL = { w: 120, h: 26 } as const;
/**
 * The phase strip on the centre line (landscape; HUD units, styles.css .ladder): room for twelve step columns (the
 * turn's parts as icons, at most 11 columns with two parts open) and the Auto-skip / Pass turn chips beside them. The front rows start right of it, so an attacker's step never runs
 * under it (the lands, LAND high and a row away from the centre line, take the full width).
 */
export const PHASE_STRIP = { w: 420, h: 46 } as const;

/** Centre of a player's avatar disc (damage pops land here), for a geometry (default: 1920 tu, HUD ×1). */
export function plateCentre(mine: boolean, g: Geometry = geometry()): { x: number; y: number } {
  const b = plateBox(mine, g);
  return { x: b.x, y: b.y };
}

/**
 * A player's avatar disc as a box in tu (centre and half extents), for arrows that end on the player. The plate
 * is DOM, sized in HUD units (geometry() hudK); the runtime prefers the disc's measured rect, this is the fallback.
 */
export function plateBox(mine: boolean, g: Geometry = geometry()): { x: number; y: number; hw: number; hh: number } {
  const p = mine ? g.PLATES.mine : g.PLATES.opp;
  const r = g.PLATES.disc / 2;
  return { x: p.x + r, y: p.y + r, hw: r, hh: r };
}

/**
 * The table's geometry for a world width (tu), a card-size multiplier, the HUD's size in tu per CSS unit
 * (hudK = max(s, 0.9) / s: 1 at s ≥ 0.9, ~1.27 on a 1366×768 laptop) and the world height (portrait).
 *
 * Horizontal budget: left-anchored things (my plate, the lands, the row starts, the
 * phase strip) stay put; right-anchored ones (row ends, stack, piles, action cluster) move with the right edge by
 * d = worldW − 1920, as do the DOM HUD's right-anchored boxes (hud/pos.ts atR); the opponent's plate and hand
 * stay centred (atC). The DOM HUD scales by max(s, 0.9), so on a 1366×768 laptop (s ≈ 0.71) it is ~27% bigger
 * in tu than at 1080p: my hand is fitted between my plate and the prompt bar, the opponent's lands end left
 * of their plate and the front rows start right of the phase strip, for the actual HUD size.
 *
 * `command` (a Brawl game): the opponent's command zone gets a pile beside their plate (COMMAND); mine waits
 * in the alt-zone strip beside my hand (layout.ts; like flashback). Without it the geometry is exactly the
 * constructed one.
 */
export function geometry(worldW: number = TABLE_W, cardScale = 1, hudK = 1, worldH = TABLE_H, command = false) {
  /** Portrait (worldSize): strips for the plates and piles at both ends, the phase strip on the centre line. */
  const portrait = worldH > worldW;
  const H = worldH;
  const d = portrait ? 0 : worldW - TABLE_W;

  // Plates in tu at the HUD's real size.
  const plateW = (portrait ? PLATE_P.w : PLATE.w) * hudK;
  const plateH = (portrait ? PLATE_P.h : PLATE.h) * hudK;
  const disc = (portrait ? PLATE_P.disc : PLATE.disc) * hudK;

  // Vertical: see TOP … MAX_TUCK. Portrait: the opponent's strip on top, mine above my hand's peek.
  const hand = (portrait ? BASE_P.hand : BASE.hand) * cardScale;
  // A tall phone shows more of my hand at rest (PEEK_P on a short one, up to 0.9 of it).
  const peekFrac = portrait ? Math.min(0.9, Math.max(PEEK_P, PEEK_P + (H - 1600) / 1100)) : PEEK;
  const peek = Math.min(peekFrac * hand, PEEK_MAX);
  const strip = plateH + 2 * STRIP_PAD;
  const top = portrait ? strip : TOP;
  const bottom = HAND_GAP + peek + (portrait ? strip : 0);
  const fixed = top + 2 * ROW_GAP + CENTRE_PAD + bottom;
  let bf = (portrait ? BASE_P.battlefield : BASE.battlefield) * cardScale;
  let tuck = 0;
  let slack = 0;
  const over = fixed + (2 + 2 * LAND + ATTACK_STEP) * bf - H;
  if (over > 0) {
    tuck = over / 2;
    if (tuck > MAX_TUCK * LAND * bf) {
      bf = (H - fixed) / (2 + 2 * LAND * (1 - MAX_TUCK) + ATTACK_STEP);
      tuck = MAX_TUCK * LAND * bf;
    }
  } else {
    slack = -over / 3;
  }
  const land = LAND * bf;
  // Portrait's spare height all goes to the centre gap, where the stack and the phase strip sit.
  const rowGap = ROW_GAP + (portrait ? 0 : slack) - tuck;
  const centreGap = ATTACK_STEP * bf + CENTRE_PAD + (portrait ? 3 * slack : slack);
  const oppBack = top + land / 2;
  const oppFront = oppBack + land / 2 + rowGap + bf / 2;
  const centre = oppFront + bf / 2 + centreGap / 2;
  const myFront = centre + centreGap / 2 + bf / 2;
  const myBack = myFront + bf / 2 + rowGap + land / 2;
  const span = (y: number, h = bf): [number, number] => [y - h / 2, y + h / 2];

  const actionsX = portrait ? worldW - STRIP_PAD : 1900 + d;
  /** Portrait: my strip's piles end before the prompt bar, which sits in the strip's right end. */
  const stripRoom = actionsX - PROMPT_W_P * hudK - GAP;
  // Portrait Brawl: four piles in the opponent's strip (the command zone last); a phone's narrow strip shrinks them to fit.
  const pileFit = portrait && command ? (stripRoom - (STRIP_PAD + plateW + 12) - 3 * 10) / 4 / CARD_ASPECT : Infinity;
  const pile = portrait ? Math.min(plateH * 0.92, pileFit) : 96;
  const stackTop = portrait ? Math.min(300, Math.max(150, centreGap + bf * 0.6)) : 360;
  const SIZE = {
    battlefield: bf,
    /** Overflowing rows shrink to this before they overlap (96 × 176/150 at the first cut's 176). */
    battlefieldMin: (bf * 113) / 176,
    /** Lands in the back rows (LAND of a battlefield card; a tucked row shows TUCK less of them). */
    land,
    hand,
    handHoverScale: 1.25,
    /** Card backs only: the count is what matters (it is also on the plate). */
    oppHand: 84,
    /** The stack's top card: big enough to read at a glance (the stack should be obvious, then louder). */
    stackTop,
    pile,
    preview: 520,
  };

  const ROW_Y = {
    /** The opponent's fan peeks 64 tu down from the top edge, beside their plate. */
    oppHand: 64 - SIZE.oppHand / 2,
    oppBack,
    oppFront,
    centre,
    myFront,
    myBack,
  };

  /** Bands as [top, bottom] in tu. Back rows overlap their front row by TUCK (the front row draws on top). */
  const BAND = {
    oppBack: span(oppBack, land),
    oppFront: span(oppFront),
    centre: [oppFront + bf / 2, myFront - bf / 2] as [number, number],
    myFront: span(myFront),
    myBack: span(myBack, land),
    hand: [H - peek, H] as [number, number],
  };

  const fanHalf = (cardWidth(hand) * Math.cos(FAN_EDGE_TILT) + hand * Math.sin(FAN_EDGE_TILT)) / 2;
  /** Hand fan: a resting peek of PEEK; hovering lifts a card fully into view ×1.25, 10 tu off the bottom. */
  const HAND = {
    y: H - peek + hand / 2,
    hoverY: H - 10 - (hand * SIZE.handHoverScale) / 2,
    neighbourPart: 30 * cardScale,
    /** Mulligan / starting hand: the whole hand lifts into view, larger. */
    raisedScale: 1.2,
    /** Portrait: the raised hand sits on my front row, the board being empty then. */
    raisedBottomGap: portrait ? H - myFront - (hand * 1.2) / 2 : 24,
    maxFanDeg: 24,
    stepDeg: 3,
    arc: 0.00012,
    /** The fan's edge cards' half extent (its tilt included), for fitting it beside the alt-zone strip (handFan). */
    fanHalf,
  };

  /** Plates' top-left corners in tu, and the avatar disc's diameter (plateBox). */
  const PLATES = portrait
    ? { w: plateW, h: plateH, disc, mine: { x: STRIP_PAD, y: H - bottom + STRIP_PAD }, opp: { x: STRIP_PAD, y: STRIP_PAD } }
    : { w: plateW, h: plateH, disc, mine: { x: PLATE.x, y: H - PLATE.bottom - plateH }, opp: { x: worldW / 2 - plateW / 2, y: PLATE.top } };

  /**
   * Piles: landscape, at the right-hand end of each player's back row, level with their lands (library outermost,
   * then graveyard, then exile, which only shows when it holds something); portrait, side by side in each strip
   * right of the plate.
   */
  const pileW = cardWidth(pile);
  const pileStep = pileW + (portrait ? 10 : 12);
  const stripY = { mine: PLATES.mine.y + plateH / 2, opp: PLATES.opp.y + plateH / 2 };
  const pileY = portrait ? stripY : { mine: myBack + tuck / 2, opp: oppBack - tuck / 2 };
  const PILES = {
    mine: { library: pileY.mine, graveyard: pileY.mine, exile: pileY.mine },
    opp: { library: pileY.opp, graveyard: pileY.opp, exile: pileY.opp },
  };
  const pile0 = portrait ? STRIP_PAD + plateW + 12 + pileW / 2 : worldW - 20 - pileW / 2;
  const pileDir = portrait ? 1 : -1;
  const PILES_X = { library: pile0, graveyard: pile0 + pileDir * pileStep, exile: pile0 + 2 * pileDir * pileStep };

  /**
   * Brawl's command zone: the opponent's is a pile, their commander's face on it while it waits there.
   * Landscape: right of their plate, level with it (their fan of backs makes room); portrait: last in their strip,
   * after the other piles. Mine waits in the alt-zone strip (layout.ts). Null in a constructed game.
   */
  // Landscape: a little taller than the other piles (the commander is the deck's face; its taxed cost has to read),
  // flush with the plate's top edge.
  const cmdH = portrait ? pile : Math.min(CMD_H, plateH * 1.25);
  const cmdW = cardWidth(cmdH);
  const cmdShift = command ? (portrait ? pileStep : cmdW + GAP) : 0;
  const COMMAND = !command
    ? null
    : { h: cmdH, opp: portrait ? { x: PILES_X.exile + pileStep, y: stripY.opp } : { x: PLATES.opp.x + plateW + GAP + cmdW / 2, y: PLATES.opp.y + cmdH / 2 } };

  // Portrait: my hand has the full width (the actions sit in my strip, above it).
  const handMin = portrait ? STRIP_PAD : PLATE.x + plateW + GAP;
  const handMax = portrait ? worldW - STRIP_PAD : actionsX - PROMPT_W * hudK - GAP;
  /**
   * Alt-zone strip: the cards I can cast from the graveyard, exile, command zone…
   * wait at the right end of the hand's span, smaller than the hand and shown whole (their chip and cost are the
   * point). `h` is the resting height, `hoverScale` the lift on hover, `maxW` the strip's widest span (portrait
   * gives it a larger share of the hand's width), `step` the share of a card's width each shows when they overlap.
   */
  const ALT = {
    h: hand * 0.62,
    hoverScale: 1.5,
    step: 0.9,
    maxW: Math.min(cardWidth(hand * 0.62) * (portrait ? 3.2 : 5), (handMax - handMin) * (portrait ? 0.4 : 0.5)),
    bottomGap: 8,
    neighbourPart: 18 * cardScale,
    maxFanDeg: 8,
    /**
     * Landscape: room right of the strip for a prompt's secondary button (Mulligan, Cancel), which sits left of the
     * primary and pushes the action row past PROMPT_W; my Brawl commander is in the strip through every prompt.
     */
    clear: portrait ? 0 : ACTION_OVERHANG * hudK,
  };

  const rowStart = portrait ? 12 : 24;
  const rowEnd = portrait ? worldW - 12 : worldW - 24;
  const cascade = portrait ? STACK_CASCADE.portrait : STACK_CASCADE.landscape;
  const stackX = worldW - cascade.inset - cardWidth(stackTop) / 2;
  // The cascade's left edge at its full depth (each older level steps left, and is narrower).
  const stackLeft = Math.min(...Array.from({ length: cascade.depth }, (_, i) => {
    const l = stackLevel(i, stackTop, portrait);
    return stackX + l.dx - cardWidth(l.h) / 2;
  }));
  const ladderX = portrait ? 12 : 16;
  const X = {
    rowStart,
    rowEnd,
    /** Front rows start right of the phase strip (landscape), so attackers stepping into the centre gap clear it. */
    frontRowStart: portrait ? rowStart : ladderX + PHASE_STRIP.w * hudK + GAP,
    /** My lands end before my piles and the prompt bar, which grows upward beside them. */
    myBackRowEnd: portrait ? stripRoom : Math.min(PILES_X.exile - pileW / 2, handMax) - GAP,
    /** The opponent's lands end left of their plate (landscape; their hand is right of it). */
    oppBackRowEnd: portrait ? rowEnd : PLATES.opp.x - GAP,
    /** Front rows reflow to end here while the stack is non-empty: left of the stack zone's cascade at full depth. */
    rowEndWithStack: stackLeft - GAP,
    handMin,
    handMax,
    handCentre: (handMin + handMax) / 2,
    /** The opponent's fan: right of their plate (portrait: right of their piles, clear of the corner menu). */
    oppHandX: portrait ? PILES_X.exile + pileW / 2 + 120 + cmdShift : worldW / 2 + plateW / 2 + GAP + OPP_FAN_W / 2 + cmdShift,
    /** The stack zone: its front card's centre x, the cascade's left edge at full depth. */
    stackX,
    stackLeft,
    /**
     * The stack fan's vertical extent (y), around the centre line: the front card's bottom sits on stackBottom
     * (landscape: the front card centred just below the centre line, right-centre as in Arena).
     */
    stackTop: centre - (portrait ? stackTop * 0.7 : 190),
    stackBottom: centre + (portrait ? stackTop * 0.7 : 190),
    /** The phase strip's left end, on the centre line. */
    ladderX,
    /** Bottom-right corner of the prompt bar / primary cluster (portrait: bottom of my strip). */
    actionsX,
    actionsY: portrait ? H - bottom + strip - STRIP_PAD : 1058,
  };

  return { X, SIZE, ROW_Y, BAND, HAND, ALT, PILES, PILES_X, PLATES, COMMAND, TUCK: tuck, H, W: worldW, portrait };
}

export type Geometry = ReturnType<typeof geometry>;

/** geometry() at 1920 tu, size M, HUD ×1. */
export const { X, SIZE, ROW_Y, BAND, HAND, PILES } = geometry();

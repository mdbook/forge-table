# Forge Table design standards

Forge Table's design system is called Kiln. It's a dark, warm "workshop at night" look: graphite surfaces, a brass
hairline for structure, and one ember orange for the thing you can do next. Everything below is taken from the
shipping code. The sources of truth are `forge-gui-web/app/src/theme/tokens.css` (the HTML chrome),
`theme/tokens.ts` (the same values for Pixi and the canvas card painter) and `app/src/styles.css`. When you add a
value, add it to both token files or neither.

## Name and logo

- The product is **Forge Table**: two words, both capitalised, never "ForgeTable" or "Forge table". "Forge" alone
  means the upstream rules engine.
- The mark is an abstract anvil with a four-point spark, drawn in gold `#D4AF6A` on a `#14171C` rounded square
  (radius 114 of 512) with a `#B08D57` brass inner border (`app/public/favicon.svg`). Use the SVG; don't redraw or
  recolour it.
- In page headers the mark sits left of the name at 38 px, the name set in Barlow Condensed (see Type).
- The card back is graphite with a brass hairline and the same abstract anvil (`cards/face.ts`).
- Every page that shows card images or mana symbols carries Wizards of the Coast's Fan Content Policy line
  (`FAN_CONTENT` in `hud/start.ts`) in small muted text at the bottom. Don't reword it.
- The page tagline is "Play Magic: The Gathering in your browser." (plus "against a neural-net opponent." when the
  AI plugin is installed), filled in by the server.

## Color

All chrome colors are CSS custom properties on `:root`.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0f13` | Page background, input wells |
| `--surface` | `#14171c` | Base surface; also the browser `theme-color` |
| `--surface2` | `#1a1e24` | Raised surface, disabled primary button |
| `--surface3` | `#222730` | Default button fill |
| `--border` | `#272c35` | Quiet divider |
| `--border-strong` | `#363c47` | Button, input and panel borders |
| `--text` | `#e8eaee` | Body text |
| `--text-muted` | `#9ba2ae` | Labels, secondary text, hints |
| `--text-faint` | `#666d79` | Disabled text only (too dim for small body text) |
| `--ember` | `#ff7a33` | Primary action, "you can act", your turn |
| `--ember-hover` | `#ff8f54` | Ember hover (12% toward white) |
| `--ember-pressed` | `#d1642a` | Ember pressed (18% toward black) |
| `--on-ember` | `#1c0d03` | Text on ember |
| `--pick` | `#22d3ee` | Something the player has picked (a chosen card or player) |
| `--on-pick` | `#04232a` | Text on pick |
| `--steel` | `#5b8def` | The opponent, their turn |
| `--brass` | `#b08d57` | Hairlines, kicker labels, toast accent |
| `--brass-dim` | `rgba(176, 141, 87, 0.35)` | Inset panel hairline, sheet top border |
| `--danger` | `#f87171` | Errors, destructive actions |
| `--success` | `#34d399` | Success, life gain |
| `--warning` | `#fbbf24` | Warnings |
| `--target-glow` | `#ffe3b0` | Valid target glow |
| `--attack` | `#ff5a4e` | Attacking, damage |

Rules:

- Ember means "can act" and pick means "picked". Never use ember to show a selection or cyan to invite an action;
  the two are chosen to stay apart under every type of color blindness.
- You are ember, the opponent is steel: plates, the phase strip and turn banners follow that.
- Hover is 12% toward white, pressed is 18% toward black. Derive new states that way.
- The table (Pixi) has its own palette in `tokens.ts` `table`: felt `0x15181d`, lift `0x1c2027`, slate `0x23272e`,
  block `0x6fa8ff`, stack halo `0xffb067`. Spell effects use `fx` per color (W `0xfff1c2`, U `0x5ab0ff`,
  B `0xa874e8`, R `0xff5a2a`, G `0x4fd47a`, C `0xd8dce4`).
- Painted mana pips use the Kiln `pip` palette in `tokens.ts` (fill, glyph and rim per color); procedural card
  frames use `frame`.

## Type

| Role | Font | Notes |
|---|---|---|
| UI | `--font-ui`: Inter Variable, then Inter, `system-ui` | Everything by default |
| Numbers and display | `--font-num`: Barlow Condensed, then Arial Narrow | Life totals, counts, the product name, big headings. Weight 600, `tabular-nums` (`.num`) |
| Card titles | Faustina, weight 700 | Canvas card painter only (`cards/m15/fonts.ts`) |
| Card rules text | Splentinex Regular | Canvas card painter only |
| Mana symbols | Mana font (`mana-font`) | Inline symbols in text |

- Fonts are bundled (Fontsource packages and `theme/fonts/` with their OFL texts). Never load fonts from a CDN.
- Weights: 600 for labels, buttons and headings (most common by far), 500 for secondary lines, 700 sparingly.
- Sizes on the table scale with the HUD unit (see Spacing): `font-size: max(9px, calc(N * var(--u)))`, with a 9 px
  floor. The HUD body is 14u; common steps are 12, 13, 14, 15, 18, 22 and 24u. The panel `h1` is Barlow Condensed
  64u, line height 1.
- Lobby and sign-in pages use plain px: 12 to 13 px for hints and labels, 14 to 16 px body, 20 px for the main
  call to action, 26 to 40 px for display text.
- Kicker labels: 12 to 13u, uppercase, `letter-spacing: 0.18em`, brass. Field labels: muted, `0.04em`.

## Spacing and sizing

- The table HUD sizes everything in `--u`, one HUD pixel: `--u = calc(var(--hs) * 1px)`, where `--hs` is the table
  scale with a 0.9 floor, set by the app on resize. Write `calc(8 * var(--u))`, not `8px`, for anything on the table.
- The lobby and sign-in pages use px and zoom the whole page on large screens (1.25, 1.5 and 2 at 1800, 2300 and
  3000 px wide), dividing viewport units by `--lz`.
- There are no spacing tokens. Use the steps the code uses: 2, 4, 6, 8, 10, 12, 14, 16 (gaps), 28 / 32 for panel
  padding.
- Touch targets are at least 44 px on coarse pointers (`@media (pointer: coarse)`).
- Breakpoints in use: 520 px (phones), 860 px (two-column lobby), 900 px or narrower than 3:2 (the corner menu folds
  behind a gear), plus a portrait layout for the table.

## Radius and elevation

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Small inputs and art tiles |
| `--radius-md` | 8px | Buttons, inputs, toasts |
| `--radius-lg` | 12px | Panels, primary button |
| `999px` | pill | Chips, toggles, status pills |
| `50%` | circle | Avatars, plate discs, pips |
| `--elev-1` | `0 1px 2px rgba(0,0,0,.45), 0 1px 1px rgba(0,0,0,.3)` | Buttons |
| `--elev-2` | `0 6px 18px rgba(0,0,0,.45), 0 2px 4px rgba(0,0,0,.35)` | Player plates and raised table chrome |
| `--elev-3` | `0 18px 48px rgba(0,0,0,.55), 0 4px 10px rgba(0,0,0,.4)` | Panels, toasts, dialogs |

## Components

All in `styles.css`; the section headers there name the component that owns each block.

- **Buttons** (`.btn`): `--surface3` fill, `--border-strong` border, `--radius-md`, 8u by 16u padding, weight 600,
  14u, `--elev-1`. Hover darkens to `#2b313c`; active nudges down 1px; disabled keeps its shape with
  `--text-faint` text.
  - `.primary`: ember fill, `--on-ember` text, `--radius-lg`, at least 250 by 72u, 24u text, an optional `.sub`
    line under the label, and an ember glow. Disabled turns `--surface2` with muted text.
  - `.secondary` (46u tall), `.chip` (pill, 13u), `.ghost` (translucent surface), `.danger` (transparent with a
    danger border and text, for actions that end games).
  - `.cta` sizes for the lobby: 56 px tall, 20 px text; `.cta.compact` 48 px, 16 px.
- **Panels** (`.panel`): a vertical gradient from `rgba(34,39,48,.98)` to `rgba(20,23,28,.98)`, `--border-strong`
  border, `--radius-lg`, `--elev-3`, 28u by 32u padding, 16u gap, and a brass-dim hairline inset 6 px. Order inside:
  kicker, `h1`, `.sub`, content, then a right-aligned `.row` of buttons.
- **Sheets** (`.sheet`, phones and narrow screens): a bottom sheet up to 720 px wide and 85% of the screen tall,
  18 px top corners, a brass-dim top border, sliding in over a scrim.
- **Forms**: a label above its input. Inputs are `--bg`-dark wells with a `--border-strong` border, `--radius-md`,
  about 9 by 12 px padding, 14 to 15 px text. Sign-in labels are brass; in-game panel labels are muted. Booleans use
  the `input.switch` toggle; small fixed sets use segmented buttons (`.seg`).
- **Navigation**: the lobby header is the mark and name on the left, then the online count, settings, the avatar
  (an initial on a per-user hue) and Sign out on the right. On the table, settings sit inline top right and fold
  behind a gear under 900 px.
- **Lists and tables**: lobby games and invites are rows with an avatar, not HTML tables. Admin lists follow the
  same row pattern.
- **Toasts** (`.toast`): top centre, 280 to 560u wide, `--elev-3`, a 3 px brass left edge (danger for `.error`), a
  bold title over a muted message. At most four; errors stay 7 s, info 4.5 s; click to dismiss.
- **Empty states**: a short plain sentence, centred, muted, inside a 1 px dashed `--border-strong` box (radius 14 px,
  18 px padding) in the lobby, or as a muted line inside a zone or lane ("Empty").
- **Error states**: an inline `.error` line in danger, weight 600, `role="alert"`; a toast for failures away from
  the current form; a status line for the connection ("Connecting to the server…", "Disconnected, retrying…"); and
  a brief red inset flash around the table when the server refuses an action.
- **Focus**: `:focus-visible` gets a 2 px solid outline in ember (actions), pick (choices) or brass (toggles).

## Motion

| Token | Value |
|---|---|
| `--dur-micro` | 90ms (press, hover) |
| `--dur-short` | 160ms (most transitions) |
| `--dur-base` | 240ms (panels, popovers) |
| `motion.long` / `motion.epic` | 420ms / 700ms (TS only: big entrances, the game-over finale) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--ease-enter` | `cubic-bezier(0, 0, 0.2, 1)` |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` |

- Game beats (draw, cast, combat, damage) are timed in `director/choreography.ts` `DUR` (a draw is 420 ms, a tap
  180 ms, a lunge 112 ms in and 208 ms out with a 70 ms hit-stop). Change those numbers there, not in CSS.
- Every animation has a reduced-motion version: `@media (prefers-reduced-motion: reduce)` in CSS, and the director
  swaps flights for short crossfades. `?reducedMotion=1` forces it; `?test=1` turns all CSS motion off for
  screenshots.
- The player can set game speed (½× to 2×, or Instant); the motion scales with it.

## Iconography

- Icons are inline SVG on a 16 by 16 grid: 1.5 stroke, round caps and joins, `fill="none"`, `stroke="currentColor"`,
  `aria-hidden="true"` (`hud/phaseIcons.tsx`). They take the color of their context (ember or steel on the phase
  strip). No icon font or icon library.
- Mana symbols come from the Mana font in text and from the Kiln pip palette when painted on the canvas.

## Copy voice

- Plain, short, second person. Say what happened and what it means: "Nothing was saved: no cards were
  recognized.", "No account? Ask whoever runs this Forge Table to make you one."
- Sentence case for labels, menus and buttons ("Sign in", "New game", "Play a friend", "Pass turn"). The big
  primary game action is the exception and uses title case for its game verbs ("End Turn", "Opponent's Turn").
- Typographic punctuation: curly apostrophes (’) and the ellipsis character (…). No em dashes; use a colon, comma
  or two sentences.

## Known drift

Recorded, not fixed here:

1. `styles.css` has 79 hex and about 270 `rgba()` literals outside the tokens; ember alone appears as
   `rgba(255, 122, 51, ...)` 49 times, and the button hover `#2b313c` isn't a token.
2. The logo gold `#D4AF6A` isn't a token; the nearest is `--brass` `#b08d57`.
3. `var(--font-display, inherit)` is used once and `--font-display` is never defined.
4. `tokens.ts` and `tokens.css` are kept in sync by hand and already differ: `steel`, `brass` and the ember hover
   and pressed states are missing from `tokens.ts` `chrome`; `motion.long` and `motion.epic` have no CSS token.
5. Durations are often literal (`160ms` 12 times, plus `200ms`, `120ms`, `0.12s`) instead of `--dur-*`; the sheet
   uses its own `320ms cubic-bezier(0.05, 0.7, 0.1, 1)`.
6. Radius literals (2, 3, 4, 5, 10, 14, 18 px and `calc(8 * var(--u))`) sit beside the three tokens, and one use
   gives `--radius-sm` a 4 px fallback that disagrees with its 6 px value.
7. Two sizing systems (`--u` on the table, px in the lobby) and over 50 distinct font sizes, including half steps
   (12.5, 13.5, 13.33u).
8. The product name is set at six different sizes and two weights (34u and 600 in `.brand .name`; 22 to 40 px and
   700 elsewhere).
9. `z-index` values are ad hoc (1 to 80) with no scale.

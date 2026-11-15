# Forge Table code standards

The rules Forge Table's own code follows today: `forge-gui-bridge/` (Java server) and `forge-gui-web/` (browser
client and protocol). Upstream Forge's modules follow upstream's conventions and aren't covered here. Where the code
isn't consistent, the rule below is the dominant pattern and says so. [AGENTS.md](../AGENTS.md) has the build
commands in full; [DESIGN.md](DESIGN.md) covers the look.

## Languages and versions

- Java: compiles to release 17 (root `pom.xml`); build and run on JDK 21 (CI, Docker image). Maven 3.9.
- TypeScript ~5.9, React 19, PixiJS 8, Motion 12 (`motion/react`), Zustand 5, Vite 7, Vitest 3. Node 22 or newer.
- Playwright is pinned to exactly `1.56.1`, matching the `mcr.microsoft.com/playwright:v1.56.1-noble` image.
- Server dependencies are Forge, Netty, Gson and `sqlite-jdbc`. Don't add a web framework, JSON library or logger;
  use the ones already here.

## Layout

- `forge-gui-bridge/src/main/java/forge/bridge/`: `Main` and the single-game sidecar at the root, then one package
  per concern: `art`, `auth`, `match`, `net`, `proj`, `proto`, `router`.
- `forge-gui-bridge/src/test/java/` mirrors the main packages. Fixtures go in `src/test/resources/table/`
  (`states/*.txt` in kebab-case, `decks/*.dck`).
- `forge-gui-web/` is an npm workspace: `app` (client), `protocol` (shared message types, no build step), `tests`
  (Playwright).
- `app/src/` is split by feature: `arrows`, `cards`, `director`, `hud`, `layout`, `lobby`, `login`, `net`,
  `overlays`, `store`, `table`, `theme`, `util`. Pages are `index.html` (table), `lobby.html` and `login.html`.
- Put logic in pure `.ts` modules with tests; keep `.tsx` components thin over them. The Pixi table (`table/`) and
  the animation director (`director/`) are plain TypeScript with no React.
- Engine changes outside Forge Table's modules stay small and carry a `// forge-table:` comment saying why.

## Naming

- Java: `public final class` in PascalCase; constants `UPPER_SNAKE`; test classes end in `Test`; test methods are
  camelCase sentences (`autoSkipPassesTheOpponentsTurnWhenNothingIsPlayable`), never underscores.
- TypeScript: components in PascalCase `.tsx`, logic in camelCase `.ts`. Named exports only; no `export default`
  outside config files. Declare components as `export function Name(`. Hooks are `useX`.
- Tests sit beside the code as `name.test.ts` (no `.test.tsx`). `it(...)` names are behaviour sentences.
- CSS classes: kebab-case with a short feature prefix (`plate-`, `lobby-`, `ng-`, `zv-`, `xpick-`). State is a
  compound class (`.btn.primary`, `.x.on`, `.x.open`). No BEM, no camelCase classes.
- Wire format: every WebSocket message is a flat JSON object with a type in `"t"` (`snapshot`, `prompt`,
  `gameOver`); sub-kinds go in `"kind"`. JSON keys are camelCase. RPC methods are dotted (`decks.list`,
  `match.start`).
- HTTP paths are lowercase and slash-separated (`/api/matches/<id>/invite`, `/auth/login`). CLI flags are
  kebab-case.

## Java style

- 4-space indents. `final` on every parameter, local, enhanced-for variable and `catch` clause.
- Prefer records for plain data, arrow `case ->` switches and pattern `instanceof`. `var` is rare: don't add it.
  No `Optional`, no nullability annotations.
- Throw unchecked exceptions (`IllegalArgumentException`, `IllegalStateException`). Exception messages are
  sentences a player can read, because they reach the client ("This game has already started").
- Errors reach the client one of three ways: an RPC reply `{"t":"rpcResult","ok":false,"error":"..."}`, an HTTP
  error body `{"error":"..."}` with a real status code, or a toast (`"t":"notice","kind":"toast"`). Check the HTTP
  method on every route and answer 405 on a mismatch.
- Log through `BridgeLog` (stderr, `HH:mm:ss.SSS [thread] LEVEL msg`). Never `System.out` except for CLI output and
  the `FORGE_TABLE_READY` line. Messages are short lowercase phrases, optionally with a `subsystem:` prefix
  (`signed in: alice from 203.0.113.5`). Pass the throwable to `BridgeLog.error`, don't stringify it.

## TypeScript style

- 2-space indents. `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax` are on (`tsconfig.base.json`); `import type` for types.
- One Zustand store (`store/uiStore.ts`) holds state only; `runtime.ts` writes it, components read it with
  selectors. The game model is updated immutably (`store/model.ts`).
- Style with classes in `styles.css`. Inline `style={{}}` only for values computed at runtime (positions, hues).
- Show errors to the user as a toast (`runtime.toast`), an inline `role="alert"` line, or the connection status line.
  Never fail silently on something the player asked for.
- Message types live in `protocol/src/messages.ts`. `protocol/src/generated/props.ts` is generated: never edit it
  by hand (see AGENTS.md for the regenerate command).

## Comments

- Comments explain why. Every TS file opens with a `/** ... */` header saying what it's for; fields get one-line
  `/** ... */` notes.
- No TODO or FIXME. A known shortcut gets a `ponytail:` comment naming the limit and when to fix it.
- No em dashes (U+2014) in code, comments or docs you write.

## Configuration

- Nothing deployment-specific is hardcoded: no host names, URLs, user names or absolute paths. Examples use
  `example.com` and documentation IP ranges.
- A router setting is a kebab-case `--flag` in `Router.java` (`VALUE_FLAGS` or `SWITCHES` plus a `parseArgs` case).
  It automatically reads `FT_<FLAG>` from the environment and `FT_<FLAG>=value` from a `--config` / `FT_CONFIG`
  file. Precedence: command line, then env, then file, then default. Unknown flags are an error.
- Every new setting gets a row in `docs/forge-table/configuration.md` and a commented line in
  `forge-gui-bridge/deploy/forge-table.env.example`.
- Client options come from the URL (`config.ts`: `?test=1`, `?replay=`, `?speed=`, `?reducedMotion=1`, ...) and
  preferences from `localStorage` keys `forge-table.<key>`. There are no config globals.
- Secrets never enter the repo; only the `.env.example` file is committed.

## Tests

Add or update a test with every behaviour change.

| What you touched | Run |
|---|---|
| Java server | `mvn -B -ntp -Dskip.web install -pl forge-gui-bridge` (TestNG; engine modules installed once first) |
| A `TrackableProperty` | regenerate `props.ts`, see AGENTS.md |
| Web client | in `forge-gui-web/`: `npm ci && npm run typecheck && npm run test:unit` |
| Anything visual | the Playwright `replay` project inside the `v1.56.1-noble` image, never on your host |

- The `table-it` TestNG group (the 10-game soak) only runs with `-Ptable-it`.
- Component tests render with `renderToStaticMarkup`; there's no Testing Library.
- A golden you changed on purpose gets opened and checked before you commit it.

## Lint and format

- There's no formatter and no linter config. Don't run prettier or "reformat file"; match the code around you and
  touch only the lines you change.
- Checkstyle (`checkstyle.xml`) runs in Maven's `validate` phase and fails on unused or redundant imports. CI skips
  it, so run a plain Maven build before you push.
- The `publish-tree` check refuses a commit if the public tree contains a forbidden private string. Run
  `forge-gui-bridge/publish/publish-tree.sh --check HEAD` when you have it.

## Commits and merge requests

- One change per merge request, with a line on how you tested it. CI must be green before a merge.
- Subject: one line saying what changed. The history mixes plain sentences ("Sign-in page: the buttons stay in the
  fields' column") and conventional prefixes (`fix(table): ...`); recent commits use the prefix form
  `type(scope): summary` with types `feat`, `fix`, `perf`, `test`, `docs`. Use that for new commits.
- Docs and `configuration.md` change in the same commit as the behaviour they describe.
- Contributions are GPL-3.0-or-later.

## Build and deploy

- `forge-gui-bridge/package.sh` builds the release zip (`forge-table-<sha8>.zip` plus `.sha256`); `--smoke` boots it.
- The GitHub workflow builds and tests every push, publishes the `ghcr.io/mdbook/forge-table:edge` image from
  `main`, and cuts a GitHub release on a `v*` tag.
- Ways to run it, all from the same zip: `docker/` (Compose: `compose.yaml` with accounts behind Caddy,
  `compose.solo.yaml` for one player on loopback, `compose.oidc.yaml` for single sign-on), `dist/` launchers for a
  local game or lobby, and `deploy/` systemd units that pull a signed build per channel and restart the router.

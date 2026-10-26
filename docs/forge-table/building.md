# Building and testing

This repository is the Forge engine's multi-module Maven project with two Forge Table modules added:

| Module | What it is |
|---|---|
| `forge-gui-bridge/` | The Java server: single-game sidecar, router, card art, packaging, Docker and systemd files. |
| `forge-gui-web/` | The browser client (TypeScript, React, PixiJS), its protocol types and the Playwright tests. Maven builds it with a downloaded Node 22. |

Forge's own modules (`forge-core`, `forge-game`, `forge-ai`, `forge-gui`, …) carry the rules engine and the card
scripts in `forge-gui/res/`. The desktop, mobile and Android modules are upstream's and Forge Table doesn't use them.

## Requirements

- JDK 17 or newer (CI uses Temurin 21).
- Maven 3.9.
- Node 22 and npm, only if you work on the web client outside Maven.

## Java

Run these from the repository root.

| Goal | Command |
|---|---|
| Everything, web bundle included | `mvn -B -DskipTests install -pl forge-gui-bridge -am` |
| Java only, no npm (the server then has no built-in UI unless you pass `--web`) | `mvn -B -Dskip.web -DskipTests install -pl forge-gui-bridge -am` |
| The server's unit and contract tests plus one live game, about a minute | `mvn -B -Dskip.web install -pl forge-gui-bridge` |
| The 10-game soak test | `mvn -B -Dskip.web install -pl forge-gui-bridge -Ptable-it` (`-Dtable.soak.games=N` for another count) |
| Forge's legacy test suite, headless | `Xvfb :1 -screen 0 800x600x8 & DISPLAY=:1 mvn -B test -Dskip.web` |
| The release zip | `forge-gui-bridge/package.sh` (`--smoke` starts it once; `--no-build` reuses the last build; `--overlay ZIP` adds a neural AI plugin such as Lyra's, which may add files but never replace one) |

The build writes `forge-gui-bridge/target/classpath.txt`, which lets you start the server from the checkout without
packaging it ([Install](install.md#from-source) has the command).

The browser and the server share a protocol whose card properties are generated from Forge's `TrackableProperty`
into `forge-gui-web/protocol/src/generated/props.ts`, which is committed. When `ProtocolCodegenTest` fails,
regenerate it:

```sh
mvn -B -Dskip.web -pl forge-gui-bridge test -Dtest=ProtocolCodegenTest -Dforge.codegen.write=true
```

## Web client

```sh
cd forge-gui-web
npm ci                  # the app, protocol and tests workspaces
npm run typecheck
npm run test:unit       # Vitest
npm run build           # into app/dist, which --web serves and Maven packs into the jar
```

To work on the client with hot reload, start a single game on a fixed port and let Vite's origin in:

```sh
java … -Dforge.bridge.devOrigin=http://localhost:5173 -cp … forge.bridge.Main --port 5000 …
cd forge-gui-web && npm run dev
```

then open `http://localhost:5173/?bridge=127.0.0.1:5000#t=<token>` with the token from the `FORGE_TABLE_READY`
line.

## Browser tests

```sh
cd forge-gui-web/tests
npx playwright test     # the replay goldens, then one live game against a real server
```

Run `npm ci` and `npm run build` in `forge-gui-web` first; the tests serve `app/dist`. The `replay` project plays recorded sessions (`tests/fixtures/sessions/*.jsonl`) with no JVM and a virtual clock, and
compares screenshots against the goldens in `tests/e2e/replay.spec.ts-snapshots/`. The `live` project starts a
server from your last Maven build and plays a few turns through the UI. `FT_SKIP_LIVE=1` skips it.

Playwright is pinned to exactly 1.56.1 and the goldens are made in the matching
`mcr.microsoft.com/playwright:v1.56.1-noble` image, which is what CI uses. Fonts and WebGL differ between machines,
so run the goldens in that image:

```sh
docker run --rm --ipc=host -v "$PWD":"$PWD" -w "$PWD/forge-gui-web/tests" \
  mcr.microsoft.com/playwright:v1.56.1-noble npx playwright test --project=replay
```

The repository is mounted at its own path because `classpath.txt` holds absolute paths. To refresh goldens after
an intended visual change, add `--update-snapshots` and look at every image it changed. Making new replay
fixtures is described in the [maintainer runbook](RUNBOOK.md#making-a-replay-fixture).

## CI

[`.github/workflows/forge-table.yml`](../../.github/workflows/forge-table.yml) runs the same checks on every push
and pull request: the web job (typecheck and Vitest), the bridge job (the engine modules, then the server's tests)
and the e2e job (Playwright in the 1.56.1 image). A `v*` tag also builds Lyra's plugin from its pinned tag,
fetches her model (checked against a pinned sha256), builds the release zip with her in it, smoke-tests it (the
smoke fails if the Neural opponent doesn't come up) and attaches it to a GitHub release, marked as a pre-release
for alpha and beta tags.

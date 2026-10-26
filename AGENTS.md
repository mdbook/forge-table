# AGENTS.md

Read this before you change anything in this repository. It's written for AI coding agents and for people new to
the code, and it only states what the repo actually does.

## What this repo is

Forge Table is a web client and a game server for playing Magic in the browser, built on the
[Forge](https://github.com/Card-Forge/forge) rules engine. This repository is Forge's multi-module Maven project with
Forge Table's modules added on top. Most of the tree is Forge's engine, and most of what you'll touch is not.

Forge Table's own code:

| Path | What it is |
|---|---|
| `forge-gui-bridge/` | The Java server: single-game sidecar, router (lobby, logins, one JVM per game), card art, packaging. |
| `forge-gui-bridge/docker/`, `deploy/`, `dist/` | The Docker image, the reference systemd units and env example, the release launchers. |
| `forge-gui-web/app/` | The browser client (TypeScript, React, PixiJS). |
| `forge-gui-web/protocol/` | Message types shared by client and server. `src/generated/props.ts` is generated, see below. |
| `forge-gui-web/tests/` | Playwright: replay goldens, viewport shots and a live game against a real server. |
| `docs/README.md`, `docs/forge-table/`, `docs/images/` | Forge Table's docs. |

Upstream Forge's code: `forge-core`, `forge-game`, `forge-ai`, `forge-gui` (card scripts in `forge-gui/res/`), and
the desktop, mobile, Android, iOS and installer modules, which Forge Table doesn't use. A card that plays wrong is
almost always a card-script or engine bug, and the fix belongs upstream at
[Card-Forge/forge](https://github.com/Card-Forge/forge). Change the engine here only when Forge Table needs it to
behave differently (several games per JVM, for example). Keep those changes small and mark each with a
`// forge-table:` comment saying why, as the existing ones do; they make merging upstream harder.

## Build and test

You need JDK 21 (CI and the Docker image use it; the code compiles to Java 17), Maven 3.9, and Node 22 with npm for
the web client. Run from the repository root:

```sh
# everything, web bundle included
mvn -B -ntp -DskipTests install -pl forge-gui-bridge -am
# Java only; the engine modules once, then the server's tests (unit, contract, one live game; about a minute)
mvn -B -ntp -Dskip.web -DskipTests install -pl forge-gui-bridge -am
mvn -B -ntp -Dskip.web install -pl forge-gui-bridge
# one test class
mvn -B -ntp -Dskip.web -pl forge-gui-bridge -am test -Dtest=RouterTest -Dsurefire.failIfNoSpecifiedTests=false
```

Server tests live in `forge-gui-bridge/src/test/java`. When `ProtocolCodegenTest` fails you changed a
`TrackableProperty`; regenerate the committed `props.ts` with
`mvn -B -Dskip.web -pl forge-gui-bridge test -Dtest=ProtocolCodegenTest -Dforge.codegen.write=true`.

Web client, from `forge-gui-web/`:

```sh
npm ci
npm run typecheck     # app and tests
npm run test:unit     # Vitest; tests sit next to the code as *.test.ts
npm run build         # into app/dist, which the Playwright tests serve
```

## Browser tests and goldens

Playwright is pinned to 1.56.1. The replay project plays recorded sessions (`tests/fixtures/sessions/*.jsonl`) with
no JVM and compares screenshots against `tests/e2e/replay.spec.ts-snapshots/*.png`. Fonts and WebGL render
differently from machine to machine, so run them in the same image CI uses, never on your host:

```sh
# after npm ci and npm run build in forge-gui-web
docker run --rm --ipc=host -v "$PWD":"$PWD" -w "$PWD/forge-gui-web/tests" \
  mcr.microsoft.com/playwright:v1.56.1-noble npx playwright test --project=replay
```

Mount the repo at its own path; the live test reads absolute paths from `forge-gui-bridge/target/classpath.txt`.
The `viewports` project isn't a golden: it writes shots at many screen sizes to `tests/output/viewports/` for you to
look at. The `live` project starts a server from your last Maven build and plays a few turns (`FT_SKIP_LIVE=1`
skips it). Never run `npx playwright install`; the image's Chromium is the one the goldens were made with.

If your change moves pixels on purpose, rerun the replay project in the image with `--update-snapshots`. Then open
every PNG that changed and check that it shows your change and nothing else before you commit it. A golden that
changed and you can't explain is a regression, not a new baseline.

## Conventions that bite

- There's no formatter. Never run prettier or an IDE "reformat file", and don't touch lines you aren't changing.
  Keep diffs surgical; a reviewer should see only your change.
- Java: 4-space indents, `final` on parameters and locals in the server code. Checkstyle runs in Maven's `validate`
  phase and fails the build on unused or redundant imports (`checkstyle.xml`). CI skips it with
  `-Dcheckstyle.skip`, so run a plain build locally to catch it.
- TypeScript: `strict`, React function components, 2-space indents. Match the surrounding code.
- Every server setting must be configurable, never hardcoded. A router option is a `--flag` in `Router.java`
  (`VALUE_FLAGS` or `SWITCHES`, plus a case in `parseArgs`), which automatically gets an `FT_*` environment variable and
  a config-file key. Don't bake in host names, URLs, user names or absolute paths; examples use `example.com`.
- Secrets never go in the repo. Real env files and config files stay outside it; only
  `forge-gui-bridge/deploy/forge-table.env.example` is committed, with placeholder values.
- No em-dashes (U+2014) in docs or comments you write. Use a comma, a colon or two sentences.
- Add or update a test with every behaviour change.
- If your checkout has `forge-gui-bridge/publish/` (the published tree leaves it out), CI runs
  `forge-gui-bridge/publish/publish-tree.sh --check HEAD`. It refuses the commit if any file outside the excluded
  paths matches a pattern in `forbid.txt`, such as a private host name or an absolute path from a private deployment.
  Run it before you push.

## Docs

User docs start at `docs/README.md`; the pages are in `docs/forge-table/`. `RUNBOOK.md` there is maintainer notes.
The other files in `docs/` are upstream Forge's and describe the desktop app.

When you add or change a setting, update the row in `docs/forge-table/configuration.md` (flag, `FT_*` variable,
default, what it does) and the commented line in `forge-table.env.example`. When you change how something works,
fix the page that describes it in the same commit. Describe only what ships.

## Before you call it done

1. The build and tests for what you touched pass: the Maven bridge tests for Java, typecheck and Vitest for the
   client, the replay goldens in the Playwright image for anything visual.
2. `git diff` shows only your change, with no reformatted lines and no build output.
3. Changed goldens were opened and look right.
4. Docs and `configuration.md` match the new behaviour.
5. `rg -n '\x{2014}'` over the files you touched finds nothing, and the publish-tree check passes if you have it.

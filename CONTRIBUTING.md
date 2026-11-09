# Contributing to Forge Table

Pull requests are welcome, from typo fixes to new features. For anything big, open an issue first so we can agree on
the shape before you spend a weekend on it.

## Where a bug belongs

Forge Table runs the [Forge](https://github.com/Card-Forge/forge) rules engine. If a card does the wrong thing, say a
trigger that never fires or a cost that's off, the bug is almost always in Forge's card script or engine. The fix
belongs upstream at [Card-Forge/forge](https://github.com/Card-Forge/forge/issues), where every Forge user gets it. Check whether Forge's desktop app does the same thing. If it does, report it there.

Report it here when the problem is in what Forge Table adds: the browser client, the lobby, the router, card art,
packaging, Docker or the docs. If you're not sure, open an issue here and say so.

## Build and test

You need a JDK 17 or newer and Maven 3.9. Node 22 is only needed for working on the web client outside Maven.

```sh
mvn -B -DskipTests install -pl forge-gui-bridge -am   # build everything, web client included
mvn -B -Dskip.web install -pl forge-gui-bridge        # the server's tests, about a minute

cd forge-gui-web
npm ci && npm run typecheck && npm run test:unit
npm run build && (cd tests && npx playwright test)
```

The Playwright replay tests compare screenshots and are only reliable in the
`mcr.microsoft.com/playwright:v1.56.1-noble` image. If your change moves pixels on purpose, refresh the goldens there
and include them in the pull request. [Building and testing](docs/forge-table/building.md) has the details.

## Code style

- Java: 4-space indents, and the server code marks parameters and locals `final`. Checkstyle runs in Maven's
  `validate` phase and fails the build on unused or redundant imports.
- TypeScript: `strict` mode, React function components, 2-space indents. There's no formatter or linter config, so
  match the code around you and keep diffs small. Please don't reformat files you aren't changing.
- Comments say why, not what. Add a test with behaviour changes; the server's tests live in
  `forge-gui-bridge/src/test`, the client's next to the code as `*.test.ts`.
- Forge's own modules follow upstream's conventions. Keep changes there small and clearly marked, since they make
  merging upstream Forge harder.

## Pull requests

Keep each one to a single change and say how you tested it. CI has to pass before a merge. By contributing you agree
that your work is licensed under the GPL-3.0-or-later, like the rest of Forge Table.

# Configuration reference

Forge Table has no settings screen and no settings database. Everything is set when the server starts. There are
four places a setting can come from, and which ones apply depends on the setting:

| Source | Applies to |
|---|---|
| Command-line flags after `forge.bridge.Main` | Everything in this page that has a flag. |
| `FT_*` environment variables | Router settings, plus `FT_NEURAL_LABEL`, `FT_NEURAL_AVATAR`, `FT_NEURAL_AVATAR_CARD` and `FT_CONFIG`. A single game reads no `FT_*` variable except those three `FT_NEURAL_*` ones. |
| A config file (`--config FILE`, or `FT_CONFIG=FILE`) | Router settings. |
| Java system properties (`-Dname=value` before `-cp`) | The properties listed [below](#java-system-properties). |

## How router settings are resolved

Every router flag has an environment variable named `FT_` plus the flag in upper case, with its inner dashes turned
into underscores. `--max-matches` is `FT_MAX_MATCHES`.

For each flag the router takes the first of these that has a value:

1. the flag on the command line,
2. the `FT_` environment variable,
3. the same `FT_` name as a `KEY=VALUE` line in the config file,
4. the built-in default.

The config file is a Java properties file, which means the same format as a systemd `EnvironmentFile`: one
`FT_NAME=value` per line, `#` for comments, surrounding single or double quotes stripped. A blank value counts as
no value, so `FT_ADMIN_GROUP=` leaves the default in place. Switches (`--guests`, `--insecure-cookies`, `--link-by-login`, `--oidc-insecure`, `--test-prefs`, `--debug`) are on
when their variable is `true`, `1`, `yes` or `on`.

[`forge-table.env.example`](../../forge-gui-bridge/deploy/forge-table.env.example) is a commented starting point
that works both as an `EnvironmentFile` and as a `--config` file.

A value from the environment or the file is a single value. `--decks` is the one flag you may repeat, and only on
the command line; `FT_DECKS` names one folder.

## Router settings

These apply with `--router` as the first argument. Defaults are what you get with nothing set.

### Listening

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--bind ADDR` | `FT_BIND` | `127.0.0.1` | The address to listen on. A wildcard (`0.0.0.0`, `::`) is always refused. Without sign-in (`--auth header`, `users` or `oidc`) only loopback is allowed; with it, loopback or one private address (RFC 1918, or IPv6 unique-local such as a Docker network). Public addresses are refused. |
| `--port N` | `FT_PORT` | `0`, an ephemeral port | The port for the lobby, the API and every game. The `FORGE_TABLE_READY` line says which port was picked. |
| `--admin-port N` | `FT_ADMIN_PORT` | none | Also listen on `127.0.0.1:N` for `GET /healthz` and `POST /admin/drain` only. Use it when `--bind` isn't loopback, so local scripts can still reach those. |
| `--public-url URL` | `FT_PUBLIC_URL` | none | `http(s)://host[:port]` and nothing after it. Used for absolute links (invite links, link-preview tags) when a request's `Host` header is missing or unusable; normally the `Host` header is used. Required by `--auth oidc`, which builds the redirect URI from it. |

### Who is asking

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--auth MODE` | `FT_AUTH` | `header` with `--trust-proxy-header`, else `token` | How people sign in. `token`: one user called `local`, who proves itself with the token in the ready line's link and is also the admin. `header`: a login proxy in front, see `--trust-proxy-header`. `users`: Forge Table's own accounts and sign-in page ([details](hosting.md#forge-tables-own-accounts)). `oidc`: a "Sign in with" button for an OpenID Connect provider ([details](hosting.md#sign-in-with-oidc)). `users,oidc` offers both; `token` and `header` don't combine. |
| `--trust-proxy-header NAME` | `FT_TRUST_PROXY_HEADER` | none | Header mode. The user name is taken from request header `NAME`, which your login proxy sets. Missing is `401`, repeated or empty is `400`. Only for `--auth header`. |
| `--name-header NAME` | `FT_NAME_HEADER` | none, others see the login | A header with the user's full name. Its first word is what other players see. Needs `--trust-proxy-header`. |
| `--logout-url URL` | `FT_LOGOUT_URL` | none, no button | `--auth header`: the lobby's **Sign out** links here, your proxy's sign-out address (oauth2-proxy's is `/oauth2/sign_out`). |
| `--groups-header NAME` | `FT_GROUPS_HEADER` | none | The header your proxy puts the user's group list in. Required by `--require-group` and `--admin-group` in header mode (`oidc` reads the groups claim instead). Must arrive exactly once. |
| `--groups-separator S` | `FT_GROUPS_SEPARATOR` | `,` | What joins the group names in that header. Authentik uses `\|`. |
| `--require-group NAME` | `FT_REQUIRE_GROUP` | none, every signed-in user may play | Only members of this group get in; everyone else gets `403`. Needs `header` (the groups header) or `oidc` (the groups claim). |
| `--admin-group NAME` | `FT_ADMIN_GROUP` | none, nobody is admin | Members of this group see the lobby's Admin section: every game, ending any game, and "Update now". Empty means no admins. Needs `header` or `oidc`, like `--require-group`. In header mode, set it only after you've checked that your proxy strips a client's own groups header, or a forged header makes someone admin. With `users`, make admins with `--users admin <login> on`. |
| `--guests` | `FT_GUESTS` | off | Lets a two-player game's creator make an invite link that works without a login. Everything a guest loads is under `/g/`, which a login proxy must let through without its login. Needs a sign-in mode (`header`, `users` or `oidc`) and `--real-ip-header`. |
| `--real-ip-header NAME` | `FT_REAL_IP_HEADER` | none | The header your proxy puts the client's address in, e.g. `X-Real-IP`. The guest join limit and the wrong-password limit count per address, so it's required with `--guests` and `--auth users`. Name a header the proxy overwrites with one address, never `X-Forwarded-For`. Never read unless set. |

### Native sign-in and OIDC

These apply with `--auth users`, `oidc` or both. [Hosting for a group](hosting.md#forge-tables-own-accounts) shows
them in use.

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--session-idle-days N` | `FT_SESSION_IDLE_DAYS` | `14` | A sign-in ends after this many days unused. |
| `--session-max-days N` | `FT_SESSION_MAX_DAYS` | `30` | A sign-in ends after this many days, used or not. |
| `--insecure-cookies` | `FT_INSECURE_COOKIES` | off | Send the session cookie without `Secure`, for plain http on a LAN. The log warns while it's on. Never on anything that faces the internet. |
| `--oidc-issuer URL` | `FT_OIDC_ISSUER` | none, required by `oidc` | The provider, exactly as its `/.well-known/openid-configuration` names it. `https` only. |
| `--oidc-client-id ID` | `FT_OIDC_CLIENT_ID` | none, required by `oidc` | This app's client id at the provider. |
| `--oidc-client-secret-file PATH` | `FT_OIDC_CLIENT_SECRET_FILE` | none, a public client | A file holding the client secret. Leave it out for a public client, which then relies on PKCE alone. |
| `--oidc-scopes S` | `FT_OIDC_SCOPES` | `openid profile email` | What to ask the provider for. Must include `openid`. |
| `--oidc-login-claim C` | `FT_OIDC_LOGIN_CLAIM` | `preferred_username` | The claim that becomes the login. `email` also needs `email_verified: true` from the provider. |
| `--oidc-name-claim C,...` | `FT_OIDC_NAME_CLAIM` | `given_name,name` | The name other players see: the first of these claims that's present. |
| `--oidc-groups-claim C` | `FT_OIDC_GROUPS_CLAIM` | `groups` | The claim `--require-group` and `--admin-group` read. |
| `--oidc-label TEXT` | `FT_OIDC_LABEL` | `Sign in with SSO` | The button's text. |
| `--oidc-logout MODE` | `FT_OIDC_LOGOUT` | `local` | `local`: **Sign out** ends the Forge Table session only. `provider`: then the provider's too. |
| `--link-by-login` | `FT_LINK_BY_LOGIN` | off | An OIDC sign-in whose login matches an existing account that isn't linked yet takes that account, once. For moving from a login proxy; turn it off afterwards. |
| `--oidc-insecure` | `FT_OIDC_INSECURE` | off | Allow an `http` issuer, for a test provider on your own machine only. The log warns while it's on. |

### Capacity and timing

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--max-matches N` | `FT_MAX_MATCHES` | derived from RAM | Hard cap on games at once, across all users. Without it, `floor((RAM - reserve) / per-game)` and at least 1, where RAM is the machine's memory or the container's limit. |
| `--reserve-mb MB` | `FT_RESERVE_MB` | `2048` | The RAM kept for the OS and the router in that formula. |
| `--game-mb MB` | `FT_GAME_MB` | `1536` | The RAM per game in that formula. A game at `-Xmx1536m` typically uses 1.0 to 1.1 GB and can reach about 1.9 GB; `2048` never overcommits. |
| `--max-per-user N` | `FT_MAX_PER_USER` | `3` | Games one user may have open at once, crashed and stopping ones included. |
| `--idle-minutes M` | `FT_IDLE_MINUTES` | `30` | End a game that no browser has had open for this long. Decimals are fine. |
| `--grace-minutes M` | `FT_GRACE_MINUTES` | `15` | End a finished game this long after its match ended and the last browser left. A crashed game is cleared after the same time. |
| `--drain-timeout M` | `FT_DRAIN_TIMEOUT` | `120` | After `POST /admin/drain` (no new games), end whatever is still running and exit after this many minutes. |

### Files

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--data DIR` | `FT_DATA` | `~/.forge-table-router` | The router's own folder. See [what's in it](#the-data-folder). |
| `--assets DIR` | `FT_ASSETS` | the `forge.bridge.assets` property, else the working directory | The folder that holds Forge's `res/`. In a release it's the unzipped folder (`.`), in a checkout `forge-gui/`. Passed to every game. |
| `--web DIR` | `FT_WEB` | the copy built into the server jar | Serve the browser client (lobby and table) from this folder instead. The router reads it on every request, so you can replace it while games run. Passed to every game. |
| `--decks DIR` | `FT_DECKS` | none | A deck folder every user can pick from. Repeat the flag for more folders. Each user's imported decks are kept separately, under the data folder. Passed to every game. |
| `--card-art MODE` | `FT_CARD_ART` | `curated` (`off` with `--test-prefs`) | `curated`, `printed` or `off`. See [Card art](card-art.md). Passed to every game. |
| `--card-image-map FILE` | `FT_CARD_IMAGE_MAP` | none, built from Scryfall | A `card_images.json` mapping card names to images, used instead of the one the server builds. See [Card art](card-art.md#bring-your-own-image-map). Passed to every game. |
| `--fonts DIR` | `FT_FONTS` | none, the bundled open fonts | Fonts for the Framed card face. The router serves only `beleren.woff2`, `beleren.ttf` (name, type line, P/T) and `mplantin.woff2`, `mplantin.woff` (rules and flavor text) from `DIR`, at `fonts/<name>` under the lobby, `/m/<id>/` and `/g/<id>/`; any other name is `404`. The browser tries those first and falls back to the bundled Faustina (weight 700) and Splentinex Regular, both OFL, for any file that's missing or won't load. The router refuses to start if `DIR` isn't a folder. |

### Neural AI plugin uploads

Only meaningful with a [neural AI plugin](ai-plugin.md) installed. Without one the router logs a warning and treats
both as off.

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--mtgai-upload MODE` | `FT_MTGAI_UPLOAD` | `off` | `on`: a player's finished games are sent unless they turn it off. `optin`: sent only if they turn it on. `off`: never, and the lobby doesn't show the switch. Each user's choice is kept in `<data>/mtgai-upload-prefs.json`. |
| `--mtgai-upload-url URL` | `FT_MTGAI_UPLOAD_URL` | none | Where the plugin sends them. Empty means never, whatever the mode says. |

### Debugging and tests

| Flag | Env / config key | Default | What it does |
|---|---|---|---|
| `--debug` | `FT_DEBUG` | off | Log every message the server sends to stderr, in the router and in every game. |
| `--game-log-dir DIR` | `FT_GAME_LOG_DIR` | none, disabled | Persist Forge's complete text game log locally, one file per engine game, including rematches and two-player games. Passed to every game. See the privacy and retention notes below. |
| `--game-log-keep N` | `FT_GAME_LOG_KEEP` | `200` | Keep at most this many `*.game.log` files in the log directory, newest modified first. Positive integer. Retention includes games still playing and is applied when a new log is created. |
| `--game-log-max-bytes N` | `FT_GAME_LOG_MAX_BYTES` | `4194304` (4 MiB) | Per-file UTF-8 byte cap, at least `1024`. A full file ends with a truncation marker and is no longer written. |
| `--test-prefs` | `FT_TEST_PREFS` | off | Deterministic Forge preferences for tests (no online image fetching, one game per match), and card art off. Never use it on a real profile. |
| `--config FILE` | `FT_CONFIG` | none | Read settings from this file (see above). Has no `FT_` key of its own inside the file. |

Text logs are operator diagnostics, not browser replays. They include player names and private game information
(such as drawn cards); restrict access to their directory and tell players when enabling them. They are never
served to browsers or uploaded by Forge Table, and are independent of the Neural training-upload toggle. Leave
the directory unset to write nothing. To keep diagnostics next to Neural trajectories, set it to
`<data>/neural-games/logs`, a sibling of `traj/`, **not inside the upload queue**.

Names start with the router's game id and the engine game number (`<id>-g<number>-<unique>.game.log`), so they can
be correlated with the lobby id, `child.log` and the trajectory's time window. A resume/restart creates another
unique file rather than overwriting the old one. Each entry is persisted as it arrives, in chronological order,
including entries already recorded before the game view attached. This also keeps logs for unfinished games.
Only `*.game.log` regular files are pruned; trajectories and other files are left alone. If retention removes an
older game still playing, its writer stops rather than recreating the file. I/O errors warn without stopping play.

### Fixed in code

Some limits have no setting. They live in `Router.Options` and `ChildProcessHost.Config`
(`forge-gui-bridge/src/main/java/forge/bridge/router/`); change them there if you must.

| Limit | Value |
|---|---|
| An idle HTTP connection is closed after | 150 s (WebSockets are exempt) |
| "Update now" warns open games for | 60 s |
| A two-player invite link works for | 15 min |
| A two-player game nobody joined is ended after | 30 min |
| Invite links one person may make | 10 per 10 min |
| A guest's access lasts | 4 h |
| Guest joins per client address | 5 per 10 min |
| Games with a guest at once | 2 |
| A user counts as "online" for | 1 min after their last request, or while they're at a table |
| Ended games' folders are kept | 24 h, at most 20 |
| Upload consent markers are pruned after | 7 days |
| A game must report ready within | 180 s |

## Single-game flags

Without `--router`, `forge.bridge.Main` runs one game. These flags don't have `FT_*` variables.

| Flag | Default | What it does |
|---|---|---|
| `--port N` | ephemeral | Listen on `127.0.0.1:N`. A single game always listens on loopback only. |
| `--open-browser` | off | Open the game's link in the default browser once it's up. The release launchers pass it. |
| `--assets DIR` | the `forge.bridge.assets` property, else the working directory | The folder that holds Forge's `res/`. |
| `--web DIR` | the copy built into the jar | Serve the browser client from this folder. |
| `--decks DIR` | none | An extra deck folder, repeatable. The user's own constructed-deck folder (shared with Forge desktop) is always read too. |
| `--deck NAME`, `--opp-deck NAME` | none | Preselect your deck and the opponent's on the start screen. |
| `--ai NAME` | `Neural` when a [plugin](ai-plugin.md) can be seated, else `Default` | Preselect the opponent's AI profile: `Default`, `Cautious`, `Reckless`, `Experimental`, or `Neural`. |
| `--format NAME` | `constructed` | `constructed`, `standard` (deck checked against Forge's Standard list) or `brawl` (Forge's Brawl variant, checked like Arena's Competitive Brawl). |
| `--card-art MODE` | `curated` (`off` with `--test-prefs`) | As for the router. |
| `--card-image-map FILE` | none | As for the router. |
| `--speed X` | `1` | Initial animation speed. `0` is instant and turns pacing off. Players can change it in the game. |
| `--record FILE` | none | Append every message sent to the browser to `FILE` as JSON lines. This is how replay test fixtures are made. |
| `--game-log-dir DIR` | none, disabled | As for the router: local Forge text logs, not protocol recordings. |
| `--game-log-keep N` | `200` | As for the router. |
| `--game-log-max-bytes N` | `4194304` | As for the router. |
| `--state FILE` | none | Start from a board state (a Forge `.pzl` file's `[state]` section, or a whole state file). For tests. |
| `--test-prefs` | off | As for the router. |
| `--debug` | off | Log every outbound message to stderr. |

The router starts its games with five more flags of its own: `--names-only`, `--progress`, `--pvp`,
`--seat1-decks` and `--game-log-id`. They are internal and you shouldn't need them.

## Java system properties

Set these as `-Dname=value` before `-cp`. A router passes every `-D` it was started with to its games, except
`user.home`, `forge.table.ignoreStdin` and JMX/RMI properties.

| Property | Default | What it does |
|---|---|---|
| `forge.table.ignoreStdin` | `false` | Keep running when standard input closes. Without it the server exits on EOF, which is how a parent process stops it. Set it under systemd, Docker or `nohup`. |
| `forge.table.neuralLabel` | `FT_NEURAL_LABEL`, else `name` in the model's `latest.json`, else `Neural` | The name the UI shows for the neural AI opponent. |
| `forge.table.neuralAvatar` | `FT_NEURAL_AVATAR`, else `avatar.png` or `avatar.webp` in `mtgai.neural.dir` | A picture of the neural AI opponent (PNG, WebP or JPEG, at most 1 MB), shown in place of its initial at the table and in the lobby. Read again when the file changes. |
| `forge.table.neuralAvatarCard` | `FT_NEURAL_AVATAR_CARD`, else `avatar_card` in the model's `latest.json` | A card (`Name` or `Name\|SET`) whose art crop is the opponent's picture when there is no picture file. Fetched like any card art, so none with card art off. |
| `forge.table.root` | unset | When set, check at startup that `res/` exists under `--assets` and fail with a clear error if not. |
| `forge.bridge.assets` | the working directory | Default for `--assets`. |
| `forge.bridge.debug` | `false` | Same as `--debug`. |
| `forge.bridge.devOrigin` | unset | An extra origin allowed to open the WebSocket, e.g. `http://localhost:5173` for the Vite dev server. |
| `forge.mtgai.neuralPlayer` | `mtgai.humanseat.LobbyPlayerNeural` | The class name of the [neural AI plugin](ai-plugin.md)'s player. |
| `mtgai.neural.dir` | `neural` (relative to the working directory) | The plugin's model folder, which must hold `latest.json`. |
| `forge.mtgai.aiCastRemAIDeck` | `false` | Let Forge's AI cast cards whose scripts say the AI shouldn't play them (`AI:RemoveDeck:All`). Upstream Forge strips them. The reference systemd unit turns it on. |
| `forge.mtgai.inlineAiEval` | `false` | Run the AI's per-decision evaluation on the game thread without its 5 s timeout. For headless simulations, not for a server. |
| `forge.mtgai.noGc` | `false` | Skip the explicit garbage collection after each game. For headless simulations. |
| `user.home` | your home | Where Forge keeps its user folder and cache, unless a `forge.profile.properties` in the working directory says otherwise. Set it to keep test runs apart. |

## Other environment variables

| Variable | Read by | What it does |
|---|---|---|
| `FT_NEURAL_LABEL` | the server (router and games) | The neural AI opponent's display name, when `-Dforge.table.neuralLabel` isn't set. |
| `FT_NEURAL_AVATAR` | the server (router and games) | The neural AI opponent's picture, when `-Dforge.table.neuralAvatar` isn't set. |
| `FT_NEURAL_AVATAR_CARD` | the server (router and games) | The card whose art is that picture when there's no file, when `-Dforge.table.neuralAvatarCard` isn't set. |
| `FORGE_TABLE_NO_BROWSER` | `launch.sh` | Any value: don't pass `--open-browser`. |
| `FT_BIND` | the Docker entrypoint | When unset, the entrypoint sets it to the container's own address. |
| `MVN`, `MVN_FLAGS` | `forge-gui-bridge/package.sh` | The Maven command and extra flags for the build it runs. |

The optional update script in `forge-gui-bridge/deploy/` has its own variables. They are described in
[Hosting for a group](hosting.md#reference-systemd-setup).

## The data folder

The router keeps everything under `--data`:

| Path | What | Keep it? |
|---|---|---|
| `users/<user>-<hash>/decks/` | Each user's imported decks. The folder name is the login made filesystem-safe plus a short hash. | Yes. |
| `results.jsonl` | Finished games' results, for the records shown in the lobby. | Yes. |
| `mtgai-upload-prefs.json` | Each user's upload choice. | Yes. |
| `cache/table/` | Card-art index and images, shared by every game. About 4 MB plus about 100 KB per card. | Optional, it refills. |
| `forge-table.db` | `--auth users` and `oidc`: accounts, provider links and sessions (SQLite; sessions only as hashes). | Yes. Back it up like the decks. |
| `matches/<id>/` | Games, running or paused: a Forge home each, the game's save (`checkpoint.json`) and `child.log`. A game without a save is cleared at start. | Yes, while you want paused games back. |
| `unreadable/<id>-<time>/` | A saved game the router couldn't read at startup. Never deleted: look at it, and move it back to `matches/<id>/` to list it again. | Up to you. |
| `ended/<id>/` | Ended games' folders, for their logs. Kept 24 h, at most 20. | No. |
| `neural-games/` | Files the neural AI plugin writes for uploads. Only used with a plugin. | Up to the plugin. |

A game saves itself whenever a player gets priority with the stack empty outside combat. Restarting the router
pauses every saved game, and the ones being played resume by themselves; the rest wait in their owner's lobby with
a **Resume** button for 30 days. Games with a guest aren't kept.

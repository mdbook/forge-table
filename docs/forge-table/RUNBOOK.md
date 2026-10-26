# Forge Table runbook

How to build, run and verify Forge Table: the web client in `forge-gui-web/` and the JVM sidecar in
`forge-gui-bridge/`, written for contributors and self-hosters (it works the same in a headless container).

## Build

| Goal | Command (repo root) |
|---|---|
| Everything, including the web bundle (downloads Node 22 into `forge-gui-web/target/node` once) | `mvn -B -DskipTests install -pl forge-gui-bridge -am` |
| Java only (skip npm; the sidecar then serves no UI unless given `--web`) | `mvn -B -Dskip.web -DskipTests install -pl forge-gui-bridge -am` |
| Bridge unit and contract tests, plus one live game (about 1 minute) | `mvn -B -Dskip.web install -pl forge-gui-bridge` |
| The 10-game soak (TestNG group `table-it`) | `mvn -B -Dskip.web install -pl forge-gui-bridge -Ptable-it` (`-Dtable.soak.games=N` to change the count) |
| The legacy suite, as CI runs it | `Xvfb :1 -screen 0 800x600x8 & DISPLAY=:1 mvn -B test -Dskip.web` |

`forge-gui-bridge/target/classpath.txt` is written at `process-classes`, so you can start the sidecar
straight from the repo after any build of the module.

## Run the sidecar

```sh
java -Xmx3g -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -Duser.home=/tmp/table-home -Dforge.table.ignoreStdin=true \
  -cp forge-gui-bridge/target/classes:$(cat forge-gui-bridge/target/classpath.txt) \
  forge.bridge.Main --assets forge-gui/ --web forge-gui-web/app/dist \
  --decks forge-gui-bridge/src/test/resources/table/decks \
  --deck mono-red-madness --opp-deck mono-blue-faeries --ai Default --test-prefs
```

Wait for the line that starts with `FORGE_TABLE_READY` (30–45 s on a cold JVM; Forge prints other
lines before it). It carries `{port, token, userDir, url}`. Open `url` in a browser, or pass
`--open-browser`.

| Flag | Meaning |
|---|---|
| `--port N` | Fixed port. The default is an ephemeral one. |
| `--assets DIR` | Folder holding `res/` (in the repo: `forge-gui/`). |
| `--web DIR` | Serve the web app from `DIR` instead of the bundle inside the jar. |
| `--decks DIR` | Extra deck folder; repeatable. Decks are also read from the user's constructed decks folder. |
| `--deck`, `--opp-deck`, `--ai` | Defaults for `match.start`. `--ai` takes a profile name: `Default`, `Neural`, … Without `--ai`, the default is **Neural** when mtg-ai, ONNX Runtime and `neural/latest.json` are present (`welcome.neural` says why not), else `Default`. The UI shows the Neural AI under the name in `-Dforge.table.neuralLabel`, else `FT_NEURAL_LABEL`, else "Neural" (`welcome.neural.label`). Against Neural the opponent deck defaults to the strongest deck it was trained on: `decks` in `latest.json` (`.dck` base names, strongest first), listed first in the start screen's opponent picker under "Neural-trained". A model without the field has no trained decks, and the opponent deck falls back to the ordinary default. |
| `--card-art curated\|printed\|off` | Card images (below). Default `curated`; `off` with `--test-prefs`. |
| `--card-image-map FILE` | Use this `card_images.json` (e.g. the mtg repo's `data/card_images.json`) instead of building one. |
| `--speed X` | Initial motion speed. `0` is Instant, which also turns pacing off. |
| `--record FILE` | Append every server→client message to `FILE` as JSONL. Use this to make replay fixtures. |
| `--test-prefs` | Deterministic test preferences. Never use it against a real profile. |
| `--debug` | Log every outbound message to stderr. |

Useful system properties:

| Property | Effect |
|---|---|
| `-Duser.home=…` | Isolates `USER_DIR` and `CACHE_DIR`. Always set it in tests. |
| `-Dforge.table.ignoreStdin=true` | Keeps the sidecar alive when stdin closes (background runs). |
| `-Dforge.bridge.devOrigin=http://localhost:5173` | Lets Vite's dev server open the WebSocket. |

**Card art.** `GET /img/card/<imageKey>` serves real card images (the client falls back to procedural faces).
- `curated` picks each card's cleanest standard printing by name, and among equally clean ones the newest
  (`forge.bridge.art.CuratedPrintings`, derived from mtg's `scripts/build_image_map.py`; it now also prefers
  2015+ frames and skips previews, placeholders, textless, playtest and acorn cards, so it no longer matches
  the Python reference exactly). On first run the sidecar streams Scryfall's `default_cards` bulk file
  (about 80 MB compressed, about 8 s here) into `<cache>/table/card_images.v2.json` (about 36k names), and
  rebuilds it in the background after 30 days. The `v2` is `CardArtIndex.FORMAT`: it changes with the picking
  rules, so older maps (`card_images.json` was v1) are never read and the map is rebuilt once.
- Downloads land in `<cache>/table/art/` (Scryfall's own path, so all copies of a card share one file).
- Names the map lacks, tokens, and `printed` mode use the deck's exact printing: Forge's picture cache
  first (Classic's downloads), else Scryfall by set and collector number.
- Requests are held up to 15 s while downloading, then answered `202` + `Retry-After`; `204` means no art.
- `GET /img/crop/<imageKey>` is the same card's art crop alone (Scryfall's `art_crop`: the `/normal/` URL with
  `/art_crop/`; the deck's printing by set and number under `printed`; tokens too), for the client's own
  "Framed" card face. Same holding, `202`/`204` and cache semantics (crops land under `art/art_crop/`). The
  answer carries the artist in `X-Card-Artist` (percent-encoded UTF-8; absent when unknown). Curated artists
  come from the same bulk pass as the map, into `<cache>/table/card_artists.v2.json`; a map built before that
  file existed is rebuilt once in the background (the old one keeps serving). A `--card-image-map` has no
  artists, so its crops carry no credit.

**Deck import.** `rpc decks.import {text?, url?, name?, dryRun?}` parses a pasted list (Arena, MTGO, Moxfield,
`.dck`) or a Moxfield/Archidekt/TappedOut/MTGGoldfish link with Forge's `DeckRecognizer`, reports unknown lines
instead of failing, and saves to the user's constructed decks folder (shared with Classic).

**Stopping it.** Close its stdin, or kill the process. Don't `pkill -f forge.bridge.Main` from a
shell whose own command line contains that text, or you'll kill the shell too. Use
`ps -eo pid,args | grep '[f]orge.bridge.Main'` to find the PID.

## Multi-game server (router mode)

`--router` turns the same program into a small front for many games:
one listener serves a lobby at `/` and starts **one child sidecar per game**, each on its own `127.0.0.1` port,
reached through `/m/<id>/…` (page, WebSocket, card images). Human vs AI only. Nothing survives a router restart.
The plain sidecar above is unchanged; the zip and the e2e tests still use it.

```sh
java -Xmx3g -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -cp forge-gui-bridge/target/classes:$(cat forge-gui-bridge/target/classpath.txt) \
  forge.bridge.Main --router --port 8790 --data /tmp/ft-router \
  --assets forge-gui/ --web forge-gui-web/app/dist --decks forge-gui-bridge/src/test/resources/table/decks
```

It prints `FORGE_TABLE_READY {"mode":"router","port":…,"maxMatches":…,"maxPerUser":…,"url":…}` within a second.
In local mode the `url` ends in `#t=<token>`: open it, press **New game**, and the game's own start screen (decks,
opponent deck, AI, deck import) opens once its sidecar is up. From the packaged zip, run the same `java` line as
`play-table.sh` with `--router --data userdata/router` put first (and without `--open-browser`). `--router` only
counts as the first argument. Children inherit the router's classpath, working directory and an allowlist of
its JVM options: `-Xmx`/`-Xms`/`-Xss`, `--add-opens=`/`--add-exports=` and `-D…` (minus `user.home` and
`forge.table.ignoreStdin`). Agents, `-XX` flags and debug ports stay with the router. Neural works the same
as in a single game.

While a game boots (about 15–30 s), its lobby row shows a progress bar with the current step: starting Java,
loading the card database (Forge's own card-reader progress), preparing the AI opponent, setting the table. The
child is started with `--progress` and prints `FORGE_TABLE_PROGRESS {"stage":…,"pct":…}` lines (at most 4 a second)
before its ready line; the router maps each stage to a fixed band of the bar, so it only moves forward, and the
lobby's labels are the router's own (nothing the child prints is shown). The plain sidecar prints these lines only
with `--progress`.

Every child is started with `--names-only`. Its `match.start` then takes bare deck names found inside its deck
folders (the shared `--decks` folders and its owner's imports), never a path or a link out of those folders,
and refuses a board-state file. Every refusal reads `Unknown deck`, so a browser learns nothing about paths or
which files exist. Deck imports refuse names starting with `.` or `-`, which couldn't be
loaded again.

| Flag | Meaning |
|---|---|
| `--router` | Router mode. Everything below is router-only, except the pass-through flags. |
| `--bind ADDR` | Listen address, default `127.0.0.1`. A wildcard (`0.0.0.0`, `::`) is always refused. Without sign-in (`--auth header`, `users` or `oidc`), loopback only. With it, loopback or one private address (RFC 1918 or IPv6 unique-local, e.g. the host's LAN address); a public address is refused. |
| `--port N` | Listen port (default ephemeral). |
| `--data DIR` | Router data, default `~/.forge-table-router`: `matches/<id>/` per running or paused game (one without a save is cleared at start, see **Saved games**), `forge-table.db` (accounts and sessions under `--auth users`/`oidc`), `ended/<id>/` the folders of ended games with their `child.log` (kept 24 h, at most 20), `users/<user>/decks/` (each user's imported decks, kept), `cache/table/` (card art, shared by all games). |
| `--trust-proxy-header NAME` | Take the user from this request header, the one your login proxy sets (`X-Forwarded-User` for oauth2-proxy, `X-authentik-username` for Authentik). Without it: one user, `local`, with the token scheme of the plain sidecar. |
| `--require-group NAME` | Also require `NAME` among the values of the `--groups-header` header (split on `--groups-separator`, default `,`), or under `--auth oidc` in the groups claim. Off by default: anyone your sign-in lets through may play. |
| `--admin-group NAME` | Members of `NAME` are admins: the lobby's Admin section, `/api/admin/*`. Read like `--require-group`: exactly one groups header, non-empty, `NAME` exactly among its values; anything else is not an admin. Needs `--trust-proxy-header` or `--auth oidc` (the groups claim); without the flag nobody is. In local mode the one local user is the admin. |
| `--auth MODE` | How people sign in (`FT_AUTH`): `token` (one user, `local`, the ready line's link), `header` (a login proxy in front, `--trust-proxy-header`), `users` (Forge Table's own accounts and sign-in page, see **Native sign-in**) or `oidc` (a "Sign in with ..." button for an OpenID Connect provider, see **Sign in with OIDC**). `users` and `oidc` combine (`users,oidc`). Unset: `header` when `--trust-proxy-header` is set, else `token`, so older configs mean what they always did. `token` and `header` don't combine with anything. |
| `--session-idle-days N` / `--session-max-days N` | `--auth users` or `oidc`: a sign-in lasts until it goes unused for `N` days (default 14), and `N` days at most (default 30). |
| `--insecure-cookies` | `--auth users` or `oidc` over plain http (a LAN without TLS): the session cookie is sent without `Secure`. Off by default, with a warning in the log when on. |
| `--oidc-issuer URL` / `--oidc-client-id ID` / `--oidc-client-secret-file PATH` | `--auth oidc`: the provider (`FT_OIDC_ISSUER`, exactly as its discovery document names it, `https` only), this app's client id (`FT_OIDC_CLIENT_ID`) and a file holding its client secret (`FT_OIDC_CLIENT_SECRET_FILE`; leave it out for a public client, which then relies on PKCE alone). Needs `--public-url`. |
| `--oidc-scopes S` / `--oidc-login-claim C` / `--oidc-name-claim C,...` / `--oidc-groups-claim C` | What to ask for (`openid profile email`) and which claims hold the login (`preferred_username`), the shown name (the first present of `given_name,name`) and the groups for `--require-group` and `--admin-group` (`groups`). A login by `email` also needs `email_verified: true` from the provider. |
| `--oidc-label TEXT` / `--oidc-logout local\|provider` | The button's text (`Sign in with SSO`). **Sign out** ends the Forge Table session only (`local`, the default), or then the provider's too (`provider`, through its `end_session_endpoint`). |
| `--link-by-login` | `--auth oidc`: an OIDC sign-in whose login matches an account not yet linked to the provider takes that account, once. For moving from header mode; turn it off afterwards (`FT_LINK_BY_LOGIN`). |
| `--oidc-insecure` | Allow an `http` issuer: a test provider on your own machine only. The log warns at startup while it's on. |
| `--real-ip-header NAME` | The header your proxy puts the client's address in (`FT_REAL_IP_HEADER`), e.g. `X-Real-IP`. Needed by `--auth users` and `--guests`, whose try limits count per address: behind a proxy every connection comes from the proxy, so without it everyone would share one count. Name a header the proxy sets to one address and overwrites, never `X-Forwarded-For` (a client can put anything in front of that list). |
| `--logout-url URL` | `--auth header`: the lobby shows **Sign out**, a link to `URL` (your proxy's sign-out address, oauth2-proxy's is `/oauth2/sign_out`). Unset: no button. |
| `--max-per-user N` | Games one user may have open at once (default 3). |
| `--max-matches N` | Hard cap on games. Default: `floor((RAM − --reserve-mb) / --game-mb)`, from the machine's total RAM (or the container's memory limit). |
| `--reserve-mb MB` / `--game-mb MB` | The RAM formula's inputs: default 2048 MB for the OS and router, 1536 MB per game (measured below). |
| `--idle-minutes M` | Close a game nobody has had open for `M` minutes (default 30). |
| `--admin-port N` | Also listen on `127.0.0.1:N` for `/healthz` and `/admin/drain` only (for local scripts when `--bind` isn't loopback). |
| `--drain-timeout M` | In drain mode, end the remaining games with a guest (the only ones not kept over a restart) and exit after `M` minutes (default 120). |
| `--grace-minutes M` | Close a finished game `M` minutes after its match ended and no browser has it open, unless a new one started (default 15). Crashed games are dropped after the same time. |
| `--fonts DIR` | Fonts for the Framed card face (`FT_FONTS`). Serves only `beleren.woff2`, `beleren.ttf` (name, type line, P/T) and `mplantin.woff2`, `mplantin.woff` (rules and flavor text) from `DIR`, at `/fonts/<name>` under the lobby and every game (anything else is `404`). A missing file, or no `--fonts`, falls back to the open fonts in the bundle: Faustina (weight 700) and Splentinex Regular, both OFL. |
| `--assets`, `--web`, `--decks`, `--card-art`, `--card-image-map`, `--test-prefs`, `--debug` | Passed to every game. `--web` is also where the lobby page comes from. `--decks` folders are shared by everyone. |

**Native sign-in** (`--auth users`). Forge Table keeps its own accounts in `<data>/forge-table.db` (SQLite; the
`sqlite3` CLI opens it) and has its own sign-in page at `/auth/login`. There is no sign-up: an admin makes every
account. Make the first one from the command line, on the machine that runs the router:

```sh
java -cp … forge.bridge.Main --users add ana --admin --data /var/lib/forge-table   # asks for the password
java -cp … forge.bridge.Main --users list --data /var/lib/forge-table
```

`--users` takes `add <login> [--admin] [--name NAME]`, `list`, `reset <login>`, `disable <login>`, `enable <login>`,
`admin <login> on|off` and `delete <login>`, and finds the database like the router does (`--data`, `FT_DATA`,
`--config`). It reads passwords from the terminal, or from stdin when piped (never from a flag or the environment).
Logins are lowercase letters, digits, `.`, `_` and `-`, up to 32 characters; passwords are 10 to 256 characters.
It's safe to run while the router is up: a turned-off or reset account is signed out on its next request. Deleting
an account leaves its decks and records on disk, under the same `users/<login>-…/` folder a proxy login would use,
so moving from header mode to native accounts with the same logins keeps everyone's stuff.

- Signing in sets the `__Host-ft_session` cookie (`HttpOnly; Secure; SameSite=Lax`; `ft_session` without `Secure`
  under `--insecure-cookies`) with a random id. The database keeps only its SHA-256, so a copy of the file can't be
  used to sign in. Every sign-in gets a new id. **Sign out** in the lobby ends the session.
- Passwords are stored as PBKDF2-HMAC-SHA256, 600,000 rounds, 16-byte salt. A hash with older settings is
  redone at the next sign-in.
- Wrong guesses wait: 5 for one login in 10 minutes locks it for 15 minutes, 30 from one address in 10 minutes
  locks the address. "No such user" and "wrong password" read and take the same. Tries still being checked count
  too, so firing many at once doesn't get past the limit. The address is the `--real-ip-header` value, which
  `--auth users` requires: set your proxy to send the client's address there (Caddy:
  `header_up X-Real-IP {remote_host}`; nginx: `proxy_set_header X-Real-IP $remote_addr;`). With no proxy in
  front (a LAN under `--insecure-cookies`), nothing overwrites that header, so the browser sends whatever it
  likes: someone can change it on every try and dodge the per-address limit. The per-login lock still holds.
- Signed out, a page (`/`, `/join/<code>`, `/m/<id>/`) goes to `/auth/login?next=…` and back after signing in (only
  ever to a path on this site); `/api/*` answers `401`.
- Every `POST` (sign-in and sign-out too) and every socket must come from this site: a matching `Origin`, or
  `Sec-Fetch-Site: same-origin` when there is none.
- Put TLS in front (Caddy, nginx, Traefik): the cookie is `Secure`, so a browser only sends it over https. Guests
  (`--guests`) work as in header mode.

**Sign in with OIDC** (`--auth oidc`, or `users,oidc` for both). The sign-in page gets a button that sends people
to your OpenID Connect provider (Authentik, Keycloak, Authelia, Google, ...) and back. At the provider, make a
confidential client (an "OAuth2/OpenID provider" or "web application") with:

- **Redirect URI** `<--public-url>/auth/oidc/callback`, for example `https://table.example.com/auth/oidc/callback`.
- **Post-logout redirect URI** `<--public-url>/auth/login`, if you use `--oidc-logout provider`.
- The `openid`, `profile` and `email` scopes, plus whatever puts the groups in a claim if you use `--require-group`
  or `--admin-group`.

Then put the client secret in a file only the router's user can read and start the router with:

```sh
FT_AUTH=oidc
FT_PUBLIC_URL=https://table.example.com
FT_OIDC_ISSUER=https://idp.example.com/application/o/forge-table/
FT_OIDC_CLIENT_ID=forge-table
FT_OIDC_CLIENT_SECRET_FILE=/etc/forge-table/oidc-secret
```

The issuer must be exactly what the provider's `/.well-known/openid-configuration` says (trailing slash and all);
the log says at startup whether it answered. How it works:

- The authorization code flow with PKCE (S256). The `state`, `nonce` and PKCE verifier ride in a short-lived
  `__Host-ft_oidc` cookie (10 minutes), sealed with a key the router makes at startup, so a sign-in only finishes in
  the browser that started it, once. Starting a sign-in stores nothing in the router, so nobody can crowd out real
  ones by starting lots of them; a restart only fails the sign-ins under way. Each router makes its own key, so if
  you run several behind a load balancer, keep each browser on one router (sticky sessions), or a sign-in started on
  one fails when the provider sends it back to another.
- The code is traded for an ID token at the token endpoint (`client_secret_basic`), and the token's `iss`, `aud`,
  `azp`, `exp`, `iat` and `nonce` are checked. Its signature isn't: the token comes straight from the provider over
  TLS and never from the browser, which OIDC Core 3.1.3.7 allows. Claims missing from the ID token are read from
  the userinfo endpoint.
- The login (`--oidc-login-claim`) is taken as the provider gives it, trimmed but not lowercased, and keys the same
  `users/<login>-…/` folder as header mode. The first sign-in makes an account and links it to the provider's
  subject (`sub`); later ones find it by that link, so a rename at the provider keeps everyone's decks.
- **A login that's already an account** with no link to this provider is refused (the sign-in page says the
  username already belongs to another account), so nobody gets an account by picking the same name at the provider. If it's the same person,
  link it: the log line names the login, provider and subject for
  `forge.bridge.Main --users link <login> <provider> <subject>` (`--users unlink <login> <provider>` undoes it;
  `--users list` shows links).
- `--require-group` and `--admin-group` read the groups claim. Admin by group lasts for that sign-in; a local
  account's own admin switch works too.

**Moving from header mode** (same provider, proxy login today): set the OIDC settings, set `--oidc-login-claim` to
the claim holding what the proxy sent (Authentik's `X-authentik-username` is `preferred_username`; check one folder
under `users/` to be sure), and turn on `FT_LINK_BY_LOGIN=true` so each existing login is linked on its first OIDC
sign-in. Then take the proxy's login away. Turn `FT_LINK_BY_LOGIN` off once everyone has signed in (the log
reminds you at startup while it's on). Going back is putting `FT_TRUST_PROXY_HEADER` back: folders are never touched.

**Identity and access.**
- Proxy mode: every request must carry the user header exactly once and non-empty. Missing is `401`;
  repeated or empty is `400`. Under `--require-group`, a repeated groups header is `400`; an empty one or
  no membership is `403`.
- **The listening port is the identity boundary.** Whoever can reach it can claim any user name with the
  header, so only the reverse proxy may reach it (see the hand-off).
- Local mode: `/api/*`, images and the socket need the router token, sent as the `X-Forge-Table-Token`
  header, the `ft` cookie or `?t=`. Static game files are open, as in the plain sidecar.
- Users see, open and end only their own games. Another user's game is `403`, an unknown one `404`.
- Socket upgrades and API writes from a foreign `Origin` are refused. The origin must match `Host`, or
  `X-Forwarded-Host` in proxy mode.
- Child tokens never reach the browser. The router swaps the token in the client's `hello` for the child's,
  and sends the child's `ft` cookie itself. Nothing else from the browser is passed on (no cookies, no
  user, name or groups headers). In local mode the token's `ft` cookie is set only by a game page, scoped to `/m/<id>/`;
  the lobby sends the token as a header and sets no cookie.
- The router decodes nothing for a game. It refuses percent-encoding in a game path except in an image key,
  and `..`, backslashes and control characters in a decoded key.
- Limits per game socket: 2 sockets per game (`429` beyond), browser frames up to 2 MB (a 1 MiB deck file plus
  JSON escaping), and reading pauses while messages wait for the game (beyond 64 messages or 4 MB the
  socket is closed). HTTP connections that send nothing for 150 s are closed (sockets are exempt).

**Lobby API** (JSON; writes need `Content-Type: application/json`):

| Call | Answer |
|---|---|
| `GET /api/me` | `{auth, login, name, admin, signOut?, logoutUrl?}`: the sign-in mode (`token`, `header`, or `users` for any native sign-in, OIDC included), who you are, and how to sign out (`signOut`: `POST` there, native sign-in; `logoutUrl`: the proxy's, when `--logout-url` is set). |
| `GET /api/matches` | `{user, maxPerUser, maxMatches, matches:[{id, status, created, error?}]}`, your games only. `status`: `starting`, `ready` (on the start screen), `playing`, `over`, `crashed`, `stopping` (ended, process still exiting). |
| `POST /api/matches` `{deck?, oppDeck?, ai?}` | `201` + the game (`starting`). Deck names preselect the start screen; `ai` is `Neural` or `Default`. `429` at your own cap, `503` when the server is full, each with `{error}`. Both caps are checked and the slot reserved under one lock. Your cap counts every listed game, crashed and stopping ones included. The total counts every process that may still hold memory, so stopping ones too, but not crashed ones. |
| `DELETE /api/matches/<id>` | Ends the game (or removes a crashed one) and answers with the new list. The game shows as `stopping` until its process has exited. |

`GET /api/matches` also says `admin: true` for an admin. **Admin API** (admins only, checked on every call;
anyone else gets `403`; writes need a same-origin request, `POST` also JSON):

| Call | Answer |
|---|---|
| `GET /api/admin/matches` | `{matches:[{id, owner, created, status, connected}], draining, restartIn?}`: every user's games. `connected`: a browser has it open. |
| `DELETE /api/admin/matches/<id>` | Ends anybody's game (logged `ending: ended by admin <name>`); answers with the list. |
| `POST /api/admin/update` `{}` | "Update now": no new games from now on; every open game shows a banner counting down 60 s ("Server restarting in 60 s. Your game is saved and picks up after the update"); then games with a guest are ended (`ending: server update (admin <name>)`) and the router drains and exits. Every other game is saved and resumes after the restart (see **Saved games**). |

After "update now" the router exits with code **75** unless a deploy asked for the drain (`POST /admin/drain`,
then it is 0 as usual). With the reference unit's `Restart=on-failure` (`RestartSec=5`), systemd starts it again
5 s later on the current build. If a deploy was already draining (a new stable build waiting for games to
finish), its loop sees the router exit and installs the new build at once. A build that the deploy timer
hasn't seen yet is installed at its next run (every 5 min), draining as usual.

**Lifecycle.**
- A game starts on `New game`, which takes 20–40 s (mostly loading the card database; 22–23 s measured with four starting at once on 8 cores).
- It is reaped `--grace-minutes` after its match ends and the last browser left, or after `--idle-minutes` with no browser
  connected. A game a browser has open is never reaped. The router logs why (`ending: finished, nobody connected for
  15 min`, `idle …`, `crashed …`, `ended by its owner`, `the router is stopping`).
- A child that dies shows as `crashed`, with a generic reason (no paths; details in the router's log), until
  its owner removes it or `--grace-minutes` pass. Nothing is restarted by itself; a game with a save is then
  paused instead of ended (below).

**Saved games.**
- A game saves itself (`matches/<id>/checkpoint.json`, Forge's board-state format plus the match's settings, and the
  decks as `deck0.dck`/`deck1.dck`) whenever a player gets priority with the stack empty outside combat. The save goes
  when the game ends. Resuming rewinds to that point; "until end of turn" effects, delayed triggers and one-shot
  control changes are not in the format and are lost.
- Reaping a game that has a save (idle, crashed) pauses it instead: the process stops, the folder stays, and the owner's
  lobby shows it as `paused` with a **Resume** button (`POST /api/matches/<id>/resume`), which starts a new process
  from the save. A paused game counts against its owner's `--max-per-user`, not against the server's cap, and is ended
  after 30 days.
- Stopping the router keeps every saved game. The next start lists them as paused and resumes by itself each one that
  was being played (a browser had it open, or had within 5 minutes); its players' tabs reconnect to it. Games between
  two signed-in people are kept too (who sits where is in `matches/<id>/router.json`), and wait until both are back;
  a game with a guest (as owner or opponent) is not kept. A resumed game is never captured for Neural training.
- A saved game whose `game.json` can't be read at startup is moved to `<data>/unreadable/<id>-<time>/`, never
  deleted or pruned: look at it, and move it back to `matches/<id>/` to list it again. A save the game itself can't
  resume is renamed `checkpoint.json.bad` and the game opens on its start screen.
- Ending a game closes its stdin (SIGTERM at once if it is still booting), then SIGTERM after 5 s and SIGKILL
  after 10 s. Its slot is only freed when the process has gone.
- Children exit when the router does: their stdin is a pipe from the router. On shutdown the router closes it
  (each game writes its save and exits), then sends SIGTERM after 5 s and SIGKILL after 10 s.
- Each child's log is `<data>/matches/<id>/child.log`. When the game ends its folder moves to `<data>/ended/<id>/`,
  kept for 24 hours (the newest 20 at most).

**Resource sizing** (measured 2026-10-04: this build in the packaged zip layout with the real Neural model, JDK 21, 8-core host, 62 GB; RSS sampled every 2 s).

| What | RSS |
|---|---|
| Router alone | about 100 MB idle; at most 231 MB with four games running |
| A game whose start screen is open (no match yet) | about 0.6 GB |
| A game, children at `-Xmx4g` (the `play-table.sh` heap) | peak 1.00–1.56 GB, about 0.86–1.02 GB afterwards (2 Neural + 2 Default games) |
| A game, children at `-Xmx1536m` | peak 0.94–1.05 GB (2 Neural + 2 Default; the two Neural games held a steady 1.0–1.05 GB for 10+ minutes) |

- Neural vs Default made no measurable difference.
- After a game the live heap is about 215 MB, and the JVM has about 0.7 GB committed. The rest is
  metaspace, code and threads.
- The heap is the knob: a child can grow to about `-Xmx` + 0.4 GB, so `-Xmx1536m` bounds a game near
  1.9 GB, with 1.0–1.1 GB typical. Children inherit the router's `-Xmx`, so start the router with
  `-Xmx1536m` (the router itself never comes near it).
- `--game-mb` defaults to **1536**, which covers every peak seen at either heap size. It can still
  **overcommit** against the about 1.9 GB worst case if every game grows to its heap cap at once. Use
  `--game-mb 2048` where that must never happen.
- The measured games were scripted (30–60 s each, plus the two 10-minute Neural ones). Real games are
  longer but bounded by the same heap cap.
- CPU wasn't the limit at four games on 8 cores. An AI decision is a burst on one core.

### Deploying behind a login proxy

The reference setup is a Linux host (a VM or system container) running systemd, behind a reverse proxy that signs
people in and sets a user header. The examples use Caddy + Authentik (Caddy on another host reaching the server over
the LAN); any proxy that meets the header rules in step 4 works. Reference files to adapt, in
[`forge-gui-bridge/deploy/`](../../forge-gui-bridge/deploy/):

| File | What it is |
|---|---|
| `forge-table@.service` | The router, one instance per channel (`forge-table@stable`, `forge-table@dev`), running `/opt/forge-table/<channel>/current` (the unpacked zip) with `-Xmx1536m`, `--router` and `--data /var/lib/forge-table/<channel>`. Everything else comes from the channel's env file. |
| `forge-table.env.example` | `/etc/forge-table/<channel>.env`: `FT_BIND`, `FT_PORT`, `FT_ADMIN_PORT`, `FT_MAX_MATCHES`, the sign-in settings (`FT_TRUST_PROXY_HEADER`, `FT_GROUPS_HEADER`, `FT_ADMIN_GROUP`: the group whose members get the lobby's Admin section), `FT_MTGAI_UPLOAD` (`on`\|`optin`\|`off`) and `FT_MTGAI_UPLOAD_URL`, which decide whether a channel's games train the Neural seat (see "Sending games to the learner" below). |
| `forge-table-deploy.sh <stable\|dev> <token-env-file>` | Polls the channel's pointer under `FT_API` (stable: generic package `forge-table/latest/version.json`; dev: `forge-table/dev/<branch>/version.json`). On a new sha256: downloads with the read-only token (never printed or put in argv), verifies the sha256, unpacks to `releases/<sha8>/`. Stable drains first; dev doesn't. Then it switches the `current` symlink and restarts the unit, keeping 2 releases. |
| `forge-table-deploy@.service` / `.timer` | Runs the script for a channel every 5 minutes (as root: it restarts the unit). The token file is `/etc/forge-table/deploy-token.env` (`GITLAB_READ_TOKEN=…`, mode 0600, not in the repo). |

1. **Run.** The unit runs the zip's `play-table.sh` `java` line with these changes:
   - `-Xmx1536m`;
   - `-Dforge.table.ignoreStdin=true` (children never inherit it);
   - `--router --data …`, with the bind address, ports, sign-in, cap and groups as `FT_*` lines in the env file.
   - `KillMode=mixed`: a stop signals the router alone, which then stops its games (each saves first) and marks the
     ones being played to resume at the next start; with the default `control-group` the games are killed alongside it.
   - `SuccessExitStatus=143`: a stop by SIGTERM (exit 143) doesn't leave the unit failed. `Restart=on-failure`
     restarts the router after an admin's "update now" (exit 75), not after a deploy's drain (exit 0).

   It needs Java 21 at `/usr/bin/java` (the unit's `ExecStart`; systemd 252 won't expand a variable there). `--bind` is the host's own private address (or `127.0.0.1` if the proxy runs
   on the same host); the router refuses wildcards and public addresses outright. Optional:
   `FT_REQUIRE_GROUP=<group>`.
2. **Firewall. `<P>` is the identity boundary:** anything that can reach it can claim any user name with the
   header.
   - Firewall `<P>` on the host so that **only Caddy's address** can connect (e.g. an nftables rule accepting
     `ip saddr <caddy-ip> tcp dport <P>` and dropping the rest), and verify it with check (e) below.
   - `--admin-port` listens on `127.0.0.1` only and answers just `/healthz` and `/admin/drain` (never the
     lobby or the API).
   - Every game listens on its own `127.0.0.1` ephemeral port on the host. Nothing outside should reach
     those.
3. **Proxy.** One site, everything to the router: `/` (lobby), `/api/*`, `/assets/*`, `/m/<id>/*`
   (including the WebSocket upgrade at `/m/<id>/ws`; Caddy's `reverse_proxy` passes upgrades by default).
   - No path stripping or rewriting.
   - Keep `Host` (Caddy's default) or set `X-Forwarded-Host`: the router checks the browser's `Origin`
     against them.
   - Sockets are long-lived, so don't put a short read timeout on them.
   - The router closes an idle HTTP connection after 150 s, longer than Caddy's 2-minute upstream keep-alive,
     so Caddy never reuses one the router is closing (which would 502 a POST or DELETE). Setting
     `transport http { keepalive 30s }` in the `reverse_proxy` works too.
   - Don't route `/healthz` or `/admin/*` through Caddy. The router refuses them anyway from anything that
     isn't a local, unproxied request.
4. **Headers (security, verify before opening it up).** Caddy must **delete every client-sent `X-authentik-*`
   header before `forward_auth` sets them**, e.g. `request_header -X-Authentik-*` ahead of `forward_auth`
   (it must also apply to WebSocket upgrades). Then confirm it from outside. Each check must come out as
   stated:
   - (a) A forged user header with no session never reaches the API:
     `curl -si -H 'X-authentik-username: mallory' https://<site>/api/matches | head -1` gives `302` (to
     Authentik) or `401`, **never `200`**.
   - (b) With a real session (its cookie in `-b`), a forged user header changes nothing:
     `curl -s -b '<session cookie>' -H 'X-authentik-username: mallory' https://<site>/api/matches` answers
     with your own `user`, never `mallory`.
   - (c') The same for `--admin-group`: a non-admin with a forged `X-authentik-groups: <the admin group>` gets `403` from
     `https://<site>/api/admin/matches`.
   - (c) With `--require-group` on and a user outside the group, a forged groups header doesn't let them in:
     `curl -s -o /dev/null -w '%{http_code}' -b '<session cookie>' -H 'X-authentik-groups: <the group>' https://<site>/api/matches`
     gives `403`.
   - (d) A WebSocket upgrade with a forged header and no session is also refused (`302`/`401`), never `101`:
     `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'X-authentik-username: mallory' https://<site>/m/0/ws | head -1`.
   - (e) From another LAN host (not Caddy), the router port can't be reached at all:
     `curl -m 5 -H 'X-authentik-username: x' http://<server-ip>:<P>/api/matches` must fail to connect.
   - The router also rejects a request whose user header is repeated or empty (`400`) and one without it
     (`401`).
   - It forwards no browser headers or cookies to the games.
5. **Memory.** Plan 1.0–1.1 GB per game typical, about 1.9 GB worst case at `-Xmx1536m`, plus about
   0.25 GB for the router.
   - The default of 1536 MB per game can overcommit against that worst case; `--game-mb 2048` makes the cap
     strict.
   - Without `--max-matches`, the cap is `floor((RAM − 2048 MB) / --game-mb)`. RAM is the container's memory
     limit (or the machine's) (the JVM reads the cgroup limit), so setting the limit sets the cap. Examples at 2048 MB per game:
     8 GB → 3 games, 16 GB → 7, 32 GB → 15.
   - The reference unit sets `--max-matches` from `FT_MAX_MATCHES` explicitly. Per user: `--max-per-user`
     (default 3).
6. **Network out.** Card art comes from Scryfall (`data.scryfall.io` once for the 80 MB bulk index, then
   `api.scryfall.com` / `cards.scryfall.io` per card), cached in `<data>/cache/table/` and shared by all
   games. `--card-art off` removes the dependency. The deploy script needs the host in `FT_API`.
7. **Disk.**
   - `<data>` holds `users/*/decks` (imported decks, small, keep it), `cache/table` (about 4 MB index plus
     about 100 KB per card image downloaded) and `matches/` (games; at start, folders without a save are wiped).
   - `/opt/forge-table/<channel>/releases` holds two unpacked builds of about 400 MB each.
8. **Health, drain, logs** (all on the admin port, from the host itself):
   - `GET /healthz` gives `{"ok":true,"build":"<forge sha8>","builtAt":"…","active":N,"starting":N,"stopping":N,"draining":false,"cap":N}`:
     counts only, never users or game ids. Any other peer, or a request carrying a forwarding header, the
     user header or an `Origin`, gets `403`.
   - `POST /admin/drain` stops new games (the lobby shows "Server is updating, new games are paused"; the
     API answers `503`). Saved games resume after the restart, so the router only waits for games with a guest: it
     exits with code 0 once none is running, or after `--drain-timeout` minutes (default 120), ending whatever is
     still running.
   - `forge-table-deploy.sh stable` drains, polls `/healthz` until the router has exited, then switches and
     restarts. `dev` just restarts.
   - The router logs to the journal. A crashed game stays in its owner's lobby as `crashed` with a generic
     reason; the details are in the journal and in `<data>/matches/<id>/child.log` until it's removed or
     `--grace-minutes` pass, then in `<data>/ended/<id>/child.log` for another 24 hours.
   - Restarting the router pauses every game; the ones being played resume after it (**Saved games**). Use drain for
     planned restarts.

### Docker

[`forge-gui-bridge/docker/`](../../forge-gui-bridge/docker/) builds the same router as an image from a release zip
(`package.sh`, then the `docker build` line at the top of its `Dockerfile`), with its data in the `/data` volume and
every setting as an `FT_*` variable. The image listens on the container's own address, never `0.0.0.0`, so it needs
a sign-in mode to start (a login proxy, `FT_AUTH=users` or `oidc`): `compose.yaml` puts it on a network with your login proxy, which forwards to
`http://forge-table:8790` and is the only thing that can reach it. To play alone without a proxy, run it on the host's
loopback instead: `docker run --network host -e FT_BIND=127.0.0.1 -v forge-table:/data forge-table`, then open the
`#t=` link it prints. `/healthz` is the image's healthcheck, on the loopback admin port 8799.

**The user header is the login, so anything that can reach port 8790 can claim to be anyone.** Never publish it
(`-p 8790:8790` or `ports:` in compose): then anyone who reaches the host sets `X-Forwarded-User` themselves. On
the proxy network, every other container can do the same, so give Forge Table and its proxy a network of their own.

### Sending games to the learner

Each channel's `FT_MTGAI_UPLOAD` (`on`/`optin`/`off`) and `FT_MTGAI_UPLOAD_URL` set whether its games train the
Neural seat (`forge-table.env.example`): `on` sends by default (a user may opt out), `optin` doesn't (a
user may opt in), `off` never does and hides the lobby's toggle.

- **The lobby toggle** ("Send my games to train the AI", one line saying what's sent: cards played, decisions
  and the result, no names or other personal data) only appears when the channel isn't `off`. `GET /api/matches`
  carries `{"upload":{"on":bool}}` (the user's effective choice: their own pick if they've made one, else the
  channel's default); `PUT /api/upload {"on":bool}` sets it. Persisted server-side per user in
  `<data>/mtgai-upload-prefs.json` (`UploadPrefs`), so it survives a router restart.
- **Per game:** when a user's effective choice is on, their game's child JVM gets
  `-Dmtgai.neural.upload=<FT_MTGAI_UPLOAD_URL>`; otherwise it doesn't. Every child always gets
  `-Dmtgai.neural.games=<data>/neural-games`. Unlike `<data>/matches/<id>`, that directory is channel-wide and
  outlives a router restart, so it's where the Neural seat keeps its trajectory files and upload retry queue
  (mtg-ai `traj/`, `traj/sent/`, `traj/rejected/`).
- The intake endpoint (`FT_MTGAI_UPLOAD_URL`, which takes `PUT <url>/v1/games/<name>`) must be reachable from the
  host; while it isn't, uploads just queue in `traj/` (harmless).

## Web client

```sh
cd forge-gui-web
npm ci                       # app, protocol and tests workspaces (no Electron in PR-1)
npm run build                # → app/dist (served by --web, or packed into the jar by Maven)
npm run test:unit            # Vitest
npx playwright test          # replay goldens + one live game (spawns the sidecar itself)
```

- **Playwright is pinned to exactly `1.56.1`.** The container's preinstalled Chromium
  (`/opt/pw-browsers`, chromium-1194, Chromium 141) only works with 1.56.x. Never run
  `npx playwright install` here. To upgrade: bump the pin, run `npx playwright install chromium`
  on a machine that can, and regenerate every golden in the same PR.
- **Chromium flag.** It runs with `--enable-unsafe-swiftshader` (WebGL on SwiftShader). Frame
  times in the container are informational only.
- **Deterministic mode.** `?test=1` turns on the virtual clock (`window.__table.advance(ms)`),
  device-pixel ratio 1 and procedural card faces only.
- **Replay.** `?replay=<url>` plays a recorded JSONL session without a JVM.

### Making a replay fixture

1. Start the sidecar with `--record /tmp/session.jsonl --speed 0`.
2. Play the game you want through the UI or the scripted client.
3. Copy the file to `forge-gui-web/tests/fixtures/sessions/`. Only commit it if it is under 1 MB.

Fixtures are tied to protocol v1, and a replay of a stale one fails. The committed ones each have a
recorder script that regenerates them from a real sidecar:

| Fixture | Recorder | Goldens |
|---|---|---|
| `madness-vs-faeries.jsonl` | `npm run record:session` | 01–06: mulligan to game over; 15: summoning-sickness tag and preview chip |
| `zones.jsonl` (state `states/zones.txt`) | `npm run record:zones` | 07–09: playable glow, graveyard / exile viewer |
| `choosers.jsonl` (state `states/choosers.txt`) | `npm run record:choosers` | 10–14: scry lanes, any-order lane, zone strip, each with its card preview |
| `split.jsonl` (state `states/split.txt`) | `npm run record:split` | 16–17: O7 combat damage assignment (trample over two blockers), Arc Lightning divided |
| `brawl.jsonl` (state `states/brawl.txt`, `--format brawl`) | `npm run record:brawl` | 47–50: Brawl command zones, the commander cast from one, its tax as a modified cost |

After re-recording, refresh that test's goldens: `npx playwright test --project=replay -g "<test name>" --update-snapshots`.

**Goldens must match on any machine.** GitLab CI (`.gitlab-ci.yml`, job `e2e`) runs them in
`mcr.microsoft.com/playwright:v1.56.1-noble`, which has the same Chromium as here but different system fonts.
Any glyph the bundled fonts lack falls back to a system font and renders differently there. Inter comes from
fontsource's language subsets, plus `app/src/theme/fonts/inter-arrows-wght.woff2` for ← → ▶ ◀. Add new symbols
to that subset; the recipe is in `styles.css`. Or use a glyph the subsets already have. To run the CI image
locally, start `dockerd` if needed, then:

```sh
docker run --rm --network host -e CI=1 -e FT_PREVIEW_PORT=4318 \
  -e PATH=/usr/lib/jvm/java-21-openjdk-amd64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$PWD":"$PWD" -v /root/.m2:/root/.m2:ro -v /usr/lib/jvm:/usr/lib/jvm:ro \
  -v /etc/java-21-openjdk:/etc/java-21-openjdk:ro -w "$PWD/forge-gui-web/tests" \
  mcr.microsoft.com/playwright:v1.56.1-noble npx playwright test
```

Run it from the repo root after a local build. The repo is mounted at its own path because
`forge-gui-bridge/target/classpath.txt` holds absolute paths.

### Video

Playwright records webm when `video: 'on'` is set. To convert:

```sh
ffmpeg -y -i video.webm -c:v libx264 -pix_fmt yuv420p out.mp4
ffmpeg -y -i video.webm -vf "fps=12,scale=960:-1" out.gif
```

## Protocol types

`forge-gui-web/protocol/src/generated/props.ts` is generated from forge-game's `TrackableProperty` and
committed. When `ProtocolCodegenTest` fails, regenerate it with:

```sh
mvn -B -Dskip.web -pl forge-gui-bridge test -Dtest=ProtocolCodegenTest -Dforge.codegen.write=true
```

## Neural (mtg-ai)

The Neural seat is an optional plugin from the separate mtg-ai project; it runs in-process. Without its jar on the
classpath the Neural opponent and game upload are off.

1. Clone mtg-ai.
2. Create the symlinks `scripts/bench/env-linux.sh` expects:

   | Link | Target |
   |---|---|
   | `~/.local/opt/jdk-21.0.12.1+1` | `/usr/lib/jvm/java-21-openjdk-amd64` |
   | `~/.local/opt/apache-maven-3.9.16` | `/opt/maven` |

3. In this repo, install Forge: `mvn -B -DskipTests install -pl forge-gui-desktop -am`.
4. In mtg-ai, build and smoke-test the human-seat package:

   ```sh
   MVN_FLAGS=-B scripts/package-humanseat.sh --forge /home/user/forge \
     --model mtgai-java/src/test/resources/onnx/policy-000001.onnx --out $SCRATCH/humanseat --smoke
   ```

   `MVN_FLAGS` must be non-empty, because the script's default is `-o`.
5. To play against Neural through Forge Table without the full package, build just mtg-ai's jar
   (`mvn -B -pl mtgai-java -DskipTests -Dcheckstyle.skip package`). Then add
   `mtgai-java/target/mtgai-java-0.1.0-SNAPSHOT.jar` and `~/.m2/.../onnxruntime-1.30.0.jar` to the sidecar's
   `-cp`. Run it from a folder holding `neural/` (`latest.json`, the `.onnx`, `cardvocab-v1.txt` and the
   `2026-09-28/` deck dir from `decks/pauper/`) with `-Dmtgai.neural.dir=neural -Dforge.mtgai.aiCastRemAIDeck=true`.
   Neural is then the default opponent. The sidecar logs `[mtg-ai] neural seat: model v1 …` on the first
   game, and game logs land in `userdata/mtgai-games/`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FORGE_TABLE_ERROR … already using this user folder` | Another sidecar holds `USER_DIR/.forge-table.lock`. Stop it, or point `-Duser.home` somewhere else. |
| Browser shows a blank page | The sidecar was started without `--web` and the jar has no bundle (it was built with `-Dskip.web`). |
| WebSocket closes with code 4001 | The `hello` token doesn't match. Reload the page using the URL from the READY line. |
| Surefire: `com/beust/jcommander/ParameterException` | TestNG needs jcommander. Don't exclude it in the pom. |
| Router: `FORGE_TABLE_ERROR {"reason":"Refusing to listen on …"}` | A wildcard `--bind`, a non-loopback one without sign-in (`--auth header`, `users` or `oidc`), or a public address. See "Multi-game server". |
| Lobby game shows `crashed` | The child exited on its own; the reason (exit code or `FORGE_TABLE_ERROR`) is in the lobby, the log in `<data>/matches/<id>/child.log` (`<data>/ended/<id>/` once it's gone). |

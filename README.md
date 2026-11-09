<h1><img src="docs/images/forge-table-icon.png" width="96" height="96" alt="" align="center"> Forge Table</h1>

Forge Table lets you play Magic: The Gathering in a web browser, against the computer or against friends, on a server you run yourself.

> **Forge Table is alpha software.** It plays real games, but expect bugs and rough edges, and expect settings,
> saved data and the plugin interface to change between releases without a migration path. Bug reports and feature
> requests are welcome.

## Your first game

You need **Java 17 or newer**, about **1.5 GB of free RAM per game**, and a browser with WebGL.
Chromium is tested; other current browsers should work. Nothing to configure for one player on your own computer,
and you do not need to clone this repository.

1. Download the latest `forge-table-<build>.zip` from the
   [Releases page](https://github.com/mdbook/forge-table/releases) and unzip it.
2. Run `./launch.sh` (Linux, macOS) or `launch.cmd` (Windows, with `java` on the `PATH`).
3. Your browser opens on the start screen after 30 to 45 seconds. Pick your deck and an opponent from the bundled
   ones, then press Start.

Everything it saves, from imported decks to the card-art cache, goes in `user/` next to the launcher. The server
listens on `127.0.0.1` only and the link it opens carries a random token, so nobody else on your network can join. With `./launch.sh --card-art off` the server fetches no card art at all.

Stop with Ctrl+C or by closing the terminal. Internet access is only needed for card art, fetched from Scryfall;
games work offline. To upgrade, unzip the next release and move your `user/` folder into it.

## Docker and playing with friends

Docker Compose is the recommended way to host the lobby and games for a group. It includes Java, Caddy for HTTPS,
and Forge Table's own accounts. No separate login provider is needed. This works with Docker Engine or Docker
Desktop; the default stack does not use host networking.

**Before you start:** Docker with Compose, a domain pointing at your server, and inbound ports 80 and 443 available
for Caddy. Allow about 1.5 GB of free RAM per running game, plus room for the server. The published image is
`ghcr.io/mdbook/forge-table:edge`; Compose pulls it, nothing to build.

From [forge-gui-bridge/docker/](forge-gui-bridge/docker/) (get `compose.yaml`, `Caddyfile` and
`compose-settings.example`, copy the settings file to `.env` and set `FT_DOMAIN`, see
[install.md](docs/forge-table/install.md#docker)):

1. Start the server:
   ```sh
   docker compose up -d
   ```
2. Make your account and your friend's account. Each command asks for a password of at least 10 characters:
   ```sh
   docker compose exec forge-table java -cp "lib/*" forge.bridge.Main --users add ana --admin --data /data
   docker compose exec forge-table java -cp "lib/*" forge.bridge.Main --users add sam --data /data
   ```
3. Open `https://<your-domain>/`, sign in, and share that address with your friend. Start a two-player game in the
   lobby. Give your friend their password privately; there is no public sign-up.

No token URL or log filtering is needed. Caddy gets the HTTPS certificate on first start. If the site does not
open, check `docker compose logs` and your domain's DNS and firewall. Stop with `docker compose down`;
accounts, decks and saved games stay in the named volume. Do not add `--volumes` unless you mean to delete them.

### Configuration

The [example settings](forge-gui-bridge/docker/compose-settings.example) has the domain and image name.
[compose.yaml](forge-gui-bridge/docker/compose.yaml) starts with one game at a time (`FT_MAX_MATCHES=1`);
raise that only when the server has enough RAM. Other server settings use `FT_*` environment variables, listed in
the [configuration reference](docs/forge-table/configuration.md).

Keep the server's port private: only Caddy publishes ports. If you already have a TLS proxy, or want single sign-on,
guest links or admin options, see [Hosting for a group](docs/forge-table/hosting.md).
The optional [compose.oidc.yaml](forge-gui-bridge/docker/compose.oidc.yaml) is for an existing login provider;
[compose.solo.yaml](forge-gui-bridge/docker/compose.solo.yaml) is a Linux-only, local token-mode alternative.

## The table

![A game in progress: the opponent attacks, the player's hand along the bottom](docs/images/game.png)

![The lobby: two games in progress, one starting, an open table from a friend](docs/images/lobby.png)

Forge Table is its own product, built on the [Forge](https://github.com/Card-Forge/forge) rules engine.
It isn't affiliated with the Forge project or with Wizards of the Coast (see [NOTICE](NOTICE)).

## Documentation

Everything else is in [docs/](docs/README.md): installing (release zip, Docker, from source), every setting, hosting,
card art, the Lyra neural opponent and the plugin hook behind her, building and testing, the architecture and a FAQ.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs in how a card's rules work belong to Forge itself, at
[Card-Forge/forge](https://github.com/Card-Forge/forge/issues).

## Licence

GPL-3.0-only ([LICENSE](LICENSE)). The Forge engine it's built on is GPL-3.0-or-later, and its files keep their
notices. Card names and rules text are Wizards of the Coast's; Forge Table is unofficial Fan Content (see [NOTICE](NOTICE)). The card frame uses open (OFL) lookalike
fonts by default, and an operator can serve other fonts with [`--fonts`](docs/forge-table/configuration.md#files).
The original Forge README is kept at [docs/Forge-engine-README.md](docs/Forge-engine-README.md).

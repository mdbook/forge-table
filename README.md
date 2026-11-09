<p align="center">
  <img src="docs/images/forge-table-icon.png" alt="Forge Table logo" width="112">
</p>

<h1 align="center">Forge Table</h1>

<p align="center">
  <b>Magic: The Gathering in your browser, on a server you run yourself.</b><br>
  Play the computer or your friends, no app to install for anyone but you.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/forge-table/install.md">Install guide</a> ·
  <a href="docs/forge-table/configuration.md">Configuration</a> ·
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/mdbook/forge-table/actions/workflows/forge-table.yml"><img src="https://github.com/mdbook/forge-table/actions/workflows/forge-table.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/java-17%2B-orange" alt="Java 17+">
  <img src="https://img.shields.io/badge/docker-compose-2496ED" alt="Runs with Docker Compose">
</p>

![A game in progress: the opponent attacks, the player's hand along the bottom](docs/images/game.png)

Forge Table is a fork of [Forge](https://github.com/Card-Forge/forge), the open-source Magic: The Gathering rules
engine, and all the rules and card scripting are theirs. I added a browser client, a lobby with accounts, and
packaging for hosting it yourself. Forge Table is GPL-3.0 like Forge, and it isn't affiliated with the Forge project
or with Wizards of the Coast (see [NOTICE](NOTICE)).

> **Alpha software.** It plays real games, but expect bugs and rough edges, and expect settings, saved data and the
> plugin interface to change between releases without a migration path. Bug reports and feature requests are welcome.

## Quick start

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

### Docker, for playing with friends

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

## Configuration

The [example settings](forge-gui-bridge/docker/compose-settings.example) has the domain and image name.
[compose.yaml](forge-gui-bridge/docker/compose.yaml) starts with one game at a time (`FT_MAX_MATCHES=1`);
raise that only when the server has enough RAM. Other server settings use `FT_*` environment variables, listed in
the [configuration reference](docs/forge-table/configuration.md).

Keep the server's port private: only Caddy publishes ports. If you already have a TLS proxy, or want single sign-on,
guest links or admin options, see [Hosting for a group](docs/forge-table/hosting.md).
The optional [compose.oidc.yaml](forge-gui-bridge/docker/compose.oidc.yaml) is for an existing login provider;
[compose.solo.yaml](forge-gui-bridge/docker/compose.solo.yaml) is a Linux-only, local token-mode alternative.

## Features

**Play in any modern browser.** Pick a deck and an opponent from the bundled ones, or import your own.

**Play friends, not just the computer.** The lobby lets people sign in with accounts you create, open a table and
start a game. Several games can run at once, each in its own process.

![The lobby: two games in progress, one starting, an open table from a friend](docs/images/lobby.png)

**Your data stays with you.** Accounts, decks and saved games live on your server. Card art is fetched from Scryfall
only if you leave it on.

**Built on Forge.** The rules, the card database and the standard AI opponents come from Forge, and rules bugs get
fixed there. An optional neural AI opponent, Lyra, plugs in through a plugin interface (see the
[AI plugin page](docs/forge-table/ai-plugin.md)).

## Docs

- [Install](docs/forge-table/install.md): release zip, Docker, or from source.
- [Configuration reference](docs/forge-table/configuration.md): every flag, `FT_*` variable and default.
- [Hosting for a group](docs/forge-table/hosting.md): accounts, single sign-on, guest links, your own proxy.
- [Card art](docs/forge-table/card-art.md): where pictures come from and how to turn them off.
- [Neural AI plugin](docs/forge-table/ai-plugin.md): the Lyra opponent and the plugin hook behind her.
- [Building and testing](docs/forge-table/building.md) and [Architecture](docs/forge-table/architecture.md).
- [FAQ and troubleshooting](docs/forge-table/faq.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs in how a card's rules work belong to Forge itself, at
[Card-Forge/forge](https://github.com/Card-Forge/forge/issues).

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). The Forge engine it's built on is GPL-3.0-or-later, and its files keep their
notices. Card names and rules text are Wizards of the Coast's; Forge Table is unofficial Fan Content (see [NOTICE](NOTICE)). The card frame uses open (OFL) lookalike
fonts by default, and an operator can serve other fonts with [`--fonts`](docs/forge-table/configuration.md#files).
The original Forge README is kept at [docs/Forge-engine-README.md](docs/Forge-engine-README.md).

# Install

There are three ways to run Forge Table. All of them end up running the same Java program, `forge.bridge.Main`, in one
of two modes:

- Single game, the default. One game against the AI for the person at the keyboard. The release zip's launcher
  starts this.
- Router, with `--router` as the first argument. A lobby and many games at once, each in its own JVM, for one person
  or a whole group. The Docker image and the reference systemd unit start this.

The zip and source installs need Java 17 or newer. Docker includes Java. The project builds and tests on 21.

## Release zip

Each release on the [Releases page](https://github.com/mdbook/forge-table/releases) has a
`forge-table-<build>.zip` and its `.sha256`. `<build>` is the first 8 characters of the commit it was built from. The
zip holds one folder:

| Path | What it is |
|---|---|
| `launch.sh`, `launch.cmd` | Start a single game and open the browser. |
| `launch-router.sh`, `launch-router.cmd` | Start the local lobby; open the token URL it prints. |
| `lib/` | The server and every library it needs (`-cp "lib/*"`). |
| `res/` | Forge's card database, AI profiles, editions and formats. |
| `web/` | The browser client. |
| `decks/` | Twelve Pauper decks to start with. |
| `version.json` | `{forge_commit, forge_sha, built_at}`, shown as the server's build. |
| `forge.profile.properties` | Points Forge's user folder at `user/forge/` and its cache at `user/cache/`, next to the launcher. |

Run `./launch.sh` or `launch.cmd`. It starts a single game with `-Xmx4g`, waits for the server, and opens the link
it prints. Set `FORGE_TABLE_NO_BROWSER=1` (Linux, macOS) to skip opening the browser; the link is in the
`FORGE_TABLE_READY` line on standard output. Anything after the launcher's name goes to the server, so
`./launch.sh --card-art printed --ai Default` works. The single-game flags are listed in the
[configuration reference](configuration.md#single-game-flags).

Stop the server with Ctrl+C or by closing its terminal window.

To upgrade, unzip the new release next to the old one and move the old `user/` folder into it.

### The router from the zip

For the lobby, run this from inside the unzipped folder (Linux, macOS):

```sh
./launch-router.sh
```

On Windows, run `launch-router.cmd`. These launchers are included in new builds; an older zip needs upgrading.
Open the `url` in the `FORGE_TABLE_READY` line. The router listens on loopback only, on port 8790, and saves to
`user/router/`. No accounts or config are needed for this local mode. Other flags go after the launcher, for
example `./launch-router.sh --port 8791`. Each game inherits the launcher's `-Xmx1536m` and other JVM options.

## Docker

Docker Compose is the recommended group setup. The default stack uses Forge Table's own accounts and Caddy for
HTTPS, not a separate login provider. It works with Docker Engine and Docker Desktop without host networking.

The image is published at `ghcr.io/mdbook/forge-table:edge` (built by CI from the latest `main`; a `v*` tag will get
its own tag once one exists). You need Docker with Compose, a public domain pointing at this server, and inbound
TCP ports 80 and 443 available. If another web server already uses them, use your existing TLS proxy as described
in [Hosting for a group](hosting.md).

### Start with your own accounts

1. Get `compose.yaml`, `Caddyfile` and `compose-settings.example` from
   [forge-gui-bridge/docker/](../../forge-gui-bridge/docker/) (clone the repo, or download those three files).
   Copy `compose-settings.example` to `.env` next to `compose.yaml`, and change `FT_DOMAIN=table.example.com` to
   your server's DNS name, without `https://` or a path.
2. From that directory, run `docker compose up -d`. Compose pulls the published image. Caddy gets and renews the
   HTTPS certificate. Only Caddy publishes ports; Forge Table stays on the Docker network. The first start can take
   longer while images download and the certificate is issued. Check `docker compose logs` if it does not come up.
3. Create your first admin account:
   ```sh
   docker compose exec forge-table java -cp "lib/*" forge.bridge.Main --users add ana --admin --data /data
   ```
   It asks for a password of 10 to 256 characters. Open `https://<your-domain>/` and sign in. Repeat the command
   without `--admin`, with a different login, for each friend. There is no public sign-up.

The settings example and [compose.yaml](../../forge-gui-bridge/docker/compose.yaml) are the complete default
configuration: `FT_AUTH=users`, a real-client-address header supplied by Caddy, secure cookies, and one game at a
time. Increase `FT_MAX_MATCHES` only if you have about 1.5 GB of free RAM for each extra game, plus server overhead.
Keep unrelated containers off the `table` network, and never publish the router's ports 8790 or 8799.

Stop with `docker compose down`. That keeps accounts, decks, results and saved games in `forge-table-data`;
`docker compose down --volumes` deletes them. Back up the volume before upgrading. To upgrade, pull the new image
and run `docker compose up -d --pull always --force-recreate`. Do not move or rename the Compose directory without
keeping its project name (`-p`), or Compose will use different named volumes.

### Building your own image

To build from a release zip instead of pulling the published image (for example, to pin an exact build or add a
local patch):

```sh
docker build -t forge-table -f forge-gui-bridge/docker/Dockerfile \
  --build-arg ZIP=target/dist/forge-table-<sha8>.zip forge-gui-bridge
```

Run that from a checkout of the Forge Table branch with the zip already at the given path (either downloaded from
the [Releases page](https://github.com/mdbook/forge-table/releases) or built with
`forge-gui-bridge/package.sh`, see [build from source](#from-source)). Then set `FORGE_TABLE_IMAGE=forge-table` in
your `.env` instead of the published image.

### Other Docker setups

Settings are `FT_*` environment variables (`-e FT_MAX_MATCHES=4`), and arguments after the image name are passed to
the server as flags. The image sets `FT_PORT=8790`, `FT_ADMIN_PORT=8799` and `FT_MTGAI_UPLOAD=off`, runs Java with
`-Xmx1536m`, and checks `/healthz` on the loopback admin port as its health check.

The router refuses to listen on `0.0.0.0`, on purpose. When `FT_BIND` is unset the entrypoint uses the container's
own address, which is private, and a private address is only allowed together with a sign-in mode (`FT_AUTH` set to
`users`, `oidc` or `header`). The default Compose stack supplies that sign-in mode for you.

For yourself alone, on the host's loopback (Linux):

```sh
docker run -d --name forge-table --network host -e FT_BIND=127.0.0.1 -v forge-table:/data ghcr.io/mdbook/forge-table:edge
docker logs forge-table 2>&1 | grep FORGE_TABLE_READY
```

or the same thing with [compose.solo.yaml](../../forge-gui-bridge/docker/compose.solo.yaml):
`docker compose -f compose.solo.yaml up -d`.

For an existing login provider, [compose.oidc.yaml](../../forge-gui-bridge/docker/compose.oidc.yaml) keeps the
oauth2-proxy setup. Use `docker compose -f compose.oidc.yaml up -d` after configuring its provider and secret file,
and put your TLS terminator in front. This was previously `compose.yaml`: existing installations should use this
file to keep their login setup, not switch to the new default by accident. Read [Hosting for a group](hosting.md)
before changing a running server's sign-in mode.

## From source

You need a JDK 17 or newer, Maven 3.9 and git. The first build downloads Node 22 into `forge-gui-web/target/node`
for the web client, so you don't need Node installed.

```sh
mvn -B -DskipTests install -pl forge-gui-bridge -am
```

The build writes `forge-gui-bridge/target/classpath.txt`, so you can start the server straight from the checkout. A
single game against the bundled test decks:

```sh
java -Xmx3g -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -Duser.home=/tmp/table-home \
  -cp forge-gui-bridge/target/classes:$(cat forge-gui-bridge/target/classpath.txt) \
  forge.bridge.Main --assets forge-gui/ --web forge-gui-web/app/dist \
  --decks forge-gui-bridge/src/test/resources/table/decks --open-browser
```

For the router, put `--router --port 8790 --data /tmp/ft-router` right after `forge.bridge.Main` and drop
`--open-browser`. `-Duser.home` keeps Forge's user folder and cache out of your real home; leave it out to share
them with a Forge desktop install.

`forge-gui-bridge/package.sh` turns a build into the release zip described above (`--smoke` also starts it once and
checks it answers). [Building and testing](building.md) has the rest.

## As a systemd service

[`forge-gui-bridge/deploy/`](../../forge-gui-bridge/deploy/) has a reference unit for the router
(`forge-table@.service`, one instance per channel such as `stable` and `dev`), an annotated settings file
(`forge-table.env.example`) and an optional update script with its timer. They assume an unpacked release under
`/opt/forge-table/<channel>/current`, a `forge-table` system user and settings in `/etc/forge-table/<channel>.env`.
Adapt them; nothing in Forge Table depends on those paths. [Hosting for a group](hosting.md#reference-systemd-setup)
explains the moving parts.

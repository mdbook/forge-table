# Install

There are three ways to run Forge Table. All of them end up running the same Java program, `forge.bridge.Main`, in one
of two modes:

- Single game, the default. One game against the AI for the person at the keyboard. The release zip's launcher
  starts this.
- Router, with `--router` as the first argument. A lobby and many games at once, each in its own JVM, for one person
  or a whole group. The Docker image and the reference systemd unit start this.

Every way needs Java 17 or newer. The project builds and tests on 21.

## Release zip

Each release on the [Releases page](https://github.com/mdbook/forge-table/releases) has a
`forge-table-<build>.zip` and its `.sha256`. `<build>` is the first 8 characters of the commit it was built from. The
zip holds one folder:

| Path | What it is |
|---|---|
| `launch.sh`, `launch.cmd` | Start a single game and open the browser. |
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

The launcher only starts single games. For the lobby, start Java yourself from inside the unzipped folder:

```sh
java -Xmx1536m -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -cp "lib/*" forge.bridge.Main --router --port 8790 --data user/router \
  --assets . --web web --decks decks
```

It prints `FORGE_TABLE_READY {"mode":"router",…,"url":"http://127.0.0.1:8790/#t=…"}` within a second. Open that
`url`. `--router` has to be the first argument. Each game inherits the router's `-Xmx`, `-Xss`, `--add-opens` and
`-D` options, so `-Xmx1536m` here caps every game's heap too.

## Docker

The [Dockerfile](../../forge-gui-bridge/docker/Dockerfile) packs a release zip into an image that runs the router,
with its data in the `/data` volume. No image is published, so you build it. You need a checkout of this repository
for the Dockerfile, and a release zip, either downloaded or built with `forge-gui-bridge/package.sh`.

```sh
mkdir -p forge-gui-bridge/target/dist
cp forge-table-<build>.zip forge-gui-bridge/target/dist/
docker build -t forge-table -f forge-gui-bridge/docker/Dockerfile \
  --build-arg ZIP=target/dist/forge-table-<build>.zip forge-gui-bridge
```

Settings are `FT_*` environment variables (`-e FT_MAX_MATCHES=4`), and arguments after the image name are passed to
the server as flags. The image sets `FT_PORT=8790`, `FT_ADMIN_PORT=8799` and `FT_MTGAI_UPLOAD=off`, runs Java with
`-Xmx1536m`, and checks `/healthz` on the loopback admin port as its health check.

The router refuses to listen on `0.0.0.0`, on purpose. When `FT_BIND` is unset the entrypoint uses the container's
own address, which is private, and a private address is only allowed together with a sign-in mode (`FT_AUTH` set to
`users`, `oidc` or `header`). So there are two ways to run the image.

For yourself alone, on the host's loopback (Linux):

```sh
docker run -d --name forge-table --network host -e FT_BIND=127.0.0.1 -v forge-table:/data forge-table
docker logs forge-table 2>&1 | grep FORGE_TABLE_READY
```

or the same thing with [compose.solo.yaml](../../forge-gui-bridge/docker/compose.solo.yaml):
`docker compose -f compose.solo.yaml up -d`.

For a group, start from [compose.yaml](../../forge-gui-bridge/docker/compose.yaml): a complete stack with
oauth2-proxy signing people in. It puts Forge Table on a network shared only with the proxy and publishes no port.
To let Forge Table sign people in itself instead, keep the private network, swap oauth2-proxy for your usual TLS
proxy and set `FT_AUTH=users` or `oidc`. Read [Hosting for a group](hosting.md) before you do either.

To upgrade, build a new image from the new zip and recreate the container. Imported decks, results and the card-art
cache live in the volume.

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

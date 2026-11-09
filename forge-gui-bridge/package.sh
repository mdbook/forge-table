#!/usr/bin/env bash
# Forge Table release zip from this repo alone: the server (forge-gui-bridge and its classpath), the web client, Forge's
# res/ and a starter deck set, no neural AI. One top folder forge-table-<sha8>/ with lib/ res/ web/ decks/ launch.sh
# launch.cmd launch-router.sh launch-router.cmd version.json README.md LICENSE (+ NOTICE): unzip and run launch.sh,
# or install it on a server with deploy/forge-table-deploy.sh (it takes this flat layout).
#
# Usage: forge-gui-bridge/package.sh [--out DIR] [--no-build] [--smoke] [--overlay ZIP]
#   --out DIR    where the zip goes (default target/dist)
#   --no-build   reuse the existing build (mvn install -pl forge-gui-bridge -am, web client included)
#   --smoke      start the unpacked zip headless, wait for FORGE_TABLE_READY, check its user folder is user/forge/ and
#                fetch the web client from it
#   --overlay ZIP  unpack ZIP over the staged folder before zipping (a neural AI plugin: lib/ jars, neural/ model,
#                decks/, licence files). It may add files, never replace one with different bytes.
# The zip and <zip>.sha256 land in --out; version.json in the zip = {forge_commit, forge_sha, built_at}, what the server
# shows as its build. A neural plugin (lib/ jars + a model dir) is an overlay on top of this zip, built elsewhere and
# added with --overlay.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
OUT="$HERE/target/dist"
BUILD=1
SMOKE=0
OVERLAY=
while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT="$2"; shift 2 ;;
        --no-build) BUILD=0; shift ;;
        --smoke) SMOKE=1; shift ;;
        --overlay) OVERLAY="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
MVN="${MVN:-mvn}"
NEED="git tar zip sha256sum"
[ "$SMOKE" = 1 ] || [ -n "$OVERLAY" ] && NEED="$NEED unzip"
[ "$SMOKE" = 1 ] && NEED="$NEED curl"
[ -z "$OVERLAY" ] || [ -f "$OVERLAY" ] || { echo "no overlay zip at $OVERLAY" >&2; exit 2; }
for t in $NEED; do
    command -v "$t" >/dev/null || { echo "package.sh needs $t on PATH" >&2; exit 2; }
done
# the zip is labelled with HEAD's sha: uncommitted changes would ship under a sha that doesn't contain them
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    echo "uncommitted changes in $REPO: commit or stash them first (the zip is labelled with HEAD)" >&2
    exit 2
fi
FORGE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
FORGE_SHA="${FORGE_COMMIT:0:8}"
NAME="forge-table-$FORGE_SHA"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$BUILD" = 1 ]; then
    echo "== building the server + web client @ $FORGE_SHA"
    (cd "$REPO" && "$MVN" -B -q ${MVN_FLAGS:-} -pl forge-gui-bridge -am -DskipTests -Dcheckstyle.skip \
        -Dmaven.javadoc.skip=true install)
fi
one() { [ $# = 1 ] || { echo "expected one jar, found: ${*:-none}" >&2; exit 2; }; echo "$1"; }
BRIDGE_JAR="$(one $(ls "$HERE"/target/forge-gui-bridge-*.jar | grep -v -- '-sources\|-tests'))"
CLASSPATH_TXT="$HERE/target/classpath.txt"
for f in "$CLASSPATH_TXT" "$REPO/forge-gui-web/app/dist/index.html"; do
    [ -e "$f" ] || { echo "missing $f (build first, or drop --no-build)" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/forge-table.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
S="$WORK/$NAME"
mkdir -p "$S/lib" "$S/decks"
echo "== staging $NAME in $WORK"
# lib/: every classpath entry (a reactor module resolves to its target/classes: ship that module's jar instead)
tr ':' '\n' <"$CLASSPATH_TXT" | while read -r e; do
    [ -n "$e" ] || continue
    if [ -d "$e" ]; then
        cp "$(one $(ls "$(dirname "$e")"/*.jar | grep -v -- '-sources\|-tests\|-jar-with-dependencies'))" "$S/lib/"
    else
        cp "$e" "$S/lib/"
    fi
done
cp "$BRIDGE_JAR" "$S/lib/"
cp -r "$REPO/forge-gui-web/app/dist" "$S/web"
# res/ = the tracked forge-gui/res at HEAD; the card scripts go into cardsfolder.zip like a Forge release
git -C "$REPO" archive --format=tar HEAD forge-gui/res | tar -x -C "$WORK"
mv "$WORK/forge-gui/res" "$S/res"
rmdir "$WORK/forge-gui"
(cd "$S/res/cardsfolder" && find . -name '*.txt' -print | LC_ALL=C sort | zip -1qX@ ../cardsfolder.zip)
rm -rf "$S/res/cardsfolder"
mkdir "$S/res/cardsfolder"
mv "$S/res/cardsfolder.zip" "$S/res/cardsfolder/"
cp "$HERE"/src/test/resources/table/decks/*.dck "$S/decks/"
# Forge's user folder and cache in user/ beside the launchers (resolved from the launcher's cwd). A server install
# drops this file: the router gives every game its own home.
printf 'userDir=user/forge/\ncacheDir=user/cache/\n' >"$S/forge.profile.properties"
cp "$HERE/dist/launch.sh" "$S/launch.sh"
chmod +x "$S/launch.sh"
sed 's/$/\r/' "$HERE/dist/launch.cmd" >"$S/launch.cmd"
cp "$HERE/dist/launch-router.sh" "$S/launch-router.sh"
chmod +x "$S/launch-router.sh"
sed 's/$/\r/' "$HERE/dist/launch-router.cmd" >"$S/launch-router.cmd"
cp "$REPO/LICENSE" "$S/LICENSE"
[ -f "$REPO/NOTICE" ] && cp "$REPO/NOTICE" "$S/NOTICE"
cp "$REPO/README.md" "$S/README.md"
printf '{"forge_commit": "%s", "forge_sha": "%s", "built_at": "%s"}\n' "$FORGE_COMMIT" "$FORGE_SHA" "$BUILT_AT" >"$S/version.json"
if [ -n "$OVERLAY" ]; then
    echo "== overlay $(basename "$OVERLAY")"
    unzip -q "$OVERLAY" -d "$WORK/overlay"
    # adds only: a plugin that replaced one of Forge Table's own files (a jar, the launcher) would ship unnoticed; the
    # same bytes again (a deck both ship) are fine
    CLASH="$(cd "$WORK/overlay" && find . ! -type d | while read -r f; do [ ! -e "$S/$f" ] || cmp -s "$f" "$S/$f" || echo "$f"; done)"
    [ -z "$CLASH" ] || { echo "overlay would replace: $CLASH" >&2; exit 2; }
    cp -r "$WORK/overlay/." "$S/"
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ZIP="$OUT/$NAME.zip"
rm -f "$ZIP"
(cd "$WORK" && zip -qrX "$ZIP" "$NAME")
(cd "$OUT" && sha256sum "$NAME.zip" | tee "$NAME.zip.sha256")
echo "== $ZIP  $(stat -c %s "$ZIP") bytes"

if [ "$SMOKE" = 1 ]; then
    T="$WORK/smoke"
    mkdir "$T"
    unzip -q "$ZIP" -d "$T"
    LOG="$OUT/$NAME.smoke.log"
    # no browser, no card-art fetches, Forge's test preferences: never reaches the network
    FORGE_TABLE_NO_BROWSER=1 timeout 300 sh "$T/$NAME/launch.sh" --card-art off --test-prefs </dev/null >"$LOG" 2>&1 &
    PID=$!
    for _ in $(seq 1 290); do
        grep -q '^FORGE_TABLE_READY' "$LOG" && break
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
    done
    READY="$(grep '^FORGE_TABLE_READY' "$LOG" | head -1 || true)"
    PORT="$(echo "$READY" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
    PAGE="$([ -n "$PORT" ] && curl -sSf "http://127.0.0.1:$PORT/" 2>&1 || true)"
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    sed -i -e 's/"token":"[0-9a-f]*"/"token":"-"/' -e 's/#t=[0-9a-f]*/#t=-/' "$LOG"
    [ -n "$READY" ] || { echo "smoke FAILED: no FORGE_TABLE_READY (see $LOG)" >&2; exit 1; }
    grep -qi '<html' <<<"$PAGE" || { echo "smoke FAILED: port $PORT does not serve the web client (see $LOG)" >&2; exit 1; }
    grep -q '^FORGE_TABLE_READY .*"userDir":"[^"]*/user/forge/"' "$LOG" || { echo "smoke FAILED: user folder is not user/forge/ (see $LOG)" >&2; exit 1; }
    if [ -n "$OVERLAY" ] && { [ ! -f "$S/neural/latest.json" ] || grep -q 'Neural opponent unavailable' "$LOG"; }; then
        echo "smoke FAILED: the overlay's Neural opponent is unavailable (see $LOG)" >&2; exit 1
    fi
    echo "smoke ok: $(grep '^FORGE_TABLE_READY' "$LOG" | head -1)"
fi

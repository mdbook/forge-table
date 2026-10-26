#!/bin/sh
# Forge Table multi-game server: install the newest build of a channel and restart it (a reference copy; the deployed one is maintained separately).
#
#   forge-table-deploy.sh <stable|dev> <token-env-file>
#
# Reads the channel's pointer under $FT_API (required; e.g. a GitLab generic-packages URL
# https://gitlab.example.org/api/v4/projects/<id>/packages/generic):
#   stable  forge-table/latest/version.json
#   dev     forge-table/dev/$FT_DEV_BRANCH/version.json
# The pointer is {zip, zip_url, sha256, forge_sha, built_at, ...}. A new sha256 is downloaded with the read-only token
# from <token-env-file> (a line GITLAB_READ_TOKEN=...; it is never printed or put on a command line; empty: anonymous),
# verified (stable: the pointer's version.json.sig against $FT_SIGNING_PUB, then the zip's sha256; dev builds
# are unsigned, the zip's sha256 only),
# unpacked to $FT_ROOT/<channel>/releases/<sha8>/, and made current:
#   stable  waits for an idle server (swap only when no games run): while a game runs or starts it does
#           nothing and the next timer run tries again; once idle it drains (exits at once), switches the symlink
#           and restarts the unit;
#   dev     switches and restarts at once.
# Two releases are kept. Runs from forge-table-deploy@<channel>.timer; overlapping runs skip (flock).
set -eu

CHANNEL=${1:?usage: forge-table-deploy.sh <stable|dev> <token-env-file>}
TOKEN_FILE=${2:?usage: forge-table-deploy.sh <stable|dev> <token-env-file>}
FT_ROOT=${FT_ROOT:-/opt/forge-table}
FT_API=${FT_API:?set FT_API to the base URL the channel pointers live under}
FT_DEV_BRANCH=${FT_DEV_BRANCH:-forge-table}
UNIT="forge-table@$CHANNEL.service"
DIR="$FT_ROOT/$CHANNEL"

case "$FT_DEV_BRANCH" in
  *[!A-Za-z0-9._-]*|'') echo "bad FT_DEV_BRANCH" >&2; exit 2 ;;
esac
case "$CHANNEL" in
  stable) POINTER="$FT_API/forge-table/latest/version.json" ;;
  dev) POINTER="$FT_API/forge-table/dev/$FT_DEV_BRANCH/version.json" ;;
  *) echo "channel must be stable or dev" >&2; exit 2 ;;
esac
# The router's loopback admin port (/healthz, /admin/drain), from the unit's settings.
FT_ADMIN_PORT=$(sed -n 's/^FT_ADMIN_PORT=//p' "/etc/forge-table/$CHANNEL.env")

mkdir -p "$DIR/releases"
exec 9>"$DIR/.deploy.lock"
flock -n 9 || { echo "another deploy of $CHANNEL is running"; exit 0; }

GITLAB_READ_TOKEN=$(sed -n 's/^GITLAB_READ_TOKEN=//p' "$TOKEN_FILE")
# curl reads the header from stdin (-K -), so the token never shows up in ps. No redirects (-L): the token must
# only ever go to $FT_API, which fetch() checks.
fetch() { # url out
  case "$1" in
    "$FT_API"/forge-table/*) ;;
    *) echo "refusing to fetch $1 (not under $FT_API/forge-table/)" >&2; exit 1 ;;
  esac
  if [ -n "$GITLAB_READ_TOKEN" ]; then
    printf 'header = "PRIVATE-TOKEN: %s"\n' "$GITLAB_READ_TOKEN" | curl -sSf --proto =https --retry 2 -K - -o "$2" "$1"
  else
    curl -sSf --proto =https --retry 2 -o "$2" "$1"
  fi
}
# The update signing public key (base64 DER body of the Ed25519 SubjectPublicKeyInfo): stable pointers must carry
# version.json.sig = base64 of the Ed25519 signature over the pointer's exact bytes. Required for stable.
FT_SIGNING_PUB=${FT_SIGNING_PUB:-}
if [ "$CHANNEL" = stable ] && [ -z "$FT_SIGNING_PUB" ]; then
  echo "stable needs FT_SIGNING_PUB (the update signing public key)" >&2; exit 2
fi
verify_pointer() { # pointer sig
  printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$FT_SIGNING_PUB" > "$TMP/signing.pub"
  base64 -d < "$2" > "$TMP/sig.bin" || { echo "bad signature encoding" >&2; exit 1; }
  openssl pkeyutl -verify -pubin -inkey "$TMP/signing.pub" -rawin -in "$1" -sigfile "$TMP/sig.bin" >/dev/null ||
    { echo "$CHANNEL: pointer signature does NOT verify: not installing" >&2; exit 1; }
}
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
# Whether the running server has games running or starting (/healthz counts). A server that is down is idle.
busy() {
  [ "$CHANNEL" = stable ] && systemctl is-active --quiet "$UNIT" || return 1
  curl -sf "http://127.0.0.1:$FT_ADMIN_PORT/healthz" |
    python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h["active"] + h["starting"] > 0 else 1)'
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch "$POINTER" "$TMP/version.json"
SHA=$(field "$TMP/version.json" sha256)
SHA8=$(printf %.8s "$SHA")
# The launcher zip's forge.profile.properties points userDir/cacheDir at ../../user/ (the player-install layout); on the
# server that lands inside the root-owned release and every game dies at boot. Without it each game child uses its own
# user.home (<data>/matches/<id>/home) the router gives it, like the flat builds. Also heals a release installed before.
rm -f "$DIR/current/forge.profile.properties"
if [ "$(cat "$DIR/current/.sha256" 2>/dev/null || true)" = "$SHA" ] && [ -d "$DIR/current/lib" ]; then
  exit 0 # up to date (and a runnable install: a broken one is reinstalled)
fi
# Draining would refuse new games until the last one ends (and end long ones at --drain-timeout): wait for idle.
if busy; then
  echo "$CHANNEL: $SHA8 waits, games are running"
  exit 0
fi

# Checked before anything in the pointer is used (an unsigned stable pointer already installed stays up to date above).
if [ "$CHANNEL" = stable ]; then
  fetch "$POINTER.sig" "$TMP/version.json.sig"
  verify_pointer "$TMP/version.json" "$TMP/version.json.sig"
  # No rollback: an older pointer, however validly signed, is a replay (ISO built_at compares as text).
  OLD=$(cat "$DIR/current/.built_at" 2>/dev/null || true)
  NEW=$(field "$TMP/version.json" built_at)
  if [ -n "$OLD" ] && [ "$NEW" != "$OLD" ] && [ "$(printf '%s\n%s\n' "$OLD" "$NEW" | LC_ALL=C sort | tail -n 1)" = "$OLD" ]; then
    echo "$CHANNEL: pointer built $NEW, older than the installed $OLD: not installing" >&2
    exit 1
  fi
fi
echo "$CHANNEL: installing $(field "$TMP/version.json" zip) (built $(field "$TMP/version.json" built_at))"
fetch "$(field "$TMP/version.json" zip_url)" "$TMP/build.zip"
echo "$SHA  $TMP/build.zip" | sha256sum -c --quiet -
rm -rf "$DIR/releases/$SHA8"
mkdir "$TMP/unpacked"
unzip -q "$TMP/build.zip" -d "$TMP/unpacked"
mv "$TMP/unpacked"/* "$DIR/releases/$SHA8" # the zip holds one top folder
# The server's root: the zip's top folder (flat builds), or, in the self-updating launcher layout (mtg-ai:
# play-table.sh + app/current naming the build folder), app/<that folder>, which holds lib/ res/ web/ version.json.
ROOT="releases/$SHA8"
if [ -f "$DIR/$ROOT/app/current" ]; then
  BUILD=$(tr -d ' \r\n' < "$DIR/$ROOT/app/current")
  case "$BUILD" in
    [A-Za-z0-9]*) ;;
    *) echo "bad app/current '$BUILD' in $SHA8" >&2; exit 1 ;;
  esac
  case "$BUILD" in *[!A-Za-z0-9._-]*) echo "bad app/current '$BUILD' in $SHA8" >&2; exit 1 ;; esac
  ROOT="$ROOT/app/$BUILD"
fi
[ -d "$DIR/$ROOT/lib" ] || { echo "no lib/ in $ROOT" >&2; exit 1; }
rm -f "$DIR/$ROOT/forge.profile.properties" # see above
echo "$SHA" > "$DIR/$ROOT/.sha256"
field "$TMP/version.json" built_at > "$DIR/$ROOT/.built_at"

# A game may have started during the download: wait for the next run then.
if busy; then
  echo "$CHANNEL: $SHA8 unpacked, waits, games are running"
  exit 0
fi
if [ "$CHANNEL" = stable ] && systemctl is-active --quiet "$UNIT"; then
  echo "$CHANNEL: draining (idle: exits at once)"
  curl -sSf -X POST "http://127.0.0.1:$FT_ADMIN_PORT/admin/drain" >/dev/null
  # The router exits once drained. A game started in the instant since busy() still finishes first (at most
  # the router's --drain-timeout, 120 min by default).
  while curl -sf "http://127.0.0.1:$FT_ADMIN_PORT/healthz" >/dev/null; do sleep 15; done
fi

ln -sfn "$ROOT" "$DIR/current.new"
mv -T "$DIR/current.new" "$DIR/current"
systemctl restart "$UNIT"
echo "$CHANNEL: running $SHA8"

# Keep the current release and the newest other one.
ls -1t "$DIR/releases" | grep -vx "$SHA8" | tail -n +2 | while read -r old; do rm -rf "${DIR:?}/releases/$old"; done

#!/usr/bin/env bash
# Run Forge Table from this repo and open it in the browser (until the Electron preview drop lands).
#
#   forge-gui-bridge/forge-table.sh [--humanseat DIR] [sidecar flags…]
#
# Build first: mvn -B -DskipTests install -pl forge-gui-bridge -am
#
# --humanseat DIR  run inside an unzipped mtg-ai human-seat package: its userdata (decks, prefs, game logs), its
#                  res/, and its lib/ (mtg-ai + ONNX Runtime) and neural/ model, so Neural is the default opponent.
#                  Close Classic Forge first: both write the same userdata.
# Without it, Forge Table uses your normal Forge profile and the repo's res/, plus the 12 Pauper test decks.
# Other flags go to forge.bridge.Main (see docs/forge-table/RUNBOOK.md), e.g. --card-art printed, --ai Default.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
[ -f "$HERE/target/classpath.txt" ] || { echo "Build first: mvn -B -DskipTests install -pl forge-gui-bridge -am" >&2; exit 2; }

CP="$HERE/target/classes:$(cat "$HERE/target/classpath.txt")"
ASSETS="$REPO/forge-gui/"
RUN_DIR="$PWD"
ARGS=(--decks "$HERE/src/test/resources/table/decks")
PROPS=()
if [ "${1:-}" = "--humanseat" ]; then
    [ -n "${2:-}" ] && [ -d "$2/neural" ] && [ -d "$2/lib" ] || { echo "--humanseat needs an unzipped human-seat folder (with lib/ and neural/)" >&2; exit 2; }
    DIR="$(cd "$2" && pwd)"
    shift 2
    CP="$CP:$DIR/lib/*"
    ASSETS="$DIR/"
    RUN_DIR="$DIR" # forge.profile.properties, neural/ and userdata/ resolve from here
    ARGS=()        # its userdata already holds the Pauper decks
    PROPS=(-Dmtgai.neural.dir=neural -Dforge.mtgai.aiCastRemAIDeck=true -Dmtgai.neural.log=true
           -Dmtgai.neural.games=userdata/mtgai-games)
fi
# A fresh web build in the repo beats the bundle inside the jar (and is the only one after -Dskip.web).
[ -f "$REPO/forge-gui-web/app/dist/index.html" ] && ARGS+=(--web "$REPO/forge-gui-web/app/dist")

cd "$RUN_DIR"
exec java -Xmx4g -Xss8m \
    --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
    --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
    --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
    "${PROPS[@]}" -cp "$CP" forge.bridge.Main --assets "$ASSETS" --open-browser "${ARGS[@]}" "$@"

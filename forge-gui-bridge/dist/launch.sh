#!/bin/sh
# Forge Table: starts the server on localhost and opens the game in the browser. Your data (Forge's user folder,
# imported decks, card data and art) is in user/ next to this script. FORGE_TABLE_NO_BROWSER=1 skips the browser.
# Other flags go to the server, e.g. --card-art printed, --ai Default (see README.md).
cd "$(dirname "$0")" || exit 1
OPEN=--open-browser
[ -n "${FORGE_TABLE_NO_BROWSER:-}" ] && OPEN=
exec java -Xmx4g -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -Dforge.table.ignoreStdin=true \
  -cp "lib/*" forge.bridge.Main \
  --assets . --web web $OPEN --decks decks "$@"

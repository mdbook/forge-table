#!/bin/sh
# Forge Table's local lobby. Data goes in user/router/ next to this script.
# Open the token URL printed in FORGE_TABLE_READY. Other flags go to the router.
cd "$(dirname "$0")" || exit 1
exec java -Xmx1536m -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -Dforge.table.ignoreStdin=true \
  -cp "lib/*" forge.bridge.Main --router --port 8790 --data user/router \
  --assets . --web web --decks decks "$@"

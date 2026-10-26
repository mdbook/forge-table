#!/bin/sh
# The image's server: router mode, its data in /data. It listens on the container's own address unless FT_BIND says
# otherwise: the router refuses a wildcard (0.0.0.0) on purpose, since only the reverse proxy may reach its port.
if [ -z "${FT_BIND:-}" ]; then
    FT_BIND="$(hostname -i | cut -d' ' -f1)"
    export FT_BIND
fi
exec java -Xmx1536m -Xss8m \
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED \
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED \
  -Dforge.table.ignoreStdin=true \
  -cp "lib/*" forge.bridge.Main --router --data /data --assets . --web web --decks decks "$@"

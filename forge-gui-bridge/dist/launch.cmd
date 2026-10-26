@echo off
rem Forge Table: starts the server on localhost and opens the game in the browser. Your data (Forge's user folder,
rem imported decks, card data and art) is in user\ next to this script. Needs Java 17 or later on the PATH.
cd /d "%~dp0"
java -Xmx4g -Xss8m ^
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED ^
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED ^
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED ^
  -Dforge.table.ignoreStdin=true ^
  -cp "lib/*" forge.bridge.Main ^
  --assets . --web web --open-browser --decks decks %*

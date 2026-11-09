@echo off
rem Forge Table's local lobby. Data goes in user\router\ next to this script.
rem Open the token URL printed in FORGE_TABLE_READY. Needs Java 17 or later on the PATH.
cd /d "%~dp0"
java -Xmx1536m -Xss8m ^
  --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED ^
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED ^
  --add-opens java.desktop/javax.imageio.spi=ALL-UNNAMED ^
  -Dforge.table.ignoreStdin=true ^
  -cp "lib/*" forge.bridge.Main --router --port 8790 --data user/router ^
  --assets . --web web --decks decks %*

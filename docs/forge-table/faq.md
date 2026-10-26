# FAQ and troubleshooting

## Questions

### Is this Forge?

No. Forge is the open-source rules engine and desktop game at [Card-Forge/forge](https://github.com/Card-Forge/forge).
Forge Table is a separate product that runs Forge's engine inside its own server and puts its own web client, lobby
and multi-game server around it. The repository carries the engine because Forge Table builds against it, with a few
changes of its own. The Forge project doesn't endorse or support Forge Table.

### Is it ready to use?

It's alpha. Games work end to end and people play it regularly, but there are bugs, and settings, saved data and
the AI plugin interface can still change between releases without a migration path. Keep a copy of your `user/`
folder before you upgrade. Bug reports and feature requests are welcome.

### Which cards and formats work?

Every card Forge can play, which is nearly all of them. Games can be Constructed (any deck), Standard (the deck is
checked against Forge's Standard list) or Brawl (Forge's Brawl variant, with the deck checked the way Arena's
Competitive Brawl checks it). Every game is two players for now, you against the AI or a friend. Limited, Commander
pods and games with three or more players are planned but not built yet.

### Can I play against a friend?

Yes, in router mode. Start a new game, choose "A friend", and either invite someone who's online or send the link.
Both of you need to be signed in, unless the server allows guests.

### Can I skip the repetitive clicking?

Yes, a few ways. All of them are off until you turn them on, last one game, and show up as lit chips beside
Auto-skip so you can see what's on and click it off again.

- **Always answer a trigger.** A "may" trigger's prompt has "Always answer this trigger this way". The chip that
  appears lists the triggers being answered for you, and you can take any of them back.
- **Auto-resolve mine.** With your own spell or ability on top of the stack, this passes priority on your own stack
  items from now on. They still wait for your opponent, who can respond as usual.
- **Resolve all** (R). Passes until the stack is empty.
- **Record loop.** For a loop you'd shortcut in paper (two Myr Retrievers and a sac outlet, say): click Record
  loop, play the loop through once, then type how many more times to repeat it and click Done. Forge replays
  exactly what you did, picking the same card again or one with the same name if the original moved. Against the
  AI it runs at once. Against a person it's a proposed shortcut, the way paper rules work it: they see how many
  times you want to repeat it and can accept, accept but stop after fewer, or choose Respond, in which case you play
  it out by hand. While an accepted loop runs, their priority passes for them. If the loop stops being possible
  partway (the outlet's gone, you run out of mana), the replay stops after a few seconds of retrying and you get
  your normal prompt back. The repeats already done stay done. Click the Looping chip to stop early.

### Is anything saved?

Imported decks, each user's results against other players and decks, the card-art cache, and games in progress.
A game saves itself whenever a player gets priority with an empty stack outside combat, so a restart, a deploy or
walking away pauses it instead of ending it. The games being played resume by themselves after a restart; the rest
wait in the lobby with a **Resume** button. Resuming goes back to the last save, and a few effects that only last
until end of turn are lost. Games with a guest aren't kept.

### Does it work offline?

Yes, with `--card-art off` (or with the cache already full). Importing a deck from a link needs the network; pasting a
list or loading a `.dck` file doesn't.

### Does it phone home?

Forge Table's own code makes outbound requests in two places: to Scryfall for card art (unless it's off), and to a
deck site when someone imports a deck from a link. With a neural AI plugin and uploads switched on by the operator, the plugin sends games to the URL the
operator configured.

### Where's the "Neural" opponent?

It only appears when a neural AI plugin is installed. The release zip includes Lyra; a build from source doesn't.
See [Neural AI plugin](ai-plugin.md).

### Can I use my Forge desktop decks?

Yes. A single game reads Forge's constructed-deck folder in its user folder, the same one Forge desktop uses, plus
any `--decks` folder. With the release zip that user folder is `user/forge/`, so copy `.dck` files into
`user/forge/decks/constructed/` or point `--decks` at your Forge folder.

## Problems

| Symptom | Cause and fix |
|---|---|
| `FORGE_TABLE_ERROR … already using this user folder` | Another Forge Table sidecar holds the lock on that user folder. Stop it, or give this one another `-Duser.home`. |
| `FORGE_TABLE_ERROR {"reason":"Refusing to listen on …"}` | A wildcard `--bind`, a non-loopback one without sign-in (`FT_AUTH` `header`, `users` or `oidc`), or a public address. In Docker without a proxy, run with `--network host -e FT_BIND=127.0.0.1`. |
| `--require-group and --admin-group need --groups-header` | Set `FT_GROUPS_HEADER` to the header your proxy sends groups in. |
| `--guests needs --real-ip-header` | Set `FT_REAL_IP_HEADER` and make your proxy set that header. |
| Every request behind the proxy gets `401` | The proxy isn't setting the header named in `FT_TRUST_PROXY_HEADER`, or sets it under another name. |
| `400` on every request | The user header (or, with group settings, the groups header) arrives twice or empty. Check that the proxy replaces it instead of adding a second copy, and that groups come in one header. |
| The lobby loads but games never connect, or the server answers `403 Forbidden origin` | The browser's `Origin` doesn't match `Host` or `X-Forwarded-Host`. Keep the original `Host` at the proxy, or set `X-Forwarded-Host`. Also check that WebSocket upgrades reach `/m/<id>/ws`. |
| Random `502`s on writes behind the proxy | The proxy reuses idle connections longer than the router's 150 s. Lower its upstream keep-alive. |
| Blank page | The server was built with `-Dskip.web` and started without `--web`, so it has no client to serve. |
| WebSocket closes with code 4001 | The token in the page doesn't match. Reload using the link from the `FORGE_TABLE_READY` line. |
| A game in the lobby says `crashed` | The game's process exited. The lobby shows a short reason; the details are in the router's log and in `<data>/matches/<id>/child.log` (or `<data>/ended/<id>/child.log` once it's gone). Out of memory is the usual cause: lower `FT_MAX_MATCHES` or give the host more RAM. |
| "The server is full (N games running)" | The total cap is reached. Raise `FT_MAX_MATCHES` if the host has the RAM, or end some games. |
| Cards have no pictures | Card art is `off`, Scryfall can't be reached, or the first-run index is still building (about 80 MB to stream). The table works meanwhile. |
| Neural shows as unavailable | The plugin class is there but its model folder or `latest.json` isn't, or ONNX Runtime is missing. The reason is shown next to it and in the log. |
| The first game takes a long time to start | Normal. A cold JVM loads Forge's card database in 20 to 45 seconds. |

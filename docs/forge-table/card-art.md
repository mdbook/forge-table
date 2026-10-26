# Card art

No card images ship with Forge Table. By default the server fetches them from [Scryfall](https://scryfall.com) the
first time a card is shown and keeps them in a local cache. Without art the table still works, and every card is drawn
from its rules data, with a coloured frame, its name, cost, type, text and a symbol where the picture would be (that's
what the [screenshots](../images/game.png) show).

## Modes

`--card-art` (or `FT_CARD_ART` for the router) picks one of three:

| Mode | What you get |
|---|---|
| `curated` (default) | For each card name, its cleanest regular printing. It prefers the 2015 frame and the newest among equally clean printings, and skips previews, placeholders, textless, playtest and acorn cards. Every copy of a card looks the same whatever printing the deck names. |
| `printed` | The exact printing the deck file names. Forge's own picture cache is tried first (so a Forge desktop install's downloads are reused), then Scryfall by set and collector number. |
| `off` | No images and no requests to Scryfall. The client draws its own faces. |

`curated` falls back to the printed picture for names its index lacks, and tokens always use their printing.

Each player also picks how cards look in their own browser, on the game's start screen. Framed, the default, is Forge
Table's own frame with Scryfall's art crop in the art box and the artist credited. Scryfall shows the full card scans
and Procedural the plain drawn faces. That choice is kept in the browser and changes nothing on the server.

## What happens on first run

In `curated` mode the server needs an index of card names to images. On first start it streams Scryfall's
`default_cards` bulk file (about 80 MB compressed, not stored) and writes:

- `card_images.v2.json`: card name to image URL, about 36,000 names, about 4 MB.
- `card_artists.v2.json`: card name to artist, for the credit under an art crop.

It rebuilds them in the background after 30 days, keeping the old ones in use meanwhile. When the picking rules
change, the `v2` in the name changes and the index is rebuilt once. In router mode the games share one cache and one
build: a lock file stops several games from each downloading the bulk file, and a failed build holds everyone off for
30 minutes.

Images are then fetched one card at a time from Scryfall (`cards.scryfall.io`, or Scryfall's API for a printing
looked up by set and number), through Forge's Scryfall rate limiter, and stored with Scryfall's own path so every copy of a card
shares one file. While a download runs the request waits up to 15 seconds, then answers `202` with `Retry-After` and
the browser asks again. `204` means there's no art for that card.

## Where the cache lives

The art cache is the `table/` folder in Forge's cache directory:

| How you run it | Cache folder |
|---|---|
| Release zip | `user/cache/table/` next to the launcher |
| Router | `<data>/cache/table/`, shared by all games |
| Docker image | `/data/cache/table/` in the volume |
| From source, single game | Forge's cache folder plus `table/`: `~/.cache/forge/table/` on Linux, `~/Library/Caches/Forge/table/` on macOS, `%LOCALAPPDATA%\Forge\Cache\table\` on Windows. On Linux and macOS `-Duser.home` moves it. |

Inside it, `art/` holds the card images (about 100 KB each) and `art/art_crop/` the crops. Deleting the folder is safe;
it refills.

## Turning it off

Start with `--card-art off` (single game, or a router flag passed on to every game), or set `FT_CARD_ART=off` for the
router or the Docker image. The server then never contacts Scryfall for art. `--test-prefs` turns art off as well.

Importing a deck from a link (Moxfield, Archidekt, TappedOut, MTGGoldfish) still fetches that page from the server.
Pasted deck lists and `.dck` files never touch the network.

## Bring your own image map

`--card-image-map FILE` (`FT_CARD_IMAGE_MAP`) uses your own `card name → image URL` JSON object instead of building
one, and never rebuilds it. It's meant for a map in the same shape as `card_images.v2.json`, which means Scryfall
`normal` image URLs, because the art crop is found by swapping `/normal/` for `/art_crop/` in the URL. A custom map has no
artists, so its crops carry no credit.

## Scryfall's terms

Scryfall asks API users to cache what they download, to keep requests modest and to credit artists. Forge Table
caches everything, rate-limits requests and shows the artist under every art crop. If you run a public server,
read [Scryfall's API terms](https://scryfall.com/docs/api) yourself.

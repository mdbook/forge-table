# Neural AI plugin

Forge Table can seat an opponent that isn't one of Forge's rule-based AI profiles. It's meant for a neural network
policy, loaded from a separate jar at runtime. This page describes that hook. Without a plugin, the "Neural" opponent
isn't offered and everything else works the same.

## Lyra

The release zip comes with one: Lyra, a neural network trained in Forge, mostly by playing herself, to play Pauper. Her plugin is
[lyra-forge-plugin](https://github.com/mdbook/lyra-forge-plugin) (GPL-3.0, like Forge Table); her weights are
licensed under the GNU Affero General Public License version 3 and come with their own notice. A build from source
doesn't include her; get the plugin jars and her model folder from that repository's releases and install them as
below.

## What's built in

Forge Table's opponents are Forge's AI profiles from `res/ai/`: `Default` (shown as "Forge AI"), `Cautious`,
`Reckless` and `Experimental`. A fifth profile, `Neural` (`res/ai/Neural.ai`), is a placeholder. Choosing it asks for
a plugin class by name. If the class is missing, the start screen and the lobby leave Neural out. If the class is
there but the model folder isn't, Neural shows as unavailable with the reason. If it fails to start, the game tells the player and uses the Default AI.

## What a plugin is

Three things, all found at runtime:

| Piece | How Forge Table finds it |
|---|---|
| A player class | A subclass of Forge's `forge.ai.LobbyPlayerAi` with a public `(String name, Set<AIOption> options)` constructor. Its name comes from `-Dforge.mtgai.neuralPlayer`, default `mtgai.humanseat.LobbyPlayerNeural`. It must be on the classpath. |
| ONNX Runtime | The class `ai.onnxruntime.OrtEnvironment` must be on the classpath too. The availability check looks for it, so a plugin that runs its model some other way still has to ship it. |
| A model folder | `-Dmtgai.neural.dir`, default `neural`, relative to the working directory. It must contain `latest.json`. |

`latest.json` is the plugin's own file. Forge Table reads three optional fields from it:

| Field | Used for |
|---|---|
| `decks` | Deck names (`.dck` base names) the model plays best, strongest first. The start screen lists them first for this opponent and preselects the first one it has. |
| `version` | Shown as the model's version. |
| `released_at` | Shown as the model's release date. |

The plugin's player takes over the decisions it wants. Forge's Default profile makes the rest.

## Installing one

With a release zip or the Docker image, the server's classpath is `lib/*` and its working directory is the release
folder.

1. Copy the plugin's jars, ONNX Runtime included, into `lib/`.
2. Put its model folder next to `lib/` as `neural/`, or point `-Dmtgai.neural.dir` at it.
3. If its player class isn't `mtgai.humanseat.LobbyPlayerNeural`, add `-Dforge.mtgai.neuralPlayer=<class>` to the
   `java` command line.
4. Restart. The single-game start screen now offers Neural and picks it by default; in the lobby it's the
   recommended opponent for Constructed.

For Docker, build a small image on top of yours that copies the jars into `/opt/forge-table/lib/` and the model into
`/opt/forge-table/neural/`. System properties can go in `JAVA_TOOL_OPTIONS`, which every JVM reads, games included.

`FT_NEURAL_LABEL` (or `-Dforge.table.neuralLabel`) sets the name the UI shows for this opponent. Without it the UI
uses `name` from the model's `latest.json` (Lyra's says "Lyra"), and failing that "Neural".

`FT_NEURAL_AVATAR` (or `-Dforge.table.neuralAvatar`) names a picture of this opponent: a PNG, WebP or JPEG of at most
1 MB. Without it, an `avatar.png` or `avatar.webp` in the model folder is used, and failing that the art of the card
that `FT_NEURAL_AVATAR_CARD` (or `-Dforge.table.neuralAvatarCard`) or `avatar_card` in `latest.json` names (`"Lyra Dawnbringer|DOM"`, or just a card name), fetched like any other card
art and so only when card art is on. The table shows it in the opponent's
disc, and the lobby in New game, game cards and Admin. With no usable picture, the UI shows the opponent's initial.

## Sending games back to the plugin's author

A plugin can learn from games played against it. In router mode the operator decides whether that's allowed, with
[`--mtgai-upload` and `--mtgai-upload-url`](configuration.md#neural-ai-plugin-uploads):

- `off` (the default) never sends anything, and the lobby has no switch for it.
- `optin` shows a "Send my games to train the AI" switch in the lobby, off until a player turns it on.
- `on` shows the same switch, on until a player turns it off.

An empty URL also means never. With no plugin installed the router ignores both settings and logs why.

Forge Table itself sends nothing. For a player who has the switch on, the router hands that player's game three
system properties: `mtgai.neural.upload` (the URL), `mtgai.neural.games` (`<data>/neural-games`, where the plugin
queues files) and `mtgai.neural.consent` (a per-game folder, made only when the player consents). Games of players
who haven't consented, and every two-player game, get an empty `mtgai.neural.games` and nothing else. When a player turns the switch off, their consent folders are withdrawn so queued files of theirs aren't sent.

What a game's upload contains is up to the plugin. The lobby's switch describes it as the player's own decisions,
the AI's side and the result, with no names or other personal data; if your plugin sends something else, change that
text before you turn uploads on.

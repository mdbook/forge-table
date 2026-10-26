package forge.ai;

import forge.game.Game;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/**
 * LobbyPlayerAi variant that attaches a PlayerControllerRandom instead of a
 * PlayerControllerAi. Extends LobbyPlayerAi so AiProfileUtil still finds an
 * AI profile for the inherited (delegated) AI decisions.
 */
public class LobbyPlayerRandom extends LobbyPlayerAi {

    private PlayerControllerRandom lastController;

    public LobbyPlayerRandom(String name) {
        super(name, null);
        setAiProfile("Default");
    }

    private PlayerControllerRandom createRandomControllerFor(Player p) {
        PlayerControllerRandom result = new PlayerControllerRandom(p.getGame(), p, this);
        lastController = result;
        return result;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return createRandomControllerFor(slave);
    }

    @Override
    public Player createIngamePlayer(Game game, final int id) {
        Player p = new Player(getName(), game, id);
        p.setFirstController(createRandomControllerFor(p));
        return p;
    }

    /** The controller created for the most recent game, for per-game stats. */
    public PlayerControllerRandom getLastController() {
        return lastController;
    }
}

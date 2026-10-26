package forge.game.event;

import java.util.List;

import com.google.common.collect.Lists;

import forge.game.card.CardCollectionView;
import forge.game.card.CardView;
import forge.game.player.Player;
import forge.game.player.PlayerView;

/**
 * Fired when {@link forge.game.GameAction#reveal} or {@link forge.game.GameAction#revealTo} shows cards to
 * one or more players (the recipients). A viewer who owns one of these cards can use this to
 * mark it as known-to-an-opponent, the inverse of the existing viewer-side reveal tracking.
 */
public record GameEventCardRevealed(List<CardView> cards, List<PlayerView> to) implements GameEvent {

    public GameEventCardRevealed(CardCollectionView cards, List<Player> to) {
        this(Lists.transform(Lists.newArrayList(cards), CardView::get), Lists.transform(to, PlayerView::get));
    }

    @Override
    public <T> T visit(IGameEventVisitor<T> visitor) {
        return visitor.visit(this);
    }

    @Override
    public String toString() {
        return cards.size() + " card(s) revealed to " + to;
    }
}

package forge.bridge.match;

import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputAttack;
import forge.gamemodes.match.input.InputBlock;
import forge.gamemodes.match.input.InputChooseStartingHand;
import forge.gamemodes.match.input.InputConfirm;
import forge.gamemodes.match.input.InputConfirmMulligan;
import forge.gamemodes.match.input.InputLockUI;
import forge.gamemodes.match.input.InputLondonMulligan;
import forge.gamemodes.match.input.InputPassPriority;
import forge.gamemodes.match.input.InputPayMana;
import forge.gamemodes.match.input.InputSelectCardsForConvokeOrImprovise;
import forge.gamemodes.match.input.InputSelectManyBase;
import forge.gamemodes.match.input.InputSelectTargets;

/**
 * Classifies the Input actually being shown into a prompt kind. Kinds the client does not know
 * render as {@code generic}: a prompt bar with the engine's message, buttons and selectables, which can
 * answer any Input.
 */
public final class InputDescriber {
    private InputDescriber() { }

    public static String kind(final Input in) {
        if (in == null || in instanceof InputLockUI) {
            return "waiting";
        }
        if (in instanceof InputPassPriority) {
            return "priority";
        }
        if (in instanceof InputConfirmMulligan) {
            return "mulligan";
        }
        if (in instanceof InputLondonMulligan) {
            return "mulliganTuck";
        }
        if (in instanceof InputConfirm) {
            return "confirm";
        }
        if (in instanceof InputAttack) {
            return "declareAttackers";
        }
        if (in instanceof InputBlock) {
            return "declareBlockers";
        }
        if (in instanceof InputSelectTargets) {
            return "chooseTargets";
        }
        if (in instanceof InputPayMana) {
            return "payMana";
        }
        if (in instanceof InputSelectCardsForConvokeOrImprovise) {
            return "convoke";
        }
        if (in instanceof InputSelectManyBase) {
            return "selectEntities";
        }
        if (in instanceof InputChooseStartingHand) {
            return "startingHand";
        }
        return "generic";
    }
}

/**
 * The primary-button state machine, as a pure function of the prompt on screen, the engine's
 * own button labels, and the state at the playhead.
 *
 * Labels such as "To Combat", "To Blockers" and "End Turn" are cosmetic: the action is ALWAYS the engine's
 * OK or Cancel for the prompt's pid (or, for the explicit extras, alphaStrike / undo). Unknown engine labels
 * pass through unchanged.
 */
import type { ButtonState, Card, CardId, Game, Phase, PlayerId, PromptBody, PromptKind } from '@forge-table/protocol';
import { PHASE_LABEL, PHASE_ORDER, canAttack } from '../store/model';
import type { MullInfo } from './mulligan';

export type ButtonAction = 'ok' | 'cancel' | 'alphaStrike' | 'undo';

export interface ButtonSpec {
  label: string;
  subtitle?: string;
  enabled: boolean;
  action: ButtonAction | null;
  /** Show a spinner (waiting on the opponent / engine). */
  busy?: boolean;
}

export interface Buttons {
  primary: ButtonSpec;
  secondary: ButtonSpec | null;
  /** The End Turn chip above primary (priority on my turn): the engine's cancel ("pass until end of turn"). */
  endTurn: ButtonSpec | null;
  /** Undo, when the engine says the last action can be undone. */
  undo: ButtonSpec | null;
}

export interface EngineLabels {
  ok: ButtonState;
  cancel: ButtonState;
  canUndo?: boolean;
  selectable?: CardId[];
}

export interface LabelState {
  game: Game;
  viewer: PlayerId;
  cards: Record<CardId, Card>;
  /** My battlefield, for "can anything attack?". */
  myBattlefield: CardId[];
  /** My phase stops (for "Next → <stop>"). */
  myStops: Phase[];
  /** A mulligan prompt's counts: "Keep 6", "Mulligan to 5", "Bottom 1, keep 6". */
  mull?: MullInfo | null;
}

const none = (label: string, busy = false): ButtonSpec => ({ label, enabled: false, action: null, busy });
const ok = (label: string, enabled = true, subtitle?: string): ButtonSpec => {
  const b: ButtonSpec = { label, enabled, action: 'ok' };
  if (subtitle) b.subtitle = subtitle;
  return b;
};
const cancel = (label: string, enabled = true): ButtonSpec => ({ label, enabled, action: 'cancel' });

/** Engine label, or a fallback when the engine sent none. */
const lbl = (b: ButtonState | undefined, fallback: string) => (b && b.label ? b.label : fallback);

const COMBAT_STEPS: Phase[] = [
  'COMBAT_BEGIN',
  'COMBAT_DECLARE_ATTACKERS',
  'COMBAT_DECLARE_BLOCKERS',
  'COMBAT_FIRST_STRIKE_DAMAGE',
  'COMBAT_DAMAGE',
  'COMBAT_END',
];

/**
 * Where passing priority goes next on my turn: my next stop after `phase`, if any. Combat steps are
 * skipped when nothing can attack (the engine skips combat without attackers).
 */
export function nextStop(phase: Phase | undefined, stops: Phase[], skipCombat = false): Phase | null {
  if (!phase) return null;
  const i = PHASE_ORDER.indexOf(phase);
  for (let j = i + 1; j < PHASE_ORDER.length; j++) {
    const p = PHASE_ORDER[j]!;
    if (p === 'CLEANUP') break;
    if (skipCombat && COMBAT_STEPS.includes(p)) continue;
    if (stops.includes(p)) return p;
  }
  return null;
}

/** The name of what is on top of the stack: its spell, or "<source> ability" (an activated or triggered one). */
export function stackTopName(g: Game, cards: Record<CardId, Card>): string | undefined {
  const top = g.stack?.[0];
  if (!top) return undefined;
  const src = top.source ? cards[top.source] : undefined;
  const name = src?.state?.name;
  if (!name) return top.ability ? 'Ability' : undefined;
  return top.ability || src.zone !== 'Stack' ? `${name} ability` : name;
}

function priorityButtons(engine: EngineLabels, s: LabelState): Buttons {
  const g = s.game;
  const myTurn = g.playerTurn === s.viewer;
  const stackEmpty = (g.stack ?? []).length === 0;
  const phase = g.phase;
  // Engine cancel during priority is "End Turn" (or "Undo (n)" right after a cancellable action).
  const engineCancelIsUndo = /^undo\b/i.test(engine.cancel.label);
  // One Undo, not two: when the engine's own Cancel already is "Undo (n)", no extra chip.
  const undo: ButtonSpec | null = engine.canUndo && !(engineCancelIsUndo && engine.cancel.enabled) ? { label: 'Undo', enabled: true, action: 'undo' } : null;
  const secondary = engineCancelIsUndo && engine.cancel.enabled ? cancel(engine.cancel.label) : null;
  const endTurn = myTurn && !engineCancelIsUndo && engine.cancel.enabled ? cancel('End Turn') : null;

  let primary: ButtonSpec;
  if (!stackEmpty) {
    // What resolves: the top item's card, or "<source> ability".
    primary = ok('Resolve', engine.ok.enabled, stackTopName(g, s.cards));
  } else if (!myTurn) {
    const attackers = (g.combat ?? []).length > 0;
    primary = phase === 'COMBAT_DECLARE_ATTACKERS' && attackers ? ok('To Blockers', engine.ok.enabled) : ok('Pass', engine.ok.enabled);
  } else if (phase === 'MAIN1') {
    const canSwing = s.myBattlefield.some((id) => canAttack(s.cards[id]));
    if (canSwing) primary = ok('To Combat', engine.ok.enabled);
    else {
      const next = nextStop(phase, s.myStops, true);
      primary = next && next !== 'END_OF_TURN' ? ok('Next', engine.ok.enabled, `→ ${PHASE_LABEL[next]}`) : ok('End Turn', engine.ok.enabled);
    }
  } else if (phase === 'COMBAT_DECLARE_ATTACKERS') {
    primary = ok('To Blockers', engine.ok.enabled, '→ opponent blocks');
  } else if (phase && COMBAT_STEPS.includes(phase)) {
    const damageNext = phase === 'COMBAT_BEGIN' || phase === 'COMBAT_DECLARE_BLOCKERS' || phase === 'COMBAT_FIRST_STRIKE_DAMAGE';
    primary = ok('Next', engine.ok.enabled, damageNext ? '→ Damage' : '→ Main 2');
  } else if (phase === 'UPKEEP' || phase === 'DRAW') {
    primary = ok('Next', engine.ok.enabled, '→ Main 1');
  } else {
    // MAIN2, END_OF_TURN, CLEANUP (and anything unknown on my turn).
    primary = ok('End Turn', engine.ok.enabled);
  }
  return { primary, secondary, endTurn, undo };
}

/**
 * The buttons for a prompt. `kind` null means no prompt is on screen (or it has not been reached by the
 * playhead yet).
 */
export function primaryLabel(kind: PromptKind | null, engine: EngineLabels | null, s: LabelState): Buttons {
  const myTurn = s.game.playerTurn === s.viewer;
  if (!kind || kind === 'waiting' || !engine) {
    return { primary: none(myTurn ? 'Waiting…' : "Opponent's Turn", true), secondary: null, endTurn: null, undo: null };
  }
  const sec = engine.cancel.enabled ? cancel(lbl(engine.cancel, 'Cancel')) : null;
  switch (kind) {
    case 'priority':
      return priorityButtons(engine, s);
    case 'mulligan': {
      // The outcome on the button: Keep 7 / Mulligan to 6, not the bare engine words.
      const m = s.mull?.kind === 'keep' ? s.mull : null;
      return {
        primary: ok(m ? `Keep ${m.keep}` : lbl(engine.ok, 'Keep'), engine.ok.enabled),
        secondary: sec && m ? { ...sec, label: `Mulligan to ${m.next}` } : sec,
        endTurn: null,
        undo: null,
      };
    }
    case 'mulliganTuck': {
      const t = s.mull?.tuck;
      return {
        primary: engine.ok.enabled ? ok(t ? `Bottom ${t.n}, keep ${s.mull!.keep}` : lbl(engine.ok, 'Done')) : none(t ? `Choose ${t.n - t.chosen} more` : 'Choose cards'),
        secondary: sec,
        endTurn: null,
        undo: null,
      };
    }
    case 'confirm':
      return { primary: ok(lbl(engine.ok, 'Yes'), engine.ok.enabled), secondary: sec, endTurn: null, undo: null };
    case 'declareAttackers': {
      const declared = (s.game.combat ?? []).filter((c) => s.cards[c.attacker]?.controller === s.viewer).length;
      // MTGA: with nothing declared the big button is Attack All, No Attacks the small one.
      if (declared === 0 && engine.cancel.enabled) {
        return {
          primary: { label: 'Attack All', enabled: true, action: 'alphaStrike' },
          secondary: ok('No Attacks', engine.ok.enabled),
          endTurn: null,
          undo: null,
        };
      }
      const primary = ok(declared > 0 ? `Attack ×${declared}` : 'No Attacks', engine.ok.enabled);
      const secondary: ButtonSpec | null =
        engine.cancel.enabled && /call back/i.test(engine.cancel.label) ? cancel('Clear') : null;
      return { primary, secondary, endTurn: null, undo: null };
    }
    case 'declareBlockers': {
      // While blocks are being declared the engine lists them as *planned*; `blockers` fills in once locked.
      const blockerIds = new Set<string>();
      for (const c of s.game.combat ?? []) for (const id of [...(c.blockers ?? []), ...(c.planned ?? [])]) blockerIds.add(id);
      const blocks = blockerIds.size;
      return {
        primary: ok(blocks > 0 ? `Block ×${blocks}` : 'No Blocks', engine.ok.enabled),
        secondary: blocks > 0 && engine.cancel.enabled ? cancel('Clear') : null,
        endTurn: null,
        undo: null,
      };
    }
    case 'chooseTargets':
      return {
        primary: engine.ok.enabled ? ok('Done') : none('Choose a target'),
        secondary: engine.cancel.enabled ? cancel('Cancel') : null,
        endTurn: null,
        undo: null,
      };
    case 'payMana':
      return {
        primary: engine.ok.enabled ? ok('Auto Pay') : none('Pay mana'),
        secondary: engine.cancel.enabled ? cancel('Cancel') : null,
        endTurn: null,
        undo: null,
      };
    case 'startingHand': {
      const n = s.mull?.kind === 'start' ? s.mull.keep : 0;
      return {
        primary: engine.ok.enabled ? ok(n > 0 ? `Begin with ${n} in play` : 'Begin the game') : none(lbl(engine.ok, 'Choose')),
        secondary: sec,
        endTurn: null,
        undo: null,
      };
    }
    case 'selectEntities':
    case 'convoke':
      return {
        primary: engine.ok.enabled ? ok(lbl(engine.ok, 'Done')) : none(lbl(engine.ok, 'Choose')),
        secondary: sec,
        endTurn: null,
        undo: null,
      };
    default:
      // generic (and any kind this client doesn't know): the engine's own buttons.
      return {
        primary: engine.ok.label ? ok(engine.ok.label, engine.ok.enabled) : none(engine.ok.enabled ? 'OK' : '—'),
        secondary: sec,
        endTurn: null,
        undo: null,
      };
  }
}

/**
 * The prompt bar's text for blocker-first blocking (arrows/interaction.ts), replacing Forge's attacker-first
 * "Select creatures to block X or select another attacker…". Null when the prompt isn't blocker-first (an older
 * server without `blockable`, or another prompt): the engine's message stands.
 */
export function blockPromptText(prompt: Pick<PromptBody, 'kind' | 'blockable'> | null, cards: Record<CardId, Card>, picked: CardId | null, blocks = 0): string | null {
  if (prompt?.kind !== 'declareBlockers' || !prompt.blockable) return null;
  const name = (id: CardId) => cards[id]?.state?.name ?? 'that creature';
  if (picked) {
    const legal = prompt.blockable[picked] ?? [];
    return legal.length > 0 ? `Now pick an attacker for ${name(picked)}` : `${name(picked)} can't block any of the attackers`;
  }
  const any = Object.values(prompt.blockable).some((a) => a.length > 0);
  if (!any) return blocks > 0 ? 'No other creature can block · click a blocker to pull it back' : 'None of your creatures can block';
  return blocks > 0 ? 'Pick a creature, then the attacker it blocks · click a blocker to pull it back' : 'Pick a creature, then the attacker it blocks';
}

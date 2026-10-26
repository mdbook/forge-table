/**
 * The phase strip (MTGA-style): the turn's five parts as icons on the centre line's left end (hud/phaseGroups.ts:
 * Beginning · Main 1 · Combat · Main 2 · End). The part the turn is in opens into its steps, the current one lit in the
 * colour of whose turn it is; hovering or focusing a part opens it too, to set a step's stop. A pip above each icon is
 * the opponent's stop, one below it mine; clicking a pip toggles that stop (`act{phaseStop}`), and a closed part's pips
 * set or clear all of its steps. Beside it (landscape) or under it (portrait) hang the auto-pass chips: Auto-skip and
 * Pass turn. Front rows start right of it (geometry.ts PHASE_STRIP), so attackers never step under it.
 */
import type { Phase, PlayerId } from '@forge-table/protocol';
import { useState } from 'react';
import { runtime } from '../runtime';
import { PHASE_LABEL, opponentOf } from '../store/model';
import { useUi } from '../store/uiStore';
import { PHASE_GROUPS, type PhaseGroup, type PhaseGroupKey, groupOf, groupStop, groupToggles, isExpanded } from './phaseGroups';
import { GroupIcon, StepIcon } from './phaseIcons';
import { at, useGeo } from './pos';
import { answerLabel } from './autoResponses';
import { LoopControls } from './LoopControls';

export function PhaseLadder() {
  const viewer = useUi((s) => s.viewer);
  const shown = useUi((s) => s.shown);
  const stops = useUi((s) => s.stops);
  const { X, ROW_Y } = useGeo();
  const [open, setOpen] = useState<PhaseGroupKey | null>(null);
  const opp = opponentOf(shown, viewer);
  const { phase, playerTurn } = shown.game;
  const current = groupOf(phase);
  const opened = new Set(open ? [open] : []);
  const who = (mine: boolean) => (mine ? 'Your' : "Opponent's");

  const pip = (player: PlayerId | undefined, mine: boolean, p: Phase) => {
    const on = !!player && (stops[player] ?? []).includes(p);
    return (
      <button
        className={`rung ${mine ? 'mine' : 'opp'}${on ? ' stop' : ''}`}
        title={`${who(mine)} stop: ${PHASE_LABEL[p]}`}
        aria-label={`${mine ? 'My' : "Opponent's"} ${PHASE_LABEL[p]} stop`}
        aria-pressed={on}
        disabled={!player}
        onClick={() => player && runtime().togglePhaseStop(player, p)}
      />
    );
  };
  const groupPip = (player: PlayerId | undefined, mine: boolean, g: PhaseGroup) => {
    const state = player ? groupStop(g, stops[player] ?? []) : 'off';
    return (
      <button
        className={`rung ${mine ? 'mine' : 'opp'}${state === 'on' ? ' stop' : state === 'some' ? ' some' : ''}`}
        title={`${who(mine)} stops: ${g.label}`}
        aria-label={`${mine ? 'My' : "Opponent's"} ${g.label} stops`}
        aria-pressed={state === 'on' ? true : state === 'some' ? 'mixed' : false}
        disabled={!player}
        onClick={() => player && groupToggles(g, stops[player] ?? []).forEach((p) => runtime().togglePhaseStop(player, p))}
      />
    );
  };
  const step = (p: Phase, icon = <StepIcon phase={p} />) => {
    const cur = phase === p ? (playerTurn === viewer ? ' current mine' : ' current opp') : '';
    return (
      <div key={p} className="cell" data-phase={p}>
        {pip(opp, false, p)}
        <span className={`rung-label${cur}`} title={PHASE_LABEL[p]} role="img" aria-label={PHASE_LABEL[p]}>
          {icon}
        </span>
        {pip(viewer, true, p)}
      </div>
    );
  };

  return (
    <div className="ladder-wrap" style={at(X.ladderX, ROW_Y.centre)} data-testid="ladder-wrap">
      <div className="ladder" data-testid="phase-ladder" onMouseLeave={() => setOpen(null)}>
        {PHASE_GROUPS.map((g) => {
          if (g.steps.length === 1) {
            return (
              <div key={g.key} className="pg single" data-phase-group={g.key} onMouseEnter={() => setOpen(null)}>
                {step(g.steps[0]!, <GroupIcon group={g.key} />)}
              </div>
            );
          }
          const expanded = isExpanded(g, current, opened);
          return (
            <div
              key={g.key}
              className={`pg${expanded ? ' expanded' : ''}${g.key === current ? ' now' : ''}`}
              data-phase-group={g.key}
              data-expanded={expanded}
              onMouseEnter={() => setOpen(g.key)}
              onFocus={() => setOpen(g.key)}
            >
              <div className="cell pg-head" inert={expanded}>
                {groupPip(opp, false, g)}
                <button className="rung-label group" title={g.label} aria-label={`${g.label}: show its steps`} onClick={() => setOpen(g.key)}>
                  <GroupIcon group={g.key} />
                </button>
                {groupPip(viewer, true, g)}
              </div>
              <div className="pg-steps" inert={!expanded}>
                {g.steps.map((p) => step(p))}
              </div>
            </div>
          );
        })}
      </div>
      <AutoPassChips />
    </div>
  );
}

/**
 * Auto-skip: Forge passes for me whenever I could only tap for mana (on by default, saved). Pass turn: pass
 * priority until end of turn; it lights up while active, and Forge ends it at cleanup or when the opponent
 * casts something or attacks me. Keys: S and E (or Shift+Space). Only while they're on (autoResponses.ts):
 * Auto-resolve, and the optional triggers answered for me, each of which can be taken back. Last, Record loop
 * (LoopControls.tsx).
 */
export function AutoPassChips() {
  const { autoSkip, untilEndOfTurn, autoResolve, answers = [] } = useUi((s) => s.autoPass);
  const gameOver = useUi((s) => !!s.gameOver);
  const [showAnswers, setShowAnswers] = useState(false);
  return (
    <div className="autopass" data-testid="autopass">
      <button
        className={`btn chip autopass-chip${autoSkip ? ' on' : ''}`}
        aria-pressed={autoSkip}
        data-testid="auto-skip"
        title="Auto-skip: pass automatically when you can do nothing but tap for mana (S)"
        onClick={(e) => {
          e.currentTarget.blur();
          runtime().toggleAutoSkip();
        }}
      >
        <span className="dot" />
        Auto-skip
      </button>
      <button
        className={`btn chip autopass-chip eot${untilEndOfTurn ? ' on' : ''}`}
        aria-pressed={untilEndOfTurn}
        data-testid="pass-turn"
        disabled={gameOver}
        title={
          untilEndOfTurn
            ? 'Passing until end of turn. Click, E or Esc to stop'
            : 'Pass priority until end of turn; stops if the opponent casts a spell or attacks you (E)'
        }
        onClick={(e) => {
          e.currentTarget.blur();
          runtime().togglePassToEndOfTurn();
        }}
      >
        <span className="dot" />
        {untilEndOfTurn ? 'Passing' : 'Pass turn'}
      </button>
      {autoResolve && (
        <button
          className="btn chip autopass-chip on"
          aria-pressed
          data-testid="auto-resolve"
          title="Auto-resolve is on: priority passes whenever the top of the stack is yours. Click to turn it off"
          onClick={(e) => {
            e.currentTarget.blur();
            runtime().toggleAutoResolve();
          }}
        >
          <span className="dot" />
          Auto-resolve
        </button>
      )}
      {answers.length > 0 && (
        <button
          className={`btn chip autopass-chip on${showAnswers ? ' open' : ''}`}
          aria-expanded={showAnswers}
          data-testid="auto-answers"
          title="Optional triggers answered for you. Click to see them and take one back"
          onClick={(e) => {
            e.currentTarget.blur();
            setShowAnswers(!showAnswers);
          }}
        >
          <span className="dot" />
          {answers.length === 1 ? '1 auto answer' : `${answers.length} auto answers`}
        </button>
      )}
      {showAnswers && answers.length > 0 && (
        <ul className="auto-answers" data-testid="auto-answers-list">
          {answers.map((a) => (
            <li key={a.key}>
              <span className={`aa-decision ${a.decision}`}>{a.decision === 'accept' ? 'Yes' : 'No'}</span>
              <span className="aa-label" title={answerLabel(a.key)}>
                {answerLabel(a.key)}
              </span>
              <button className="btn chip ghost" data-testid="auto-answer-clear" onClick={() => runtime().setTriggerAnswer(a.key, 'ask')}>
                Ask again
              </button>
            </li>
          ))}
        </ul>
      )}
      <LoopControls />
    </div>
  );
}

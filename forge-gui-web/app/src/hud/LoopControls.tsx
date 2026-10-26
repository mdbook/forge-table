/**
 * The loop shortcut's chips (hud/loop.ts): Record loop, then while recording a "repeat N more times" row with Done
 * and Cancel; Waiting on opponent and Looping 3 / 10 take it back or stop it. From the other side, an offered loop
 * asks Accept / Stop after N / Respond, and an accepted one shows its progress.
 */
import { useState } from 'react';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { loopChip, opponentLoopText, repeatCount } from './loop';

export function LoopControls() {
  const { loop, opponentLoop } = useUi((s) => s.autoPass);
  const gameOver = useUi((s) => !!s.gameOver);
  const [times, setTimes] = useState('3');
  const [stopAfter, setStopAfter] = useState('');
  if (gameOver) return null;
  const chip = loopChip(loop);
  const count = repeatCount(times);
  const offered = opponentLoop?.state === 'offered' ? opponentLoop : null;
  const offerId = offered?.offerId ?? 0;
  const stopAt = offered ? repeatCount(stopAfter, Math.max(1, (offered.times ?? 1) - 1)) : null;
  return (
    <>
      <button
        className={`btn chip autopass-chip${chip.on ? ' on' : ''}`}
        aria-pressed={chip.on}
        data-testid="loop"
        title={chip.title}
        onClick={(e) => {
          e.currentTarget.blur();
          if (!loop) runtime().loopShortcut('record');
          else if (loop.state !== 'recording') runtime().loopShortcut('cancel');
        }}
      >
        <span className="dot" />
        {chip.label}
      </button>
      {loop?.state === 'recording' && (
        <form
          className="loop-panel"
          data-testid="loop-recording"
          onSubmit={(e) => {
            e.preventDefault();
            if (count !== null) runtime().loopShortcut('done', count);
          }}
        >
          <label>
            Repeat
            <input
              type="text"
              inputMode="numeric"
              value={times}
              aria-label="Repeat how many more times"
              data-testid="loop-times"
              onChange={(e) => setTimes(e.target.value)}
            />
            more times
          </label>
          <button type="submit" className="btn chip" disabled={count === null || !loop.steps} data-testid="loop-done">
            Done
          </button>
          <button type="button" className="btn chip ghost" data-testid="loop-cancel" onClick={() => runtime().loopShortcut('cancel')}>
            Cancel
          </button>
        </form>
      )}
      {offered && (
        <div className="loop-panel offer" role="alertdialog" aria-label="Loop shortcut" data-testid="loop-offer">
          <p>{opponentLoopText(offered)}</p>
          <div className="loop-row">
            <button className="btn chip" data-testid="loop-accept" onClick={() => runtime().answerLoop(offerId, true)}>
              Accept
            </button>
            {(offered.times ?? 0) > 1 && (
              <form
                className="loop-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (stopAt !== null) runtime().answerLoop(offerId, true, stopAt);
                }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  value={stopAfter}
                  placeholder="N"
                  aria-label="Stop after this many repeats"
                  data-testid="loop-stop-after"
                  onChange={(e) => setStopAfter(e.target.value)}
                />
                <button type="submit" className="btn chip ghost" disabled={stopAt === null} data-testid="loop-stop">
                  Stop after
                </button>
              </form>
            )}
            <button
              className="btn chip ghost"
              data-testid="loop-respond"
              title="You want to act during the loop: it isn't shortcut, they play it out by hand"
              onClick={() => runtime().answerLoop(offerId, false)}
            >
              Respond
            </button>
          </div>
        </div>
      )}
      {opponentLoop?.state === 'playing' && (
        <span className="btn chip autopass-chip on" data-testid="opponent-loop">
          <span className="dot" />
          {opponentLoopText(opponentLoop)}
        </span>
      )}
    </>
  );
}

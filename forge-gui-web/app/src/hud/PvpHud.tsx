/**
 * Human-vs-human table pieces: the calm "Waiting for {name}…" line on the opponent's
 * plate while they are the one deciding, and the banner that says they dropped, counts down to Claim win and clears
 * when they come back. Logic lives in pvp.ts.
 */
import { useEffect, useState } from 'react';
import { runtime } from '../runtime';
import { opponentOf } from '../store/model';
import { useUi } from '../store/uiStore';
import { at, atC, useGeo } from './pos';
import { awayView, waitingOnOpponent } from './pvp';

/** The opponent's name as the table knows it (the player's name on the wire), else the lobby's. */
function useOpponentName(): string {
  const lobbyName = useUi((s) => s.pvp?.lobby.opponent ?? null);
  const shown = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const opp = opponentOf(shown, viewer);
  const p = opp ? shown.players[opp] : undefined;
  return p?.lobbyPlayerName ?? p?.name ?? lobbyName ?? 'Your opponent';
}

/** A clock that ticks while `active` (the countdown re-renders; nothing else does). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** On the opponent's plate: "Waiting for Sam…" while a PvP opponent holds priority or is deciding. Nothing otherwise. */
export function OppWaiting({ name }: { name: string }) {
  const pvp = useUi((s) => s.pvp);
  const game = useUi((s) => s.shown.game);
  const viewer = useUi((s) => s.viewer);
  const prompt = useUi((s) => s.prompt);
  const asks = useUi((s) => s.asks.length);
  const gameOver = useUi((s) => !!s.gameOver);
  const away = !!pvp?.presence && !pvp.presence.opponentConnected;
  const waiting = waitingOnOpponent({
    pvp: !!pvp,
    turn: game.turn ?? 0,
    phase: game.phase,
    playerTurn: game.playerTurn,
    priority: game.priority,
    viewer,
    promptKind: prompt?.kind ?? null,
    asks,
    gameOver,
    away,
  });
  if (!waiting) return null;
  return (
    <div className="plate-wait" role="status" data-testid="opp-waiting">
      Waiting<span className="wait-for"> for {name}</span>
      <span className="wait-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** "Sam disconnected…": under the opponent's plate, with Claim win once the server allows it. */
export function PvpBanner() {
  const pvp = useUi((s) => s.pvp);
  const gameOver = useUi((s) => !!s.gameOver);
  const name = useOpponentName();
  const { PLATES, ROW_Y, W, hudPortrait } = useGeo();
  const gone = !!pvp?.presence && !pvp.presence.opponentConnected && !gameOver;
  const now = useNow(gone);
  const v = gone ? awayView(pvp, name, now) : null;
  if (!v) return null;
  // Landscape: just under the opponent's plate. Portrait: in the gap above the centre line (its strip is the plate's).
  const style = hudPortrait ? { ...at(W / 2, ROW_Y.centre - 52), transform: 'translate(-50%, -100%)' } : atC(W / 2, PLATES.opp.y + PLATES.h + 12);
  return (
    <div className="pvp-banner" style={style} role="alert" data-testid="pvp-banner">
      <div className="pvp-banner-text">{v.text}</div>
      <div className="pvp-banner-row">
        {v.countdown && (
          <span className="pvp-banner-count" data-testid="pvp-countdown">
            {v.countdown}
          </span>
        )}
        <button className="btn primary pvp-claim" disabled={!v.claimable} data-testid="claim-win" onClick={() => runtime().claimWin()}>
          Claim win
        </button>
      </div>
    </div>
  );
}

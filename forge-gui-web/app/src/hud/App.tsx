/**
 * The page: the Pixi table canvas underneath, the React HUD on top (sharing the table transform through
 * CSS variables), overlays above that.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { TABLE_W } from '../layout/geometry';
import { AskLayer } from '../overlays/AskLayer';
import { BattlefieldToggle } from '../overlays/BattlefieldPeek';
import { ManaPromptPicker } from '../overlays/ManaPicker';
import { ZoneStrip } from '../overlays/ZoneStrip';
import { ZoneViewer } from '../overlays/ZoneViewer';
import type { Runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { ActionCluster, useKeyboard } from './Actions';
import { ConfirmPrompt } from './ConfirmPrompt';
import { MulliganBanner } from './MulliganBanner';
import { CornerMenu, GameOverPanel, HoverPreview, PinnedPreview } from './Panels';
import { StartScreen } from './StartScreen';
import { PhaseLadder } from './PhaseLadder';
import { Plates } from './Plates';
import { PvpBanner } from './PvpHud';
import { scales } from './pos';
import { ConnectionBadge, Flash, PileCounts, RestartBanner, StackList, StatusLine, Toasts, TurnBanner } from './TableHud';

function applyScaleVars(): void {
  const { s, hs, ox, oy, worldW, portrait } = scales(window.innerWidth, window.innerHeight);
  const root = document.documentElement.style;
  root.setProperty('--s', String(s));
  root.setProperty('--hs', String(hs));
  root.setProperty('--ox', `${ox}px`);
  root.setProperty('--oy', `${oy}px`);
  // Portrait's HUD places itself by the real geometry (pos.ts useGeo): nothing moves with a right edge.
  root.setProperty('--dx', portrait ? '0' : String(worldW - TABLE_W));
  document.documentElement.classList.toggle('portrait', portrait);
}

export function App({ runtime, onHost }: { runtime: Runtime; onHost: (el: HTMLDivElement) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const inMatch = useUi((s) => s.inMatch);
  const test = useUi((s) => s.test);
  useLayoutEffect(() => {
    applyScaleVars();
    window.addEventListener('resize', applyScaleVars);
    return () => window.removeEventListener('resize', applyScaleVars);
  }, []);
  useEffect(() => {
    if (host.current) onHost(host.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const effects = useUi((st) => st.effects);
  // Reduced motion (the OS setting or ?reducedMotion=1): CSS-driven motion keys off `.rm` as well as the media query.
  const rm = useUi((st) => st.reducedMotion);
  useKeyboard();
  void runtime;
  return (
    <div className={`app${test ? ' test-mode' : ''} fx-${effects}${rm ? ' rm' : ''}`}>
      <div className="table-host" ref={host} />
      {inMatch ? (
        <div className="hud" data-testid="hud">
          <StatusLine />
          {/* First in the HUD: its peek keys go on the window before any overlay's own (BattlefieldPeek.tsx). */}
          <BattlefieldToggle />
          <TurnBanner />
          <MulliganBanner />
          <Plates />
          <PileCounts />
          <PhaseLadder />
          <StackList />
          <ActionCluster />
          <ZoneStrip />
          {/* Test mode never sets a preview from pointer hover (runtime.hover); only __table.preview does. */}
          <HoverPreview />
          <PinnedPreview />
          <CornerMenu />
          <ZoneViewer />
          <AskLayer />
          <ConfirmPrompt />
          <ManaPromptPicker />
          <GameOverPanel />
          <Toasts />
          <RestartBanner />
          <PvpBanner />
          {!test && <Flash />}
          <ConnectionBadge />
        </div>
      ) : (
        <div className="hud">
          <StartScreen />
          <Toasts />
          <RestartBanner />
          <ConnectionBadge />
        </div>
      )}
    </div>
  );
}

import '@fontsource-variable/inter/wght.css';
import '@fontsource/barlow-condensed/600.css';
import './styles.css';
import { MotionGlobalConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { readConfig } from './config';
import { App } from './hud/App';
import { Runtime, setRuntime } from './runtime';

const config = readConfig();
// Deterministic screenshots: HUD motion is skipped entirely under ?test=1.
if (config.test) MotionGlobalConfig.skipAnimations = true;

// iOS Safari ignores user-scalable=no: block its pinch-zoom gesture so the table can't be zoomed half-off screen.
document.addEventListener('gesturestart', (e) => e.preventDefault());

const rt = new Runtime(config);
setRuntime(rt);

let started = false;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      runtime={rt}
      onHost={(el) => {
        if (started) return;
        started = true;
        rt.start(el).catch((e: unknown) => {
          console.error('Forge Table failed to start', e);
          rt.toast('error', 'Forge Table failed to start', String((e as Error)?.message ?? e));
        });
      }}
    />
  </StrictMode>,
);

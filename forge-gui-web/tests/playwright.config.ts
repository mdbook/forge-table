/**
 * Playwright 1.56.1 (pinned: the preinstalled Chromium 141 only works with 1.56.x; never `playwright
 * install`). Two projects:
 * - `replay`: JVM-free; plays a recorded session with the virtual clock and compares 6 goldens.
 * - `live`:   spawns the real sidecar (global setup) and plays to turn 3 through the UI, with video.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const PREVIEW_PORT = Number(process.env.FT_PREVIEW_PORT ?? 4317);
/** Absolute paths, so the config also works when re-exported from the workspace root. */
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  outputDir: path.join(here, 'test-results'),
  timeout: 12 * 60_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide' },
  },
  // Each replay test has its own page and mocked routes, so they run side by side (~3x faster in CI);
  // FT_PW_WORKERS=1 for a serial run. The live project shares one sidecar game: one worker.
  fullyParallel: true,
  workers: Number(process.env.FT_PW_WORKERS ?? 3),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(here, 'playwright-report') }]],
  globalSetup: path.join(here, 'support', 'global-setup.ts'),
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  use: {
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  },
  webServer: {
    command: `npx vite preview --port ${PREVIEW_PORT} --strictPort --host 127.0.0.1`,
    cwd: path.join(here, '..', 'app'),
    url: `http://127.0.0.1:${PREVIEW_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'replay',
      testMatch: /replay\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}`, viewport: { width: 1920, height: 1080 } },
    },
    {
      // Not a golden: `npx playwright test --project viewports` writes shots at many sizes (FT_VP=WxH,…).
      name: 'viewports',
      testMatch: /viewports\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
      use: {
        viewport: { width: 1280, height: 720 },
        video: { mode: 'on', size: { width: 1280, height: 720 } },
      },
    },
  ],
});

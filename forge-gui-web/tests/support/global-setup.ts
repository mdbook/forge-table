/**
 * Playwright global setup: spawns the real sidecar for the `live` project (skipped when only other projects
 * run, or with FT_SKIP_LIVE=1) and publishes its READY line to the workers through the environment.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { startSidecar, WEB_ROOT } from './sidecar.ts';

/** Projects named on the command line (`--project x`, `--project=x`); empty = all. */
function selectedProjects(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--project' && argv[i + 1]) out.push(argv[i + 1]!);
    else if (a.startsWith('--project=')) out.push(a.slice('--project='.length));
  });
  return out;
}

export default async function globalSetup(_config: FullConfig): Promise<(() => Promise<void>) | void> {
  if (!existsSync(path.join(WEB_ROOT, 'app', 'dist', 'index.html'))) {
    throw new Error('app/dist is missing: run `npm run build` in forge-gui-web first.');
  }
  const selected = selectedProjects(process.argv);
  const live = !process.env.FT_SKIP_LIVE && (selected.length === 0 || selected.includes('live'));
  if (!live) return;
  const outDir = path.join(WEB_ROOT, 'tests', 'output', 'live');
  mkdirSync(outDir, { recursive: true });
  const sc = await startSidecar({
    deck: 'mono-red-madness',
    oppDeck: 'mono-blue-faeries',
    ai: 'Default',
    logFile: path.join(outDir, 'sidecar.log'),
    timeoutMs: 180_000,
  });
  process.env.FT_LIVE_URL = sc.ready.url;
  process.env.FT_LIVE_PORT = String(sc.ready.port);
  writeFileSync(path.join(outDir, 'ready.json'), JSON.stringify({ port: sc.ready.port, url: sc.ready.url.replace(/#t=.*/, '#t=…') }));
  return async () => {
    await sc.stop();
  };
}

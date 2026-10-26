/**
 * Spawns the Forge Table sidecar (forge.bridge.Main) for live tests and fixture recording, waits for its
 * `FORGE_TABLE_READY {json}` line, and always drains stdout/stderr (an undrained pipe would freeze the game
 * thread). Plain, erasable TypeScript so `node` can run it directly.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, createWriteStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, '../..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..');
const BRIDGE = path.join(REPO_ROOT, 'forge-gui-bridge');

export interface Ready {
  port: number;
  token: string;
  url: string;
  userDir?: string;
}

export interface SidecarOptions {
  deck?: string;
  oppDeck?: string;
  ai?: string;
  record?: string;
  port?: number;
  /** Where the process log goes (stdout + stderr). */
  logFile?: string;
  /** Boot timeout (ms). */
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface Sidecar {
  ready: Ready;
  proc: ChildProcess;
  home: string;
  stop(): Promise<void>;
}

/** Make sure the bridge is compiled and its runtime classpath is written. */
export function ensureBridgeBuilt(): string {
  const cpFile = path.join(BRIDGE, 'target', 'classpath.txt');
  if (!existsSync(cpFile) || !existsSync(path.join(BRIDGE, 'target', 'classes', 'forge', 'bridge', 'Main.class'))) {
    execFileSync('mvn', ['-B', '-q', '-o', '-Dskip.web', '-DskipTests', 'install', '-pl', 'forge-gui-web,forge-gui-bridge'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }
  return readFileSync(cpFile, 'utf8').trim();
}

export async function startSidecar(opts: SidecarOptions = {}): Promise<Sidecar> {
  const classpath = ensureBridgeBuilt();
  const home = mkdtempSync(path.join(tmpdir(), 'forge-table-home-'));
  mkdirSync(path.join(home, 'home'), { recursive: true });
  const args = [
    '-Xmx3g',
    '-Xss8m',
    `-Duser.home=${path.join(home, 'home')}`,
    '-Dforge.table.ignoreStdin=true',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
    '--add-opens', 'java.base/java.text=ALL-UNNAMED',
    '--add-opens', 'java.desktop/javax.imageio.spi=ALL-UNNAMED',
    '-cp', `${path.join(BRIDGE, 'target', 'classes')}${path.delimiter}${classpath}`,
    'forge.bridge.Main',
    '--assets', path.join(REPO_ROOT, 'forge-gui') + path.sep,
    '--web', path.join(WEB_ROOT, 'app', 'dist'),
    '--decks', path.join(BRIDGE, 'src', 'test', 'resources', 'table', 'decks'),
    '--deck', opts.deck ?? 'mono-red-madness',
    '--opp-deck', opts.oppDeck ?? 'mono-blue-faeries',
    '--ai', opts.ai ?? 'Default',
    '--test-prefs',
  ];
  if (opts.record) args.push('--record', opts.record);
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.extraArgs) args.push(...opts.extraArgs);

  const proc = spawn('java', args, { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = opts.logFile ? createWriteStream(opts.logFile) : null;
  const timeout = opts.timeoutMs ?? 150_000;

  const ready = await new Promise<Ready>((resolve, reject) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`sidecar did not print FORGE_TABLE_READY within ${timeout} ms`));
      }
    }, timeout);
    // Drain both streams for the whole life of the process.
    proc.stdout!.on('data', (chunk: Buffer) => {
      log?.write(chunk);
      if (done) return;
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('FORGE_TABLE_ERROR')) {
          done = true;
          clearTimeout(timer);
          reject(new Error(line));
          return;
        }
        if (line.startsWith('FORGE_TABLE_READY ')) {
          done = true;
          clearTimeout(timer);
          resolve(JSON.parse(line.slice('FORGE_TABLE_READY '.length)) as Ready);
          return;
        }
      }
    });
    proc.stderr!.on('data', (chunk: Buffer) => log?.write(chunk));
    proc.on('exit', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`sidecar exited early with code ${code}`));
      }
    });
  });

  const stop = async () => {
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        log?.end();
        resolve();
      });
      proc.kill('SIGTERM');
    });
  };
  return { ready, proc, home, stop };
}

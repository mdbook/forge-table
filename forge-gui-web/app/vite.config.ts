/// <reference types="vitest/config" />
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Packages whose assets are bundled through CSS (fonts) rather than JS imports. rollup-plugin-license only
 * sees JS modules, so their licences are appended explicitly (an OFL text for each font).
 */
const CSS_ASSET_PACKAGES = ['@fontsource-variable/inter', '@fontsource/barlow-condensed'];

/** Fonts vendored in the source tree (not from npm), with their licence files. */
const VENDORED_FONTS = [
  { name: 'Inter (arrows subset, src/theme/fonts/inter-arrows-wght.woff2)', version: '4.1', license: 'OFL-1.1', file: 'src/theme/fonts/Inter-OFL.txt' },
  // The font file only (mana-font/fonts/mana.woff2, imported as an asset; its CSS is never imported).
  { name: 'Mana font (mana-font/fonts/mana.woff2)', version: '1.18.0', license: 'OFL-1.1', file: 'src/theme/fonts/Mana-OFL.txt' },
  // The Framed (M15) face's title and body fonts (src/cards/m15/fonts.ts), unmodified from google/fonts and CTAN.
  { name: 'Faustina (src/theme/fonts/faustina-wght.ttf)', version: '1.200', license: 'OFL-1.1', file: 'src/theme/fonts/Faustina-OFL.txt' },
  { name: 'Splentinex Regular (src/theme/fonts/splentinex-regular.otf)', version: '1.000', license: 'OFL-1.1', file: 'src/theme/fonts/Splentinex-OFL.txt' },
];

interface Dep {
  name: string | null;
  version: string | null;
  license: string | null;
  licenseText: string | null;
  repository?: { url?: string } | string | null;
  author?: { text?: () => string } | null;
}

function section(name: string, version: string, lic: string, text: string): string {
  return [`${name}@${version}`, `License: ${lic}`, '', text.trim(), ''].join('\n');
}

function notices(deps: Dep[]): string {
  const parts: string[] = [
    'Forge Table: third-party notices',
    '',
    'This file lists the open-source software bundled into the Forge Table web client, with each',
    'package\'s licence. Forge itself is GPL-3.0; card faces are drawn procedurally (the Framed face in the style',
    'of the modern Magic frame, set in the open Faustina and Splentinex typefaces, around art crops served by',
    'the sidecar); no MTG Arena assets are included. The mana, tap and card-type symbols drawn with the Mana font are copyright Wizards of the',
    'Coast, used under its Fan Content Policy: Unofficial Fan Content permitted under the Fan Content Policy.',
    'Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.',
    '©Wizards of the Coast LLC.',
    '',
    '='.repeat(78),
    '',
  ];
  const seen = new Set<string>();
  for (const d of [...deps].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    if (!d.name || seen.has(d.name)) continue;
    seen.add(d.name);
    parts.push(section(d.name, d.version ?? '?', d.license ?? 'UNKNOWN', d.licenseText ?? '(no licence text shipped)'));
    parts.push('-'.repeat(78), '');
  }
  for (const pkg of CSS_ASSET_PACKAGES) {
    if (seen.has(pkg)) continue;
    const pj = require.resolve(`${pkg}/package.json`);
    const meta = JSON.parse(readFileSync(pj, 'utf8')) as { version: string; license: string };
    const licFile = path.join(path.dirname(pj), 'LICENSE');
    const text = existsSync(licFile) ? readFileSync(licFile, 'utf8') : '(no licence text shipped)';
    parts.push(section(pkg, meta.version, meta.license, text));
    parts.push('-'.repeat(78), '');
  }
  for (const f of VENDORED_FONTS) {
    parts.push(section(f.name, f.version, f.license, readFileSync(path.join(here, f.file), 'utf8')));
    parts.push('-'.repeat(78), '');
  }
  return parts.join('\n');
}

export default defineConfig({
  root: here,
  // Relative URLs: the sidecar serves the bundle at "/", Vite preview and file-based replays work too.
  base: './',
  plugins: [
    react(),
    license({
      thirdParty: {
        includePrivate: false,
        output: {
          file: path.join(here, 'dist', 'THIRD-PARTY-NOTICES.txt'),
          template: (deps) => notices(deps as unknown as Dep[]),
        },
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    // The table (index.html), and the multi-game router's lobby (lobby.html) and sign-in page (login.html), which a plain sidecar never serves.
    rollupOptions: {
      input: { main: path.join(here, 'index.html'), lobby: path.join(here, 'lobby.html'), login: path.join(here, 'login.html') },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Importing Pixi from the NFS-backed worktree can take >5 s when every file loads at once (pt.test flaked).
    testTimeout: 20_000,
    environment: 'node',
  },
});

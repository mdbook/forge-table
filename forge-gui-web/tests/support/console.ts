/**
 * Console-error gate: every page error and console error fails the test, except the known noise of
 * software WebGL (SwiftShader) in a headless container.
 */
import type { ConsoleMessage, Page } from '@playwright/test';

const ALLOW = [
  /swiftshader/i,
  /webgl/i,
  /GPU stall due to ReadPixels/i,
  /GL Driver Message/i,
  /Automatic fallback to software WebGL/i,
  /GroupMarkerNotSet/i,
];

export interface ConsoleGate {
  errors: string[];
}

export function gateConsole(page: Page): ConsoleGate {
  const gate: ConsoleGate = { errors: [] };
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (ALLOW.some((re) => re.test(text))) return;
    if (m.type() === 'error') gate.errors.push(text);
  });
  page.on('pageerror', (e) => gate.errors.push(`pageerror: ${e.message}`));
  return gate;
}

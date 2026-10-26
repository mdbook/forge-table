/**
 * Real card art from the sidecar: `GET /img/card/<imageKey>` returns a Scryfall "normal" scan
 * (488×680) of the curated printing. This loader keeps one decoded, corner-rounded ImageBitmap per image
 * key, with at most a few requests in flight, and tells subscribers when a key becomes ready.
 *
 * Server contract:
 * - 200 image/*: the scan. 204 (or 404): no art for this key; it stays procedural for this page session.
 * - 202 (or 503) with `Retry-After: <seconds>`: the art index or the download is still running; retried
 *   after that delay, up to `maxAttempts` requests per key in all. The server may hold a request ~15 s.
 *
 * Art crops (`/img/crop/<imageKey>`: the illustration alone, for our own card frame) load the same way through a
 * second loader (`cropArt`); a crop's answer carries the artist in `X-Card-Artist` (percent-encoded UTF-8), kept
 * beside its bitmap for the credit drawn with it.
 *
 * Off under `?test=1`, `?replay=…` and `?art=0` (the runtime never enables it there), so deterministic
 * runs never see real art. The image-treatment rule (never tint, filter or cover the scan) is the
 * renderers' job; this module only decodes.
 */
import { CARD_RADIUS } from '../layout/geometry';

export type ArtState = 'loading' | 'ready' | 'missing';

/** Native Scryfall "normal" height. Larger images are scaled down to it; smaller ones are never upscaled. */
export const MAX_ART_HEIGHT = 680;
export const DEFAULT_MAX_IN_FLIGHT = 5;
// A busy server (a burst of downloads at game start, Scryfall's rate limit) is waited out for minutes, backing off: giving
// up after ~24 s left cards procedural until a reload (Elvish Mystic).
export const DEFAULT_MAX_ATTEMPTS = 40;
/** Network failures (fetch rejected) are retried this many times before the key is given up on. */
export const MAX_NETWORK_ATTEMPTS = 3;
/** Retry-After bounds (ms) and the delay used when the header is absent or unreadable. */
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 60_000;
const RETRY_DEFAULT_MS = 2_000;
/** Per-request timeout: comfortably above the ~15 s the server may hold a request. */
const REQUEST_TIMEOUT_MS = 45_000;

export interface ArtDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Decode a blob (and optionally rescale an existing bitmap). */
  createImageBitmap: (src: ImageBitmapSource, opts?: ImageBitmapOptions) => Promise<ImageBitmap>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Round the bitmap's corners (transparent outside the card radius). Identity when no canvas is available. */
  round: (bmp: ImageBitmap) => ImageBitmap | Promise<ImageBitmap>;
}

export interface ArtOptions {
  enabled?: boolean;
  maxInFlight?: number;
  maxAttempts?: number;
  /** URL for an image key (default: same-origin `/img/card/<key>`, which carries the `ft` cookie). */
  url?: (key: string) => string;
  deps?: Partial<ArtDeps>;
}

interface Entry {
  state: ArtState;
  bitmap: ImageBitmap | null;
  /** Requests made so far. */
  attempts: number;
  networkFailures: number;
  /** Who painted a crop (the `X-Card-Artist` header), else null. */
  artist: string | null;
  /** Waiting in the queue (not in flight, not in a retry delay). */
  queued: boolean;
  retryTimer: unknown;
}

/** Called with the key that changed, or `null` when everything may have changed (enabled toggled). */
export type ArtListener = (key: string | null) => void;

export function defaultArtUrl(key: string): string {
  return `/img/card/${encodeURIComponent(key)}`;
}

export function defaultCropUrl(key: string): string {
  return `/img/crop/${encodeURIComponent(key)}`;
}

/** The artist from an `X-Card-Artist` value (percent-encoded UTF-8); null when absent, empty or not decodable. */
export function parseArtist(value: string | null): string | null {
  if (value === null) return null;
  try {
    const name = decodeURIComponent(value).trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/** `Retry-After` as ms: delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Draw the bitmap into a canvas clipped to the card's rounded rect (corners only; nothing else changes). */
export function roundCorners(bmp: ImageBitmap): ImageBitmap {
  const w = bmp.width;
  const h = bmp.height;
  if (typeof OffscreenCanvas === 'undefined' || w === 0 || h === 0) return bmp;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return bmp;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, w * CARD_RADIUS);
  ctx.clip();
  ctx.drawImage(bmp, 0, 0);
  const out = canvas.transferToImageBitmap();
  bmp.close();
  return out;
}

function defaultDeps(): ArtDeps {
  const g = globalThis as typeof globalThis & { createImageBitmap?: ArtDeps['createImageBitmap'] };
  return {
    fetch: (url, init) => fetch(url, init),
    createImageBitmap: (src, opts) => {
      if (!g.createImageBitmap) return Promise.reject(new Error('createImageBitmap is unavailable'));
      return opts ? g.createImageBitmap(src, opts) : g.createImageBitmap(src);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    round: roundCorners,
  };
}

export class ArtLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<ArtListener>();
  /** Entries whose request is running right now. */
  private readonly flying = new Set<Entry>();
  private readonly deps: ArtDeps;
  private inFlight = 0;
  private enabledFlag: boolean;
  private urlFor: (key: string) => string;
  readonly maxInFlight: number;
  readonly maxAttempts: number;
  /** Bumped on every change; React reads it through useSyncExternalStore. */
  version = 0;

  constructor(opts: ArtOptions = {}) {
    this.enabledFlag = opts.enabled ?? false;
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.urlFor = opts.url ?? defaultArtUrl;
    this.deps = { ...defaultDeps(), ...opts.deps };
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** Turn real art on or off. Off: every key reads as not ready and nothing new is requested. */
  setEnabled(on: boolean): void {
    if (on === this.enabledFlag) return;
    this.enabledFlag = on;
    if (on) this.pump();
    this.emit(null);
  }

  setUrl(url: (key: string) => string): void {
    this.urlFor = url;
  }

  subscribe(fn: ArtListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The bitmap for a key when it is ready (and art is on); otherwise requests it and returns null. */
  get(key: string | undefined | null): ImageBitmap | null {
    if (!key || !this.enabledFlag) return null;
    const e = this.entries.get(key);
    if (e?.state === 'ready') return e.bitmap;
    this.request(key, true);
    return null;
  }

  /** Like get() but never starts a request (safe inside render / getSnapshot). */
  peek(key: string | undefined | null): ImageBitmap | null {
    if (!key || !this.enabledFlag) return null;
    const e = this.entries.get(key);
    return e?.state === 'ready' ? e.bitmap : null;
  }

  /** Who painted a ready crop (null for a scan, an unknown artist, or a key not ready). */
  artist(key: string | undefined | null): string | null {
    const e = key ? this.entries.get(key) : undefined;
    return e?.state === 'ready' ? e.artist : null;
  }

  status(key: string): ArtState | undefined {
    return this.entries.get(key)?.state;
  }

  /** Queue art for these keys behind anything already waiting (snapshot prefetch). */
  prefetch(keys: Iterable<string | undefined | null>): void {
    if (!this.enabledFlag) return;
    for (const k of keys) if (k) this.request(k, false);
  }

  /** Start (or reprioritise) loading a key. `urgent` puts it at the front of the queue. */
  request(key: string, urgent = false): void {
    if (!this.enabledFlag || !key) return;
    let e = this.entries.get(key);
    if (!e) {
      e = { state: 'loading', bitmap: null, artist: null, attempts: 0, networkFailures: 0, queued: false, retryTimer: null };
      this.entries.set(key, e);
    } else if (e.state !== 'loading') {
      return;
    }
    if (e.queued) {
      if (urgent) {
        const i = this.queue.indexOf(key);
        if (i > 0) {
          this.queue.splice(i, 1);
          this.queue.unshift(key);
        }
      }
    } else if (e.retryTimer === null && !this.flying.has(e)) {
      e.queued = true;
      if (urgent) this.queue.unshift(key);
      else this.queue.push(key);
    }
    this.pump();
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  get readyCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === 'ready') n++;
    return n;
  }

  /** Close every bitmap and forget everything (page teardown). */
  dispose(): void {
    for (const e of this.entries.values()) {
      if (e.retryTimer !== null) this.deps.clearTimeout(e.retryTimer);
      e.bitmap?.close();
    }
    this.entries.clear();
    this.queue.length = 0;
    this.listeners.clear();
  }

  // ----------------------------------------------------------------------------------- internals

  private pump(): void {
    while (this.enabledFlag && this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const e = this.entries.get(key);
      if (!e || e.state !== 'loading') continue;
      e.queued = false;
      void this.load(key, e);
    }
  }

  private async load(key: string, e: Entry): Promise<void> {
    this.inFlight++;
    this.flying.add(e);
    e.attempts++;
    let outcome: { kind: 'ready'; bitmap: ImageBitmap; artist: string | null } | { kind: 'missing' } | { kind: 'retry'; ms: number; network: boolean };
    try {
      outcome = await this.fetchOnce(key);
    } catch {
      e.networkFailures++;
      outcome = { kind: 'retry', ms: Math.min(16_000, 1000 * 2 ** (e.networkFailures - 1)), network: true };
    } finally {
      this.inFlight--;
      this.flying.delete(e);
    }
    if (this.entries.get(key) !== e) {
      // Disposed meanwhile.
      if (outcome.kind === 'ready') outcome.bitmap.close();
      this.pump();
      return;
    }
    switch (outcome.kind) {
      case 'ready':
        e.state = 'ready';
        e.bitmap = outcome.bitmap;
        e.artist = outcome.artist;
        this.emit(key);
        break;
      case 'missing':
        this.giveUp(key, e);
        break;
      case 'retry': {
        const exhausted = e.attempts >= this.maxAttempts || (outcome.network && e.networkFailures >= MAX_NETWORK_ATTEMPTS);
        if (exhausted) {
          this.giveUp(key, e);
          break;
        }
        const wait = outcome.network ? outcome.ms : Math.max(outcome.ms, Math.min(30_000, 1000 * 2 ** Math.floor(e.attempts / 4)));
        e.retryTimer = this.deps.setTimeout(() => {
          e.retryTimer = null;
          if (this.entries.get(key) !== e || e.state !== 'loading') return;
          e.queued = true;
          this.queue.push(key);
          this.pump();
        }, wait);
        break;
      }
    }
    this.pump();
  }

  private giveUp(key: string, e: Entry): void {
    e.state = 'missing';
    e.bitmap = null;
    e.artist = null;
    this.emit(key);
  }

  private async fetchOnce(key: string): Promise<{ kind: 'ready'; bitmap: ImageBitmap; artist: string | null } | { kind: 'missing' } | { kind: 'retry'; ms: number; network: boolean }> {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? this.deps.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    let res: Response;
    try {
      res = await this.deps.fetch(this.urlFor(key), { credentials: 'same-origin', ...(ctrl ? { signal: ctrl.signal } : {}) });
    } finally {
      if (timer !== null) this.deps.clearTimeout(timer);
    }
    if (res.status === 503 || res.status === 202) {
      const ms = parseRetryAfter(res.headers.get('Retry-After')) ?? RETRY_DEFAULT_MS;
      return { kind: 'retry', ms: Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, ms)), network: false };
    }
    if (!res.ok || res.status === 204) return { kind: 'missing' };
    const type = res.headers.get('Content-Type') ?? '';
    if (type && !type.startsWith('image/')) return { kind: 'missing' };
    const blob = await res.blob();
    let bmp: ImageBitmap;
    try {
      bmp = await this.deps.createImageBitmap(blob);
    } catch {
      return { kind: 'missing' }; // not an image we can decode: keep the procedural face
    }
    if (bmp.height > MAX_ART_HEIGHT) {
      const scaled = await this.deps.createImageBitmap(bmp, {
        resizeHeight: MAX_ART_HEIGHT,
        resizeWidth: Math.round((bmp.width * MAX_ART_HEIGHT) / bmp.height),
        resizeQuality: 'high',
      });
      bmp.close();
      bmp = scaled;
    }
    return { kind: 'ready', bitmap: await this.deps.round(bmp), artist: parseArtist(res.headers.get('X-Card-Artist')) };
  }

  private emit(key: string | null): void {
    this.version++;
    for (const fn of [...this.listeners]) fn(key);
  }
}

/** The page's loader. The runtime configures and enables it; everything else only reads from it. */
export const cardArt = new ArtLoader();

/**
 * The page's art-crop loader (the 'frame' art mode): rectangular crops, so no rounded corners. The runtime points it at
 * `/img/crop/` and enables it only in that mode.
 */
export const cropArt = new ArtLoader({ url: defaultCropUrl, deps: { round: (b) => b } });

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../config';
import { ArtLoader, MAX_ART_HEIGHT, defaultArtUrl, defaultCropUrl, parseArtist, parseRetryAfter, type ArtOptions } from './art';

type Bmp = ImageBitmap & { closed: boolean; label: string };

function bitmap(label: string, width = 488, height = 680): Bmp {
  const b = { width, height, closed: false, label, close: () => void (b.closed = true) };
  return b as unknown as Bmp;
}

const jpeg = (body = 'jpeg') => new Response(new Blob([body], { type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
const busy = (retryAfter: string | null = '3') =>
  new Response(null, { status: 503, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } });
const notFound = () => new Response('no art', { status: 404 });
const crop = (artist: string | null) =>
  new Response(new Blob(['crop'], { type: 'image/jpeg' }), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', ...(artist === null ? {} : { 'X-Card-Artist': artist }) },
  });

/** A loader with mocked fetch / createImageBitmap; `routes` answers each request by key. */
function setup(route: (key: string, n: number) => Response | Promise<Response>, opts: ArtOptions = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fetchMock = vi.fn(async (url: string) => {
    const key = decodeURIComponent(url.replace('/img/card/', ''));
    calls.push(key);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return route(key, n);
  });
  const decode = vi.fn(async (src: ImageBitmapSource, o?: ImageBitmapOptions) => {
    if (o?.resizeHeight) return bitmap(`scaled:${(src as Bmp).label}`, o.resizeWidth, o.resizeHeight);
    const text = await (src as Blob).text();
    return text === 'huge' ? bitmap(text, 745, 1040) : bitmap(text);
  });
  const loader = new ArtLoader({
    enabled: true,
    ...opts,
    deps: { fetch: fetchMock as unknown as typeof fetch, createImageBitmap: decode, round: (b) => b, ...opts.deps },
  });
  const events: Array<string | null> = [];
  loader.subscribe((k) => events.push(k));
  return { loader, calls, fetchMock, decode, events };
}

/** Fake time forward, letting Node's Response/Blob bodies (which settle over a few real setImmediate turns) finish. */
async function advance(ms: number): Promise<void> {
  const turns = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  await turns();
  await vi.advanceTimersByTimeAsync(ms);
  await turns();
}

beforeEach(() => {
  // Only the loader's own timers: Node's Response/Blob bodies resolve through setImmediate, which must stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('art loader', () => {
  it('fetches /img/card/<encoded key>, decodes once and notifies subscribers', async () => {
    const { loader, fetchMock, decode, events } = setup(() => jpeg('bolt'));
    expect(loader.get('c:Lightning Bolt|M10|1')).toBeNull();
    expect(loader.status('c:Lightning Bolt|M10|1')).toBe('loading');
    expect(fetchMock).toHaveBeenCalledWith(defaultArtUrl('c:Lightning Bolt|M10|1'), expect.anything());
    expect(defaultArtUrl('c:Lightning Bolt|M10|1')).toBe('/img/card/c%3ALightning%20Bolt%7CM10%7C1');
    await advance(0);
    expect(loader.status('c:Lightning Bolt|M10|1')).toBe('ready');
    expect((loader.get('c:Lightning Bolt|M10|1') as Bmp).label).toBe('bolt');
    expect(events).toEqual(['c:Lightning Bolt|M10|1']);
    // One request and one bitmap per key, however often it is asked for.
    loader.get('c:Lightning Bolt|M10|1');
    loader.prefetch(['c:Lightning Bolt|M10|1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 after its Retry-After, then succeeds', async () => {
    const { loader, calls, events } = setup((_k, n) => (n === 1 ? busy('3') : jpeg()));
    loader.get('t:goblin');
    await advance(0);
    expect(calls).toEqual(['t:goblin']);
    expect(loader.status('t:goblin')).toBe('loading');
    await advance(2900);
    expect(calls).toHaveLength(1); // still waiting out the 3 s
    await advance(200);
    expect(calls).toHaveLength(2);
    expect(loader.status('t:goblin')).toBe('ready');
    expect(events).toEqual(['t:goblin']);
  });

  it('gives up after the attempt cap when the server stays busy', async () => {
    const { loader, calls, events } = setup(() => busy('1'), { maxAttempts: 4 });
    loader.get('c:Slow');
    await advance(10_000);
    expect(calls).toHaveLength(4);
    expect(loader.status('c:Slow')).toBe('missing');
    expect(events).toEqual(['c:Slow']);
    await advance(60_000);
    expect(calls).toHaveLength(4);
  });

  it('treats 404 as missing for the rest of the session (no retry)', async () => {
    const { loader, calls, events } = setup(() => notFound());
    loader.get('t:morph');
    await advance(0);
    expect(loader.status('t:morph')).toBe('missing');
    expect(events).toEqual(['t:morph']);
    expect(loader.get('t:morph')).toBeNull();
    loader.prefetch(['t:morph']);
    await advance(120_000);
    expect(calls).toEqual(['t:morph']);
  });

  it('treats a non-image body as missing', async () => {
    const { loader } = setup(() => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    loader.get('c:Weird');
    await advance(0);
    expect(loader.status('c:Weird')).toBe('missing');
  });

  it('retries network failures a few times, then gives up', async () => {
    const { loader, calls } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    loader.get('c:Offline');
    await advance(60_000);
    expect(calls.length).toBe(3);
    expect(loader.status('c:Offline')).toBe('missing');
  });

  it('keeps at most maxInFlight requests running and starts the next as one finishes', async () => {
    const pending = new Map<string, (r: Response) => void>();
    const { loader, calls } = setup((key) => new Promise<Response>((resolve) => pending.set(key, resolve)), { maxInFlight: 4 });
    const keys = Array.from({ length: 10 }, (_, i) => `c:Card ${i}`);
    loader.prefetch(keys);
    await advance(0);
    expect(loader.inFlightCount).toBe(4);
    expect(calls).toEqual(keys.slice(0, 4));
    pending.get('c:Card 1')!(jpeg());
    await advance(0);
    expect(loader.status('c:Card 1')).toBe('ready');
    expect(loader.inFlightCount).toBe(4);
    expect(calls).toEqual(keys.slice(0, 5));
    // A card asked for on screen jumps the prefetch queue.
    loader.get('c:Card 9');
    pending.get('c:Card 0')!(notFound());
    await advance(0);
    expect(calls[5]).toBe('c:Card 9');
    expect(loader.inFlightCount).toBe(4);
  });

  it('scales an oversized scan down to the native height, never up', async () => {
    const { loader, decode } = setup((k) => jpeg(k === 'big' ? 'huge' : 'small'));
    loader.get('big');
    await advance(0);
    const big = loader.get('big') as Bmp;
    expect(big.height).toBe(MAX_ART_HEIGHT);
    expect(big.label).toBe('scaled:huge');
    expect(decode).toHaveBeenCalledTimes(2);
    loader.get('small');
    await advance(0);
    expect((loader.get('small') as Bmp).height).toBe(680);
    expect(decode).toHaveBeenCalledTimes(3); // no resize pass for a normal-size scan
  });

  it('is inert while disabled, and toggling notifies everyone', async () => {
    const { loader, fetchMock, events } = setup(() => jpeg(), { enabled: false });
    expect(loader.get('c:Anything')).toBeNull();
    loader.prefetch(['c:Anything', 'c:Else']);
    await advance(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    loader.setEnabled(true);
    expect(events).toEqual([null]);
    loader.get('c:Anything');
    await advance(0);
    expect(loader.peek('c:Anything')).not.toBeNull();
    loader.setEnabled(false);
    expect(loader.peek('c:Anything')).toBeNull(); // off means procedural, even for ready keys
  });

  it('closes bitmaps on dispose', async () => {
    const { loader } = setup(() => jpeg());
    loader.get('c:A');
    await advance(0);
    const b = loader.get('c:A') as Bmp;
    loader.dispose();
    expect(b.closed).toBe(true);
  });
});

describe('art is off in deterministic runs', () => {
  const at = (search: string) => readConfig({ search } as Location);
  it('is allowed on a plain live page', () => {
    expect(at('').artAllowed).toBe(true);
    expect(at('?speed=2&autostart=1').artAllowed).toBe(true);
  });
  it('is never allowed under ?test=1, ?replay=… or ?art=0', () => {
    expect(at('?test=1').artAllowed).toBe(false);
    expect(at('?replay=session.jsonl').artAllowed).toBe(false);
    expect(at('?test=1&replay=session.jsonl').artAllowed).toBe(false);
    expect(at('?art=0').artAllowed).toBe(false);
  });
});

describe('Retry-After', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(' 0.5 ')).toBe(500);
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(parseRetryAfter('Sat, 03 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('falls back to a short default without the header', async () => {
    const { loader, calls } = setup((_k, n) => (n === 1 ? busy(null) : jpeg()));
    loader.get('c:X');
    await advance(0);
    expect(calls).toHaveLength(1);
    await advance(2000);
    expect(calls).toHaveLength(2);
    expect(loader.status('c:X')).toBe('ready');
  });
});

describe('art crops', () => {
  const key = 'c:Lightning Bolt|M10|1';
  /** A crop loader as the page configures it: /img/crop/ URLs, corners left alone. */
  function cropSetup(route: (n: number) => Response) {
    const urls: string[] = [];
    let n = 0;
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return route(++n);
    });
    const round = vi.fn((b: ImageBitmap) => b);
    const loader = new ArtLoader({
      enabled: true,
      url: defaultCropUrl,
      deps: { fetch: fetchMock as unknown as typeof fetch, createImageBitmap: async () => bitmap('crop', 626, 457), round },
    });
    return { loader, urls, round };
  }

  it('fetches /img/crop/<encoded key> and keeps the artist from X-Card-Artist (percent-encoded UTF-8)', async () => {
    const { loader, urls } = cropSetup(() => crop(encodeURIComponent('Noriyuki Kōjima')));
    expect(loader.get(key)).toBeNull();
    expect(loader.artist(key)).toBeNull(); // not ready yet
    await advance(0);
    expect(urls).toEqual(['/img/crop/c%3ALightning%20Bolt%7CM10%7C1']);
    expect(defaultCropUrl(key)).toBe(urls[0]);
    expect(loader.status(key)).toBe('ready');
    expect(loader.get(key)).not.toBeNull();
    expect(loader.artist(key)).toBe('Noriyuki Kōjima');
  });

  it('is ready without an artist when the header is missing (no credit line is drawn)', async () => {
    const { loader } = cropSetup(() => crop(null));
    loader.get(key);
    await advance(0);
    expect(loader.status(key)).toBe('ready');
    expect(loader.artist(key)).toBeNull();
  });

  it('stays missing (the face keeps its glyph) when the server has no crop', async () => {
    const { loader } = cropSetup(() => notFound());
    loader.get(key);
    await advance(0);
    expect(loader.status(key)).toBe('missing');
    expect(loader.get(key)).toBeNull();
    expect(loader.artist(key)).toBeNull();
  });

  it('does not touch the network while disabled (every other art mode)', async () => {
    const { loader, urls } = cropSetup(() => crop('X'));
    loader.setEnabled(false);
    loader.get(key);
    loader.prefetch([key]);
    await advance(1000);
    expect(urls).toEqual([]);
  });

  it('reads the artist header', () => {
    expect(parseArtist('Christopher%20Moeller')).toBe('Christopher Moeller');
    expect(parseArtist('J%C3%A9r%C3%B4me%20Gaucher')).toBe('Jérôme Gaucher');
    expect(parseArtist(' %20 ')).toBeNull();
    expect(parseArtist('')).toBeNull();
    expect(parseArtist(null)).toBeNull();
    expect(parseArtist('%E0%A4%A')).toBeNull(); // not decodable: no credit rather than a crash
  });
});

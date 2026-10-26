import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@forge-table/protocol';
import { VirtualClock } from '../util/clock';
import { PROMPT_LINGER_MS, REPLAY_BUDGET_MS, ReplaySource, parseJsonl } from './replay';

const lines = (msgs: object[]) => msgs.map((m) => JSON.stringify(m)).join('\n');
const beat = (seq: number, kind = 'draw') => ({ t: 'beat', seq, kind, card: `c${seq}` });
const prompt = (seq: number, kind = 'priority') => ({ t: 'prompt', seq, pid: seq, kind, message: '', ok: { label: 'OK', enabled: true }, cancel: { label: '', enabled: false }, focusOk: true, selectable: [], highlighted: [], weak: {} });

afterEach(() => vi.unstubAllGlobals());

describe('replay source', () => {
  it('parses JSONL, skipping blanks and client lines', () => {
    expect(parseJsonl('{"t":"notice","kind":"alert"}\n\n>> {"t":"ack"}\n')).toHaveLength(1);
  });

  it('delivers a synthetic welcome and the snapshot on load, then feeds just in time', async () => {
    const msgs = [{ t: 'snapshot', seq: 0, viewer: 'p0', game: { stack: [] }, players: {}, cards: {}, asks: [], stops: {} }, beat(1), beat(2), beat(3), prompt(4), beat(5)];
    vi.stubGlobal('fetch', async () => new Response(lines(msgs)));
    const clock = new VirtualClock();
    let backlog = 0;
    let idle = true;
    const got: ServerMessage[] = [];
    const src = new ReplaySource('x.jsonl', { clock, isIdle: () => idle, speed: () => 1, backlogMs: () => backlog });
    src.start((m) => {
      got.push(m);
      if (m.t === 'beat') backlog += 420;
    }, () => {});
    await src.load();
    expect(got.map((m) => m.t)).toEqual(['welcome', 'snapshot']);
    // Feeds while the playhead is within the budget (900 ms): two 420 ms draws, then a third pushes it over.
    src.pump();
    expect(got.filter((m) => m.t === 'beat')).toHaveLength(3);
    expect(backlog).toBeGreaterThan(REPLAY_BUDGET_MS);
    backlog = 0;
    src.pump(); // the prompt is delivered, then the replay lingers on it
    expect(got[got.length - 1]!.t).toBe('prompt');
    idle = false;
    src.pump();
    expect(got[got.length - 1]!.t).toBe('prompt'); // the table is still busy
    idle = true;
    src.pump();
    clock.advance(PROMPT_LINGER_MS - 1);
    src.pump();
    expect(got[got.length - 1]!.t).toBe('prompt');
    clock.advance(2);
    src.pump();
    expect(got[got.length - 1]).toMatchObject({ t: 'beat', seq: 5 });
    expect(src.done).toBe(true);
  });
});

describe('replay rpc stub', () => {
  it('answers the lobby rpcs with empty lists and rejects deck import cleanly', async () => {
    const src = new ReplaySource('x.jsonl', { clock: new VirtualClock(), isIdle: () => true, speed: () => 1, backlogMs: () => 0 });
    await expect(src.rpc('decks.list')).resolves.toEqual([]);
    await expect(src.rpc('decks.import')).rejects.toThrow(/replay/);
  });
});

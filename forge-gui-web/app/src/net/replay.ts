/**
 * Replay a recorded session (`--record` JSONL: one server message per line) with no JVM and no socket
 * Acts and replies are no-ops; the recording already contains what happened next.
 *
 * Messages are fed "just in time", emulating the server's Pacer: the next one is delivered only while
 * the playhead is less than a budget behind, and after each real prompt the replay waits until the table
 * is idle and then lingers briefly, as a player would. Timing therefore depends only on the client's
 * clock: with the virtual clock, every run is frame-identical regardless of how the session was recorded.
 */
import type { ActMsg, ReplyMsg, RpcMethod, ServerMessage } from '@forge-table/protocol';
import type { Clock } from '../util/clock';
import type { ConnectionStatus, MessageSource } from './source';

/** The Pacer's default look-ahead (ms of play time). */
export const REPLAY_BUDGET_MS = 900;
/** How long a prompt stays up (ms of clock time) before the recorded answer arrives. */
export const PROMPT_LINGER_MS = 600;

export interface ReplayDeps {
  clock: Clock;
  /** Whether the Director has nothing queued or playing. */
  isIdle(): boolean;
  /** Current speed multiplier (0 = Instant). */
  speed(): number;
  /** Play time queued behind the playhead (ms). */
  backlogMs(): number;
}

export function parseJsonl(text: string): ServerMessage[] {
  const out: ServerMessage[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('>>')) continue;
    out.push(JSON.parse(s) as ServerMessage);
  }
  return out;
}

export class ReplaySource implements MessageSource {
  readonly kind = 'replay' as const;
  private messages: ServerMessage[] = [];
  private index = 0;
  private onMessage: (m: ServerMessage) => void = () => {};
  private lingerFrom: number | null = null;
  private waitingOnPrompt = false;
  /** Tests can pause feeding entirely. */
  paused = false;

  constructor(
    private readonly url: string,
    private readonly deps: ReplayDeps,
  ) {}

  start(onMessage: (m: ServerMessage) => void, onStatus: (s: ConnectionStatus) => void): void {
    this.onMessage = onMessage;
    onStatus('replay');
  }

  /** Fetch and parse the session. Resolves once the first snapshot has been delivered. */
  async load(): Promise<number> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`replay: ${res.status} fetching ${this.url}`);
    this.messages = parseJsonl(await res.text());
    this.onMessage({
      t: 'welcome',
      proto: 1,
      session: 'replay',
      forgeVersion: 'replay',
      features: ['pid', 'settle', 'replay'],
      match: true,
      defaults: { ai: 'Default' },
    });
    // Deliver everything up to and including the first snapshot.
    while (this.index < this.messages.length) {
      const m = this.messages[this.index++]!;
      this.onMessage(m);
      if (m.t === 'snapshot') break;
    }
    return this.messages.length;
  }

  get done(): boolean {
    return this.index >= this.messages.length;
  }

  get position(): { index: number; total: number } {
    return { index: this.index, total: this.messages.length };
  }

  pump(): void {
    if (this.paused) return;
    const now = this.deps.clock.now();
    while (this.index < this.messages.length) {
      if (this.waitingOnPrompt) {
        if (!this.deps.isIdle()) return;
        if (this.lingerFrom === null) this.lingerFrom = now;
        const speed = this.deps.speed();
        const linger = speed > 0 ? PROMPT_LINGER_MS / speed : 0;
        if (now - this.lingerFrom < linger) return;
        this.waitingOnPrompt = false;
        this.lingerFrom = null;
      }
      if (this.deps.backlogMs() > REPLAY_BUDGET_MS) return;
      const m = this.messages[this.index++]!;
      this.onMessage(m);
      if ((m.t === 'prompt' || m.t === 'promptUpdate') && m.kind !== 'waiting') this.waitingOnPrompt = true;
      // A lone ability menu was answered by the recording client without showing it (runtime.isLoneAbility).
      if (m.t === 'ask' && !(m.kind === 'ability' && m.items.length === 1 && m.items[0]!.enabled !== false)) this.waitingOnPrompt = true;
    }
  }

  act(_msg: ActMsg): void {}
  reply(_msg: ReplyMsg): void {}
  ack(): void {}
  async rpc<T = unknown>(method: RpcMethod): Promise<T> {
    if (method === 'decks.list' || method === 'ai.profiles') return [] as unknown as T;
    if (method === 'decks.import') throw new Error('Deck import needs a live server; this is a replay.');
    return {} as T;
  }
  close(): void {
    this.index = this.messages.length;
  }
}

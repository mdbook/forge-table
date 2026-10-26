/**
 * Where server messages come from and where client messages go: the live WebSocket or a recorded replay.
 * The rest of the client only sees this interface.
 */
import type { ActMsg, ReplyMsg, RpcMethod, ServerMessage } from '@forge-table/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'replay';

export interface MessageSource {
  readonly kind: 'live' | 'replay';
  /** Start delivering messages to `onMessage`. */
  start(onMessage: (m: ServerMessage) => void, onStatus: (s: ConnectionStatus) => void): void;
  act(msg: ActMsg): void;
  reply(msg: ReplyMsg): void;
  rpc<T = unknown>(method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
  /** Report playback progress (the ack), sent from a timer at ~20 Hz. */
  ack(playedSeq: number, backlogMs: number, hidden: boolean): void;
  /** Replays only: feed more messages when the playhead has room (called every frame). */
  pump?(): void;
  close(): void;
}

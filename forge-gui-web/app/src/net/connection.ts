/**
 * The live WebSocket to the sidecar. Sends `hello` with the client's motion settings, keeps
 * the RPC table, and reconnects with backoff. A reconnect gets a fresh `welcome` + `snapshot`, which the
 * Director treats as a resume (collapse).
 */
import {
  PROTOCOL_VERSION,
  type ActMsg,
  type ClientInfo,
  type ClientMessage,
  type ReplyMsg,
  type RpcMethod,
  type RpcResultMsg,
  type ServerMessage,
} from '@forge-table/protocol';
import type { ConnectionStatus, MessageSource } from './source';

export interface ConnectionOptions {
  url: string;
  token: string;
  client: () => ClientInfo;
}

export class LiveConnection implements MessageSource {
  readonly kind = 'live' as const;
  private ws: WebSocket | null = null;
  private onMessage: (m: ServerMessage) => void = () => {};
  private onStatus: (s: ConnectionStatus) => void = () => {};
  private rpcSeq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private retry = 0;
  private outbox: string[] = [];

  constructor(private readonly opts: ConnectionOptions) {}

  start(onMessage: (m: ServerMessage) => void, onStatus: (s: ConnectionStatus) => void): void {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.onStatus('connecting');
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw({ t: 'hello', proto: PROTOCOL_VERSION, token: this.opts.token, client: this.opts.client() });
      this.onStatus('open');
      for (const m of this.outbox.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'rpcResult') {
        this.settleRpc(msg);
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.onStatus('closed');
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (this.closed || ev.code === 4001) return; // 4001: bad token, retrying can't help
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private raw(m: ClientMessage): void {
    const json = JSON.stringify(m);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(json);
    else if (m.t !== 'ack' && m.t !== 'hello') this.outbox.push(json);
  }

  private settleRpc(m: RpcResultMsg): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error ?? 'rpc failed'));
  }

  act(msg: ActMsg): void {
    this.raw(msg);
  }

  reply(msg: ReplyMsg): void {
    this.raw(msg);
  }

  rpc<T = unknown>(method: RpcMethod, params?: Record<string, unknown>): Promise<T> {
    const id = `r${++this.rpcSeq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.raw({ t: 'rpc', id, method, params: params ?? {} });
    });
  }

  ack(playedSeq: number, backlogMs: number, hidden: boolean): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.raw({ t: 'ack', playedSeq, backlogMs: Math.round(backlogMs), hidden });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/**
 * The lobby's Admin sheet (admins only; the server checks every admin call itself): the server at a glance, every
 * user's games (who plays whom, with what, how far along, who is at the table) with an End per row, and, set apart at
 * the bottom, "Update now", which warns every open game, ends them all after a countdown and restarts the server.
 */
import { useState } from 'react';
import { STATUS_LABEL, type AdminList, type AdminMatch, type AdminServer, type LobbyApi } from './api';
import { Art } from './Art';
import { aiName } from './home';
import { AiPhoto } from './people';
import { ageText } from './pvp';

/** The warning games get before "Update now" ends them (the server's default countdown). */
export const UPDATE_COUNTDOWN_S = 60;

/** The Update now confirmation: how many games end, and when. */
export function updateConfirmText(n: number): string {
  if (n === 0) return 'Restart the server now? No game is open.';
  return `Restart the server now? ${n === 1 ? '1 game' : `${n} games`} will end in ${UPDATE_COUNTDOWN_S} s (the players are warned).`;
}

/** How long something has been going: "40 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function spanText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** What kind of game a row is: against the AI, a friend, or a friend who came in as a guest. */
export function adminMode(m: AdminMatch): 'ai' | 'friend' | 'guest' {
  if (m.mode !== 'pvp') return 'ai';
  return m.players?.some((p) => p.guest) ? 'guest' : 'friend';
}

const MODE_LABEL = { ai: 'AI', friend: 'Friend', guest: 'Guest' } as const;

/** One side of a game: who, whether they're at the table (null: the AI, always there), their deck and its key card. */
interface Side {
  name: string;
  /** The Neural AI's seat (its picture, when the server has one). */
  neural?: boolean;
  you?: boolean;
  connected: boolean | null;
  deck?: string;
  card?: string;
  life?: number;
  turn?: boolean;
}

/** A row's two sides, seat 0 first. An older server sends no players: the owner alone, connected as the game is. */
export function adminSides(m: AdminMatch, me: string | undefined, neuralLabel: string | undefined): [Side, Side | null] {
  const seats = m.table?.seats ?? [];
  const at = (seat: number) => ({
    ...(seats[seat]?.deck !== undefined ? { deck: seats[seat]!.deck } : {}),
    ...(seats[seat]?.key !== undefined ? { card: seats[seat]!.key } : {}),
    ...(seats[seat] ? { life: seats[seat]!.life } : {}),
    ...(m.table ? { turn: m.table.active === seat } : {}),
  });
  const players = m.players ?? [{ seat: 0 as const, name: m.owner, connected: m.connected }];
  const p0 = players.find((p) => p.seat === 0) ?? players[0]!;
  const first: Side = { name: p0.name, connected: p0.connected, ...(me !== undefined && p0.name === me ? { you: true } : {}), ...at(0) };
  if (m.mode !== 'pvp') return [first, { name: aiName(m.ai, neuralLabel), ...(m.ai === 'Neural' ? { neural: true } : {}), connected: null, ...at(1) }];
  const p1 = players.find((p) => p.seat === 1);
  if (!p1) return [first, null];
  return [first, { name: p1.name, connected: p1.connected, ...(me !== undefined && p1.name === me ? { you: true } : {}), ...at(1) }];
}

/** The row's state, in words: the turn, the boot, the wait, or the plain status (a crash says why). */
export function adminState(m: AdminMatch): { text: string; sub?: string; warn?: boolean } {
  if (m.status === 'playing' && m.table) return { text: `Turn ${m.table.turn}` };
  if (m.waiting) return { text: 'Waiting for a friend', ...(m.guests ? { sub: 'Guests allowed' } : {}) };
  if (m.status === 'starting' && m.progress) return { text: `${m.progress.label} · ${Math.round(m.progress.pct)}%` };
  if (m.status === 'crashed') return { text: m.error ? `Crashed: ${m.error}` : STATUS_LABEL.crashed, warn: true };
  return { text: STATUS_LABEL[m.status] };
}

function Dot({ on }: { on: boolean | null }) {
  if (on === null) return null;
  return <span className={`pdot ${on ? 'online' : 'away'}`} role="img" aria-label={on ? 'at the table' : 'not connected'} title={on ? 'At the table' : 'Not connected'} />;
}

function Player({ side, photo }: { side: Side; photo?: string }) {
  return (
    <span className={`ag-player${side.connected === null ? ' ai' : ''}`}>
      <Dot on={side.connected} />
      {side.neural && <AiPhoto src={photo} alt={side.name} className="vs-photo" fallback={null} />}
      <b>{side.name}</b>
      {side.you && <span className="you"> (you)</span>}
    </span>
  );
}

/** The server strip: build, uptime, games against the cap, people online, guests, and whether it is restarting. */
function ServerStrip({ s, list, now }: { s: AdminServer | undefined; list: AdminList; now: number }) {
  const state =
    list.restartIn !== undefined ? { text: `Restarting in ${list.restartIn} s`, cls: 'warn' }
    : list.draining ? { text: 'Draining', cls: 'warn' }
    : { text: 'Running', cls: 'ok' };
  return (
    <dl className="admin-server" data-testid="admin-server">
      <div className={`as-item as-state ${state.cls}`}>
        <dt>Server</dt>
        <dd>
          <span className={`pdot ${state.cls === 'ok' ? 'online' : 'playing'}`} aria-hidden="true" />
          {state.text}
        </dd>
      </div>
      {s && (
        <>
          <div className="as-item">
            <dt>Up</dt>
            <dd>{spanText(now - s.started)}</dd>
          </div>
          <div className={`as-item${s.games >= s.maxMatches ? ' warn' : ''}`}>
            <dt>Games</dt>
            <dd>
              {s.games} <span className="of">/ {s.maxMatches}</span>
            </dd>
          </div>
          <div className="as-item">
            <dt>Online</dt>
            <dd>{s.online}</dd>
          </div>
          <div className="as-item">
            <dt>Per person</dt>
            <dd>{s.maxPerUser}</dd>
          </div>
          <div className="as-item">
            <dt>Guests</dt>
            <dd>{s.guests ? 'Allowed' : 'Off'}</dd>
          </div>
          <div className="as-item as-build" title={s.builtAt ? `Built ${s.builtAt}` : undefined}>
            <dt>Build</dt>
            <dd>
              <code>{s.build.slice(0, 8)}</code>
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

export function AdminSection({
  isAdmin,
  me,
  now,
  list,
  api,
  neuralLabel,
  neuralAvatar,
  onList,
  onError,
}: {
  /** From the lobby's own list: only admins see anything here. */
  isAdmin: boolean;
  /** My own name: my games are marked "you". */
  me?: string;
  /** The lobby's once-a-second clock (for the ages); the wall clock when absent. */
  now?: number;
  list: AdminList | null;
  api: LobbyApi;
  /** What the Neural AI is called here ("Lyra"). */
  neuralLabel?: string;
  /** The Neural AI's picture, when the server has one. */
  neuralAvatar?: string;
  onList: (l: AdminList) => void;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  if (!isAdmin) return null;
  const t = now ?? Date.now();

  const act = async (call: () => Promise<AdminList>) => {
    try {
      onList(await call());
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const end = (m: AdminMatch) => {
    if (confirming !== m.id) {
      setConfirming(m.id);
      return;
    }
    setConfirming(null);
    void act(() => api.adminEnd(m.id));
  };
  const live = list?.matches.filter((m) => m.status !== 'stopping' && m.status !== 'crashed' && m.status !== 'paused').length ?? 0;
  const counting = list?.restartIn !== undefined;

  const row = (m: AdminMatch) => {
    const mode = adminMode(m);
    const [a, b] = adminSides(m, me, neuralLabel);
    const state = adminState(m);
    const decks = [a.deck, b?.deck].filter(Boolean);
    const life = m.status === 'playing' && a.life !== undefined && b?.life !== undefined;
    const started = new Date(m.created).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return (
      <li key={m.id} className={`ag-row mode-${mode}`} data-testid={`admin-game-${m.id}`}>
        <span className="ag-art" aria-hidden="true">
          <Art card={a.card} colors="" cropUrl={(c) => api.cropUrl(c)} className="ag-crop" />
          <Art card={b?.card} colors="" cropUrl={(c) => api.cropUrl(c)} className="ag-crop" />
        </span>
        <div className="ag-who">
          <div className="ag-players">
            <span className={`ag-mode mode-${mode}`}>{MODE_LABEL[mode]}</span>
            <Player side={a} />
            <span className="ag-vs">vs</span>
            {b ? <Player side={b} photo={neuralAvatar} /> : <span className="ag-player empty">nobody yet</span>}
          </div>
          <div className="ag-decks">
            {decks.length > 0 ? decks.join('  ·  ') : m.format ? <span className="ag-format">{m.format}</span> : <span className="ag-none">No decks yet</span>}
            {decks.length > 0 && m.format && <span className="ag-format">{m.format}</span>}
          </div>
        </div>
        <div className="ag-meta">
          <div className="ag-state">
            <span className={state.warn ? 'warn' : ''} title={state.warn ? state.text : undefined}>
              {state.text}
            </span>
            {state.sub && <span className="ag-sub">{state.sub}</span>}
            {life && (
              <span className="ag-life" aria-label={`Life ${a.life} to ${b!.life}`} title="Life (whose turn it is in orange)">
                <b className={a.turn ? 'turn' : ''}>{a.life}</b>
                <i>–</i>
                <b className={b!.turn ? 'turn' : ''}>{b!.life}</b>
              </span>
            )}
          </div>
          <div className="ag-time">
            <span title={`Started ${started}`}>{ageText(m.created, t)}</span>
            {m.lastSeen !== undefined && <span className="ag-seen">nobody on · {spanText(t - m.lastSeen)}</span>}
          </div>
        </div>
        <div className="ag-end">
          {m.status !== 'stopping' && (
            <button className={`btn ghost${confirming === m.id ? ' confirming' : ''}`} data-testid="admin-end" onClick={() => end(m)} onBlur={() => setConfirming(null)}>
              {confirming === m.id ? 'End game?' : 'End'}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="lobby-admin" data-testid="lobby-admin">
      {list && <ServerStrip s={list.server} list={list} now={t} />}
      <div className="admin-h">
        <h3>Games</h3>
        {list && list.matches.length > 0 && <span className="count">{list.matches.length}</span>}
      </div>
      {!list ? (
        <div className="hint">Loading…</div>
      ) : list.matches.length === 0 ? (
        <div className="hint admin-empty">No games on the server.</div>
      ) : (
        <ul className="admin-games" data-testid="admin-games">
          {list.matches.map(row)}
        </ul>
      )}
      <div className="admin-danger" data-testid="admin-danger">
        <div className="ad-text">
          <h3>Update now</h3>
          {counting ? (
            <span className="hint warn" data-testid="admin-restarting">
              Restarting: games end in {list!.restartIn} s.
            </span>
          ) : confirmUpdate ? (
            <span className="hint warn" data-testid="admin-update-confirm">
              {updateConfirmText(live)}
            </span>
          ) : (
            <span className="hint">Warns every player, ends all games after {UPDATE_COUNTDOWN_S} s, then restarts the server.</span>
          )}
        </div>
        <div className="ad-actions">
          {!counting && confirmUpdate && (
            <button className="btn ghost" onClick={() => setConfirmUpdate(false)}>
              Cancel
            </button>
          )}
          {!counting && (
            <button
              className="btn danger"
              data-testid="admin-update"
              onClick={() => {
                if (!confirmUpdate) {
                  setConfirmUpdate(true);
                  return;
                }
                setConfirmUpdate(false);
                void act(() => api.updateNow());
              }}
            >
              {confirmUpdate ? 'Restart now' : 'Update now'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

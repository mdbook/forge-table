/**
 * `/g/join/<code>`: a link that lets guests in. Sign in (the usual `/join/<code>`, through the
 * login), or play as a guest: a name and one of the server's shared decks, then the table at `/g/<id>/`. Like
 * `/join/<code>`, the page says nothing about the code until it is used: the deck list is only asked for on "Play as
 * guest", and the join itself says whether the link still works. Only `/g/api/*` is called from here.
 */
import { useEffect, useState } from 'react';
import { type DeckList, type GuestApi } from './api';
import { DeckGallery } from './DeckGallery';
import { FAN_CONTENT } from '../hud/start';
import { rememberDeck } from './pvp';

/** How long the joined page waits for the table to answer before opening it anyway (it says "starting" itself). */
const WAIT_MS = 180_000;
const WAIT_STEP_MS = 1000;

/** What the Join button needs: a name with something in it and a deck. */
export function guestReady(name: string, deck: string): boolean {
  return name.trim().length > 0 && deck.length > 0;
}

/** Wait until the table answers (or the time is up), then go there. */
export async function openWhenUp(api: Pick<GuestApi, 'tableUp' | 'tableUrl'>, id: string, go: (url: string) => void, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), waitMs = WAIT_MS): Promise<void> {
  for (let waited = 0; waited < waitMs; waited += WAIT_STEP_MS) {
    if (await api.tableUp(id)) break;
    await sleep(WAIT_STEP_MS);
  }
  go(api.tableUrl(id));
}

export function GuestJoin({ api, code, initial = 'choose' }: { api: GuestApi; code: string; initial?: 'choose' | 'guest' }) {
  const [step, setStep] = useState<'choose' | 'guest'>(initial);
  /** The shared decks: undefined while loading. */
  const [decks, setDecks] = useState<DeckList | undefined>(undefined);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const deck = picked ?? decks?.names[0] ?? '';

  useEffect(() => {
    if (step !== 'guest') return;
    let alive = true;
    api.decks(code).then(
      (d) => alive && setDecks(d),
      (e: Error) => {
        if (!alive) return;
        setDecks({ names: [], details: {} });
        setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, code, step]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await api.join({ code, name: name.trim(), deck });
      rememberDeck(m.id, deck);
      setJoined(true);
      await openWhenUp(api, m.id, (url) => window.location.assign(url));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="start-screen lobby home join-page" data-testid="guest-page">
      <header className="home-head">
        <div className="brand">
          <img src="./favicon.svg" width={38} height={38} alt="" />
          <h1 className="name">Forge Table</h1>
        </div>
      </header>
      <div className="join-body">
        <div className="home-h">
          <h2>You’re invited</h2>
          <span className="home-sub">A friend wants to play Magic with you.</span>
        </div>
        {step === 'choose' && (
          <div className="join-actions">
            <a className="btn secondary" href={`/join/${encodeURIComponent(code)}`} data-testid="guest-signin">
              Sign in
            </a>
            <span className="ng-spacer" />
            <button className="btn primary cta" data-testid="guest-choose" onClick={() => setStep('guest')}>
              Play as guest
            </button>
          </div>
        )}
        {step === 'guest' && (
          <>
            <label className="guest-name">
              <span className="ng-label">Your name</span>
              <input className="field" value={name} maxLength={24} placeholder="What your friend sees" aria-label="Your name" data-testid="guest-name" onChange={(e) => setName(e.target.value)} />
            </label>
            {decks === undefined ? (
              <span className="hint">Loading decks…</span>
            ) : (
              <DeckGallery label="Your deck" names={decks.names} details={decks.details} selected={deck} onPick={setPicked} cropUrl={(c) => api.cropUrl(code, c)} />
            )}
            <span className="hint">You play as “{name.trim() || 'your name'} (guest)”, with one of this server’s decks. Nothing is saved.</span>
            {error && (
              <div className="error" role="alert" data-testid="join-error">
                {error}
              </div>
            )}
            {joined && <div className="hint" role="status">You’re in. The game opens by itself when it’s ready.</div>}
            <div className="join-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setStep('choose')}>
                Back
              </button>
              <span className="ng-spacer" />
              <button
                className="btn primary cta"
                disabled={busy || !guestReady(name, deck)}
                data-testid="guest-go"
                onClick={() => void join()}
              >
                {joined ? 'Joined…' : busy ? 'Joining…' : 'Join game'}
              </button>
            </div>
          </>
        )}
        <div className="hint fan-content">{FAN_CONTENT}</div>
      </div>
    </div>
  );
}

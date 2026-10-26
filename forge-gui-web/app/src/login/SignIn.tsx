/**
 * `/auth/login`: Forge Table's own sign-in page (native sign-in, `--auth users` and `oidc`). Username and password,
 * a button off to the OIDC provider, or both; then back to where you were going (`?next=`, which the server checks
 * again). Accounts are made by an admin or by a first OIDC sign-in; there is no sign-up.
 */
import { useState, type FormEvent } from 'react';
import { type SignInApi, type SignInMethods } from '../lobby/api';
import { FAN_CONTENT } from '../hud/start';

/** What the Sign in button needs: something in both fields. */
export function signInReady(login: string, password: string): boolean {
  return login.trim().length > 0 && password.length > 0;
}

/** What `?error=` says after an OIDC sign-in that didn't work: fixed words per code, never the URL's own text. */
export function oidcError(code: string | null): string | null {
  switch (code) {
    case 'oidc-stale':
      return 'That sign-in took too long or was started in another browser. Try again.';
    case 'oidc-denied':
      return 'The sign-in was cancelled.';
    case 'oidc-busy':
      return 'Signing in is busy right now. Try again in a moment.';
    case 'oidc-group':
      return 'Your account isn’t allowed on this Forge Table. Ask whoever runs it.';
    case 'oidc-taken':
      return 'That username already belongs to another account here. Ask whoever runs this Forge Table to link the two.';
    case 'oidc-off':
      return 'This account is turned off. Ask an admin to turn it back on.';
    case 'oidc-provider':
      return 'Signing in didn’t work. Try again, or ask whoever runs this Forge Table.';
    default:
      return null;
  }
}

/** The OIDC button's address: the start route, carrying `next`. */
export function oidcHref(start: string, next: string | null): string {
  return next ? `${start}?next=${encodeURIComponent(next)}` : start;
}

export function SignIn({ api, methods, next, error: initialError, go }: {
  api: SignInApi;
  methods: SignInMethods;
  next: string | null;
  error: string | null;
  go: (url: string) => void;
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !signInReady(login, password)) return;
    setBusy(true);
    setError(null);
    try {
      go(await api.signIn(login.trim(), password, next));
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="start-screen lobby home join-page" data-testid="signin-page">
      <header className="home-head">
        <div className="brand">
          <img src="./favicon.svg" width={38} height={38} alt="" />
          <h1 className="name">Forge Table</h1>
        </div>
      </header>
      <form className="join-body signin-body" onSubmit={(e) => void submit(e)}>
        <div className="home-h">
          <h2>Sign in</h2>
        </div>
        {methods.password && (
          <>
            <label className="guest-name">
              <span className="ng-label">Username</span>
              <input className="field" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={256} autoFocus value={login} data-testid="signin-login" onChange={(e) => setLogin(e.target.value)} />
            </label>
            <label className="guest-name">
              <span className="ng-label">Password</span>
              <input className="field" name="password" type="password" autoComplete="current-password" maxLength={1024} value={password} data-testid="signin-password" onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        {error && (
          <div className="error" role="alert" data-testid="signin-error">
            {error}
          </div>
        )}
        {methods.password && <span className="hint">No account? Ask whoever runs this Forge Table to make you one.</span>}
        <div className="join-actions">
          {methods.oidc && (
            <a className={`btn ${methods.password ? 'ghost' : 'primary cta'}`} href={oidcHref(methods.oidc.start, next)} data-testid="signin-oidc">
              {methods.oidc.label}
            </a>
          )}
          <span className="ng-spacer" />
          {methods.password && (
            <button type="submit" className="btn primary cta" disabled={busy || !signInReady(login, password)} data-testid="signin-go">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          )}
        </div>
        <div className="hint fan-content">{FAN_CONTENT}</div>
      </form>
    </div>
  );
}

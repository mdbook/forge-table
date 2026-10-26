import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LobbyApi, LobbyError, localPath, signInAgain, SignInApi, type Me } from '../lobby/api';
import { oidcError, oidcHref, SignIn, signInReady } from './SignIn';

function fakeFetch(status: number, body: string, calls: { url: string; init?: RequestInit }[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
}

const USERS: Me = { auth: 'users', login: 'ana', name: 'Ana', admin: false, signOut: '/auth/logout' };

describe('the sign-in page', () => {
  it('asks for a username and a password, with no sign-up', () => {
    const html = renderToStaticMarkup(createElement(SignIn, { api: new SignInApi(), methods: { password: true }, next: null, error: null, go: () => {} }));
    expect(html).toContain('data-testid="signin-login"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toMatch(/disabled=""[^>]*data-testid="signin-go"/);
    expect(html).not.toMatch(/sign up/i);
    expect(html).not.toContain('signin-oidc');
  });

  it('offers the OIDC button, alone or with the form, carrying next', () => {
    const oidc = { label: 'Sign in with SSO', start: '/auth/oidc/start' };
    const only = renderToStaticMarkup(createElement(SignIn, { api: new SignInApi(), methods: { password: false, oidc }, next: '/m/ab/', error: null, go: () => {} }));
    expect(only).toContain('href="/auth/oidc/start?next=%2Fm%2Fab%2F"');
    expect(only).toContain('Sign in with SSO');
    expect(only).not.toContain('signin-login');
    const both = renderToStaticMarkup(createElement(SignIn, { api: new SignInApi(), methods: { password: true, oidc }, next: null, error: null, go: () => {} }));
    expect(both).toContain('href="/auth/oidc/start"');
    expect(both).toContain('signin-login');
    expect(oidcHref('/auth/oidc/start', null)).toBe('/auth/oidc/start');
  });

  it('says why an OIDC sign-in came back, in its own words only', () => {
    expect(oidcError('oidc-taken')).toMatch(/already belongs to another account/);
    expect(oidcError('oidc-stale')).toMatch(/Try again/);
    expect(oidcError('<script>')).toBeNull();
    expect(oidcError(null)).toBeNull();
    const html = renderToStaticMarkup(createElement(SignIn, { api: new SignInApi(), methods: { password: true }, next: null, error: oidcError('oidc-off'), go: () => {} }));
    expect(html).toContain('turned off');
  });

  it('reads what the server offers, and falls back to the form', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await expect(new SignInApi(fakeFetch(200, '{"password":false,"oidc":{"label":"Go","start":"/auth/oidc/start"}}', calls)).methods())
      .resolves.toEqual({ password: false, oidc: { label: 'Go', start: '/auth/oidc/start' } });
    expect(calls[0]!.url).toBe('/auth/methods');
    await expect(new SignInApi(fakeFetch(200, '{"password":true,"oidc":{"label":"Go","start":"https://evil.example/"}}')).methods())
      .resolves.toEqual({ password: true, oidc: undefined });
    await expect(new SignInApi(fakeFetch(500, 'nope')).methods()).resolves.toEqual({ password: true });
  });

  it('needs something in both fields', () => {
    expect(signInReady('ana', 'pw')).toBe(true);
    expect(signInReady('  ', 'pw')).toBe(false);
    expect(signInReady('ana', '')).toBe(false);
  });

  it('posts the details and goes where the server says, on this site only', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await expect(new SignInApi(fakeFetch(200, '{"next":"/m/ab/"}', calls)).signIn('ana', 'pw', '/m/ab/')).resolves.toBe('/m/ab/');
    expect(calls[0]!.url).toBe('/auth/login');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ login: 'ana', password: 'pw', next: '/m/ab/' });
    await expect(new SignInApi(fakeFetch(200, '{"next":"//evil.example/"}')).signIn('ana', 'pw', null)).resolves.toBe('/');
  });

  it('shows the server’s words for wrong details', async () => {
    await expect(new SignInApi(fakeFetch(401, '{"error":"Wrong username or password."}')).signIn('ana', 'nope', null)).rejects.toThrow('Wrong username or password.');
  });
});

describe('signing out and back in', () => {
  it('keeps every redirect on this site', () => {
    expect(localPath('/join/abc')).toBe('/join/abc');
    expect(localPath('//evil.example')).toBe('/');
    expect(localPath('https://evil.example')).toBe('/');
    expect(localPath('/\\evil.example')).toBe('/');
    expect(localPath(42)).toBe('/');
  });

  it('signs out natively and lands on the sign-in page', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await expect(new LobbyApi(null, fakeFetch(200, '{"next":"/auth/login"}', calls)).signOut()).resolves.toBe('/auth/login');
    expect(calls[0]!.url).toBe('/auth/logout');
    expect(calls[0]!.init?.method).toBe('POST');
    await expect(new LobbyApi(null, fakeFetch(200, '{"next":"//evil.example"}')).signOut()).resolves.toBe('/auth/login');
  });

  it('goes on to the provider’s sign-out page when the server says so', async () => {
    const end = 'https://idp.example/end?client_id=ft&post_logout_redirect_uri=https%3A%2F%2Fft.example%2Fauth%2Flogin';
    await expect(new LobbyApi(null, fakeFetch(200, JSON.stringify({ next: '/auth/login', endSession: end }))).signOut()).resolves.toBe(end);
    await expect(new LobbyApi(null, fakeFetch(200, '{"next":"/auth/login","endSession":"javascript:alert(1)"}')).signOut()).resolves.toBe('/auth/login');
  });

  it('sends a signed-out page to the sign-in page only with native sign-in', () => {
    const gone = new LobbyError('not signed in', 401);
    expect(signInAgain(USERS, gone, { pathname: '/', search: '' })).toBe('/auth/login');
    expect(signInAgain(USERS, gone, { pathname: '/join/abc', search: '?x=1' })).toBe('/auth/login?next=%2Fjoin%2Fabc%3Fx%3D1');
    expect(signInAgain(USERS, new LobbyError('no', 403), { pathname: '/', search: '' })).toBeNull();
    expect(signInAgain({ ...USERS, auth: 'header' }, gone, { pathname: '/', search: '' })).toBeNull();
    expect(signInAgain(null, gone, { pathname: '/', search: '' })).toBeNull();
  });
});

import '@fontsource-variable/inter/wght.css';
import '@fontsource/barlow-condensed/600.css';
import '../styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { takeToken } from '../net/token';
import { GuestApi, LobbyApi } from './api';
import { GuestJoin } from './Guest';
import { Lobby } from './Lobby';
import { guestCodeFromPath, joinCodeFromPath } from './pvp';

const root = createRoot(document.getElementById('root')!);
// A guest link (/g/join/<code>) has no login: its page only ever calls /g/api/*.
const guestCode = guestCodeFromPath(window.location.pathname);
if (guestCode) {
  root.render(
    <StrictMode>
      <GuestJoin api={new GuestApi()} code={guestCode} />
    </StrictMode>,
  );
} else {
  // Local mode: the router's link carries #t=… (kept for the session); behind a proxy login there is none.
  const api = new LobbyApi(takeToken(window.location, window.history, false));
  root.render(
    <StrictMode>
      <Lobby api={api} joinCode={joinCodeFromPath(window.location.pathname)} />
    </StrictMode>,
  );
}

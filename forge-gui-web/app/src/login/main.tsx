import '@fontsource-variable/inter/wght.css';
import '@fontsource/barlow-condensed/600.css';
import '../styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SignInApi } from '../lobby/api';
import { oidcError, SignIn } from './SignIn';

const api = new SignInApi();
const params = new URLSearchParams(window.location.search);
void api.methods().then((methods) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SignIn api={api} methods={methods} next={params.get('next')} error={oidcError(params.get('error'))} go={(url) => window.location.replace(url)} />
    </StrictMode>,
  ),
);

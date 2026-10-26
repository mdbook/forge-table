// Synthetic human-vs-human sessions for the PvP goldens (replay.spec.ts goldens 44-46).
// They reuse the ward board (sessions/ward-fx.jsonl) with the opponent as a person named Sam and add what a PvP
// sidecar sends: welcome.pvp, `{t:'pvp',kind:'lobby'}` and `{t:'pvp',kind:'presence'}`.
//   pvp-start.jsonl  the start screen: Mik has chosen a deck, Sam is still choosing
//   pvp-wait.jsonl   Sam holds priority (a waiting bar for Mik): "Waiting for Sam…" on his plate
//   pvp-away.jsonl   Sam dropped long ago: the banner with Claim win unlocked (claimableAt 120001 is rewritten by
//                    the spec to a time ahead to see the countdown)
// node tests/fixtures/make-pvp.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions');
const snap = JSON.parse(readFileSync(path.join(dir, 'ward-fx.jsonl'), 'utf8').split('\n')[0]);

snap.game.title = 'PvP';
snap.game.priority = 'p1';
snap.players.p0.name = 'Mik';
snap.players.p1.name = 'Sam';
delete snap.players.p1.isAI;
// Sam's board has hexproof / ward showcase cards; fine for a table, but his hand stays hidden (xh ids).

const pvp = (o) => ({ seat: 0, you: 'Mik', opponent: 'Sam', oppReady: true, youReady: true, ...o });
const welcome = (match, lobby) => ({ t: 'welcome', proto: 1, session: 'pvp', forgeVersion: 'replay', features: ['pid', 'settle', 'replay'], match, defaults: { ai: 'Default' }, pvp: lobby });
const lobbyMsg = (l) => ({ t: 'pvp', kind: 'lobby', you: l.you, opponent: l.opponent, oppReady: l.oppReady, youReady: l.youReady });
const waiting = { t: 'prompt', seq: 1, pid: 1, kind: 'waiting', seat: 'p0', message: '', ok: { label: '', enabled: false }, cancel: { label: '', enabled: false }, focusOk: false, selectable: [], highlighted: [], weak: {} };
const write = (name, msgs) => writeFileSync(path.join(dir, name), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');

const choosing = pvp({ oppReady: false });
write('pvp-start.jsonl', [welcome(false, pvp({ opponent: null, oppReady: false, youReady: false })), lobbyMsg(pvp({ oppReady: false, youReady: false })), lobbyMsg(choosing)]);
write('pvp-wait.jsonl', [welcome(true, pvp()), snap, waiting, { t: 'pvp', kind: 'presence', opponentConnected: true, since: 1 }]);
write('pvp-away.jsonl', [welcome(true, pvp()), snap, waiting, { t: 'pvp', kind: 'presence', opponentConnected: false, since: 1, claimableAt: 120001 }]);

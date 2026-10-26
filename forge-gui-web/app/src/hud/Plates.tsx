/**
 * Avatar plates (MTGA-style): a round avatar disc (the player's monogram) with the life total in a
 * shield on its lower edge, and beside it the name, hand and library counts, player counters and floating mana.
 * Priority, targetable and picked rings sit on the disc: ember for me, steel for the opponent. Mine is at the
 * bottom left (it grows upward), the opponent's at the top centre. Clicking a plate sends `act{player}` (targets,
 * Phyrexian life payments).
 */
import { msGlyph } from '../theme/manaFont';
import { useEffect, useRef, useState } from 'react';
import type { PlayerId } from '@forge-table/protocol';
import { runtime } from '../runtime';
import { opponentOf } from '../store/model';
import { pickBadge, picksOf } from '../table/selection';
import { useUi } from '../store/uiStore';
import { pip } from '../theme/tokens';
import { PickBadge } from '../overlays/PickBadge';
import { PLATE } from '../layout/geometry';
import { at, atC, useGeo } from './pos';
import { lifeChip, lowLife } from './life';
import { OppWaiting } from './PvpHud';
import { LastingChip, LastingRail } from './LastingRail';
import { aiLabel, NEURAL, showsNeuralPhoto } from './start';
import { AiPhoto } from '../lobby/people';

function LifeNumber({ player }: { player: PlayerId }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rt = runtime();
    let last = Number.NaN;
    return rt.onFrame((now) => {
      const el = ref.current;
      if (!el) return;
      const shown = rt.director.displayLife(player, now);
      const target = rt.director.shown.players[player]?.life ?? shown;
      if (shown !== last) {
        el.textContent = String(shown);
        last = shown;
      }
      const cls = shown > target ? 'down' : shown < target ? 'up' : '';
      const want = `plate-life num${cls ? ` ${cls}` : ''}`;
      if (el.className !== want) {
        el.className = want;
        // The whole plate pulses while the total rolls: red and a jolt on a loss, a green glow on a gain.
        const plate = el.closest('.plate');
        plate?.classList.toggle('plate-hit', cls === 'down');
        plate?.classList.toggle('plate-heal', cls === 'up');
      }
    });
  }, [player]);
  const life = useUi((s) => s.shown.players[player]?.life ?? 0);
  return (
    <div ref={ref} className="plate-life num" data-testid={`life-${player}`}>
      {life}
    </div>
  );
}

type Chip = { id: number; text: string; tone: 'loss' | 'gain' };

/**
 * Life changes at the playhead (MTGA juice): each one throws a chip ("−3" / "+2") that rises off the shield and
 * fades, and flashes the shield red or green (styles.css .life-chip, .shield-flash). A snapshot or a collapse (Skip)
 * jumps the total without one. The newest few are kept; each goes when its animation ends.
 */
function useLifeChips(player: PlayerId): [Chip[], (id: number) => void] {
  const [chips, setChips] = useState<Chip[]>([]);
  useEffect(() => {
    const rt = runtime();
    let prev: number | undefined;
    let collapsed = rt.director.collapsedAt;
    let n = 0;
    return rt.onFrame(() => {
      const d = rt.director;
      const life = d.shown.players[player]?.life;
      const jumped = d.collapsedAt !== collapsed;
      collapsed = d.collapsedAt;
      const chip = prev !== undefined && life !== undefined && !jumped ? lifeChip(prev, life) : null;
      if (chip) setChips((cs) => [...cs.slice(-2), { id: ++n, ...chip }]);
      prev = life;
    });
  }, [player]);
  return [chips, (id) => setChips((cs) => cs.filter((c) => c.id !== id))];
}

function ManaPool({ mana }: { mana: Record<string, number> | undefined }) {
  const entries = Object.entries(mana ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="mana-pool">
      {entries.map(([c, n]) => {
        const style = (pip as Record<string, { fill: string; glyph: string }>)[c] ?? pip.generic;
        return (
          <span key={c} className="mana-chip num" style={{ background: style.fill, color: style.glyph }} aria-label={`${n} ${c}`}>
            {msGlyph(c) ? <span className="ms">{msGlyph(c)}</span> : `${c} `}
            {n}
          </span>
        );
      })}
    </div>
  );
}

/** Player counters by Forge's CounterType name: short labels; poison is drawn in red (QA: they showed nowhere). */
const PLAYER_COUNTERS: Record<string, string> = { POISON: 'Poison', ENERGY: 'Energy', EXPERIENCE: 'Exp', RAD: 'Rad', TICKET: 'Tickets' };

function PlayerCounters({ counters }: { counters: Record<string, number> | undefined }) {
  return (
    <>
      {Object.entries(counters ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => (
          <span key={k} className={`plate-counter ${k.toLowerCase()}`} data-testid={`player-counter-${k.toLowerCase()}`}>
            {PLAYER_COUNTERS[k] ?? k.charAt(0) + k.slice(1).toLowerCase()}
            <b>{n}</b>
          </span>
        ))}
    </>
  );
}

/** The avatar's monogram: the first letter of the player's name (a deck name for the AI). */
function monogram(name: string): string {
  return (name.match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();
}

function Plate({ player, mine }: { player: PlayerId; mine: boolean }) {
  const p = useUi((s) => s.shown.players[player]);
  const game = useUi((s) => s.shown.game);
  const prompt = useUi((s) => s.prompt);
  const blocked = useUi((s) => s.asks.length > 0);
  // A dragged attacker can be dropped here (arrows/controller.ts): outlined like a target.
  const drop = useUi((s) => s.dropPlates.includes(player));
  const { PLATES, H, W, hudPortrait } = useGeo();
  const [chips, dropChip] = useLifeChips(player);
  // The Neural AI's seat shows its picture when the sidecar has one; every other seat its monogram.
  const photo = useUi((s) => showsNeuralPhoto(s.welcome, s.matchAi, s.shown.players[player]?.isAI));
  if (!p) return null;
  const priority = game.priority === player;
  const turn = game.playerTurn === player;
  // A player already picked (a chosen target, a chosen player) gets the same pick treatment as a card.
  const pick = pickBadge(player, picksOf(prompt));
  const targetable = (!blocked && prompt?.kind === 'chooseTargets' && !pick) || drop;
  const cls = ['plate', mine ? 'mine' : 'opp', priority ? 'priority' : '', targetable ? 'targetable' : '', pick ? 'picked' : '', turn ? 'turn' : '', lowLife(p.life) ? 'low-life' : ''].filter(Boolean).join(' ');
  const last = chips[chips.length - 1];
  const name = p.lobbyPlayerName ?? p.name ?? player;
  // Landscape: mine hangs from its bottom-left corner (styles.css), the opponent's from its top centre, so a bigger
  // HUD or a mana pool grows the plate away from the table's edge. Portrait: top-left in its strip.
  const style = hudPortrait
    ? at((mine ? PLATES.mine : PLATES.opp).x, (mine ? PLATES.mine : PLATES.opp).y)
    : mine
      ? at(PLATE.x, H - PLATE.bottom)
      : atC(W / 2, PLATES.opp.y);
  return (
    <div
      className={cls}
      style={style}
      data-testid={`plate-${mine ? 'me' : 'opp'}`}
      data-player={player}
      onClick={() => runtime().clickPlayer(player)}
    >
      <div className="plate-avatar">
        <AiPhoto
          src={photo ? runtime().neuralAvatarUrl : null}
          alt={aiLabel(NEURAL)}
          className="plate-photo"
          fallback={
            <span className="plate-monogram" aria-hidden="true">
              {monogram(name)}
            </span>
          }
        />
        <div className="plate-shield">
          {last && <span key={last.id} className={`shield-flash ${last.tone}`} aria-hidden="true" />}
          <LifeNumber player={player} />
        </div>
        {chips.map((c) => (
          <span key={c.id} className={`life-chip num ${c.tone}`} aria-hidden="true" onAnimationEnd={() => dropChip(c.id)}>
            {c.text}
          </span>
        ))}
      </div>
      <div className="plate-info">
        <div className="plate-name">
          <span className={`turn-dot${turn ? ' on' : ''}`} />
          {name}
          {p.isAI ? ' · AI' : ''}
        </div>
        <div className="plate-counts">
          <span>
            Hand<b>{p.zones.hand?.length ?? 0}</b>
          </span>
          <span>
            Library<b>{p.zones.library?.length ?? 0}</b>
          </span>
          <PlayerCounters counters={p.counters} />
          {hudPortrait && <LastingChip player={player} />}
        </div>
        <ManaPool mana={p.mana} />
        {!mine && <OppWaiting name={name} />}
      </div>
      {pick && <PickBadge label={pick} testId={`plate-pick-${mine ? 'me' : 'opp'}`} />}
      {!hudPortrait && <LastingRail player={player} mine={mine} />}
    </div>
  );
}

export function Plates() {
  const viewer = useUi((s) => s.viewer);
  const shown = useUi((s) => s.shown);
  const opp = opponentOf(shown, viewer);
  return (
    <>
      {opp && <Plate player={opp} mine={false} />}
      <Plate player={viewer} mine />
    </>
  );
}

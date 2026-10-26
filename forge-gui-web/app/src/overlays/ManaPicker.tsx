/**
 * The mana picker ("a selector for mana that's not just a dropdown; take inspiration from MTGA"): big round
 * mana symbols fanned in an arc over the source card on the table, popping out of it in a quick cascade. Replaces
 * the list for a mana ability menu or a colour choice (manaChoice.ts); a non-mana ability menu keeps its list.
 * Keys: W U B R G C pick that colour, 1–9 the n-th symbol, ← → move between them, Esc cancels when allowed.
 *
 * `ManaPromptPicker` is the same picker for Forge's two-colour choice, which is a confirm prompt rather than an ask:
 * its symbols press the prompt's OK / Cancel (the engine labels them with the two colours).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { CardId } from '@forge-table/protocol';
import { parseSymbol } from '../cards/mana';
import { pipView } from '../hud/ManaText';
import { runtime } from '../runtime';
import { msGlyph } from '../theme/manaFont';
import { pip as pipColors } from '../theme/tokens';
import { useUi } from '../store/uiStore';
import { hudScale } from './askCards';
import { manaPickForPrompt, type ManaOption, type ManaPick } from './manaChoice';
import { useBattlefieldPeek } from './BattlefieldPeek';

/** Where the arc sits: its centre (the source card's centre, or a fallback point) and the card's height, in px. */
interface Anchor {
  x: number;
  y: number;
  h: number;
}

function cardAnchor(card: CardId | null): Anchor | null {
  if (!card) return null;
  const rt = runtime();
  const pose = rt.scene.poseOf(card);
  if (!pose) return null;
  const c = rt.scene.screenPoint(pose.x, pose.y);
  const top = rt.scene.screenPoint(pose.x, pose.y - pose.h / 2);
  return { x: c.x, y: c.y, h: 2 * (c.y - top.y) };
}

/** No source card on the table: over the cost being paid (the cost tracker), else the middle of the screen. */
function fallbackAnchor(): Anchor {
  const el = typeof document !== 'undefined' ? document.querySelector('[data-testid="cost-tracker"]') : null;
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top - 40 * hudScale(), h: 0 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight * 0.55, h: 0 };
}

/** The orb's look: the colour's pip for one symbol, a split disc for "W or U", the WUBRG wheel for any colour. */
function orb(o: ManaOption): { glyphs: string; css: CSSProperties; glow: string } {
  const syms = o.symbols;
  if (syms[0] === 'any') {
    const wheel = `conic-gradient(${['W', 'U', 'B', 'R', 'G'].map((c, i) => `${pipColors[c as 'W'].fill} ${i * 72}deg ${(i + 1) * 72}deg`).join(', ')})`;
    return { glyphs: msGlyph('multicolor') ?? '★', css: { background: wheel, color: '#fff' }, glow: '#ffe3b0' };
  }
  const views = syms.map((s) => pipView(parseSymbol(s)));
  const fill = (s: string) => (pipColors as Record<string, { fill: string }>)[s]?.fill ?? pipColors.generic.fill;
  if (o.or && syms.length === 2) {
    const [a, b] = syms as [string, string];
    return {
      glyphs: (views[0]?.glyphs ?? a) + (views[1]?.glyphs ?? b),
      css: { background: `linear-gradient(135deg, ${fill(a)} 50%, ${fill(b)} 50%)`, color: '#1b1b1b' },
      glow: fill(b),
    };
  }
  const v = views[0];
  return { glyphs: syms.map((_, i) => views[i]?.glyphs ?? syms[i]).join(''), css: v?.css ?? { background: fill(syms[0]!), color: '#1b1b1b' }, glow: fill(syms[0]!) };
}

/**
 * Arc geometry: each orb's offset from the anchor. The fan opens at least 70° (two orbs on a narrow arc would touch),
 * wide enough that neighbours never overlap, and `drop` lowers the whole arc so it sits on the source card's own face
 * (its name line stays visible and the card row above is left alone) rather than rising off the top of it.
 */
function arc(n: number, radius: number, drop: number): Array<{ dx: number; dy: number }> {
  const spread = n > 1 ? Math.min(160, Math.max(70, (n - 1) * 40)) : 0;
  return Array.from({ length: n }, (_, i) => {
    const a = ((-90 - spread / 2 + (n > 1 ? (i * spread) / (n - 1) : 0)) * Math.PI) / 180;
    return { dx: Math.cos(a) * radius, dy: Math.sin(a) * radius + drop };
  });
}

export function ManaPicker({ pick, onPick, onCancel, testid = 'mana-picker' }: { pick: ManaPick; onPick: (o: ManaOption) => void; onCancel: (() => void) | null; testid?: string }) {
  const reduced = useUi((s) => s.reducedMotion);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  useLayoutEffect(() => {
    setAnchor(cardAnchor(pick.card) ?? fallbackAnchor());
  }, [pick.card]);
  const peek = useBattlefieldPeek(true, 'mana choice');

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const k = e.key.toUpperCase();
      const n = Number.parseInt(e.key, 10);
      const byColor = pick.options.find((o) => o.hotkey === k && o.enabled);
      const byNum = n >= 1 && n <= 9 ? pick.options[n - 1] : undefined;
      let hit: ManaOption | undefined;
      if (byColor) hit = byColor;
      else if (byNum?.enabled) hit = byNum;
      if (hit) onPick(hit);
      else if (e.key === 'Escape' && onCancel) onCancel();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const i = refs.current.findIndex((b) => b === document.activeElement);
        const j = (i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1) + pick.options.length) % pick.options.length;
        refs.current[j]?.focus();
      } else if (e.key !== 'Escape' && e.key !== 'Backspace') return;
      // Esc / Backspace never fall through to the table (they would press the prompt's Cancel: a colour, in a prompt).
      e.preventDefault();
      e.stopPropagation();
    };
    // Capture: ahead of the table's own keys (Actions.tsx useKeyboard), which a prompt-based picker leaves on.
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [pick, onPick, onCancel]);

  if (!anchor) return null;
  const hs = hudScale();
  const size = Math.round(66 * hs);
  const n = pick.options.length;
  // Radius: a card-sized fan, but never so tight that neighbouring orbs (size + 15% gap) overlap.
  const spread = n > 1 ? Math.min(160, Math.max(70, (n - 1) * 40)) : 0;
  const apart = n > 1 ? (size * 1.15) / (2 * Math.sin(((spread / (n - 1)) * Math.PI) / 360)) : 0;
  const radius = Math.max(apart, anchor.h * 0.42, 64 * hs);
  const spots = arc(n, radius, anchor.h * 0.2);
  // Keep the whole fan on screen.
  const margin = size * 0.8;
  const minDx = Math.min(...spots.map((s) => s.dx));
  const maxDx = Math.max(...spots.map((s) => s.dx));
  const minDy = Math.min(...spots.map((s) => s.dy));
  const maxDy = Math.max(...spots.map((s) => s.dy));
  // The title goes under the fan when there's a source card and room (over a neighbour's name line is worse than over
  // its rules text); with no card it stays above, clear of the cost tracker below.
  const underH = 40 * hs;
  const titleBelow = anchor.h > 0 && anchor.y + maxDy + size / 2 + underH + (onCancel ? 34 * hs : 0) < window.innerHeight - 8;
  const x = Math.min(window.innerWidth - margin - maxDx, Math.max(margin - minDx, anchor.x));
  const y = Math.max(margin + (titleBelow ? 0 : 34 * hs) - minDy, Math.min(window.innerHeight - margin - maxDy, anchor.y));
  const titleTop = titleBelow ? maxDy + size / 2 + 6 * hs : minDy - size * 0.5 - 30 * hs;
  const cancelTop = maxDy + size / 2 + 6 * hs + (titleBelow ? 34 * hs : 0);
  return (
    <div className={`mana-pick-layer${reduced ? ' rm' : ''}${peek.className}`} inert={peek.inert} data-testid={testid} onPointerDown={(e) => e.target === e.currentTarget && onCancel?.()}>
      <div className="mana-pick" style={{ left: x, top: y }} role="group" aria-label={pick.title || 'Choose mana'}>
        <div className="mana-pick-title" style={{ top: titleTop }}>
          {pick.title}
        </div>
        {pick.options.map((o, i) => {
          const v = orb(o);
          const s = spots[i]!;
          return (
            <button
              key={o.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className={`mana-pick-btn${o.symbols.length > 1 && !o.or ? ' multi' : ''}`}
              style={{ '--dx': `${s.dx}px`, '--dy': `${s.dy}px`, '--i': i, '--glow': v.glow, width: size, height: size } as CSSProperties}
              disabled={!o.enabled}
              aria-label={o.label}
              aria-keyshortcuts={[o.hotkey, i < 9 ? String(i + 1) : null].filter(Boolean).join(' ')}
              data-testid={`mana-option-${i}`}
              onClick={() => onPick(o)}
            >
              <span className="mana-orb" style={v.css}>
                {v.glyphs}
              </span>
              {o.note && <span className="mana-pick-note">{o.note}</span>}
              <span className="mana-pick-key num">{o.hotkey ?? (i < 9 ? i + 1 : '')}</span>
            </button>
          );
        })}
        {onCancel && (
          <button className="btn chip ghost mana-pick-cancel" style={{ top: cancelTop }} data-testid="mana-cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** Forge's two-colour choice (a confirm prompt whose buttons are the colours), as the picker over its source. */
export function ManaPromptPicker() {
  const prompt = useUi((s) => s.prompt);
  const asks = useUi((s) => s.asks);
  const pick = asks.length === 0 ? manaPickForPrompt(prompt) : null;
  if (!pick || !prompt) return null;
  return (
    <ManaPicker
      key={prompt.pid}
      pick={pick}
      testid="mana-prompt-picker"
      onPick={(o) => 'act' in o.reply && runtime().press({ label: o.label, enabled: true, action: o.reply.act })}
      onCancel={null}
    />
  );
}

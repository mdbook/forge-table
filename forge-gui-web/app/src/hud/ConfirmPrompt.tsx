/**
 * The engine's yes/no prompts (InputConfirm: optional triggers, "may" effects, optional costs, binary choices,
 * play or draw): the same frame as an ask instead of a line over the buttons. The question is the title, the card it
 * is about large on the left, one answer per row. The answers are the table's own buttons, so the table keys still
 * drive them (Enter or Space the first, Esc the second). A "may" trigger adds "Always answer this trigger this way":
 * with it on, the answer is remembered (autoResponses.ts) and the auto-pass chips list it until it's taken back.
 */
import type { ConfirmAsk } from '@forge-table/protocol';
import { CardFaceView } from '../cards/CardFaceView';
import { useBattlefieldPeek } from '../overlays/BattlefieldPeek';
import { hudScale } from '../overlays/askCards';
import { confirmWords, PromptFrame } from '../overlays/PromptFrame';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { ManaText } from './ManaText';
import type { ButtonSpec } from './primaryLabel';

/** Whether a prompt on screen is a confirm the frame shows (the table's prompt bar and buttons step aside for it). */
export function framedConfirm(s: { prompt: { kind: string } | null; asks: unknown[]; gameOver: unknown }): boolean {
  return s.prompt?.kind === 'confirm' && s.asks.length === 0 && !s.gameOver;
}

export function ConfirmPrompt() {
  const prompt = useUi((s) => s.prompt);
  const active = useUi(framedConfirm);
  const model = useUi((s) => s.shown);
  const rememberPid = useUi((s) => s.rememberAnswer);
  const peek = useBattlefieldPeek(active, 'the question', String(prompt?.pid ?? ''));
  if (!active || !prompt) return null;
  const b = runtime().buttons();
  const answers = [b.primary, b.secondary].filter((x): x is ButtonSpec => !!x);
  const card = prompt.card ? model.cards[prompt.card] : undefined;
  // A "may" trigger: Forge's Auto-Yield can answer it from now on (like "Always use this order" for trigger order).
  const remember = prompt.triggerKey ? (
    <label className="trig-remember">
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={rememberPid === prompt.pid}
        data-testid="confirm-remember"
        onChange={(e) => {
          // Drop focus so Enter / Esc still answer (the table keys skip a focused input).
          e.currentTarget.blur();
          useUi.setState({ rememberAnswer: e.target.checked ? prompt.pid : null });
        }}
      />
      Always answer this trigger this way
    </label>
  ) : null;
  const words = confirmWords(prompt.message);
  const ask: ConfirmAsk = { t: 'ask', seq: 0, id: `p${prompt.pid}`, kind: 'confirm', options: [], default: 0, title: words.title ?? 'Your choice', ...(words.message ? { message: words.message } : {}) };
  return (
    <div className={`scrim ask-scrim${peek.className}`} inert={peek.inert} data-testid="confirm-layer">
      <PromptFrame
        ask={ask}
        model={model}
        testId="prompt-confirm"
        className="confirm-ask"
        status={remember}
        keys={[['Enter', answers[0]?.label ?? 'yes'], ...(answers[1] ? ([['Esc', answers[1].label]] as [string, string][]) : []), ['V', 'table']]}
      >
        <div className="confirm-body">
          {card?.state && <CardFaceView card={card} height={Math.round(260 * hudScale())} />}
          <div className="answers">
            {answers.map((a, i) => (
              <button
                key={a.label}
                className={`answer${i === 0 ? ' default' : ''}`}
                disabled={!a.enabled || !a.action}
                data-testid={i === 0 ? 'confirm-yes' : 'confirm-no'}
                onClick={(e) => {
                  e.currentTarget.blur();
                  runtime().press(a);
                }}
              >
                <span className="lbl">
                  <ManaText text={a.label} />
                </span>
                <kbd>{i === 0 ? 'Enter' : 'Esc'}</kbd>
              </button>
            ))}
          </div>
        </div>
      </PromptFrame>
    </div>
  );
}

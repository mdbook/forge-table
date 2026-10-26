/**
 * Auto-responses, the table's answers on the player's behalf (all off until the player turns them on, all shown so
 * they can be turned off again):
 *
 * - Always answer a "may" trigger the same way (Forge's Auto-Yield trigger decisions). Its confirm carries the
 *   trigger's `triggerKey`; with the frame's "Always answer this trigger this way" switch on, Yes or No goes out as
 *   a `triggerAnswer`, and Forge answers this prompt and every later one for that trigger.
 * - Auto-resolve: priority passes while the top of the stack is mine (YIELD_AUTO_RESOLVE_OWN on the bridge). It's
 *   offered as a chip at the moment it would have helped: my own spell on top and the priority prompt mine.
 */
import type { PlayerId, PromptBody, StackItem, TriggerDecision } from '@forge-table/protocol';
import type { ButtonAction } from './primaryLabel';

/** The answer to remember for this press, or null when it is an ordinary press. */
export function rememberedAnswer(
  prompt: Pick<PromptBody, 'kind' | 'pid' | 'triggerKey'> | null,
  rememberPid: number | null,
  action: ButtonAction | null,
): { key: string; decision: TriggerDecision } | null {
  if (!prompt || prompt.kind !== 'confirm' || !prompt.triggerKey || rememberPid !== prompt.pid) return null;
  if (action === 'ok') return { key: prompt.triggerKey, decision: 'accept' };
  if (action === 'cancel') return { key: prompt.triggerKey, decision: 'decline' };
  return null;
}

/**
 * A trigger key as a person reads it. Forge's keys are the trigger's text, prefixed with "Card Name (id=N): " when
 * the answer is for one card only: the id goes, the card name stays.
 */
export function answerLabel(key: string): string {
  return key.replace(/ \(id=\d+\)(?=: )/, '');
}

/** Whether to offer the Auto-resolve chip: it's off, the priority prompt is mine and my own item tops the stack. */
export function offerAutoResolve(
  promptKind: string | null,
  stack: Pick<StackItem, 'activator'>[],
  viewer: PlayerId,
  autoResolve: boolean,
  blocked: boolean,
): boolean {
  return !autoResolve && !blocked && promptKind === 'priority' && stack[0]?.activator === viewer;
}

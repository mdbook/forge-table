/**
 * The cost tracker (MTGA): while paying mana, the cost still owed as a strip of big pips above the action buttons,
 * read from the payMana prompt's "Pay Mana Cost: {1}{U}{B}". Each payment updates the prompt; the pip it paid pops
 * and fades out of the strip, and the generic pip's number rolls down (manaChoice.ts pipKeys keeps the rest put).
 */
import { AnimatePresence, motion } from 'motion/react';
import { parseSymbol } from '../cards/mana';
import { payCost, pipKeys } from '../overlays/manaChoice';
import { useUi } from '../store/uiStore';
import { pipView } from './ManaText';

const NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless', S: 'snow' };

function spoken(cost: string[]): string {
  return cost.map((s) => (/^\d+$/.test(s) ? `${s} generic` : (NAMES[s] ?? s.replace('/', ' or ')))).join(', ');
}

export function CostTracker() {
  const prompt = useUi((s) => s.prompt);
  const blocked = useUi((s) => s.asks.length > 0);
  const reduced = useUi((s) => s.reducedMotion);
  const cost = prompt?.kind === 'payMana' ? payCost(prompt.message) : null;
  const keys = cost ? pipKeys(cost) : [];
  const pop = reduced ? { duration: 0.12 } : { duration: 0.24, ease: [0.34, 1.56, 0.64, 1] as const };
  return (
    <AnimatePresence>
      {cost && cost.length > 0 && (
        <motion.div
          key="cost"
          className={`cost-tracker${blocked ? ' dim' : ''}`}
          data-testid="cost-tracker"
          role="status"
          aria-label={`Mana left to pay: ${spoken(cost)}`}
          initial={{ opacity: 0, y: reduced ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.2, ease: [0.05, 0.7, 0.1, 1] }}
        >
          <span className="cost-label">To pay</span>
          <span className="cost-pips">
            <AnimatePresence initial={true} mode="popLayout">
              {cost.map((s, i) => {
                const v = pipView(parseSymbol(s));
                return (
                  <motion.span
                    key={keys[i]}
                    layout={!reduced}
                    className={`cost-pip${v && v.glyphs.length > 1 ? ' split' : ''}`}
                    style={v?.css}
                    data-testid={`cost-pip-${keys[i]}`}
                    aria-hidden="true"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1, transition: { ...pop, delay: reduced ? 0 : i * 0.03 } }}
                    // Paid: a quick bloom outward, gone (ease-in exit).
                    exit={reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, scale: 1.7, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
                  >
                    <span key={s} className={reduced ? undefined : 'cost-glyph'}>
                      {v ? v.glyphs : s}
                    </span>
                  </motion.span>
                );
              })}
            </AnimatePresence>
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

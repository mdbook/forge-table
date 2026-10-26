/**
 * Aiming on the table: the client-side half of blocker-first blocking, drag-to-block / drag-to-attack, the
 * pending arrow that follows the cursor (blocking, attacking by drag, choosing targets) and the arrows the table
 * shows (combat, stack targets). Decisions are the pure functions of ./interaction and ./specs; this class keeps
 * the little state they need and listens to the pointer and Esc.
 *
 * Clicks still arrive as sprite taps (Runtime.clickCard → tap()); a press that travels past DRAG_THRESHOLD_PX
 * with the button down becomes a drag, its tap is swallowed and the release decides. My hand's cards are dragged
 * by table/handDrag.ts (drag to play, drag to reorder).
 */
import type { CardId, GameModel, PlayerId, PromptBody } from '@forge-table/protocol';
import { aimMode, blockClick, dragSource, dropAct, legalAttackers, pastThreshold, snapTargets, type AimAct, type AimMode } from './interaction';
import { arrowSpecs, blockerMap, targetSource, type ArrowEnd, type ArrowSpec, type PendingArrow } from './specs';
import type { Pt } from './geometry';
import { illegalTarget, type ShieldKind } from '../director/protection';

/** What the scene should emphasise while the player aims. */
export interface AimFocus {
  /** The card picked up (a blocker being aimed): it lifts. */
  lifted: CardId | null;
  /** The card an arrow is being aimed from. */
  source: CardId | null;
  /** Legal ends for the aim: they glow. */
  legal: Set<string>;
  /** Cards that are not legal ends: they dim. */
  dim: Set<CardId>;
  /** The protected card the pointer is over while choosing targets (hexproof, shroud, protection against the source): the aim bounces off it. */
  denied: { card: CardId; kind: ShieldKind } | null;
  /** Cards the player can pick up to aim from (blockers the server lists in `blockable`): the selectable ring. */
  selectable: Set<CardId>;
  /**
   * Show the engine's own combat focus (`highlighted` in declareBlockers: Forge's "current attacker"). Blocker-first
   * makes it meaningless, so it is hidden then.
   */
  engineFocus: boolean;
}

export const NO_FOCUS: AimFocus = { lifted: null, source: null, legal: new Set(), dim: new Set(), denied: null, selectable: new Set(), engineFocus: true };

export interface AimHost {
  model(): GameModel;
  viewer(): PlayerId;
  prompt(): PromptBody | null;
  /** A real prompt is up and nothing covers it. */
  inputLive(): boolean;
  send(act: AimAct): void;
  /** Client px → table units. */
  toTable(x: number, y: number): Pt;
  /** The topmost card at a table point. */
  cardAt(p: Pt): CardId | null;
  /** The card has a pose on the table. */
  visible(id: CardId): boolean;
  /** The card under the pointer on the canvas (hover), if any. */
  hovered(): CardId | null;
  canvas(): HTMLElement | null;
  /** The plates the player could drop on changed (the HUD outlines them). */
  onDropPlates?(players: PlayerId[]): void;
  /** The creature picked up to block with changed (the prompt bar's text follows it). */
  onPicked?(card: CardId | null): void;
}

interface Press {
  card: CardId;
  x: number;
  y: number;
}

export class AimController {
  /** Blocker-first: the creature picked to block with (client-side only). */
  selected: CardId | null = null;
  /** The card being dragged. */
  dragging: CardId | null = null;
  /** A stack item hovered in the HUD's stack list. */
  hoverStack: string | null = null;
  private press: Press | null = null;
  private pressFresh = false;
  private downOnCanvas = false;
  private pointer: Pt | null = null;
  private client: { x: number; y: number } | null = null;
  private promptKey = '';
  private dropPlates = '';
  private picked: CardId | null = null;
  private detach: (() => void) | null = null;

  constructor(private readonly host: AimHost) {}

  // ------------------------------------------------------------------------------------- input

  attach(win: Window = window): void {
    const move = (e: PointerEvent) => this.move(e.clientX, e.clientY);
    const down = (e: PointerEvent) => {
      if (!this.pressFresh) this.press = null;
      this.pressFresh = false;
      this.downOnCanvas = !!e.target && e.target === this.host.canvas();
    };
    const up = (e: PointerEvent) => this.release(e.clientX, e.clientY);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (!this.selected && !this.dragging)) return;
      // Esc drops the aim before it reaches the table's secondary button.
      this.cancel();
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const lost = () => this.cancelDrag();
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerdown', down);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', lost);
    win.addEventListener('blur', lost);
    win.addEventListener('keydown', key, true);
    this.detach = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerdown', down);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', lost);
      win.removeEventListener('blur', lost);
      win.removeEventListener('keydown', key, true);
    };
  }

  dispose(): void {
    this.detach?.();
  }

  /** A press on a card sprite (before the window sees the pointerdown). */
  cardDown(card: CardId, x: number, y: number): void {
    const h = this.host;
    this.pressFresh = true;
    this.press = null;
    if (!h.inputLive()) return;
    const prompt = h.prompt();
    const model = h.model();
    if (dragSource(aimMode(prompt), prompt, model.game.combat, card, h.viewer(), model.cards[card]?.controller)) this.press = { card, x, y };
  }

  move(x: number, y: number): void {
    this.client = { x, y };
    this.pointer = this.host.toTable(x, y);
    const p = this.press;
    if (p && !this.dragging && pastThreshold(p, { x, y })) {
      this.dragging = p.card;
      this.selected = null;
    }
  }

  /** The button came up anywhere (after any sprite tap). */
  release(x: number, y: number): void {
    this.move(x, y);
    const h = this.host;
    const drag = this.dragging;
    if (drag) {
      this.dragging = null;
      this.press = null;
      const over = this.endUnder();
      if (over === drag) {
        // Picked up and put back down: a click.
        if (aimMode(h.prompt()) === 'block') this.selected = drag;
        return;
      }
      const act = h.inputLive() ? dropAct(aimMode(h.prompt()), h.prompt(), drag, over) : null;
      if (act) h.send(act);
      return;
    }
    // A click on the bare table drops a selection.
    if (!this.press && this.downOnCanvas && this.selected && this.pointer && !h.cardAt(this.pointer)) this.selected = null;
    this.press = null;
    this.downOnCanvas = false;
  }

  /** A card tap. True when aiming handled it (the runtime then sends no plain card click). */
  tap(card: CardId): boolean {
    if (this.dragging) return true;
    const h = this.host;
    const prompt = h.prompt();
    if (!prompt || aimMode(prompt) !== 'block') return false;
    const d = blockClick(prompt, h.model().game.combat, this.selected, card);
    if (d.select !== undefined) this.selected = d.select;
    if (d.act) h.send(d.act);
    return true;
  }

  cancel(): void {
    this.selected = null;
    this.cancelDrag();
  }

  private cancelDrag(): void {
    this.dragging = null;
    this.press = null;
  }

  /** The card or player under the pointer (a plate counts as its player). */
  private endUnder(): string | null {
    const c = this.client;
    if (c && typeof document !== 'undefined') {
      const plate = document.elementFromPoint(c.x, c.y)?.closest<HTMLElement>('[data-player]');
      if (plate?.dataset.player) return plate.dataset.player;
    }
    return this.pointer ? this.host.cardAt(this.pointer) : null;
  }

  // ------------------------------------------------------------------------------------- per frame

  /** The arrows to draw and what to emphasise, for the state at the playhead. */
  frame(): { arrows: ArrowSpec[]; focus: AimFocus } {
    const h = this.host;
    const prompt = h.prompt();
    const model = h.model();
    const live = h.inputLive();
    const key = prompt ? `${prompt.pid}:${prompt.kind}` : '';
    if (!live) this.cancel();
    if (key !== this.promptKey) {
      // A different prompt: aiming starts over (not on the very first frame we see).
      if (this.promptKey !== '') this.cancel();
      this.promptKey = key;
    }
    const mode = live ? aimMode(prompt) : null;
    if (this.selected && legalAttackers(prompt, this.selected).length === 0) this.selected = null;

    let pending: PendingArrow | null = null;
    // Blocker-first: my creatures that can block are what I click first (the engine's `selectable` is empty).
    // Creatures already blocking keep their blue ring (a click pulls them back).
    const blocking = blockerMap(model.game.combat);
    const pickable = new Set<CardId>(mode === 'block' ? Object.entries(prompt?.blockable ?? {}).filter(([b, a]) => a.length > 0 && !blocking.has(b)).map(([b]) => b) : []);
    let focus: AimFocus = mode === 'block' ? { ...NO_FOCUS, selectable: pickable, engineFocus: false } : NO_FOCUS;
    const source = mode === 'block' ? (this.dragging ?? this.selected) : mode === 'attack' ? this.dragging : mode === 'target' ? (targetSource(model, prompt) ?? null) : null;
    if (mode && source && h.visible(source)) {
      const legal = snapTargets(mode, prompt, source);
      const denied = mode === 'target' ? this.deniedUnder(source, legal) : null;
      if (denied) pending = { kind: mode, from: source, to: { card: denied.card }, deflect: true };
      else if (this.pointer) pending = { kind: mode, from: source, to: this.snap(mode, legal) };
      const dim = new Set<CardId>();
      if (mode === 'block') {
        for (const band of model.game.combat ?? []) if (!legal.has(band.attacker)) dim.add(band.attacker);
      } else if (mode === 'target' && prompt) {
        const keep = new Set<string>([...legal, ...(prompt.highlighted ?? []), source]);
        for (const [id, c] of Object.entries(model.cards)) if (c.zone === 'Battlefield' && !keep.has(id) && h.visible(id)) dim.add(id);
      }
      focus = { lifted: mode === 'block' ? source : null, source, legal, dim, denied, selectable: pickable, engineFocus: mode !== 'block' };
    }
    // The plates a drag (or the targeting arrow) could land on.
    const plates = mode === 'attack' && this.dragging ? (prompt?.defenders ?? []).filter((d) => !!model.players[d]) : [];
    const picked = mode === 'block' ? source : null;
    if (picked !== this.picked) {
      this.picked = picked;
      h.onPicked?.(picked);
    }
    const pk = plates.join(',');
    if (pk !== this.dropPlates) {
      this.dropPlates = pk;
      h.onDropPlates?.(plates);
    }
    // A hovered stack item (in the list, or its card / its source on the table) shows its targets.
    const arrows = arrowSpecs({ model, viewer: h.viewer(), prompt, visible: h.visible, pending, hoverStack: this.hoverStack ?? h.hovered() });
    return { arrows, focus };
  }

  /** While choosing targets: the battlefield card under the pointer if it is not a legal end and its protection forbids this source. */
  private deniedUnder(source: CardId, legal: Set<string>): { card: CardId; kind: ShieldKind } | null {
    const h = this.host;
    const over = this.pointer ? this.endUnder() : null;
    const model = h.model();
    const card = over ? model.cards[over] : undefined;
    if (!over || !card || over === source || legal.has(over) || !h.visible(over) || card.zone !== 'Battlefield') return null;
    const kind = illegalTarget(card, model.cards[source], h.viewer());
    return kind ? { card: over, kind } : null;
  }

  /** The pending arrow's end: a legal card or player under the pointer, else the pointer itself. */
  private snap(mode: AimMode, legal: Set<string>): ArrowEnd {
    const over = this.endUnder();
    const model = this.host.model();
    if (over && model.players[over] && (legal.has(over) || mode === 'target')) return { player: over };
    if (over && legal.has(over)) return { card: over };
    return { point: this.pointer! };
  }
}

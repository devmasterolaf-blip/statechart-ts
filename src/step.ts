/**
 * The step algorithm: selecting transitions for an event and applying them as
 * a microstep (exit states, run transition actions, enter states), repeated
 * until the machine is stable (a macrostep).
 *
 * Exit order is innermost first (reverse document order), entry order is
 * outermost first (document order).
 */

import { applyAssign } from './actions';
import { MacrostepLimitError, MissingImplementationError } from './errors';
import { evaluateGuard } from './guards';
import {
  ALWAYS_EVENT,
  byDocumentOrder,
  isDescendant,
  properAncestors,
  type StateNode,
  type TransitionDefinition,
} from './node';
import type { Effect } from './state';
import type { ActionConfig, EventObject, Implementations } from './types';

/**
 * Upper bound on the microsteps of one macrostep. Eventless transitions and
 * raised events that keep re-enabling each other would otherwise never end.
 */
export const MAX_MICROSTEPS = 1000;

export interface StepSnapshot<C, E extends EventObject> {
  configuration: Iterable<StateNode<C, E>>;
  context: C;
  /** Recorded history: history node id to the remembered states. */
  history?: ReadonlyMap<string, readonly StateNode<C, E>[]>;
}

export class Stepper<C, E extends EventObject> {
  readonly configuration: Set<StateNode<C, E>>;
  context: C;
  readonly history: Map<string, readonly StateNode<C, E>[]>;
  readonly effects: Effect<C, E>[] = [];
  /** Number of transitions taken so far. */
  taken = 0;
  private readonly internalQueue: EventObject[] = [];
  private event: EventObject = { type: '' };

  constructor(
    private readonly root: StateNode<C, E>,
    private readonly implementations: Implementations<C, E>,
    snapshot: StepSnapshot<C, E>,
  ) {
    this.configuration = new Set(snapshot.configuration);
    this.context = snapshot.context;
    this.history = new Map(snapshot.history);
  }

  /** Enters the initial configuration and runs to a stable state. */
  start(event: EventObject): void {
    this.event = event;
    const toEnter = new Set<StateNode<C, E>>();
    this.addDescendants(this.root, toEnter);
    this.enterStates(toEnter);
    this.settle();
  }

  /** Processes one external event as a full macrostep. */
  send(event: EventObject): void {
    this.event = event;
    this.microstep(this.select(event.type));
    this.settle();
  }

  /**
   * Runs until the machine is stable: eventless transitions are taken as long
   * as any is enabled, then the next raised event is handled, and so on.
   */
  private settle(): void {
    let microsteps = 0;
    for (;;) {
      let enabled = this.select(ALWAYS_EVENT);
      if (enabled.length === 0) {
        const next = this.internalQueue.shift();
        if (!next) {
          return;
        }
        this.event = next;
        enabled = this.select(next.type);
      }
      if (enabled.length > 0 && ++microsteps > MAX_MICROSTEPS) {
        throw new MacrostepLimitError(MAX_MICROSTEPS, enabled[0].source.label);
      }
      this.microstep(enabled);
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * For every active leaf, the first matching transition whose guard passes,
   * found on the leaf or its nearest ancestor, wins. With parallel regions
   * several transitions can be enabled at once; conflicting ones are dropped.
   */
  private select(eventType: string): TransitionDefinition<C, E>[] {
    const enabled: TransitionDefinition<C, E>[] = [];
    const leaves = [...this.configuration].filter((node) => node.isLeaf).sort(byDocumentOrder);
    for (const leaf of leaves) {
      for (const node of [leaf, ...properAncestors(leaf)]) {
        const transition = node.transitions.find(
          (candidate) => candidate.eventType === eventType && this.passes(candidate),
        );
        if (transition) {
          if (!enabled.includes(transition)) {
            enabled.push(transition);
          }
          break;
        }
      }
    }
    return enabled.length > 1 ? this.removeConflicts(enabled) : enabled;
  }

  /**
   * Two transitions conflict when they would exit a common state. The one
   * whose source is nested inside the other's source wins; otherwise the one
   * selected first (earlier region in document order) wins.
   */
  private removeConflicts(enabled: readonly TransitionDefinition<C, E>[]): TransitionDefinition<C, E>[] {
    let kept: TransitionDefinition<C, E>[] = [];
    for (const candidate of enabled) {
      const candidateExits = this.exitSetOf([candidate]);
      const displaced = new Set<TransitionDefinition<C, E>>();
      let preempted = false;
      for (const other of kept) {
        const otherExits = this.exitSetOf([other]);
        if (![...candidateExits].some((node) => otherExits.has(node))) {
          continue;
        }
        if (isDescendant(candidate.source, other.source)) {
          displaced.add(other);
        } else {
          preempted = true;
          break;
        }
      }
      if (!preempted) {
        kept = kept.filter((other) => !displaced.has(other));
        kept.push(candidate);
      }
    }
    return kept;
  }

  private passes(transition: TransitionDefinition<C, E>): boolean {
    if (transition.guard === undefined) {
      return true;
    }
    return evaluateGuard(transition.guard, {
      context: this.context,
      event: this.event as E,
      meta: { isActive: (stateId) => [...this.configuration].some((node) => node.id === stateId) },
      guards: this.implementations.guards,
      owner: transition.source.label,
    });
  }

  // -------------------------------------------------------------------------
  // Microstep
  // -------------------------------------------------------------------------

  private microstep(transitions: readonly TransitionDefinition<C, E>[]): void {
    if (transitions.length === 0) {
      return;
    }
    this.taken += transitions.length;
    this.exitStates(transitions);
    for (const transition of transitions) {
      this.runActions(transition.actions, transition.source);
    }
    this.enterStates(this.computeEntrySet(transitions));
  }

  /**
   * The domain of a transition is the innermost state that stays active while
   * the transition is taken; everything active below it is exited.
   */
  private domainOf(transition: TransitionDefinition<C, E>): StateNode<C, E> | undefined {
    const { source, targets } = transition;
    if (targets.length === 0) {
      return undefined;
    }
    if (transition.internal && source.kind === 'compound' && targets.every((target) => isDescendant(target, source))) {
      return source;
    }
    for (const ancestor of properAncestors(source)) {
      const canContain = ancestor.kind === 'compound' || !ancestor.parent;
      if (canContain && targets.every((target) => isDescendant(target, ancestor))) {
        return ancestor;
      }
    }
    return this.root;
  }

  private exitSetOf(transitions: readonly TransitionDefinition<C, E>[]): Set<StateNode<C, E>> {
    const toExit = new Set<StateNode<C, E>>();
    for (const transition of transitions) {
      const domain = this.domainOf(transition);
      if (!domain) {
        continue;
      }
      for (const node of this.configuration) {
        if (isDescendant(node, domain)) {
          toExit.add(node);
        }
      }
    }
    return toExit;
  }

  private exitStates(transitions: readonly TransitionDefinition<C, E>[]): void {
    const ordered = [...this.exitSetOf(transitions)].sort(byDocumentOrder).reverse();
    // History is recorded for all exiting states before any of them is removed.
    for (const node of ordered) {
      for (const child of node.children) {
        if (child.kind === 'history') {
          this.history.set(child.id, this.activeBelow(node, child.historyKind === 'deep'));
        }
      }
    }
    for (const node of ordered) {
      this.runActions(node.exit, node);
      this.configuration.delete(node);
    }
  }

  /** Active direct children of `node` (shallow) or active leaves below it (deep). */
  private activeBelow(node: StateNode<C, E>, deep: boolean): StateNode<C, E>[] {
    return [...this.configuration]
      .filter((active) => (deep ? active.isLeaf && isDescendant(active, node) : active.parent === node))
      .sort(byDocumentOrder);
  }

  private computeEntrySet(transitions: readonly TransitionDefinition<C, E>[]): Set<StateNode<C, E>> {
    const toEnter = new Set<StateNode<C, E>>();
    for (const transition of transitions) {
      // Every explicit target goes in first, so that the default entry of a
      // parallel region never competes with a target inside that region.
      for (const target of transition.targets) {
        this.addDescendants(target, toEnter);
      }
      const domain = this.domainOf(transition);
      for (const target of transition.targets) {
        this.addAncestors(target, domain, toEnter);
      }
    }
    return toEnter;
  }

  /**
   * Adds a state and its default descendants: the initial child of a compound
   * state, every region of a parallel state. A history state is never entered
   * itself; it stands for the states it remembers.
   */
  private addDescendants(node: StateNode<C, E>, toEnter: Set<StateNode<C, E>>): void {
    if (node.kind === 'history') {
      this.addHistory(node, toEnter);
      return;
    }
    toEnter.add(node);
    if (node.kind === 'compound' && node.initial) {
      this.addDescendants(node.initial, toEnter);
    } else if (node.kind === 'parallel') {
      this.addMissingRegions(node, toEnter);
    }
  }

  private addHistory(node: StateNode<C, E>, toEnter: Set<StateNode<C, E>>): void {
    const parent = node.parent as StateNode<C, E>;
    const remembered = this.history.get(node.id) ?? (node.historyDefault ? [node.historyDefault] : undefined);
    if (!remembered) {
      // Nothing recorded and no default target: behave like a plain entry of the parent.
      if (parent.kind === 'parallel') {
        this.addMissingRegions(parent, toEnter);
      } else if (parent.initial) {
        this.addDescendants(parent.initial, toEnter);
      }
      return;
    }
    for (const state of remembered) {
      this.addDescendants(state, toEnter);
    }
    for (const state of remembered) {
      this.addAncestors(state, parent, toEnter);
    }
  }

  /** Adds the ancestors of a target up to (not including) the domain. */
  private addAncestors(
    node: StateNode<C, E>,
    domain: StateNode<C, E> | undefined,
    toEnter: Set<StateNode<C, E>>,
  ): void {
    for (const ancestor of properAncestors(node, domain)) {
      toEnter.add(ancestor);
      if (ancestor.kind === 'parallel') {
        this.addMissingRegions(ancestor, toEnter);
      }
    }
  }

  /** Enters by default every region that is not already being entered. */
  private addMissingRegions(parallel: StateNode<C, E>, toEnter: Set<StateNode<C, E>>): void {
    for (const region of parallel.children) {
      if (region.kind === 'history') {
        continue;
      }
      const covered = [...toEnter].some((node) => node === region || isDescendant(node, region));
      if (!covered) {
        this.addDescendants(region, toEnter);
      }
    }
  }

  private enterStates(toEnter: ReadonlySet<StateNode<C, E>>): void {
    const ordered = [...toEnter].sort(byDocumentOrder);
    for (const node of ordered) {
      if (this.configuration.has(node)) {
        continue;
      }
      this.configuration.add(node);
      this.runActions(node.entry, node);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private runActions(actions: readonly ActionConfig<C, E>[], owner: StateNode<C, E>): void {
    for (const action of actions) {
      this.runAction(action, owner);
    }
  }

  private runAction(action: ActionConfig<C, E>, owner: StateNode<C, E>): void {
    let name: string | undefined;
    let resolved: Exclude<ActionConfig<C, E>, string>;
    if (typeof action === 'string') {
      const implementation = this.implementations.actions?.[action];
      if (!implementation) {
        throw new MissingImplementationError('action', action, owner.label);
      }
      name = action;
      resolved = implementation;
    } else {
      resolved = action;
    }

    const event = this.event as E;
    if (typeof resolved === 'function') {
      this.effects.push({ kind: 'exec', name, exec: resolved, context: this.context, event });
    } else if (resolved.type === 'assign') {
      this.context = applyAssign(resolved, this.context, event);
    } else {
      this.internalQueue.push(resolved.event);
    }
  }
}

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
}

export class Stepper<C, E extends EventObject> {
  readonly configuration: Set<StateNode<C, E>>;
  context: C;
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
   * found on the leaf or its nearest ancestor, wins.
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
    return enabled;
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

  private exitStates(transitions: readonly TransitionDefinition<C, E>[]): void {
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
    const ordered = [...toExit].sort(byDocumentOrder).reverse();
    for (const node of ordered) {
      this.runActions(node.exit, node);
      this.configuration.delete(node);
    }
  }

  private computeEntrySet(transitions: readonly TransitionDefinition<C, E>[]): Set<StateNode<C, E>> {
    const toEnter = new Set<StateNode<C, E>>();
    for (const transition of transitions) {
      const domain = this.domainOf(transition);
      for (const target of transition.targets) {
        this.addDescendants(target, toEnter);
        for (const ancestor of properAncestors(target, domain)) {
          toEnter.add(ancestor);
        }
      }
    }
    return toEnter;
  }

  /** Adds a state and, for compound states, its default descendants. */
  private addDescendants(node: StateNode<C, E>, toEnter: Set<StateNode<C, E>>): void {
    toEnter.add(node);
    if (node.kind === 'compound' && node.initial) {
      this.addDescendants(node.initial, toEnter);
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

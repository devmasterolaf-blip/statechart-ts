/**
 * Machine: a validated definition plus the pure functions that compute its
 * initial state and the state reached from another state by an event.
 */

import { InvalidMachineError, type Issue } from './errors';
import { buildTree, type StateNode } from './node';
import { State } from './state';
import { Stepper } from './step';
import { INIT_EVENT_TYPE, type EventObject, type Implementations, type MachineConfig } from './types';

/** Accepts an event object or just its type. */
export function toEventObject<E extends EventObject>(event: E | E['type']): E {
  return typeof event === 'string' ? ({ type: event } as E) : event;
}

export class Machine<C, E extends EventObject> {
  readonly id: string;
  readonly config: MachineConfig<C, E>;
  readonly root: StateNode<C, E>;
  /** Every state node in document order. */
  readonly nodes: readonly StateNode<C, E>[];
  readonly implementations: Implementations<C, E>;
  /** Non-fatal findings from building the definition. */
  readonly warnings: readonly Issue[];
  private readonly byId: ReadonlyMap<string, StateNode<C, E>>;
  private cachedInitial: State<C, E> | undefined;

  constructor(config: MachineConfig<C, E>, implementations: Implementations<C, E> = {}) {
    const tree = buildTree(config);
    if (tree.issues.some((issue) => issue.severity === 'error')) {
      throw new InvalidMachineError(tree.issues);
    }
    this.config = config;
    this.root = tree.root;
    this.id = tree.root.id;
    this.nodes = tree.nodes;
    this.byId = tree.byId;
    this.implementations = implementations;
    this.warnings = tree.issues;
  }

  /** Looks a state node up by id (without the leading `#`). */
  getNode(stateId: string): StateNode<C, E> | undefined {
    return this.byId.get(stateId);
  }

  /** Returns a copy of this machine with extra or replaced implementations. */
  provide(implementations: Implementations<C, E>): Machine<C, E> {
    return new Machine(this.config, {
      guards: { ...this.implementations.guards, ...implementations.guards },
      actions: { ...this.implementations.actions, ...implementations.actions },
      delays: { ...this.implementations.delays, ...implementations.delays },
    });
  }

  /** The state after entering the initial configuration. */
  get initialState(): State<C, E> {
    if (!this.cachedInitial) {
      const event: EventObject = { type: INIT_EVENT_TYPE };
      const stepper = new Stepper(this.root, this.implementations, {
        configuration: [],
        context: this.config.context as C,
      });
      stepper.start(event);
      this.cachedInitial = this.snapshot(stepper, event, true);
    }
    return this.cachedInitial;
  }

  /**
   * Computes the next state for an event. Pure: the given state is not
   * modified and no action is executed; the side effects to run are listed in
   * `effects` of the returned state.
   */
  transition(state: State<C, E>, event: E | E['type']): State<C, E> {
    const eventObject = toEventObject(event);
    const stepper = new Stepper(this.root, this.implementations, {
      configuration: state.configuration,
      context: state.context,
    });
    stepper.send(eventObject);
    return this.snapshot(stepper, eventObject, stepper.taken > 0);
  }

  private snapshot(stepper: Stepper<C, E>, event: EventObject, changed: boolean): State<C, E> {
    return new State({
      root: this.root,
      configuration: stepper.configuration,
      context: stepper.context,
      event,
      effects: stepper.effects,
      changed,
    });
  }
}

/**
 * Creates a machine from a definition.
 *
 * @throws InvalidMachineError when the definition has structural errors.
 */
export function createMachine<C = undefined, E extends EventObject = EventObject>(
  config: MachineConfig<C, E>,
  implementations?: Implementations<C, E>,
): Machine<C, E> {
  return new Machine(config, implementations);
}

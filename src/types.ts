/**
 * Public configuration types for machine definitions.
 *
 * A definition is a plain object tree. When guards and actions are referenced
 * by name (strings) the whole definition is JSON-compatible, which is what the
 * JSON loader and the CLI rely on.
 */

/** Every event is an object with a string `type`; payload fields are free. */
export interface EventObject {
  type: string;
}

/** Event delivered once when a machine computes its initial state. */
export const INIT_EVENT_TYPE = 'statechart.init';

export type StateKind = 'atomic' | 'compound' | 'parallel' | 'final' | 'history';

export type HistoryKind = 'shallow' | 'deep';

/**
 * The active configuration as a plain value: a string for the single active
 * child of a compound state, or an object keyed by child for nested and
 * parallel states. An active leaf inside an object is represented by `{}`.
 */
export type StateValue = string | { [key: string]: StateValue };

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface GuardMeta {
  /** True when the state with this id is active as the transition is selected. */
  isActive(stateId: string): boolean;
}

export type GuardFn<C, E extends EventObject> = (context: C, event: E, meta: GuardMeta) => boolean;

export interface NotGuard<C, E extends EventObject> {
  type: 'not';
  guard: GuardConfig<C, E>;
}

export interface AndGuard<C, E extends EventObject> {
  type: 'and';
  guards: GuardConfig<C, E>[];
}

export interface OrGuard<C, E extends EventObject> {
  type: 'or';
  guards: GuardConfig<C, E>[];
}

/** Passes while the referenced state (by id, without the leading `#`) is active. */
export interface InStateGuard {
  type: 'in';
  state: string;
}

/** A guard is a named reference, an inline predicate or a combinator object. */
export type GuardConfig<C, E extends EventObject> =
  | string
  | GuardFn<C, E>
  | NotGuard<C, E>
  | AndGuard<C, E>
  | OrGuard<C, E>
  | InStateGuard;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ActionMeta<E extends EventObject> {
  /**
   * Sends an event to the running service. It is queued and handled after the
   * current event has been fully processed. Outside a service it is a no-op.
   */
  send(event: E | E['type']): void;
}

export type ActionFn<C, E extends EventObject> = (context: C, event: E, meta: ActionMeta<E>) => void;

export type Assigner<C, E extends EventObject> = (context: C, event: E) => Partial<C>;

export type PropertyAssigner<C, E extends EventObject> = {
  [K in keyof C]?: C[K] | ((context: C, event: E) => C[K]);
};

/** Updates the extended context. Applied while the transition is computed. */
export interface AssignAction<C, E extends EventObject> {
  type: 'assign';
  assignment: Assigner<C, E> | PropertyAssigner<C, E>;
}

/** Puts an event on the internal queue; it is handled within the same macrostep. */
export interface RaiseAction<E extends EventObject> {
  type: 'raise';
  event: E;
}

/** An action is a named reference, an inline function or a built-in action object. */
export type ActionConfig<C, E extends EventObject> =
  | string
  | ActionFn<C, E>
  | AssignAction<C, E>
  | RaiseAction<E>;

// ---------------------------------------------------------------------------
// Transitions and states
// ---------------------------------------------------------------------------

export type SingleOrArray<T> = T | T[];

export interface TransitionConfig<C, E extends EventObject> {
  /**
   * Target state(s). `sibling`, `sibling.child`, `.child` (relative to the
   * source) or `#id`. Omit for a targetless transition that only runs actions.
   */
  target?: SingleOrArray<string>;
  guard?: GuardConfig<C, E>;
  actions?: SingleOrArray<ActionConfig<C, E>>;
  /**
   * An internal transition does not exit its source state. Defaults to true
   * when every target is relative (starts with `.`), false otherwise.
   */
  internal?: boolean;
  description?: string;
}

/** A transition is written as a bare target string or a full config object. */
export type TransitionInput<C, E extends EventObject> = string | TransitionConfig<C, E>;

export type TransitionsConfig<C, E extends EventObject> = SingleOrArray<TransitionInput<C, E>>;

export interface StateNodeConfig<C, E extends EventObject> {
  /** Custom id, addressable as `#id`. Defaults to the dotted path from the root. */
  id?: string;
  /** Inferred when omitted: `compound` if the node has child states, else `atomic`. */
  type?: StateKind;
  /** Key of the child entered by default. Required for compound states. */
  initial?: string;
  states?: { [key: string]: StateNodeConfig<C, E> };
  on?: { [K in E['type']]?: TransitionsConfig<C, Extract<E, { type: K }>> };
  /** Eventless transitions, checked whenever the state is active. */
  always?: TransitionsConfig<C, E>;
  /** Delayed transitions keyed by milliseconds or by a named delay. */
  after?: { [delay: string]: TransitionsConfig<C, E> };
  /** Taken when this compound or parallel state reaches a final configuration. */
  onDone?: TransitionsConfig<C, E>;
  entry?: SingleOrArray<ActionConfig<C, E>>;
  exit?: SingleOrArray<ActionConfig<C, E>>;
  /** For `type: 'history'`: remember direct children (shallow) or leaves (deep). */
  history?: HistoryKind;
  /** For `type: 'history'`: where to go when no history has been recorded yet. */
  target?: string;
  description?: string;
}

export interface MachineConfig<C, E extends EventObject> extends StateNodeConfig<C, E> {
  /** Initial extended context. */
  context?: C;
}

export type DelayFn<C, E extends EventObject> = (context: C, event: E) => number;

/** Implementations for the names used in a definition. */
export interface Implementations<C, E extends EventObject> {
  guards?: { [name: string]: GuardFn<C, E> };
  actions?: { [name: string]: ActionFn<C, E> | AssignAction<C, E> | RaiseAction<E> };
  delays?: { [name: string]: number | DelayFn<C, E> };
}

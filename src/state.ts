/**
 * State: an immutable snapshot of a machine — which states are active, the
 * extended context and the recorded history.
 */

import { byDocumentOrder, type StateNode } from './node';
import type { ActionFn, EventObject, StateValue } from './types';

/**
 * A side effect produced while computing a transition. Computing a state is
 * pure; effects are data for whoever runs the machine (normally a Service).
 */
export interface ExecEffect<C, E extends EventObject> {
  kind: 'exec';
  /** Name of the action when it was referenced by name. */
  name: string | undefined;
  exec: ActionFn<C, E>;
  /** Context and event as they were when the action was reached. */
  context: C;
  event: E;
}

export type Effect<C, E extends EventObject> = ExecEffect<C, E>;

/**
 * Computes the value of `node` for a configuration: the key of the active
 * child when that child is a leaf, otherwise an object keyed by active child.
 */
export function valueOf<C, E extends EventObject>(
  node: StateNode<C, E>,
  configuration: ReadonlySet<StateNode<C, E>>,
): StateValue {
  const active = node.children.filter((child) => configuration.has(child));
  if (node.kind === 'compound' && active.length === 1 && active[0].isLeaf) {
    return active[0].key;
  }
  const value: { [key: string]: StateValue } = {};
  for (const child of active) {
    value[child.key] = valueOf(child, configuration);
  }
  return value;
}

/** Turns `'a.b.c'` into `{ a: { b: 'c' } }`; a single key stays a string. */
export function pathToValue(path: string): StateValue {
  const keys = path.split('.');
  let value: StateValue = keys[keys.length - 1];
  for (let index = keys.length - 2; index >= 0; index--) {
    value = { [keys[index]]: value };
  }
  return value;
}

/** True when every state named by `pattern` is active in `value`. */
export function matchesValue(pattern: StateValue, value: StateValue): boolean {
  if (typeof pattern === 'string') {
    return typeof value === 'string' ? value === pattern : Object.hasOwn(value, pattern);
  }
  const keys = Object.keys(pattern);
  if (keys.length === 0) {
    return true;
  }
  if (typeof value === 'string') {
    // A string value is a leaf child, so it can only satisfy `{ key: {} }`.
    return keys.length === 1 && keys[0] === value && matchesValue(pattern[value], {});
  }
  return keys.every((key) => Object.hasOwn(value, key) && matchesValue(pattern[key], value[key]));
}

export interface StateInit<C, E extends EventObject> {
  root: StateNode<C, E>;
  configuration: Iterable<StateNode<C, E>>;
  context: C;
  event: EventObject;
  history?: ReadonlyMap<string, readonly string[]>;
  effects?: readonly Effect<C, E>[];
  changed?: boolean;
  done?: boolean;
}

export class State<C, E extends EventObject> {
  /** Active state nodes, ancestors included, in document order. */
  readonly configuration: readonly StateNode<C, E>[];
  readonly value: StateValue;
  readonly context: C;
  /** The event that produced this state. */
  readonly event: EventObject;
  /** Recorded history: history state id to the ids of the remembered states. */
  readonly history: ReadonlyMap<string, readonly string[]>;
  /** Side effects of the step that produced this state, in execution order. */
  readonly effects: readonly Effect<C, E>[];
  /** True when at least one transition was taken to produce this state. */
  readonly changed: boolean;
  /** True when the machine has reached a top-level final configuration. */
  readonly done: boolean;
  private readonly ids: ReadonlySet<string>;

  constructor(init: StateInit<C, E>) {
    const set = new Set(init.configuration);
    this.configuration = [...set].sort(byDocumentOrder);
    this.value = valueOf(init.root, set);
    this.context = init.context;
    this.event = init.event;
    this.history = init.history ?? new Map();
    this.effects = init.effects ?? [];
    this.changed = init.changed ?? false;
    this.done = init.done ?? false;
    this.ids = new Set(this.configuration.map((node) => node.id));
  }

  /**
   * Checks whether the given states are active. Accepts a dotted path of keys
   * from the root (`'on.bright'`) or a partial state value.
   */
  matches(pattern: string | StateValue): boolean {
    const value = typeof pattern === 'string' ? pathToValue(pattern) : pattern;
    return matchesValue(value, this.value);
  }

  /** True when the state with this id (no leading `#`) is active. */
  isActive(stateId: string): boolean {
    return this.ids.has(stateId);
  }

  /** Ids of the active leaf states in document order. */
  get leafIds(): string[] {
    return this.configuration.filter((node) => node.isLeaf).map((node) => node.id);
  }
}

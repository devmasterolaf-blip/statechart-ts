/**
 * Turning a persisted state back into a configuration. The input usually
 * comes from JSON.parse, so nothing about its shape is taken for granted.
 */

import { RestoreError } from './errors';
import { isDescendant, type StateNode } from './node';
import type { EventObject, StateValue } from './types';

/** Event carried by a state that was produced by Machine.restoreState(). */
export const RESTORE_EVENT_TYPE = 'statechart.restore';

/** What State.toJSON() produces. */
export interface StateJSON<C> {
  value: StateValue;
  context: C;
  /** History state id to the ids of the states it remembers. */
  history: { [historyId: string]: string[] };
  done: boolean;
}

/** What Machine.restoreState() accepts: `history` and `done` may be left out. */
export type PersistedState<C> = Pick<StateJSON<C>, 'value' | 'context'> & Partial<StateJSON<C>>;

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childOf<C, E extends EventObject>(node: StateNode<C, E>, key: string): StateNode<C, E> {
  const child = node.child(key);
  if (!child || child.kind === 'history') {
    const known = node.children.filter((item) => item.kind !== 'history').map((item) => item.key);
    throw new RestoreError(node.label, `"${key}" is not a child state (children: ${known.join(', ')}).`);
  }
  return child;
}

function resolveNode<C, E extends EventObject>(
  node: StateNode<C, E>,
  value: unknown,
  configuration: Set<StateNode<C, E>>,
): void {
  configuration.add(node);
  if (node.isLeaf) {
    if (!isPlainObject(value) || Object.keys(value).length > 0) {
      throw new RestoreError(node.label, 'A state without children must have the value {}.');
    }
    return;
  }
  if (node.kind === 'compound' && typeof value === 'string') {
    const child = childOf(node, value);
    if (!child.isLeaf) {
      throw new RestoreError(node.label, `Child "${value}" has child states of its own; its value must be an object.`);
    }
    configuration.add(child);
    return;
  }
  if (!isPlainObject(value)) {
    throw new RestoreError(node.label, 'The value must be a child key or an object keyed by child.');
  }
  const keys = Object.keys(value);
  if (node.kind === 'compound') {
    if (keys.length !== 1) {
      throw new RestoreError(node.label, `Exactly one child must be active, got ${keys.length}.`);
    }
    resolveNode(childOf(node, keys[0]), value[keys[0]], configuration);
    return;
  }
  for (const key of keys) {
    resolveNode(childOf(node, key), value[key], configuration);
  }
  for (const region of node.children) {
    if (region.kind !== 'history' && !configuration.has(region)) {
      throw new RestoreError(node.label, `Region "${region.key}" of the parallel state is missing.`);
    }
  }
}

/**
 * Resolves a state value into the set of active nodes. The value has to name
 * the active child of every compound state and every region of every parallel
 * state, exactly as State.value does.
 *
 * @throws RestoreError
 */
export function resolveConfiguration<C, E extends EventObject>(
  root: StateNode<C, E>,
  value: unknown,
): Set<StateNode<C, E>> {
  const configuration = new Set<StateNode<C, E>>();
  resolveNode(root, value, configuration);
  return configuration;
}

/**
 * Checks persisted history against the definition.
 *
 * @throws RestoreError
 */
export function resolveHistory<C, E extends EventObject>(
  byId: ReadonlyMap<string, StateNode<C, E>>,
  history: unknown,
): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  if (history === undefined) {
    return result;
  }
  if (!isPlainObject(history)) {
    throw new RestoreError('(history)', 'History must be an object keyed by history state id.');
  }
  for (const [historyId, stateIds] of Object.entries(history)) {
    const node = byId.get(historyId);
    if (!node || node.kind !== 'history' || !node.parent) {
      throw new RestoreError('(history)', `"${historyId}" is not the id of a history state.`);
    }
    if (!Array.isArray(stateIds) || stateIds.length === 0) {
      throw new RestoreError(node.label, 'Recorded history must be a non-empty array of state ids.');
    }
    for (const stateId of stateIds as unknown[]) {
      const remembered = typeof stateId === 'string' ? byId.get(stateId) : undefined;
      if (!remembered || remembered.kind === 'history' || !isDescendant(remembered, node.parent)) {
        throw new RestoreError(node.label, `"${String(stateId)}" is not a state inside "${node.parent.label}".`);
      }
    }
    result.set(historyId, [...(stateIds as string[])]);
  }
  return result;
}

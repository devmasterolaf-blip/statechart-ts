/**
 * Human-readable labels for transitions, shared by the diagram exporters.
 */

import { ALWAYS_EVENT, type StateNode, type TransitionDefinition } from '../node';
import type { ActionConfig, EventObject, GuardConfig } from '../types';

const INLINE = 'inline';

/** Name of a guard for display; inline functions show their function name. */
export function guardLabel<C, E extends EventObject>(guard: GuardConfig<C, E>): string {
  if (typeof guard === 'string') {
    return guard;
  }
  if (typeof guard === 'function') {
    return guard.name || INLINE;
  }
  switch (guard.type) {
    case 'not':
      return `not(${guardLabel(guard.guard)})`;
    case 'and':
    case 'or':
      return `${guard.type}(${guard.guards.map((inner) => guardLabel(inner)).join(', ')})`;
    case 'in':
      return `in ${guard.state}`;
  }
}

/** Name of an action for display. */
export function actionLabel<C, E extends EventObject>(action: ActionConfig<C, E>): string {
  if (typeof action === 'string') {
    return action;
  }
  if (typeof action === 'function') {
    return action.name || INLINE;
  }
  return action.type === 'raise' ? `raise ${action.event.type}` : 'assign';
}

/**
 * The trigger of a transition: the event type, `always` for an eventless
 * transition, `after <delay>` for a delayed one and `done` for onDone.
 */
export function triggerLabel<C, E extends EventObject>(transition: TransitionDefinition<C, E>): string {
  const { eventType, source } = transition;
  if (eventType === ALWAYS_EVENT) {
    return 'always';
  }
  const delay = source.delays.find((item) => item.eventType === eventType);
  if (delay) {
    return typeof delay.delay === 'number' ? `after ${delay.delay}ms` : `after ${delay.delay}`;
  }
  if (source.config.onDone !== undefined && eventType === `done.state.${source.id}`) {
    return 'done';
  }
  return eventType;
}

/** `TRIGGER [guard] / action, action` with the empty parts left out. */
export function transitionLabel<C, E extends EventObject>(
  transition: TransitionDefinition<C, E>,
  withActions = true,
): string {
  let label = triggerLabel(transition);
  if (transition.guard !== undefined) {
    label += ` [${guardLabel(transition.guard)}]`;
  }
  if (withActions && transition.actions.length > 0) {
    label += ` / ${transition.actions.map((action) => actionLabel(action)).join(', ')}`;
  }
  return label;
}

/** `entry / a, b` and `exit / c` lines of a state. */
export function activityLines<C, E extends EventObject>(node: StateNode<C, E>): string[] {
  const lines: string[] = [];
  if (node.entry.length > 0) {
    lines.push(`entry / ${node.entry.map((action) => actionLabel(action)).join(', ')}`);
  }
  if (node.exit.length > 0) {
    lines.push(`exit / ${node.exit.map((action) => actionLabel(action)).join(', ')}`);
  }
  return lines;
}

/** True when the root itself has to be drawn as a box around everything. */
export function needsRootBox<C, E extends EventObject>(root: StateNode<C, E>): boolean {
  return root.kind === 'parallel' || root.transitions.length > 0;
}

export interface DiagramOptions {
  /** Layout direction: top to bottom (default) or left to right. */
  direction?: 'TB' | 'LR';
  /** Show transition actions and entry/exit actions. Defaults to true. */
  actions?: boolean;
}

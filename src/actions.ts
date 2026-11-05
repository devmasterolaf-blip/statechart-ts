/** Creators for the built-in action objects. */

import type { AssignAction, Assigner, EventObject, PropertyAssigner, RaiseAction } from './types';

/**
 * Updates the context. Takes either a function returning a partial context or
 * an object whose properties are new values or functions computing them. All
 * property functions see the context as it was before this action.
 *
 * The context and event types come from where the action is used (or from
 * explicit type arguments), never from the argument itself.
 */
export function assign<C, E extends EventObject = EventObject>(
  assignment: NoInfer<Assigner<C, E> | PropertyAssigner<C, E>>,
): AssignAction<C, E> {
  return { type: 'assign', assignment };
}

/** Raises an internal event, handled before any further external event. */
export function raise<E extends EventObject>(event: NoInfer<E> | NoInfer<E>['type']): RaiseAction<E> {
  return { type: 'raise', event: typeof event === 'string' ? ({ type: event } as E) : event };
}

/** Applies an assign action to a context and returns the new context. */
export function applyAssign<C, E extends EventObject>(action: AssignAction<C, E>, context: C, event: E): C {
  const { assignment } = action;
  if (typeof assignment === 'function') {
    return { ...context, ...assignment(context, event) };
  }
  const next = { ...context };
  for (const key of Object.keys(assignment) as (keyof C)[]) {
    const value = assignment[key];
    next[key] =
      typeof value === 'function' ? (value as (context: C, event: E) => C[keyof C])(context, event) : (value as C[keyof C]);
  }
  return next;
}

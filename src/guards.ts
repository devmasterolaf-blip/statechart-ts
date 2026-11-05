/** Guard combinators and guard evaluation. */

import { GuardEvaluationError, MissingImplementationError } from './errors';
import type {
  AndGuard,
  EventObject,
  GuardConfig,
  GuardFn,
  GuardMeta,
  InStateGuard,
  NotGuard,
  OrGuard,
} from './types';

/** Passes when the wrapped guard fails. */
export function not<C, E extends EventObject>(guard: GuardConfig<C, E>): NotGuard<C, E> {
  return { type: 'not', guard };
}

/** Passes when every guard passes; evaluation stops at the first failure. */
export function and<C, E extends EventObject>(...guards: GuardConfig<C, E>[]): AndGuard<C, E> {
  return { type: 'and', guards };
}

/** Passes when any guard passes; evaluation stops at the first success. */
export function or<C, E extends EventObject>(...guards: GuardConfig<C, E>[]): OrGuard<C, E> {
  return { type: 'or', guards };
}

/** Passes while the state with the given id is active. A leading `#` is optional. */
export function stateIn(stateId: string): InStateGuard {
  return { type: 'in', state: stateId.startsWith('#') ? stateId.slice(1) : stateId };
}

export interface GuardScope<C, E extends EventObject> {
  context: C;
  event: E;
  meta: GuardMeta;
  guards: { [name: string]: GuardFn<C, E> } | undefined;
  /** Label of the state owning the transition, for error messages. */
  owner: string;
}

/**
 * Evaluates a guard config.
 *
 * @throws MissingImplementationError for an unknown guard name.
 * @throws GuardEvaluationError when a guard function throws.
 */
export function evaluateGuard<C, E extends EventObject>(guard: GuardConfig<C, E>, scope: GuardScope<C, E>): boolean {
  if (typeof guard === 'string') {
    const implementation = scope.guards?.[guard];
    if (!implementation) {
      throw new MissingImplementationError('guard', guard, scope.owner);
    }
    return call(implementation, guard, scope);
  }
  if (typeof guard === 'function') {
    return call(guard, undefined, scope);
  }
  switch (guard.type) {
    case 'not':
      return !evaluateGuard(guard.guard, scope);
    case 'and':
      return guard.guards.every((inner) => evaluateGuard(inner, scope));
    case 'or':
      return guard.guards.some((inner) => evaluateGuard(inner, scope));
    case 'in':
      return scope.meta.isActive(guard.state);
  }
}

function call<C, E extends EventObject>(guard: GuardFn<C, E>, name: string | undefined, scope: GuardScope<C, E>): boolean {
  try {
    return Boolean(guard(scope.context, scope.event, scope.meta));
  } catch (cause) {
    throw new GuardEvaluationError(name, scope.owner, scope.event.type, cause);
  }
}

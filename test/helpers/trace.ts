import type { EventObject, State } from '../../src/index';

/**
 * Runs the exec effects of a state the way a service would and returns the
 * names of the named actions in execution order.
 */
export function effectNames<C, E extends EventObject>(state: State<C, E>): string[] {
  const names: string[] = [];
  for (const effect of state.effects) {
    if (effect.kind === 'exec') {
      names.push(effect.name ?? '(inline)');
    }
  }
  return names;
}

/** Implementations that do nothing, one per given action name. */
export function noopActions(...names: string[]): { [name: string]: () => void } {
  return Object.fromEntries(names.map((name) => [name, () => undefined]));
}

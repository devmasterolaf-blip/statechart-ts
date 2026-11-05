/** Library version, kept in sync with package.json. */
export const VERSION = '0.1.0';

export * from './types';
export * from './errors';
export { assign, raise } from './actions';
export { and, not, or, stateIn } from './guards';
export { StateNode } from './node';
export type { TransitionDefinition, DelayDefinition } from './node';
export { State } from './state';
export type { Effect, ExecEffect } from './state';
export { Machine, createMachine } from './machine';
export { ClockError, SimulatedClock, SystemClock } from './clock';
export type { Clock, TimerHandle } from './clock';

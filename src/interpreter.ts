/**
 * Service: runs a machine. It keeps the current state, executes the effects
 * of every step and processes events one at a time (run-to-completion): an
 * event sent while another is being handled waits in a queue.
 */

import { ActionExecutionError, ServiceStateError } from './errors';
import { toEventObject, type Machine } from './machine';
import type { Effect, State } from './state';
import type { ActionMeta, EventObject } from './types';

/**
 * - `idle`: created, not started; sent events are kept for start().
 * - `running`: processing events.
 * - `done`: the machine reached a top-level final state.
 * - `stopped`: stop() was called.
 */
export type ServiceStatus = 'idle' | 'running' | 'done' | 'stopped';

export type StateListener<C, E extends EventObject> = (state: State<C, E>) => void;
export type ErrorListener = (error: unknown) => void;
export type Unsubscribe = () => void;

export class Service<C, E extends EventObject> {
  readonly machine: Machine<C, E>;
  private current: State<C, E> | undefined;
  private currentStatus: ServiceStatus = 'idle';
  private readonly queue: E[] = [];
  private processing = false;
  private readonly listeners = new Set<StateListener<C, E>>();
  private readonly doneListeners = new Set<StateListener<C, E>>();
  private readonly errorListeners = new Set<ErrorListener>();
  /** Errors of the current processing run, when nobody listens for errors. */
  private pendingErrors: unknown[] = [];
  private readonly meta: ActionMeta<E> = { send: (event) => this.send(event) };

  constructor(machine: Machine<C, E>) {
    this.machine = machine;
  }

  get status(): ServiceStatus {
    return this.currentStatus;
  }

  /** The current state; before start() this is the machine's initial state. */
  getSnapshot(): State<C, E> {
    return this.current ?? this.machine.initialState;
  }

  /**
   * Enters the initial state, runs its effects, then handles the events that
   * were sent before the start. Calling it on a running service does nothing.
   *
   * @throws ServiceStateError when the service was stopped or is done.
   */
  start(): this {
    if (this.currentStatus === 'running') {
      return this;
    }
    if (this.currentStatus !== 'idle') {
      throw new ServiceStateError(`A service that is ${this.currentStatus} cannot be started again.`);
    }
    this.currentStatus = 'running';
    this.process(() => this.commit(this.machine.initialState));
    return this;
  }

  /** Stops the service. Queued and later events are dropped. */
  stop(): this {
    if (this.currentStatus === 'running' || this.currentStatus === 'idle') {
      this.currentStatus = 'stopped';
      this.queue.length = 0;
    }
    return this;
  }

  /**
   * Sends an event. If an event is being processed (the call comes from an
   * action or a listener) the new event is handled right after it. Events
   * sent to a stopped or finished service are ignored.
   */
  send(event: E | E['type']): void {
    if (this.currentStatus === 'stopped' || this.currentStatus === 'done') {
      return;
    }
    this.queue.push(toEventObject(event));
    if (this.currentStatus === 'running') {
      this.process();
    }
  }

  /**
   * Calls the listener after every processed event (check `state.changed` to
   * skip no-ops). On a running service it is also called at once with the
   * current state.
   */
  subscribe(listener: StateListener<C, E>): Unsubscribe {
    this.listeners.add(listener);
    if (this.current && this.currentStatus === 'running') {
      listener(this.current);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Calls the listener once when the machine reaches a top-level final state. */
  onDone(listener: StateListener<C, E>): Unsubscribe {
    this.doneListeners.add(listener);
    return () => {
      this.doneListeners.delete(listener);
    };
  }

  /**
   * Receives errors thrown by guards, actions and listeners. Without an error
   * listener the first error of a run is rethrown from send() or start()
   * after the queue has been drained.
   */
  onError(listener: ErrorListener): Unsubscribe {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------

  /** Runs `first` (if any) and then drains the queue, unless already draining. */
  private process(first?: () => void): void {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      if (first) {
        this.guarded(first);
      }
      while (this.queue.length > 0 && this.currentStatus === 'running') {
        const event = this.queue.shift() as E;
        this.guarded(() => this.commit(this.machine.transition(this.getSnapshot(), event)));
      }
    } finally {
      this.processing = false;
    }
    const errors = this.pendingErrors;
    this.pendingErrors = [];
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private guarded(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    if (this.errorListeners.size === 0) {
      this.pendingErrors.push(error);
      return;
    }
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }

  /** Makes `state` current, executes its effects and notifies listeners. */
  private commit(state: State<C, E>): void {
    this.current = state;
    for (const effect of state.effects) {
      this.execute(effect);
    }
    if (state.done) {
      this.currentStatus = 'done';
      this.queue.length = 0;
    }
    for (const listener of [...this.listeners]) {
      this.guarded(() => listener(state));
    }
    if (state.done) {
      for (const listener of [...this.doneListeners]) {
        this.guarded(() => listener(state));
      }
    }
  }

  private execute(effect: Effect<C, E>): void {
    try {
      effect.exec(effect.context, effect.event, this.meta);
    } catch (cause) {
      this.report(new ActionExecutionError(effect.name, effect.event.type, cause));
    }
  }
}

/** Creates a service for a machine. Call start() to run it. */
export function interpret<C, E extends EventObject>(machine: Machine<C, E>): Service<C, E> {
  return new Service(machine);
}

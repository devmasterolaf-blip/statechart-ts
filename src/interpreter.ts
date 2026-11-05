/**
 * Service: runs a machine. It keeps the current state, executes the effects
 * of every step and processes events one at a time (run-to-completion): an
 * event sent while another is being handled waits in a queue.
 */

import { SystemClock, type Clock, type TimerHandle } from './clock';
import { ActionExecutionError, RestoreError, ServiceStateError } from './errors';
import { toEventObject, type Machine } from './machine';
import type { PersistedState, StateJSON } from './serialize';
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

/** A pending delayed transition as stored in a service snapshot. */
export interface TimerJSON {
  id: string;
  event: EventObject;
  /** Milliseconds left until the timer fires. */
  remaining: number;
}

/** What Service.persist() produces. */
export interface ServiceSnapshot<C> {
  state: StateJSON<C>;
  timers: TimerJSON[];
}

/** What a service can be resumed from; `timers` may be left out. */
export interface PersistedService<C> {
  state: PersistedState<C>;
  timers?: TimerJSON[];
}

export interface ServiceOptions<C = unknown> {
  /** Drives delayed transitions. Defaults to the system clock. */
  clock?: Clock;
  /**
   * Resume from the output of Service.persist() instead of entering the
   * initial state. Entry actions are not run again; the pending timers are
   * started with the time they had left.
   */
  snapshot?: PersistedService<C>;
}

interface ActiveTimer {
  handle: TimerHandle;
  event: EventObject;
  /** Clock time at which the timer fires. */
  due: number;
}

export class Service<C, E extends EventObject> {
  readonly machine: Machine<C, E>;
  readonly clock: Clock;
  private readonly timers = new Map<string, ActiveTimer>();
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
  /** Timers to start again when the service was created from a snapshot. */
  private readonly restoredTimers: TimerJSON[] | undefined;

  /**
   * @throws RestoreError when `options.snapshot` does not fit the machine.
   */
  constructor(machine: Machine<C, E>, options: ServiceOptions<C> = {}) {
    this.machine = machine;
    this.clock = options.clock ?? new SystemClock();
    if (options.snapshot !== undefined) {
      const { snapshot } = options;
      if (typeof snapshot !== 'object' || snapshot === null) {
        throw new RestoreError('(root)', 'A service snapshot must be an object with "state".');
      }
      this.current = machine.restoreState(snapshot.state);
      this.restoredTimers = checkTimers(snapshot.timers);
    }
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
    this.process(() => this.enter());
    return this;
  }

  private enter(): void {
    if (!this.current || !this.restoredTimers) {
      this.commit(this.machine.initialState);
      return;
    }
    this.commit(this.current);
    for (const timer of this.restoredTimers) {
      // A listener may have stopped the service while it was being resumed.
      if (this.currentStatus === 'running') {
        this.schedule(timer.id, timer.event, timer.remaining);
      }
    }
  }

  /**
   * The current state plus the pending timers, as plain data. Feed it to
   * `interpret(machine, { snapshot })` to continue later, in this process or
   * another one. Events still waiting in the queue are not part of it, so
   * call this between events rather than from an action.
   *
   * @throws ServiceStateError when the service has not been started.
   */
  persist(): ServiceSnapshot<C> {
    if (this.currentStatus === 'idle') {
      throw new ServiceStateError('A service has to be started before it can be persisted.');
    }
    const now = this.clock.now();
    const timers: TimerJSON[] = [];
    for (const [id, timer] of this.timers) {
      timers.push({ id, event: timer.event, remaining: Math.max(0, timer.due - now) });
    }
    return { state: this.getSnapshot().toJSON(), timers };
  }

  /** Stops the service. Queued and later events are dropped, timers cancelled. */
  stop(): this {
    if (this.currentStatus === 'running' || this.currentStatus === 'idle') {
      this.currentStatus = 'stopped';
      this.queue.length = 0;
      this.cancelAllTimers();
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
      this.cancelAllTimers();
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
    switch (effect.kind) {
      case 'exec':
        try {
          effect.exec(effect.context, effect.event, this.meta);
        } catch (cause) {
          this.report(new ActionExecutionError(effect.name, effect.event.type, cause));
        }
        break;
      case 'schedule':
        this.schedule(effect.id, effect.event, effect.delay);
        break;
      case 'cancel':
        this.cancel(effect.id);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private schedule(id: string, event: EventObject, delay: number): void {
    this.cancel(id);
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(id);
      this.send(event as E);
    }, delay);
    this.timers.set(id, { handle, event, due: this.clock.now() + delay });
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      this.clock.clearTimeout(timer.handle);
      this.timers.delete(id);
    }
  }

  private cancelAllTimers(): void {
    for (const id of [...this.timers.keys()]) {
      this.cancel(id);
    }
  }
}

function checkTimers(timers: unknown): TimerJSON[] {
  if (timers === undefined) {
    return [];
  }
  if (!Array.isArray(timers)) {
    throw new RestoreError('(timers)', 'Timers must be an array.');
  }
  return (timers as unknown[]).map((item, index) => {
    const timer = item as Partial<TimerJSON> | null;
    const event = timer?.event as Partial<EventObject> | null | undefined;
    if (typeof timer !== 'object' || timer === null || typeof timer.id !== 'string') {
      throw new RestoreError('(timers)', `Timer ${index} needs a string "id".`);
    }
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
      throw new RestoreError('(timers)', `Timer "${timer.id}" needs an "event" with a string type.`);
    }
    if (typeof timer.remaining !== 'number' || !Number.isFinite(timer.remaining) || timer.remaining < 0) {
      throw new RestoreError('(timers)', `Timer "${timer.id}" needs a finite "remaining" time >= 0.`);
    }
    return { id: timer.id, event: event as EventObject, remaining: timer.remaining };
  });
}

/**
 * Creates a service for a machine. Call start() to run it.
 *
 * @throws RestoreError when `options.snapshot` does not fit the machine.
 */
export function interpret<C, E extends EventObject>(
  machine: Machine<C, E>,
  options?: ServiceOptions<C>,
): Service<C, E> {
  return new Service(machine, options);
}

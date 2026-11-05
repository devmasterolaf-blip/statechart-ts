/**
 * Clocks. A Service never touches timers directly; it goes through a Clock,
 * so that tests (and simulations) can drive time by hand.
 */

import { StatechartError } from './errors';

export type TimerHandle = unknown;

export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock: Date.now and the global timers. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delay: number): TimerHandle {
    return setTimeout(callback, delay);
  }

  clearTimeout(handle: TimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/** A clock operation was called with an argument that makes no sense. */
export class ClockError extends StatechartError {
  constructor(message: string) {
    super('invalid-clock-operation', message);
  }
}

interface PendingTimer {
  id: number;
  due: number;
  callback: () => void;
}

/**
 * A manually driven clock. Time only moves through advance(), advanceTo() and
 * runAll(); timers fire in order of due time, ties in order of creation.
 */
export class SimulatedClock implements Clock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, PendingTimer>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  /** Number of timers that have not fired or been cleared yet. */
  get pending(): number {
    return this.timers.size;
  }

  /** Due time of the earliest pending timer. */
  nextDue(): number | undefined {
    return this.earliest()?.due;
  }

  setTimeout(callback: () => void, delay: number): TimerHandle {
    const id = this.nextId++;
    const effective = Number.isFinite(delay) && delay > 0 ? delay : 0;
    this.timers.set(id, { id, due: this.time + effective, callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /**
   * Moves time forward by `ms` and fires every timer that becomes due,
   * including timers created by the callbacks themselves when they fall
   * inside the window. Returns the number of timers fired.
   */
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ClockError(`Cannot advance the clock by ${ms} ms.`);
    }
    return this.advanceTo(this.time + ms);
  }

  /** Moves time forward to an absolute time; see advance(). */
  advanceTo(time: number): number {
    if (!Number.isFinite(time) || time < this.time) {
      throw new ClockError(`Cannot move the clock from ${this.time} back to ${time}.`);
    }
    let fired = 0;
    for (;;) {
      const next = this.earliest();
      if (!next || next.due > time) {
        break;
      }
      this.timers.delete(next.id);
      this.time = next.due;
      next.callback();
      fired++;
    }
    this.time = time;
    return fired;
  }

  /**
   * Fires pending timers until none is left, jumping from due time to due
   * time. Stops with an error after `limit` timers, which catches callbacks
   * that keep rescheduling themselves.
   */
  runAll(limit = 10_000): number {
    let fired = 0;
    for (;;) {
      const next = this.earliest();
      if (!next) {
        return fired;
      }
      if (fired >= limit) {
        throw new ClockError(`runAll() fired ${limit} timers and more are still pending.`);
      }
      this.timers.delete(next.id);
      this.time = next.due;
      next.callback();
      fired++;
    }
  }

  private earliest(): PendingTimer | undefined {
    let best: PendingTimer | undefined;
    for (const timer of this.timers.values()) {
      if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) {
        best = timer;
      }
    }
    return best;
  }
}

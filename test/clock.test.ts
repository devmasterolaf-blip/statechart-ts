import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockError, SimulatedClock, SystemClock } from '../src/clock';

test('timers fire in order of due time, ties in creation order', () => {
  const clock = new SimulatedClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push('late'), 300);
  clock.setTimeout(() => fired.push('early'), 100);
  clock.setTimeout(() => fired.push('tie-1'), 200);
  clock.setTimeout(() => fired.push('tie-2'), 200);
  assert.equal(clock.pending, 4);
  assert.equal(clock.nextDue(), 100);
  assert.equal(clock.advance(250), 3);
  assert.deepEqual(fired, ['early', 'tie-1', 'tie-2']);
  assert.equal(clock.now(), 250);
  assert.equal(clock.advance(50), 1);
  assert.deepEqual(fired, ['early', 'tie-1', 'tie-2', 'late']);
  assert.equal(clock.pending, 0);
  assert.equal(clock.nextDue(), undefined);
});

test('a timer does not fire before its due time and fires exactly at it', () => {
  const clock = new SimulatedClock(1000);
  let count = 0;
  clock.setTimeout(() => count++, 50);
  clock.advance(49);
  assert.equal(count, 0);
  clock.advance(1);
  assert.equal(count, 1);
  assert.equal(clock.now(), 1050);
});

test('callbacks observe the due time of their timer', () => {
  const clock = new SimulatedClock();
  const seen: number[] = [];
  clock.setTimeout(() => seen.push(clock.now()), 10);
  clock.setTimeout(() => seen.push(clock.now()), 25);
  clock.advance(100);
  assert.deepEqual(seen, [10, 25]);
  assert.equal(clock.now(), 100);
});

test('timers created by callbacks fire in the same advance when they fall inside the window', () => {
  const clock = new SimulatedClock();
  const fired: string[] = [];
  clock.setTimeout(() => {
    fired.push('first');
    clock.setTimeout(() => fired.push('chained'), 20);
    clock.setTimeout(() => fired.push('outside'), 500);
  }, 10);
  clock.advance(100);
  assert.deepEqual(fired, ['first', 'chained']);
  assert.equal(clock.pending, 1);
});

test('cleared timers never fire and clearing twice is harmless', () => {
  const clock = new SimulatedClock();
  let fired = false;
  const handle = clock.setTimeout(() => (fired = true), 10);
  clock.clearTimeout(handle);
  clock.clearTimeout(handle);
  clock.clearTimeout('not a handle');
  clock.advance(100);
  assert.equal(fired, false);
});

test('zero, negative and non-finite delays are due immediately but still need an advance', () => {
  const clock = new SimulatedClock();
  const fired: number[] = [];
  clock.setTimeout(() => fired.push(1), 0);
  clock.setTimeout(() => fired.push(2), -5);
  clock.setTimeout(() => fired.push(3), Number.NaN);
  assert.deepEqual(fired, []);
  clock.advance(0);
  assert.deepEqual(fired, [1, 2, 3]);
});

test('advanceTo moves to an absolute time and refuses to go back', () => {
  const clock = new SimulatedClock(100);
  let fired = 0;
  clock.setTimeout(() => fired++, 50);
  assert.equal(clock.advanceTo(150), 1);
  assert.equal(fired, 1);
  assert.throws(() => clock.advanceTo(149), ClockError);
  assert.throws(() => clock.advance(-1), (error: unknown) => error instanceof ClockError && error.code === 'invalid-clock-operation');
  assert.throws(() => clock.advance(Number.POSITIVE_INFINITY), ClockError);
});

test('runAll drains every timer and jumps to the last due time', () => {
  const clock = new SimulatedClock();
  const fired: number[] = [];
  clock.setTimeout(() => {
    fired.push(clock.now());
    clock.setTimeout(() => fired.push(clock.now()), 1000);
  }, 5);
  assert.equal(clock.runAll(), 2);
  assert.deepEqual(fired, [5, 1005]);
  assert.equal(clock.now(), 1005);
  assert.equal(clock.runAll(), 0);
});

test('runAll gives up on timers that reschedule themselves forever', () => {
  const clock = new SimulatedClock();
  const tick = (): void => {
    clock.setTimeout(tick, 1);
  };
  tick();
  assert.throws(() => clock.runAll(50), /fired 50 timers/);
});

test('SystemClock delegates to the real timers', async () => {
  const clock = new SystemClock();
  assert.ok(Math.abs(clock.now() - Date.now()) < 50);
  let cancelled = false;
  clock.clearTimeout(clock.setTimeout(() => (cancelled = true), 1));
  await new Promise<void>((resolve) => clock.setTimeout(resolve, 5));
  assert.equal(cancelled, false);
});

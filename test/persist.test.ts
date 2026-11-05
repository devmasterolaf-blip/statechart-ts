import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RestoreError,
  ServiceStateError,
  SimulatedClock,
  assign,
  createMachine,
  interpret,
  type PersistedService,
  type ServiceSnapshot,
} from '../src/index';

type DoorEvent = { type: 'OPEN' } | { type: 'CLOSE' } | { type: 'LOCK' };
interface DoorContext {
  opened: number;
  log: string[];
}

function doorMachine() {
  return createMachine<DoorContext, DoorEvent>({
    id: 'door',
    context: { opened: 0, log: [] },
    initial: 'closed',
    states: {
      closed: { on: { OPEN: 'open', LOCK: 'locked' } },
      open: {
        entry: assign({ opened: (context) => context.opened + 1, log: (context) => [...context.log, 'enter open'] }),
        exit: assign({ log: (context) => [...context.log, 'exit open'] }),
        after: { 5000: 'closed', 1000: { actions: assign({ log: (context) => [...context.log, 'beep'] }) } },
        on: { CLOSE: 'closed' },
      },
      locked: { type: 'final' },
    },
  });
}

function viaJson<T>(snapshot: ServiceSnapshot<T>): PersistedService<T> {
  return JSON.parse(JSON.stringify(snapshot)) as PersistedService<T>;
}

test('persist returns the state and the time left on every timer', () => {
  const clock = new SimulatedClock();
  const service = interpret(doorMachine(), { clock }).start();
  assert.deepEqual(service.persist(), {
    state: { value: 'closed', context: { opened: 0, log: [] }, history: {}, done: false },
    timers: [],
  });
  service.send('OPEN');
  clock.advance(1200);
  const snapshot = service.persist();
  assert.equal(snapshot.state.value, 'open');
  assert.deepEqual(snapshot.state.context.log, ['enter open', 'beep']);
  assert.deepEqual(snapshot.timers, [
    { id: 'after(5000)#door.open', event: { type: 'after(5000)#door.open' }, remaining: 3800 },
  ]);
});

test('persist needs a started service', () => {
  const service = interpret(doorMachine());
  assert.throws(() => service.persist(), ServiceStateError);
});

test('a resumed service continues with the remaining delays on a new clock', () => {
  const firstClock = new SimulatedClock();
  const first = interpret(doorMachine(), { clock: firstClock }).start();
  first.send('OPEN');
  firstClock.advance(400);
  const snapshot = viaJson(first.persist());
  first.stop();

  const clock = new SimulatedClock(1_000_000);
  const second = interpret(doorMachine(), { clock, snapshot });
  assert.equal(second.status, 'idle');
  assert.equal(second.getSnapshot().value, 'open');
  second.start();
  assert.equal(clock.pending, 2);

  clock.advance(599);
  assert.deepEqual(second.getSnapshot().context.log, ['enter open']);
  clock.advance(1);
  assert.deepEqual(second.getSnapshot().context.log, ['enter open', 'beep']);
  clock.advance(3999);
  assert.equal(second.getSnapshot().value, 'open');
  clock.advance(1);
  assert.equal(second.getSnapshot().value, 'closed');
  assert.deepEqual(second.getSnapshot().context, { opened: 1, log: ['enter open', 'beep', 'exit open'] });
  assert.equal(clock.pending, 0);
});

test('resuming does not run entry actions and notifies subscribers once', () => {
  const clock = new SimulatedClock();
  const first = interpret(doorMachine(), { clock }).start();
  first.send('OPEN');
  const snapshot = viaJson(first.persist());

  const second = interpret(doorMachine(), { clock: new SimulatedClock(), snapshot });
  const seen: unknown[] = [];
  second.subscribe((state) => seen.push([state.value, state.changed, state.context.opened]));
  second.start();
  assert.deepEqual(seen, [['open', false, 1]]);
  second.send('CLOSE');
  assert.deepEqual(seen[1], ['closed', true, 1]);
});

test('leaving a state after a resume cancels its restored timers', () => {
  const clock = new SimulatedClock();
  const first = interpret(doorMachine(), { clock }).start();
  first.send('OPEN');
  const snapshot = viaJson(first.persist());

  const nextClock = new SimulatedClock();
  const second = interpret(doorMachine(), { clock: nextClock, snapshot }).start();
  assert.equal(nextClock.pending, 2);
  second.send('CLOSE');
  assert.equal(nextClock.pending, 0);
});

test('events sent before start are handled after the resume', () => {
  const snapshot: PersistedService<DoorContext> = {
    state: { value: 'closed', context: { opened: 4, log: [] } },
  };
  const service = interpret(doorMachine(), { clock: new SimulatedClock(), snapshot });
  service.send('OPEN');
  service.start();
  assert.equal(service.getSnapshot().value, 'open');
  assert.equal(service.getSnapshot().context.opened, 5);
});

test('a snapshot of a finished machine resumes as done', () => {
  const first = interpret(doorMachine(), { clock: new SimulatedClock() }).start();
  first.send('LOCK');
  assert.equal(first.status, 'done');
  const snapshot = viaJson(first.persist());
  assert.equal(snapshot.state.done, true);

  const second = interpret(doorMachine(), { clock: new SimulatedClock(), snapshot });
  let finished = 0;
  second.onDone(() => finished++);
  second.start();
  assert.equal(second.status, 'done');
  assert.equal(finished, 1);
  second.send('OPEN');
  assert.equal(second.getSnapshot().value, 'locked');
});

test('interpret rejects snapshots that do not fit', () => {
  const machine = doorMachine();
  const state = { value: 'open', context: { opened: 1, log: [] } };
  const bad = (snapshot: unknown, path: string, pattern: RegExp): void => {
    assert.throws(
      () => interpret(machine, { snapshot: snapshot as never }),
      (error: unknown) => error instanceof RestoreError && error.path === path && pattern.test(error.message),
    );
  };
  bad(null, '(root)', /must be an object/);
  bad({ state: { value: 'ajar', context: {} } }, '(root)', /"ajar" is not a child state/);
  bad({ state, timers: {} }, '(timers)', /must be an array/);
  bad({ state, timers: [{ event: { type: 'x' }, remaining: 1 }] }, '(timers)', /Timer 0 needs a string "id"/);
  bad({ state, timers: [{ id: 't', event: 'x', remaining: 1 }] }, '(timers)', /needs an "event"/);
  bad({ state, timers: [{ id: 't', event: { type: 'x' }, remaining: -1 }] }, '(timers)', /finite "remaining"/);
  bad({ state, timers: [{ id: 't', event: { type: 'x' }, remaining: null }] }, '(timers)', /finite "remaining"/);
});

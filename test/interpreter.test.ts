import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionExecutionError,
  GuardEvaluationError,
  ServiceStateError,
  assign,
  createMachine,
  interpret,
  type MachineConfig,
} from '../src/index';

type Ev = { type: 'TOGGLE' } | { type: 'BREAK' } | { type: 'PING'; id: number };

function toggleMachine(log: string[]) {
  const config: MachineConfig<{ toggles: number }, Ev> = {
    id: 'toggle',
    context: { toggles: 0 },
    initial: 'off',
    states: {
      off: { entry: () => log.push('enter off'), on: { TOGGLE: 'on' } },
      on: {
        entry: [() => log.push('enter on'), assign({ toggles: (c) => c.toggles + 1 })],
        exit: () => log.push('exit on'),
        on: { TOGGLE: 'off', BREAK: 'broken' },
      },
      broken: { type: 'final' },
    },
  };
  return createMachine(config);
}

test('start enters the initial state, runs its actions and notifies subscribers', () => {
  const log: string[] = [];
  const service = interpret(toggleMachine(log));
  const seen: unknown[] = [];
  service.subscribe((state) => seen.push(state.value));
  assert.equal(service.status, 'idle');
  assert.deepEqual(log, [], 'nothing runs before start');
  assert.equal(service.start(), service);
  assert.equal(service.status, 'running');
  assert.deepEqual(log, ['enter off']);
  assert.deepEqual(seen, ['off']);
  service.start();
  assert.deepEqual(log, ['enter off'], 'starting twice is a no-op');
});

test('send moves the machine, executes actions and updates the snapshot', () => {
  const log: string[] = [];
  const service = interpret(toggleMachine(log)).start();
  service.send('TOGGLE');
  assert.equal(service.getSnapshot().value, 'on');
  assert.equal(service.getSnapshot().context.toggles, 1);
  service.send({ type: 'TOGGLE' });
  assert.deepEqual(log, ['enter off', 'enter on', 'exit on', 'enter off']);
});

test('subscribers are told about every processed event, changed or not', () => {
  const service = interpret(toggleMachine([])).start();
  const seen: Array<[unknown, boolean]> = [];
  const unsubscribe = service.subscribe((state) => seen.push([state.value, state.changed]));
  service.send('TOGGLE');
  service.send({ type: 'PING', id: 1 });
  unsubscribe();
  service.send('TOGGLE');
  assert.deepEqual(seen, [
    ['off', true],
    ['on', true],
    ['on', false],
  ]);
});

test('events sent before start are handled right after the initial state', () => {
  const service = interpret(toggleMachine([]));
  service.send('TOGGLE');
  service.send('TOGGLE');
  service.send('TOGGLE');
  assert.equal(service.getSnapshot().value, 'off', 'still the initial state');
  const seen: unknown[] = [];
  service.subscribe((state) => seen.push(state.value));
  service.start();
  assert.deepEqual(seen, ['off', 'on', 'off', 'on']);
});

test('run-to-completion: events sent from actions wait until the current event is done', () => {
  type E2 = { type: 'START' } | { type: 'STEP' } | { type: 'FINISH' };
  const order: string[] = [];
  const machine = createMachine<undefined, E2>({
    initial: 'idle',
    states: {
      idle: {
        on: {
          START: {
            target: 'working',
            actions: [
              (_c, _e, meta) => {
                meta.send('STEP');
                meta.send({ type: 'FINISH' });
                order.push('transition action ran');
              },
            ],
          },
        },
      },
      working: {
        entry: () => order.push('entered working'),
        on: { STEP: { actions: () => order.push('step handled') }, FINISH: 'finished' },
      },
      finished: { entry: () => order.push('entered finished') },
    },
  });
  const service = interpret(machine).start();
  const values: unknown[] = [];
  service.subscribe((state) => values.push(state.value));
  service.send('START');
  assert.deepEqual(order, ['transition action ran', 'entered working', 'step handled', 'entered finished']);
  assert.deepEqual(values, ['idle', 'working', 'working', 'finished']);
});

test('events sent from a subscriber are queued too', () => {
  const service = interpret(toggleMachine([])).start();
  const values: unknown[] = [];
  let reacted = false;
  service.subscribe((state) => {
    values.push(state.value);
    if (state.value === 'on' && !reacted) {
      reacted = true;
      service.send('TOGGLE');
      values.push('sent from listener');
    }
  });
  service.send('TOGGLE');
  assert.deepEqual(values, ['off', 'on', 'sent from listener', 'off']);
});

test('reaching a final state finishes the service', () => {
  const service = interpret(toggleMachine([])).start();
  const done: unknown[] = [];
  const off = service.onDone((state) => done.push(['first', state.value]));
  service.onDone((state) => done.push(['second', state.value]));
  off();
  service.send('TOGGLE');
  service.send('BREAK');
  assert.equal(service.status, 'done');
  assert.deepEqual(done, [['second', 'broken']]);
  service.send('TOGGLE');
  assert.equal(service.getSnapshot().value, 'broken');
  assert.throws(() => service.start(), ServiceStateError);
});

test('stop drops queued and later events and prevents a restart', () => {
  const log: string[] = [];
  const service = interpret(toggleMachine(log)).start();
  const seen: unknown[] = [];
  service.subscribe((state) => {
    seen.push(state.value);
    if (state.value === 'on') {
      service.send('TOGGLE');
      service.stop();
    }
  });
  service.send('TOGGLE');
  service.send('TOGGLE');
  assert.equal(service.status, 'stopped');
  assert.deepEqual(seen, ['off', 'on']);
  assert.equal(service.getSnapshot().value, 'on');
  assert.throws(
    () => service.start(),
    (error: unknown) => error instanceof ServiceStateError && error.code === 'invalid-service-state',
  );
  assert.equal(service.stop(), service);
});

test('subscribing to a running service delivers the current state at once', () => {
  const service = interpret(toggleMachine([])).start();
  service.send('TOGGLE');
  const seen: unknown[] = [];
  service.subscribe((state) => seen.push(state.value));
  assert.deepEqual(seen, ['on']);
});

test('an action that throws surfaces as ActionExecutionError after the step is committed', () => {
  const ran: string[] = [];
  const machine = createMachine(
    {
      initial: 'a',
      states: { a: { on: { GO: { target: 'b', actions: ['explode', 'after'] } } }, b: { entry: 'entered' } },
    },
    {
      actions: {
        explode: () => {
          throw new Error('kaboom');
        },
        after: () => ran.push('after'),
        entered: () => ran.push('entered'),
      },
    },
  );
  const service = interpret(machine).start();
  assert.throws(
    () => service.send('GO'),
    (error: unknown) => {
      assert.ok(error instanceof ActionExecutionError);
      assert.equal(error.actionName, 'explode');
      assert.match(error.message, /Action "explode" threw while handling event "GO": kaboom/);
      return true;
    },
  );
  assert.equal(service.getSnapshot().value, 'b', 'the transition itself is not undone');
  assert.deepEqual(ran, ['after', 'entered'], 'the remaining actions still run');
  assert.equal(service.status, 'running');
});

test('an error listener receives errors instead of send throwing', () => {
  const machine = createMachine<undefined, { type: 'GO' } | { type: 'OK' }>({
    initial: 'a',
    states: {
      a: {
        on: {
          GO: {
            target: 'b',
            guard: () => {
              throw new Error('bad guard');
            },
          },
          OK: 'b',
        },
      },
      b: {},
    },
  });
  const service = interpret(machine).start();
  const errors: unknown[] = [];
  const off = service.onError((error) => errors.push(error));
  service.send('GO');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof GuardEvaluationError);
  assert.equal(service.getSnapshot().value, 'a', 'a failed transition leaves the state as it was');
  off();
  assert.throws(() => service.send('GO'), GuardEvaluationError);
  service.send('OK');
  assert.equal(service.getSnapshot().value, 'b', 'the service keeps working after an error');
});

test('the queue is drained even when an earlier event failed', () => {
  const machine = createMachine<{ n: number }, { type: 'BAD' } | { type: 'INC' }>({
    context: { n: 0 },
    initial: 'a',
    states: {
      a: {
        on: {
          BAD: {
            actions: (_c, _e, meta) => {
              meta.send('INC');
              throw new Error('first');
            },
          },
          INC: { actions: assign({ n: (c) => c.n + 1 }) },
        },
      },
    },
  });
  const service = interpret(machine).start();
  assert.throws(() => service.send('BAD'), /first/);
  assert.equal(service.getSnapshot().context.n, 1);
});

test('a throwing subscriber does not stop other subscribers', () => {
  const service = interpret(toggleMachine([])).start();
  const seen: unknown[] = [];
  service.subscribe((state) => {
    if (state.value === 'on') {
      throw new Error('listener failed');
    }
  });
  service.subscribe((state) => seen.push(state.value));
  assert.throws(() => service.send('TOGGLE'), /listener failed/);
  assert.deepEqual(seen, ['off', 'on']);
});

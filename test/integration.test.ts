/**
 * End-to-end scenarios that use several parts of the library together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SimulatedClock,
  assign,
  createMachine,
  interpret,
  parseMachineConfig,
  raise,
  toDot,
  toMermaid,
  validateMachine,
  type PersistedService,
} from '../src/index';

const examples = join(__dirname, '..', '..', 'examples');

function example(name: string) {
  return parseMachineConfig(readFileSync(join(examples, name), 'utf8'));
}

test('traffic light example: runs from JSON, survives a restart mid-cycle', () => {
  const config = example('traffic-light.json');
  const log: string[] = [];
  const implementations = {
    guards: { minGreenElapsed: () => true },
    actions: {
      countCycle: assign<{ cycles: number }>({ cycles: (context) => context.cycles + 1 }),
      startFlashing: () => log.push('flash on'),
      stopFlashing: () => log.push('flash off'),
    },
    delays: { RED_TIME: 20_000 },
  };
  assert.deepEqual(validateMachine(config, { implementations: implementations as never }), []);
  const machine = createMachine<{ cycles: number }>(config as never, implementations);

  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  const values: unknown[] = [];
  service.subscribe((state) => values.push(state.value));

  clock.advance(30_000);
  clock.advance(4_000);
  assert.deepEqual(service.getSnapshot().value, { working: 'red' });
  assert.equal(service.getSnapshot().context.cycles, 1);

  // Half-way through red the process "restarts".
  clock.advance(12_000);
  const snapshot = JSON.parse(JSON.stringify(service.persist())) as PersistedService<{ cycles: number }>;
  service.stop();
  assert.equal(clock.pending, 0);

  const laterClock = new SimulatedClock(5_000_000);
  const resumed = interpret(machine, { clock: laterClock, snapshot }).start();
  laterClock.advance(7_999);
  assert.deepEqual(resumed.getSnapshot().value, { working: 'red' });
  laterClock.advance(1);
  assert.deepEqual(resumed.getSnapshot().value, { working: 'green' });

  // The pedestrian button shortens green; a power cut leaves the cycle.
  resumed.send({ type: 'PEDESTRIAN' });
  assert.deepEqual(resumed.getSnapshot().value, { working: 'yellow' });
  resumed.send({ type: 'POWER_OUT' });
  assert.equal(resumed.getSnapshot().value, 'flashing');
  assert.equal(laterClock.pending, 0);
  resumed.send({ type: 'POWER_BACK' });
  assert.deepEqual(resumed.getSnapshot().value, { working: 'green' });
  assert.deepEqual(log, ['flash on', 'flash off']);
  assert.equal(resumed.getSnapshot().context.cycles, 1);

  assert.deepEqual(values, [{ working: 'green' }, { working: 'yellow' }, { working: 'red' }]);
});

test('media player example: history brings back both regions', () => {
  const machine = createMachine(example('media-player.json'), {
    guards: { trayLocked: () => false },
    actions: { startPlayback: () => undefined, pausePlayback: () => undefined, openTray: () => undefined },
  });
  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  for (const type of ['PLAY', 'MUTE', 'PAUSE']) {
    service.send({ type });
  }
  assert.deepEqual(service.getSnapshot().value, { active: { transport: 'paused', sound: 'off' } });

  // Ten minutes of pause stop the player; RESUME returns to the same spot.
  clock.advance(600_000);
  assert.equal(service.getSnapshot().value, 'stopped');
  service.send({ type: 'RESUME' });
  assert.deepEqual(service.getSnapshot().value, { active: { transport: 'paused', sound: 'off' } });
  service.send({ type: 'STOP' });
  service.send({ type: 'EJECT' });
  assert.equal(service.status, 'done');

  assert.match(toMermaid(machine), /stopped --> active_memory : RESUME/);
  assert.match(toDot(machine), /"player.stopped" -> "player.active.memory" \[label="RESUME"\];/);
});

type OrderEvent =
  | { type: 'ADD'; price: number }
  | { type: 'CHECKOUT' }
  | { type: 'PAID' }
  | { type: 'PACKED' }
  | { type: 'CANCEL' }
  | { type: 'REFUNDED' }
  | { type: 'EMPTY_CART' };

interface OrderContext {
  total: number;
  trace: string[];
}

function orderMachine() {
  const note =
    (text: string) =>
    (context: OrderContext): Partial<OrderContext> => ({ trace: [...context.trace, text] });
  return createMachine<OrderContext, OrderEvent>({
    id: 'order',
    context: { total: 0, trace: [] },
    initial: 'cart',
    states: {
      cart: {
        on: {
          ADD: { actions: assign({ total: (context, event) => context.total + event.price }) },
          CHECKOUT: [{ target: 'fulfilment', guard: (context) => context.total > 0 }, { actions: raise('EMPTY_CART') }],
          EMPTY_CART: { actions: assign(note('cart was empty')) },
        },
      },
      fulfilment: {
        type: 'parallel',
        entry: assign(note('enter fulfilment')),
        exit: assign(note('exit fulfilment')),
        onDone: 'delivered',
        on: { CANCEL: 'cancelling' },
        states: {
          payment: {
            initial: 'pending',
            states: {
              pending: { on: { PAID: 'settled' }, after: { 900_000: '#order.cancelling' } },
              settled: { type: 'final', entry: assign(note('payment settled')) },
            },
          },
          warehouse: {
            initial: 'picking',
            exit: assign(note('exit warehouse')),
            states: {
              picking: { exit: assign(note('exit picking')), on: { PACKED: 'packed' } },
              packed: { type: 'final', entry: assign(note('packed')) },
            },
          },
        },
      },
      cancelling: {
        entry: assign(note('enter cancelling')),
        always: { target: 'cancelled', guard: (context) => context.total === 0 },
        on: { REFUNDED: { target: 'cancelled', actions: assign({ total: 0 }) } },
      },
      cancelled: { type: 'final' },
      delivered: { type: 'final', entry: assign(note('delivered')) },
    },
  });
}

test('order workflow: both regions have to finish before delivery', () => {
  const service = interpret(orderMachine(), { clock: new SimulatedClock() }).start();
  service.send('CHECKOUT');
  assert.equal(service.getSnapshot().value, 'cart');
  assert.deepEqual(service.getSnapshot().context.trace, ['cart was empty']);

  service.send({ type: 'ADD', price: 30 });
  service.send({ type: 'ADD', price: 12 });
  service.send('CHECKOUT');
  assert.deepEqual(service.getSnapshot().value, { fulfilment: { payment: 'pending', warehouse: 'picking' } });

  service.send('PACKED');
  assert.equal(service.status, 'running');
  service.send('PAID');
  assert.equal(service.status, 'done');
  assert.equal(service.getSnapshot().value, 'delivered');
  assert.deepEqual(service.getSnapshot().context, {
    total: 42,
    trace: [
      'cart was empty',
      'enter fulfilment',
      'exit picking',
      'packed',
      'payment settled',
      'exit warehouse',
      'exit fulfilment',
      'delivered',
    ],
  });
});

test('order workflow: cancelling leaves the regions innermost first and waits for the refund', () => {
  const clock = new SimulatedClock();
  const service = interpret(orderMachine(), { clock }).start();
  service.send({ type: 'ADD', price: 5 });
  service.send('CHECKOUT');
  service.send('CANCEL');
  assert.equal(service.getSnapshot().value, 'cancelling');
  assert.deepEqual(service.getSnapshot().context.trace, [
    'enter fulfilment',
    'exit picking',
    'exit warehouse',
    'exit fulfilment',
    'enter cancelling',
  ]);
  assert.equal(clock.pending, 0);
  service.send('REFUNDED');
  assert.equal(service.status, 'done');
  assert.equal(service.getSnapshot().value, 'cancelled');
});

test('order workflow: an unpaid order times out from inside a region', () => {
  const clock = new SimulatedClock();
  const service = interpret(orderMachine(), { clock }).start();
  service.send({ type: 'ADD', price: 5 });
  service.send('CHECKOUT');
  service.send('PACKED');
  clock.advance(900_000);
  assert.equal(service.getSnapshot().value, 'cancelling');
  assert.deepEqual(service.getSnapshot().context.trace.slice(-3), ['exit warehouse', 'exit fulfilment', 'enter cancelling']);
});

test('retry with back-off: delays computed from context, done after success', () => {
  type FetchEvent = { type: 'FAIL' } | { type: 'OK' };
  const machine = createMachine<{ attempt: number; waits: number[] }, FetchEvent>(
    {
      id: 'fetch',
      context: { attempt: 0, waits: [] },
      initial: 'loading',
      states: {
        loading: {
          entry: assign({ attempt: (context) => context.attempt + 1 }),
          on: { OK: 'success', FAIL: 'deciding' },
        },
        deciding: {
          always: [{ target: 'failed', guard: (context) => context.attempt >= 4 }, { target: 'waiting' }],
        },
        waiting: { after: { BACKOFF: 'loading' } },
        success: { type: 'final' },
        failed: { type: 'final' },
      },
    },
    { delays: { BACKOFF: (context) => 100 * 2 ** (context.attempt - 1) } },
  );

  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  const dues: (number | undefined)[] = [];
  for (let round = 0; round < 2; round++) {
    service.send('FAIL');
    assert.equal(service.getSnapshot().value, 'waiting');
    dues.push(clock.nextDue());
    clock.runAll();
  }
  assert.deepEqual(dues, [100, 300]);
  assert.equal(service.getSnapshot().context.attempt, 3);
  service.send('OK');
  assert.equal(service.status, 'done');
  assert.equal(service.getSnapshot().value, 'success');

  const failing = interpret(machine, { clock: new SimulatedClock() }).start();
  let finishedIn: unknown;
  failing.onDone((state) => {
    finishedIn = state.value;
  });
  for (let round = 0; round < 4; round++) {
    failing.send('FAIL');
    (failing.clock as SimulatedClock).runAll();
  }
  assert.equal(finishedIn, 'failed');
  assert.equal(failing.getSnapshot().context.attempt, 4);
});

test('the pure machine and the service agree on the same event sequence', () => {
  const machine = orderMachine();
  const events: OrderEvent[] = [
    { type: 'ADD', price: 3 },
    { type: 'CHECKOUT' },
    { type: 'PAID' },
    { type: 'CANCEL' },
    { type: 'REFUNDED' },
  ];
  let state = machine.initialState;
  const service = interpret(machine, { clock: new SimulatedClock() }).start();
  for (const event of events) {
    state = machine.transition(state, event);
    service.send(event);
    assert.deepEqual(service.getSnapshot().toJSON(), state.toJSON());
  }
  assert.equal(state.done, true);
});

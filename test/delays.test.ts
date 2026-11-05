import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidDelayError,
  MissingImplementationError,
  SimulatedClock,
  assign,
  createMachine,
  interpret,
  type MachineConfig,
} from '../src/index';

type LightEvent = { type: 'POWER_OUT' } | { type: 'POWER_ON' } | { type: 'PEDESTRIAN' };

const lightConfig: MachineConfig<{ cycles: number }, LightEvent> = {
  id: 'light',
  context: { cycles: 0 },
  initial: 'working',
  states: {
    working: {
      initial: 'green',
      on: { POWER_OUT: 'dark' },
      states: {
        green: { after: { 3000: 'yellow' }, on: { PEDESTRIAN: 'yellow' } },
        yellow: { after: { 500: 'red' } },
        red: { after: { 2000: { target: 'green', actions: assign({ cycles: (c) => c.cycles + 1 }) } } },
      },
    },
    dark: { on: { POWER_ON: 'working' } },
  },
};

function startLight() {
  const clock = new SimulatedClock();
  const service = interpret(createMachine(lightConfig), { clock }).start();
  return { clock, service };
}

test('delayed transitions fire when the clock reaches their delay', () => {
  const { clock, service } = startLight();
  clock.advance(2999);
  assert.deepEqual(service.getSnapshot().value, { working: 'green' });
  clock.advance(1);
  assert.deepEqual(service.getSnapshot().value, { working: 'yellow' });
  clock.advance(500);
  assert.deepEqual(service.getSnapshot().value, { working: 'red' });
  clock.advance(2000);
  assert.deepEqual(service.getSnapshot().value, { working: 'green' });
  assert.equal(service.getSnapshot().context.cycles, 1);
});

test('one long advance runs through several delayed transitions in order', () => {
  const { clock, service } = startLight();
  const seen: unknown[] = [];
  service.subscribe((state) => seen.push([clock.now(), state.value]));
  clock.advance(5500 * 2 + 100);
  assert.deepEqual(seen.slice(1), [
    [3000, { working: 'yellow' }],
    [3500, { working: 'red' }],
    [5500, { working: 'green' }],
    [8500, { working: 'yellow' }],
    [9000, { working: 'red' }],
    [11000, { working: 'green' }],
  ]);
  assert.equal(service.getSnapshot().context.cycles, 2);
});

test('leaving a state cancels its timer', () => {
  const { clock, service } = startLight();
  clock.advance(1000);
  service.send('PEDESTRIAN');
  assert.equal(clock.pending, 1, 'only the yellow timer is pending');
  clock.advance(2000);
  assert.deepEqual(service.getSnapshot().value, { working: 'red' }, 'the green timer did not fire at 3000');
});

test('re-entering a state restarts its timer from zero', () => {
  const { clock, service } = startLight();
  clock.advance(2500);
  service.send('POWER_OUT');
  assert.equal(clock.pending, 0);
  clock.advance(10_000);
  assert.equal(service.getSnapshot().value, 'dark');
  service.send('POWER_ON');
  clock.advance(2999);
  assert.deepEqual(service.getSnapshot().value, { working: 'green' });
  clock.advance(1);
  assert.deepEqual(service.getSnapshot().value, { working: 'yellow' });
});

test('a timer on a compound state survives transitions between its children', () => {
  const machine = createMachine({
    initial: 'session',
    states: {
      session: {
        initial: 'a',
        after: { 1000: 'expired' },
        states: { a: { on: { FLIP: 'b' } }, b: { on: { FLIP: 'a' } } },
      },
      expired: {},
    },
  });
  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  clock.advance(600);
  service.send('FLIP');
  clock.advance(399);
  assert.deepEqual(service.getSnapshot().value, { session: 'b' });
  clock.advance(1);
  assert.equal(service.getSnapshot().value, 'expired');
});

test('named delays are resolved from implementations, fixed or computed from the context', () => {
  const machine = createMachine<{ attempt: number }, { type: 'FAIL' }>(
    {
      context: { attempt: 0 },
      initial: 'trying',
      states: {
        trying: { on: { FAIL: { target: 'waiting', actions: assign({ attempt: (c) => c.attempt + 1 }) } } },
        waiting: { after: { BACKOFF: 'trying', GIVE_UP: 'failed' } },
        failed: {},
      },
    },
    { delays: { BACKOFF: (context) => 100 * 2 ** context.attempt, GIVE_UP: 500 } },
  );
  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  service.send('FAIL');
  clock.advance(199);
  assert.equal(service.getSnapshot().value, 'waiting');
  clock.advance(1);
  assert.equal(service.getSnapshot().value, 'trying');
  assert.equal(clock.pending, 0, 'the GIVE_UP timer was cancelled on exit');
  service.send('FAIL');
  clock.advance(400);
  assert.equal(service.getSnapshot().value, 'trying', 'second backoff is 400 ms');
  service.send('FAIL');
  clock.advance(500);
  assert.equal(service.getSnapshot().value, 'failed', 'third backoff of 800 ms loses against GIVE_UP');
});

test('a guarded delayed transition that fails leaves the state without retrying', () => {
  const machine = createMachine<{ ready: boolean }, { type: 'READY' }>({
    context: { ready: false },
    initial: 'waiting',
    states: {
      waiting: {
        on: { READY: { actions: assign({ ready: true }) } },
        after: { 100: { target: 'go', guard: (c) => c.ready } },
      },
      go: {},
    },
  });
  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  clock.advance(100);
  assert.equal(service.getSnapshot().value, 'waiting');
  service.send('READY');
  clock.advance(1000);
  assert.equal(service.getSnapshot().value, 'waiting');
  assert.equal(clock.pending, 0);
});

test('stopping or finishing a service cancels pending timers', () => {
  const { clock, service } = startLight();
  assert.equal(clock.pending, 1);
  service.stop();
  assert.equal(clock.pending, 0);

  const machine = createMachine({
    type: 'parallel',
    states: {
      ticking: { initial: 'tick', states: { tick: { after: { 50: 'tick' } } } },
      main: { initial: 'run', states: { run: { on: { END: 'end' } }, end: { type: 'final' } } },
    },
  });
  const clock2 = new SimulatedClock();
  const service2 = interpret(machine, { clock: clock2 }).start();
  clock2.advance(120);
  assert.equal(clock2.pending, 1, 'the tick state keeps rescheduling itself');
  service2.send('END');
  assert.equal(service2.status, 'running', 'the ticking region is not final');
  service2.stop();
  assert.equal(clock2.pending, 0);

  const finishing = createMachine({
    initial: 'run',
    states: { run: { after: { 50: 'run' }, on: { END: 'end' } }, end: { type: 'final' } },
    after: { 1000: '.run' },
  });
  const clock3 = new SimulatedClock();
  const service3 = interpret(finishing, { clock: clock3 }).start();
  assert.equal(clock3.pending, 2);
  service3.send('END');
  assert.equal(service3.status, 'done');
  assert.equal(clock3.pending, 0, 'the timer of the still active root is cancelled too');
});

test('a zero delay fires on the next clock turn, not synchronously', () => {
  const machine = createMachine({ initial: 'a', states: { a: { after: { 0: 'b' } }, b: {} } });
  const clock = new SimulatedClock();
  const service = interpret(machine, { clock }).start();
  assert.equal(service.getSnapshot().value, 'a');
  clock.advance(0);
  assert.equal(service.getSnapshot().value, 'b');
});

test('the pure transition lists schedule and cancel effects', () => {
  const machine = createMachine(lightConfig);
  const initial = machine.initialState;
  assert.deepEqual(initial.effects, [
    {
      kind: 'schedule',
      id: 'after(3000)#light.working.green',
      event: { type: 'after(3000)#light.working.green' },
      delay: 3000,
    },
  ]);
  const yellow = machine.transition(initial, 'PEDESTRIAN');
  assert.deepEqual(
    yellow.effects.map((effect) => [effect.kind, effect.kind === 'exec' ? '' : effect.id]),
    [
      ['cancel', 'after(3000)#light.working.green'],
      ['schedule', 'after(500)#light.working.yellow'],
    ],
  );
  const red = machine.transition(yellow, { type: 'after(500)#light.working.yellow' } as unknown as LightEvent);
  assert.deepEqual(red.value, { working: 'red' });
});

test('unknown and invalid delays are typed errors', () => {
  const config = { initial: 'a', states: { a: { after: { SOON: 'b' } }, b: {} } };
  assert.throws(
    () => createMachine(config).initialState,
    (error: unknown) => error instanceof MissingImplementationError && error.kind === 'delay',
  );
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createMachine(config, { delays: { SOON: () => bad } }).initialState,
      (error: unknown) => error instanceof InvalidDelayError && error.code === 'invalid-delay',
    );
  }
});

test('works with the system clock', async () => {
  const machine = createMachine({ initial: 'a', states: { a: { after: { 5: 'b' } }, b: { type: 'final' } } });
  const service = interpret(machine);
  const done = new Promise<unknown>((resolve) => service.onDone((state) => resolve(state.value)));
  service.start();
  assert.equal(await done, 'b');
});

test('an action that stops the service leaves no timer behind', () => {
  type E = { type: 'GO' };
  const clock = new SimulatedClock();
  const holder: { stop?: () => void } = {};
  const machine = createMachine<undefined, E>({
    initial: 'a',
    states: {
      a: { on: { GO: { target: 'b', actions: () => holder.stop?.() } } },
      b: { after: { 10: 'a' } },
    },
  });
  const service = interpret(machine, { clock }).start();
  holder.stop = () => service.stop();
  service.send('GO');
  assert.equal(service.status, 'stopped');
  // The timer of "b" used to be started after stop() had cancelled all timers.
  assert.equal(clock.pending, 0);
  clock.advance(100);
  assert.equal(service.getSnapshot().value, 'b');
});

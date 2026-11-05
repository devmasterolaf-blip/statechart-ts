import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidMachineError,
  MissingImplementationError,
  assign,
  createMachine,
  raise,
  type MachineConfig,
} from '../src/index';
import { effectNames, noopActions } from './helpers/trace';

type DoorEvent = { type: 'OPEN' } | { type: 'CLOSE' } | { type: 'LOCK'; code: number } | { type: 'UNLOCK' };

const doorConfig: MachineConfig<{ opened: number }, DoorEvent> = {
  id: 'door',
  context: { opened: 0 },
  initial: 'closed',
  states: {
    closed: {
      initial: 'unlocked',
      entry: 'enterClosed',
      exit: 'exitClosed',
      on: { OPEN: { target: 'open', actions: 'creak' } },
      states: {
        unlocked: { entry: 'enterUnlocked', exit: 'exitUnlocked', on: { LOCK: 'locked' } },
        locked: {
          entry: 'enterLocked',
          exit: 'exitLocked',
          on: { UNLOCK: 'unlocked', OPEN: { actions: 'rattle' } },
        },
      },
    },
    open: {
      entry: ['enterOpen', assign({ opened: (context) => context.opened + 1 })],
      exit: 'exitOpen',
      on: { CLOSE: 'closed', LOCK: 'closed.locked' },
    },
  },
};

const doorActions = noopActions(
  'enterClosed',
  'exitClosed',
  'enterUnlocked',
  'exitUnlocked',
  'enterLocked',
  'exitLocked',
  'enterOpen',
  'exitOpen',
  'creak',
  'rattle',
);

const door = createMachine(doorConfig, { actions: doorActions });

test('initial state enters the default descendants, outermost first', () => {
  const state = door.initialState;
  assert.deepEqual(state.value, { closed: 'unlocked' });
  assert.deepEqual(effectNames(state), ['enterClosed', 'enterUnlocked']);
  assert.equal(state.event.type, 'statechart.init');
  assert.equal(state.changed, true);
  assert.equal(door.initialState, state, 'the initial state is cached');
});

test('a transition between siblings exits and enters only the leaf', () => {
  const state = door.transition(door.initialState, { type: 'LOCK', code: 1 });
  assert.deepEqual(state.value, { closed: 'locked' });
  assert.deepEqual(effectNames(state), ['exitUnlocked', 'enterLocked']);
  assert.equal(state.changed, true);
});

test('leaving a compound state exits innermost first, then runs transition actions, then enters', () => {
  const state = door.transition(door.initialState, 'OPEN');
  assert.equal(state.value, 'open');
  assert.deepEqual(effectNames(state), ['exitUnlocked', 'exitClosed', 'creak', 'enterOpen']);
  assert.equal(state.context.opened, 1);
});

test('a transition on the leaf shadows the same event on its ancestor', () => {
  const locked = door.transition(door.initialState, { type: 'LOCK', code: 1 });
  const state = door.transition(locked, 'OPEN');
  assert.deepEqual(state.value, { closed: 'locked' });
  assert.deepEqual(effectNames(state), ['rattle'], 'targetless transition exits and enters nothing');
  assert.equal(state.changed, true);
});

test('targeting a nested state enters its ancestors first', () => {
  const open = door.transition(door.initialState, 'OPEN');
  const state = door.transition(open, { type: 'LOCK', code: 7 });
  assert.deepEqual(state.value, { closed: 'locked' });
  assert.deepEqual(effectNames(state), ['exitOpen', 'enterClosed', 'enterLocked']);
});

test('an unhandled event leaves the state unchanged', () => {
  const state = door.transition(door.initialState, 'CLOSE');
  assert.deepEqual(state.value, { closed: 'unlocked' });
  assert.equal(state.changed, false);
  assert.deepEqual(state.effects, []);
  assert.equal(state.event.type, 'CLOSE');
});

test('transition is pure: the input state is not modified', () => {
  const before = door.initialState;
  const snapshot = JSON.stringify([before.value, before.context]);
  door.transition(before, 'OPEN');
  assert.equal(JSON.stringify([before.value, before.context]), snapshot);
});

test('an external self-transition re-enters the state, an internal one does not', () => {
  const machine = createMachine(
    {
      initial: 'a',
      states: {
        a: {
          initial: 'x',
          entry: 'enterA',
          exit: 'exitA',
          on: {
            EXTERNAL: 'a',
            TO_Y: '.y',
            TO_Y_EXTERNAL: { target: '.y', internal: false },
          },
          states: { x: { exit: 'exitX' }, y: { entry: 'enterY' } },
        },
      },
    },
    { actions: noopActions('enterA', 'exitA', 'exitX', 'enterY') },
  );
  const external = machine.transition(machine.initialState, 'EXTERNAL');
  assert.deepEqual(effectNames(external), ['exitX', 'exitA', 'enterA']);
  assert.deepEqual(external.value, { a: 'x' });

  const internal = machine.transition(machine.initialState, 'TO_Y');
  assert.deepEqual(effectNames(internal), ['exitX', 'enterY']);

  const forced = machine.transition(machine.initialState, 'TO_Y_EXTERNAL');
  assert.deepEqual(effectNames(forced), ['exitX', 'exitA', 'enterA', 'enterY']);
  assert.deepEqual(forced.value, { a: 'y' });
});

test('a transition on the root can target any state by key', () => {
  const machine = createMachine({
    initial: 'a',
    on: { HOME: '.a', JUMP: 'b.deep' },
    states: { a: {}, b: { initial: 'shallow', states: { shallow: {}, deep: {} } } },
  });
  const jumped = machine.transition(machine.initialState, 'JUMP');
  assert.deepEqual(jumped.value, { b: 'deep' });
  assert.equal(machine.transition(jumped, 'HOME').value, 'a');
});

test('exec effects capture the context and event at the point the action was reached', () => {
  type Ev = { type: 'ADD'; by: number };
  const seen: Array<[string, number, string]> = [];
  const machine = createMachine<{ total: number }, Ev>(
    {
      context: { total: 0 },
      initial: 'a',
      states: {
        a: {
          on: {
            ADD: {
              actions: [
                (context, event) => seen.push(['before', context.total, event.type]),
                assign((context, event) => ({ total: context.total + event.by })),
                'after',
              ],
            },
          },
        },
      },
    },
    { actions: { after: (context, event) => seen.push(['after', context.total, event.type]) } },
  );
  const state = machine.transition(machine.initialState, { type: 'ADD', by: 5 });
  assert.equal(state.context.total, 5);
  assert.deepEqual(seen, [], 'nothing runs while the transition is computed');
  for (const effect of state.effects) {
    effect.exec(effect.context, effect.event, { send: () => undefined });
  }
  assert.deepEqual(seen, [
    ['before', 0, 'ADD'],
    ['after', 5, 'ADD'],
  ]);
});

test('assign with a property map computes every property from the previous context', () => {
  const machine = createMachine<{ a: number; b: number; label: string }, { type: 'SWAP' }>({
    context: { a: 1, b: 2, label: 'start' },
    initial: 's',
    states: {
      s: { on: { SWAP: { actions: assign({ a: (c) => c.b, b: (c) => c.a, label: 'swapped' }) } } },
    },
  });
  assert.deepEqual(machine.transition(machine.initialState, 'SWAP').context, { a: 2, b: 1, label: 'swapped' });
  assert.deepEqual(machine.initialState.context, { a: 1, b: 2, label: 'start' });
});

test('raised events are handled in the same step, in order, before control returns', () => {
  const machine = createMachine<{ log: string[] }, { type: 'START' } | { type: 'ONE' } | { type: 'TWO' }>({
    context: { log: [] },
    initial: 'idle',
    states: {
      idle: { on: { START: { target: 'first', actions: [raise('ONE'), raise({ type: 'TWO' })] } } },
      first: {
        on: {
          ONE: { target: 'second', actions: assign({ log: (c, e) => [...c.log, e.type] }) },
          TWO: 'wrong',
        },
      },
      second: { on: { TWO: { target: 'third', actions: assign({ log: (c, e) => [...c.log, e.type] }) } } },
      third: {},
      wrong: {},
    },
  });
  const state = machine.transition(machine.initialState, 'START');
  assert.equal(state.value, 'third');
  assert.deepEqual(state.context.log, ['ONE', 'TWO']);
  assert.equal(state.event.type, 'START', 'the state reports the external event');
});

test('named assign and raise implementations are resolved like inline ones', () => {
  const machine = createMachine<{ n: number }, { type: 'GO' } | { type: 'NEXT' }>(
    {
      context: { n: 0 },
      initial: 'a',
      states: { a: { on: { GO: { actions: ['bump', 'next'] }, NEXT: 'b' } }, b: {} },
    },
    { actions: { bump: assign({ n: (c) => c.n + 1 }), next: raise('NEXT') } },
  );
  const state = machine.transition(machine.initialState, 'GO');
  assert.equal(state.value, 'b');
  assert.equal(state.context.n, 1);
});

test('a missing action implementation is a typed error', () => {
  const machine = createMachine({ initial: 'a', states: { a: { on: { GO: { actions: 'undefinedAction' } } } } });
  assert.throws(
    () => machine.transition(machine.initialState, 'GO'),
    (error: unknown) =>
      error instanceof MissingImplementationError &&
      error.kind === 'action' &&
      error.implementationName === 'undefinedAction' &&
      error.code === 'missing-implementation',
  );
});

test('provide returns a new machine with merged implementations', () => {
  const base = createMachine(
    { initial: 'a', states: { a: { entry: ['one', 'two'] } } },
    { actions: { one: () => undefined } },
  );
  assert.throws(() => base.initialState, MissingImplementationError);
  const full = base.provide({ actions: { two: () => undefined } });
  assert.deepEqual(effectNames(full.initialState), ['one', 'two']);
  assert.notEqual(full, base);
});

test('createMachine throws InvalidMachineError listing every structural error', () => {
  assert.throws(
    () => createMachine({ states: { a: { on: { GO: 'nowhere' } } } }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidMachineError);
      assert.deepEqual(error.issues.map((issue) => issue.code).sort(), ['missing-initial', 'unknown-target']);
      return true;
    },
  );
});

test('warnings do not prevent creation and are exposed on the machine', () => {
  const machine = createMachine({ initial: 'a', states: { a: { initial: 'ignored' } } });
  assert.equal(machine.warnings.length, 1);
  assert.equal(machine.warnings[0].severity, 'warning');
  assert.equal(machine.getNode('machine.a')?.key, 'a');
  assert.equal(machine.getNode('nope'), undefined);
});

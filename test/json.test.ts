import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigParseError,
  checkMachineConfig,
  createMachine,
  parseMachineConfig,
  type ConfigProblem,
} from '../src/index';

function problems(run: () => unknown): ConfigProblem[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigParseError, `expected a ConfigParseError, got ${String(error)}`);
    assert.equal(error.code, 'invalid-config');
    return [...error.problems];
  }
  return assert.fail('expected the config to be rejected');
}

function paths(value: unknown): string[] {
  return problems(() => checkMachineConfig(value)).map((problem) => problem.path);
}

const document = {
  id: 'order',
  context: { attempts: 0 },
  initial: 'cart',
  states: {
    cart: {
      entry: 'loadCart',
      on: {
        CHECKOUT: [{ target: 'payment', guard: { type: 'not', guard: 'cartEmpty' } }, { actions: ['warnEmpty'] }],
      },
    },
    payment: {
      initial: 'entering',
      onDone: 'shipped',
      after: { 60000: { target: 'cart', actions: { type: 'raise', event: { type: 'TIMEOUT' } } } },
      states: {
        entering: { on: { PAY: { target: 'charging', guard: { type: 'and', guards: ['cardValid', 'inStock'] } } } },
        charging: {
          entry: { type: 'assign', assignment: { attempts: 1 } },
          on: { OK: 'paid', FAIL: { target: 'entering', internal: false, description: 'try again' } },
        },
        paid: { type: 'final' },
        last: { type: 'history', history: 'deep', target: 'entering' },
      },
    },
    shipped: { type: 'final', description: 'on its way' },
  },
};

test('a well-formed document parses and builds a working machine', () => {
  const config = parseMachineConfig(JSON.stringify(document));
  assert.deepEqual(config, document);
  const machine = createMachine(config, {
    guards: { cartEmpty: () => false, cardValid: () => true, inStock: () => true },
    actions: { loadCart: () => undefined, warnEmpty: () => undefined },
  });
  let state = machine.transition(machine.initialState, 'CHECKOUT');
  state = machine.transition(state, 'PAY');
  assert.deepEqual(state.value, { payment: 'charging' });
  assert.deepEqual(state.context, { attempts: 1 });
  state = machine.transition(state, 'OK');
  assert.equal(state.value, 'shipped');
  assert.equal(state.done, true);
});

test('text that is not JSON is reported as a problem of the document', () => {
  const found = problems(() => parseMachineConfig('{ "initial": '));
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '');
  assert.match(found[0].message, /^Not valid JSON: /);
});

test('the document itself must be an object', () => {
  assert.deepEqual(problems(() => parseMachineConfig('[]')), [
    { path: '', message: 'A state must be an object, got an array.' },
  ]);
  assert.deepEqual(paths(null), ['']);
  assert.deepEqual(paths('machine'), ['']);
});

test('unknown properties are reported with their path', () => {
  const found = problems(() =>
    checkMachineConfig({
      initail: 'a',
      states: { a: { context: {}, on: { GO: { traget: 'b' } } }, b: {} },
    }),
  );
  assert.deepEqual(found, [
    { path: 'initail', message: 'Unknown state property "initail".' },
    { path: 'states.a.context', message: 'Unknown state property "context".' },
    { path: 'states.a.on.GO.traget', message: 'Unknown transition property "traget".' },
  ]);
});

test('field types of states are checked', () => {
  assert.deepEqual(
    paths({
      id: 1,
      initial: ['a'],
      type: 'composite',
      history: 'deepest',
      description: {},
      states: [],
      on: 'GO',
      after: 5,
    }),
    ['id', 'initial', 'description', 'type', 'history', 'states', 'on', 'after'],
  );
  assert.deepEqual(paths({ states: { a: 'atomic', b: null } }), ['states.a', 'states.b']);
});

test('transitions are checked in every place they can appear', () => {
  assert.deepEqual(
    paths({
      initial: 'a',
      states: {
        a: {
          on: { GO: 5, MANY: ['a', { target: [1] }, null] },
          always: { target: 'a', internal: 'yes' },
          after: { 100: { target: {} } },
          onDone: [true],
        },
      },
    }),
    [
      'states.a.on.GO',
      'states.a.on.MANY[1].target',
      'states.a.on.MANY[2]',
      'states.a.after.100.target',
      'states.a.always.internal',
      'states.a.onDone[0]',
    ],
  );
});

test('guards must be names or known combinators', () => {
  assert.deepEqual(
    paths({
      initial: 'a',
      states: {
        a: {
          on: {
            A: { guard: 5 },
            B: { guard: { type: 'xor', guards: [] } },
            C: { guard: { type: 'and', guards: 'x' } },
            D: { guard: { type: 'or', guards: ['x', { type: 'in' }, { type: 'not' }] } },
          },
        },
      },
    }),
    [
      'states.a.on.A.guard',
      'states.a.on.B.guard.type',
      'states.a.on.C.guard.guards',
      'states.a.on.D.guard.guards[1].state',
      'states.a.on.D.guard.guards[2].guard',
    ],
  );
});

test('actions must be names or built-in action objects', () => {
  assert.deepEqual(
    paths({
      initial: 'a',
      states: {
        a: {
          entry: [1, { type: 'send' }, { type: 'raise', event: 'GO' }, { type: 'assign', assignment: [] }],
          exit: false,
          on: { GO: { actions: { type: 'raise', event: {} } } },
        },
      },
    }),
    [
      'states.a.on.GO.actions.event',
      'states.a.entry[0]',
      'states.a.entry[1].type',
      'states.a.entry[2].event',
      'states.a.entry[3].assignment',
      'states.a.exit',
    ],
  );
});

test('the error message lists every problem', () => {
  assert.throws(
    () => checkMachineConfig({ initial: 1, states: { a: 2 } }),
    (error: unknown) =>
      error instanceof ConfigParseError &&
      error.message ===
        'Invalid machine definition file (2 problem(s)):\n' +
          '  - initial: Expected a string, got a number.\n' +
          '  - states.a: A state must be an object, got a number.',
  );
});

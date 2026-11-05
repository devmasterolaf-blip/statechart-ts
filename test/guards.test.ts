import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GuardEvaluationError,
  MissingImplementationError,
  and,
  assign,
  createMachine,
  not,
  or,
  stateIn,
  type MachineConfig,
} from '../src/index';

interface Ctx {
  balance: number;
  frozen: boolean;
}
type Ev = { type: 'WITHDRAW'; amount: number } | { type: 'FREEZE' } | { type: 'CHECK' };

const config: MachineConfig<Ctx, Ev> = {
  id: 'account',
  context: { balance: 100, frozen: false },
  initial: 'open',
  states: {
    open: {
      on: {
        WITHDRAW: [
          { target: 'rejected', guard: 'isFrozen' },
          {
            guard: (context, event) => event.amount <= context.balance,
            actions: assign({ balance: (context, event) => context.balance - event.amount }),
          },
          { target: 'overdrawn' },
        ],
        FREEZE: { actions: assign({ frozen: true }) },
      },
    },
    overdrawn: {},
    rejected: {},
  },
};

const account = createMachine(config, { guards: { isFrozen: (context) => context.frozen } });

test('the first transition whose guard passes is taken', () => {
  const state = account.transition(account.initialState, { type: 'WITHDRAW', amount: 30 });
  assert.equal(state.value, 'open');
  assert.equal(state.context.balance, 70);
});

test('falls through to the unguarded transition when earlier guards fail', () => {
  const state = account.transition(account.initialState, { type: 'WITHDRAW', amount: 500 });
  assert.equal(state.value, 'overdrawn');
  assert.equal(state.context.balance, 100);
});

test('guards see the context as updated by earlier events', () => {
  const frozen = account.transition(account.initialState, 'FREEZE');
  assert.equal(account.transition(frozen, { type: 'WITHDRAW', amount: 1 }).value, 'rejected');
});

test('when every guard fails on the leaf the event bubbles to the ancestor', () => {
  const machine = createMachine<{ allowed: boolean }, { type: 'GO' }>({
    context: { allowed: false },
    initial: 'outer',
    states: {
      outer: {
        initial: 'inner',
        on: { GO: 'fallback' },
        states: { inner: { on: { GO: { target: 'never', guard: (context) => context.allowed } } }, never: {} },
      },
      fallback: {},
    },
  });
  assert.equal(machine.transition(machine.initialState, 'GO').value, 'fallback');
});

test('no transition is taken when all guards fail', () => {
  const machine = createMachine({
    initial: 'a',
    states: { a: { on: { GO: { target: 'b', guard: () => false } } }, b: {} },
  });
  const state = machine.transition(machine.initialState, 'GO');
  assert.equal(state.value, 'a');
  assert.equal(state.changed, false);
});

test('combinators compose named and inline guards and short-circuit', () => {
  const calls: string[] = [];
  const machine = createMachine<{ n: number }, { type: 'A' } | { type: 'B' } | { type: 'C' }>(
    {
      context: { n: 5 },
      initial: 'start',
      states: {
        start: {
          on: {
            A: { target: 'hit', guard: and('positive', not('big'), (context) => context.n === 5) },
            B: { target: 'hit', guard: or('big', 'positive', 'explodes') },
            C: { target: 'hit', guard: and('big', 'explodes') },
          },
        },
        hit: {},
      },
    },
    {
      guards: {
        positive: (context) => (calls.push('positive'), context.n > 0),
        big: (context) => (calls.push('big'), context.n > 100),
        explodes: () => {
          throw new Error('must not be evaluated');
        },
      },
    },
  );
  assert.equal(machine.transition(machine.initialState, 'A').value, 'hit');
  assert.deepEqual(calls, ['positive', 'big']);
  calls.length = 0;
  assert.equal(machine.transition(machine.initialState, 'B').value, 'hit');
  assert.deepEqual(calls, ['big', 'positive']);
  assert.equal(machine.transition(machine.initialState, 'C').value, 'start');
});

test('combinator objects are plain data', () => {
  assert.deepEqual(and('a', not('b')), { type: 'and', guards: ['a', { type: 'not', guard: 'b' }] });
  assert.deepEqual(or('a'), { type: 'or', guards: ['a'] });
  assert.deepEqual(stateIn('#x.y'), { type: 'in', state: 'x.y' });
  assert.deepEqual(stateIn('x.y'), { type: 'in', state: 'x.y' });
});

test('stateIn and meta.isActive check the active configuration', () => {
  const machine = createMachine<undefined, { type: 'ENTER' } | { type: 'PROBE' }>({
    id: 'm',
    initial: 'lobby',
    states: {
      lobby: { on: { ENTER: 'room' } },
      room: {
        id: 'theRoom',
        initial: 'door',
        on: { PROBE: [{ target: '.inside', guard: stateIn('#theRoom') }] },
        states: {
          door: { on: { PROBE: { target: 'never', guard: (_c, _e, meta) => meta.isActive('m.lobby') } } },
          inside: {},
          never: {},
        },
      },
    },
  });
  const room = machine.transition(machine.initialState, 'ENTER');
  assert.deepEqual(machine.transition(room, 'PROBE').value, { room: 'inside' });
});

test('a missing guard implementation is a typed error', () => {
  const machine = createMachine({ initial: 'a', states: { a: { on: { GO: { target: 'b', guard: 'nope' } } }, b: {} } });
  assert.throws(
    () => machine.transition(machine.initialState, 'GO'),
    (error: unknown) =>
      error instanceof MissingImplementationError && error.kind === 'guard' && error.implementationName === 'nope',
  );
});

test('an exception inside a guard is wrapped with the state and event', () => {
  const boom = new Error('boom');
  const machine = createMachine(
    { initial: 'a', states: { a: { on: { GO: { target: 'b', guard: 'bad' } } }, b: {} } },
    {
      guards: {
        bad: () => {
          throw boom;
        },
      },
    },
  );
  assert.throws(
    () => machine.transition(machine.initialState, 'GO'),
    (error: unknown) => {
      assert.ok(error instanceof GuardEvaluationError);
      assert.equal(error.code, 'guard-failed');
      assert.equal(error.cause, boom);
      assert.match(error.message, /Guard "bad" of state "a" threw on event "GO": boom/);
      return true;
    },
  );
});

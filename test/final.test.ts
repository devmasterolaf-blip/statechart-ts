import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, createMachine, raise } from '../src/index';
import { effectNames, noopActions } from './helpers/trace';

test('reaching a final child fires onDone of the parent', () => {
  const machine = createMachine(
    {
      id: 'order',
      initial: 'payment',
      states: {
        payment: {
          initial: 'pending',
          exit: 'exitPayment',
          onDone: { target: 'shipping', actions: 'receipt' },
          states: {
            pending: { on: { PAY: 'paid' } },
            paid: { type: 'final', entry: 'enterPaid' },
          },
        },
        shipping: {},
      },
    },
    { actions: noopActions('exitPayment', 'receipt', 'enterPaid') },
  );
  const state = machine.transition(machine.initialState, 'PAY');
  assert.equal(state.value, 'shipping');
  assert.deepEqual(effectNames(state), ['enterPaid', 'exitPayment', 'receipt']);
  assert.equal(state.done, false);
});

test('a parallel state is done only when every region is final', () => {
  const machine = createMachine({
    initial: 'checks',
    states: {
      checks: {
        type: 'parallel',
        onDone: 'approved',
        states: {
          credit: { initial: 'running', states: { running: { on: { CREDIT_OK: 'ok' } }, ok: { type: 'final' } } },
          identity: { initial: 'running', states: { running: { on: { ID_OK: 'ok' } }, ok: { type: 'final' } } },
        },
      },
      approved: {},
    },
  });
  const half = machine.transition(machine.initialState, 'ID_OK');
  assert.deepEqual(half.value, { checks: { credit: 'running', identity: 'ok' } });
  assert.equal(machine.transition(half, 'CREDIT_OK').value, 'approved');
});

test('each region can react to its own completion', () => {
  const machine = createMachine<{ done: string[] }, { type: 'A' } | { type: 'B' }>({
    context: { done: [] },
    initial: 'both',
    states: {
      both: {
        type: 'parallel',
        onDone: { actions: assign({ done: (c) => [...c.done, 'both'] }) },
        states: {
          a: {
            initial: 'run',
            onDone: { actions: assign({ done: (c) => [...c.done, 'a'] }) },
            states: { run: { on: { A: 'end' } }, end: { type: 'final' } },
          },
          b: {
            initial: 'run',
            onDone: { actions: assign({ done: (c) => [...c.done, 'b'] }) },
            states: { run: { on: { B: 'end' } }, end: { type: 'final' } },
          },
        },
      },
    },
  });
  const afterB = machine.transition(machine.initialState, 'B');
  assert.deepEqual(afterB.context.done, ['b']);
  const afterBoth = machine.transition(afterB, 'A');
  assert.deepEqual(afterBoth.context.done, ['b', 'a', 'both']);
  assert.equal(afterBoth.done, false, 'only a final configuration of the root finishes the machine');
});

test('a parallel root is done when all of its regions are final', () => {
  const machine = createMachine({
    type: 'parallel',
    states: {
      a: { initial: 'run', states: { run: { on: { A: 'end' } }, end: { type: 'final' } } },
      b: { initial: 'run', states: { run: { on: { B: 'end' } }, end: { type: 'final' } } },
    },
  });
  const afterB = machine.transition(machine.initialState, 'B');
  assert.equal(afterB.done, false);
  assert.equal(machine.transition(afterB, 'A').done, true);
});

test('completion propagates through nested parallel states', () => {
  const machine = createMachine({
    initial: 'outer',
    states: {
      outer: {
        type: 'parallel',
        onDone: 'finished',
        states: {
          inner: {
            type: 'parallel',
            states: {
              x: { initial: 'go', states: { go: { on: { X: 'end' } }, end: { type: 'final' } } },
              y: { initial: 'go', states: { go: { on: { Y: 'end' } }, end: { type: 'final' } } },
            },
          },
          z: { initial: 'go', states: { go: { on: { Z: 'end' } }, end: { type: 'final' } } },
        },
      },
      finished: {},
    },
  });
  const state = ['Z', 'X', 'Y'].reduce((s, e) => machine.transition(s, e), machine.initialState);
  assert.equal(state.value, 'finished');
});

test('a top-level final state marks the machine as done and later events are ignored', () => {
  const machine = createMachine<{ n: number }, { type: 'FINISH' } | { type: 'MORE' }>({
    context: { n: 0 },
    initial: 'running',
    on: { MORE: { actions: assign({ n: (c) => c.n + 1 }) } },
    states: { running: { on: { FINISH: 'finished' } }, finished: { type: 'final' } },
  });
  const running = machine.transition(machine.initialState, 'MORE');
  assert.equal(running.done, false);
  const finished = machine.transition(running, 'FINISH');
  assert.equal(finished.done, true);
  assert.equal(finished.value, 'finished');
  const after = machine.transition(finished, 'MORE');
  assert.equal(after.done, true);
  assert.equal(after.changed, false);
  assert.equal(after.context.n, 1);
  assert.deepEqual(after.effects, []);
});

test('a machine can be done right from its initial state', () => {
  const machine = createMachine({ initial: 'boot', states: { boot: { always: 'end' }, end: { type: 'final' } } });
  assert.equal(machine.initialState.done, true);
});

test('events raised while finishing are dropped once the machine is done', () => {
  const machine = createMachine<{ late: boolean }, { type: 'END' } | { type: 'LATE' }>({
    context: { late: false },
    initial: 'a',
    on: { LATE: { actions: assign({ late: true }) } },
    states: { a: { on: { END: { target: 'z', actions: raise('LATE') } } }, z: { type: 'final' } },
  });
  const state = machine.transition(machine.initialState, 'END');
  assert.equal(state.done, true);
  assert.equal(state.context.late, false);
});

test('a final state nested in a compound state does not finish the machine', () => {
  const machine = createMachine({
    initial: 'task',
    states: { task: { initial: 'work', states: { work: { on: { DONE: 'complete' } }, complete: { type: 'final' } } } },
  });
  const state = machine.transition(machine.initialState, 'DONE');
  assert.deepEqual(state.value, { task: 'complete' });
  assert.equal(state.done, false);
});

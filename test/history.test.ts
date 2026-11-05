import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidMachineError, createMachine, type MachineConfig } from '../src/index';
import { effectNames, noopActions } from './helpers/trace';

type Ev =
  | { type: 'NEXT' }
  | { type: 'DEEPER' }
  | { type: 'INTERRUPT' }
  | { type: 'RESUME' }
  | { type: 'RESUME_DEEP' }
  | { type: 'RESTART' };

const wizardConfig: MachineConfig<undefined, Ev> = {
  id: 'wizard',
  initial: 'steps',
  states: {
    steps: {
      initial: 'one',
      on: { INTERRUPT: 'interrupted' },
      states: {
        one: { on: { NEXT: 'two' } },
        two: {
          initial: 'basic',
          entry: 'enterTwo',
          on: { NEXT: 'three' },
          states: { basic: { entry: 'enterBasic', on: { DEEPER: 'advanced' } }, advanced: { entry: 'enterAdvanced' } },
        },
        three: {},
        shallow: { type: 'history' },
        deep: { type: 'history', history: 'deep' },
      },
    },
    interrupted: {
      on: { RESUME: 'steps.shallow', RESUME_DEEP: 'steps.deep', RESTART: 'steps' },
    },
  },
};

const wizard = createMachine(wizardConfig, { actions: noopActions('enterTwo', 'enterBasic', 'enterAdvanced') });

function run(...events: Ev['type'][]) {
  return events.reduce((state, type) => wizard.transition(state, type), wizard.initialState);
}

test('shallow history restores the direct child and enters its default descendants', () => {
  const state = run('NEXT', 'DEEPER', 'INTERRUPT', 'RESUME');
  assert.deepEqual(state.value, { steps: { two: 'basic' } });
  assert.deepEqual(effectNames(state), ['enterTwo', 'enterBasic']);
});

test('deep history restores the exact leaf', () => {
  const state = run('NEXT', 'DEEPER', 'INTERRUPT', 'RESUME_DEEP');
  assert.deepEqual(state.value, { steps: { two: 'advanced' } });
  assert.deepEqual(effectNames(state), ['enterTwo', 'enterAdvanced']);
});

test('without recorded history and without a default target the parent is entered normally', () => {
  const machine = createMachine({
    initial: 'out',
    states: {
      out: { on: { IN: 'box.h' } },
      box: { initial: 'first', states: { first: {}, second: {}, h: { type: 'history' } } },
    },
  });
  assert.deepEqual(machine.transition(machine.initialState, 'IN').value, { box: 'first' });
});

test('the default target is used until history has been recorded', () => {
  const machine = createMachine({
    initial: 'out',
    states: {
      out: { on: { IN: 'box.h' } },
      box: {
        initial: 'first',
        on: { OUT: 'out' },
        states: { first: { on: { NEXT: 'third' } }, second: {}, third: {}, h: { type: 'history', target: 'second' } },
      },
    },
  });
  const first = machine.transition(machine.initialState, 'IN');
  assert.deepEqual(first.value, { box: 'second' });
  const state = ['OUT', 'IN'].reduce((s, e) => machine.transition(s, e), first);
  assert.deepEqual(state.value, { box: 'second' });
});

test('history is overwritten on every exit and plain entry still uses the initial state', () => {
  const state = run('NEXT', 'INTERRUPT', 'RESUME', 'NEXT', 'INTERRUPT');
  assert.deepEqual([...state.history], [
    ['wizard.steps.shallow', ['wizard.steps.three']],
    ['wizard.steps.deep', ['wizard.steps.three']],
  ]);
  assert.deepEqual(wizard.transition(state, 'RESTART').value, { steps: 'one' });
  assert.deepEqual(wizard.transition(state, 'RESUME').value, { steps: 'three' });
});

test('computing a transition does not modify the history of the previous state', () => {
  const interrupted = run('NEXT', 'INTERRUPT');
  const before = JSON.stringify([...interrupted.history]);
  const resumed = wizard.transition(interrupted, 'RESUME');
  wizard.transition(wizard.transition(resumed, 'NEXT'), 'INTERRUPT');
  assert.equal(JSON.stringify([...interrupted.history]), before);
});

test('deep history of a parallel state restores every region', () => {
  const machine = createMachine({
    id: 'p',
    initial: 'work',
    states: {
      work: {
        type: 'parallel',
        on: { PAUSE: 'paused' },
        states: {
          a: { initial: 'a1', states: { a1: { on: { A: 'a2' } }, a2: {} } },
          b: { initial: 'b1', states: { b1: { on: { B: 'b2' } }, b2: { on: { B: 'b3' } }, b3: {} } },
          memo: { type: 'history', history: 'deep' },
        },
      },
      paused: { on: { RESUME: 'work.memo', RESTART: 'work' } },
    },
  });
  const paused = ['A', 'B', 'B', 'PAUSE'].reduce((s, e) => machine.transition(s, e), machine.initialState);
  assert.deepEqual([...paused.history], [['p.work.memo', ['p.work.a.a2', 'p.work.b.b3']]]);
  assert.deepEqual(machine.transition(paused, 'RESUME').value, { work: { a: 'a2', b: 'b3' } });
  assert.deepEqual(machine.transition(paused, 'RESTART').value, { work: { a: 'a1', b: 'b1' } });
});

test('a history state inside one region keeps the other regions on their defaults', () => {
  const machine = createMachine({
    initial: 'work',
    states: {
      work: {
        type: 'parallel',
        on: { PAUSE: 'paused' },
        states: {
          a: { initial: 'a1', states: { a1: { on: { GO: 'a2' } }, a2: {}, h: { type: 'history' } } },
          b: { initial: 'b1', states: { b1: { on: { GO: 'b2' } }, b2: {} } },
        },
      },
      paused: { on: { RESUME: 'work.a.h' } },
    },
  });
  const state = ['GO', 'PAUSE', 'RESUME'].reduce((s, e) => machine.transition(s, e), machine.initialState);
  assert.deepEqual(state.value, { work: { a: 'a2', b: 'b1' } });
});

test('a history state can be the initial child when it has a default target', () => {
  const machine = createMachine({
    initial: 'box',
    states: {
      box: {
        initial: 'h',
        on: { LEAVE: 'away' },
        states: { h: { type: 'history', target: 'x' }, x: { on: { NEXT: 'y' } }, y: {} },
      },
      away: { on: { BACK: 'box' } },
    },
  });
  assert.deepEqual(machine.initialState.value, { box: 'x' });
  const back = ['NEXT', 'LEAVE', 'BACK'].reduce((s, e) => machine.transition(s, e), machine.initialState);
  assert.deepEqual(back.value, { box: 'y' });
});

test('definition errors specific to history states', () => {
  const codesOf = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof InvalidMachineError);
      return error.issues.map((issue) => `${issue.code}@${issue.path}`);
    }
    return [];
  };
  assert.deepEqual(
    codesOf(() => createMachine({ initial: 'h', states: { h: { type: 'history' }, a: {} } })),
    ['invalid-history@h'],
  );
  assert.deepEqual(
    codesOf(() =>
      createMachine({
        initial: 'a',
        states: { a: {}, h1: { type: 'history', target: 'h2' }, h2: { type: 'history' } },
      }),
    ),
    ['invalid-history@h1'],
  );
});

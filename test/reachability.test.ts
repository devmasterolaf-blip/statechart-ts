import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMachine, type EventObject, type MachineConfig } from '../src/index';
import { buildTree } from '../src/node';
import { reachableStates, unreachableStates } from '../src/reachability';

type Config = MachineConfig<unknown, EventObject>;

function unreachable(config: Config): string[] {
  return unreachableStates(buildTree(config)).map((node) => node.label);
}

function reachable(config: Config): string[] {
  const tree = buildTree(config);
  const reached = reachableStates(tree);
  return tree.nodes.filter((node) => reached.has(node)).map((node) => node.label);
}

test('every state of a connected machine is reachable', () => {
  const config: Config = {
    initial: 'a',
    states: { a: { on: { GO: 'b' } }, b: { on: { GO: 'c' } }, c: { type: 'final' } },
  };
  assert.deepEqual(unreachable(config), []);
  assert.deepEqual(reachable(config), ['(root)', 'a', 'b', 'c']);
});

test('a state without incoming transitions is unreachable', () => {
  assert.deepEqual(
    unreachable({ initial: 'a', states: { a: { on: { GO: 'a' } }, orphan: { on: { BACK: 'a' } } } }),
    ['orphan'],
  );
});

test('transitions of unreachable states do not make their targets reachable', () => {
  assert.deepEqual(
    unreachable({
      initial: 'a',
      states: { a: {}, island1: { on: { GO: 'island2' } }, island2: { on: { GO: 'island1' } } },
    }),
    ['island1', 'island2'],
  );
});

test('only the topmost unreachable state is listed', () => {
  assert.deepEqual(
    unreachable({
      initial: 'a',
      states: { a: {}, dead: { initial: 'x', states: { x: { on: { GO: 'y' } }, y: {} } } },
    }),
    ['dead'],
  );
});

test('a deep target reaches its ancestors but not their default children', () => {
  const config: Config = {
    initial: 'a',
    states: {
      a: { on: { GO: 'box.second' } },
      box: { initial: 'first', states: { first: {}, second: {} } },
    },
  };
  assert.deepEqual(unreachable(config), ['box.first']);
});

test('transitions on an ancestor count once the ancestor is active', () => {
  assert.deepEqual(
    unreachable({
      initial: 'box',
      states: {
        box: { initial: 'first', on: { OUT: 'other' }, states: { first: {} } },
        other: {},
      },
    }),
    [],
  );
});

test('entering one region of a parallel state enters the others by default', () => {
  const config: Config = {
    initial: 'idle',
    states: {
      idle: { on: { GO: 'work.left.b' } },
      work: {
        type: 'parallel',
        states: {
          left: { initial: 'a', states: { a: {}, b: {} } },
          right: { initial: 'x', states: { x: {}, y: {} } },
        },
      },
    },
  };
  assert.deepEqual(unreachable(config), ['work.left.a', 'work.right.y']);
});

test('history states: targeted ones are reachable and lead to their default', () => {
  const config: Config = {
    initial: 'off',
    states: {
      off: { on: { RESUME: 'on.hist' } },
      on: {
        initial: 'low',
        states: {
          low: {},
          high: {},
          hist: { type: 'history', target: 'high' },
          unused: { type: 'history' },
        },
      },
    },
  };
  assert.deepEqual(unreachable(config), ['on.low', 'on.unused']);
});

test('a history state without a default falls back to the initial child', () => {
  const config: Config = {
    initial: 'off',
    states: {
      off: { on: { RESUME: 'on.hist' } },
      on: { initial: 'low', states: { low: {}, high: {}, hist: { type: 'history' } } },
    },
  };
  assert.deepEqual(unreachable(config), ['on.high']);
});

test('delayed, eventless and onDone transitions are followed', () => {
  const config: Config = {
    initial: 'a',
    states: {
      a: { after: { 100: 'b' } },
      b: { always: 'c' },
      c: { initial: 'x', onDone: 'd', states: { x: { type: 'final' } } },
      d: {},
    },
  };
  assert.deepEqual(unreachable(config), []);
});

test('validateMachine reports unreachable states as warnings', () => {
  const issues = validateMachine({ initial: 'a', states: { a: {}, orphan: {} } });
  assert.deepEqual(issues, [
    {
      code: 'unreachable-state',
      severity: 'warning',
      message: 'No transition or initial entry leads to this state.',
      path: 'orphan',
    },
  ]);
});

test('reachability is skipped while the definition has errors', () => {
  const issues = validateMachine({ initial: 'a', states: { a: { on: { GO: 'missing' } }, orphan: {} } });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['unknown-target'],
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidMachineError,
  and,
  assertValidMachine,
  formatIssues,
  not,
  stateIn,
  validateMachine,
  type EventObject,
  type MachineConfig,
} from '../src/index';

type Config = MachineConfig<unknown, EventObject>;

function summary(config: Config, options?: Parameters<typeof validateMachine>[1]): string[] {
  return validateMachine(config, options as never).map((issue) => `${issue.severity}:${issue.code}@${issue.path}`);
}

const clean: Config = {
  id: 'clean',
  initial: 'a',
  states: {
    a: { on: { GO: [{ target: 'b', guard: 'ready' }, { target: 'c' }] }, entry: 'hello' },
    b: { after: { WAIT: 'c' }, exit: 'bye' },
    c: { type: 'final' },
  },
};

test('a clean definition has no issues', () => {
  assert.deepEqual(validateMachine(clean), []);
});

test('structural issues from the builder are included and nothing is thrown', () => {
  assert.deepEqual(
    summary({ states: { a: { on: { GO: 'nowhere' } }, b: { id: 'machine.a' } } }),
    ['error:duplicate-id@b', 'error:missing-initial@(root)', 'error:unknown-target@a'],
  );
});

test('warns about transitions shadowed by an earlier unguarded one', () => {
  const issues = validateMachine({
    initial: 'a',
    states: {
      a: {
        on: {
          GO: [{ target: 'b' }, { target: 'a', guard: 'never' }, { target: 'b' }],
          OK: [{ target: 'b', guard: 'first' }, { target: 'a' }],
        },
        always: [{ target: 'b', guard: 'x' }, 'b', 'a'],
      },
      b: {},
    },
  });
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.path]),
    [
      ['shadowed-transition', 'warning', 'a'],
      ['shadowed-transition', 'warning', 'a'],
    ],
  );
  assert.match(issues[0].message, /transition on "GO"/);
  assert.match(issues[1].message, /eventless transition/);
});

test('in guards must refer to existing state ids, also inside combinators', () => {
  const config: Config = {
    id: 'm',
    type: 'parallel',
    states: {
      a: {
        on: {
          OK: { guard: stateIn('#m.b') },
          BAD: { guard: and(not(stateIn('m.ghost')), 'named', () => true) },
        },
      },
      b: {},
    },
  };
  const issues = validateMachine(config);
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.path]),
    [['unknown-state-reference', 'a']],
  );
  assert.match(issues[0].message, /"m.ghost"/);
});

test('implementations are only checked when they are passed', () => {
  assert.deepEqual(summary(clean, { implementations: {} }), [
    'error:missing-guard@a',
    'error:missing-action@a',
    'error:missing-action@b',
    'error:missing-delay@b',
  ]);
  assert.deepEqual(
    summary(clean, {
      implementations: {
        guards: { ready: () => true },
        actions: { hello: () => undefined, bye: () => undefined },
        delays: { WAIT: 10 },
      },
    }),
    [],
  );
});

test('implementation names inherited from Object.prototype do not count', () => {
  const config: Config = { initial: 'a', states: { a: { entry: 'toString', on: { GO: { guard: 'constructor' } } } } };
  assert.deepEqual(summary(config, { implementations: { actions: {}, guards: {} } }), [
    'error:missing-guard@a',
    'error:missing-action@a',
  ]);
});

test('assertValidMachine throws on errors and returns warnings otherwise', () => {
  assert.throws(
    () => assertValidMachine(clean, { implementations: {} }),
    (error: unknown) => error instanceof InvalidMachineError && error.issues.length === 4,
  );
  const warnings = assertValidMachine({ initial: 'a', states: { a: { on: { GO: ['a', 'a'] } } } });
  assert.deepEqual(
    warnings.map((issue) => issue.code),
    ['shadowed-transition'],
  );
});

test('formatIssues prints one line per issue', () => {
  const text = formatIssues(validateMachine({ states: { a: {} } }));
  assert.equal(text, 'error [missing-initial] (root): Compound state has no "initial" child.');
  assert.equal(formatIssues([]), '');
});

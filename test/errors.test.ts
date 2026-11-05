import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidMachineError, StatechartError, type Issue } from '../src/index';

test('InvalidMachineError lists error issues and keeps warnings out of the message', () => {
  const issues: Issue[] = [
    { code: 'missing-initial', severity: 'error', message: 'no initial state', path: 'a' },
    { code: 'invalid-structure', severity: 'warning', message: 'just a hint', path: 'b' },
  ];
  const error = new InvalidMachineError(issues);
  assert.ok(error instanceof StatechartError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'InvalidMachineError');
  assert.equal(error.code, 'invalid-machine');
  assert.equal(error.issues.length, 2);
  assert.match(error.message, /1 error\(s\)/);
  assert.match(error.message, /\[missing-initial\] a: no initial state/);
  assert.doesNotMatch(error.message, /just a hint/);
});

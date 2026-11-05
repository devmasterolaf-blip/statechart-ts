import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../src/index';

test('exposes the package version', () => {
  const pkg = require('../../package.json') as { version: string };
  assert.equal(VERSION, pkg.version);
});

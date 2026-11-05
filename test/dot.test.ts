import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, toDot } from '../src/index';

function lines(text: string): string[] {
  return text.trimEnd().split('\n');
}

test('flat machine: header, initial marker, nodes and labelled edges', () => {
  const machine = createMachine({
    id: 'fetch',
    initial: 'idle',
    states: {
      idle: { on: { FETCH: 'loading' } },
      loading: { on: { RESOLVE: 'done', REJECT: { target: 'idle', guard: 'canRetry', actions: 'count' } } },
      done: { type: 'final' },
    },
  });
  assert.equal(
    toDot(machine),
    [
      'digraph "fetch" {',
      '  compound=true;',
      '  rankdir=TB;',
      '  node [shape=box, style=rounded];',
      '  "fetch__initial" [shape=point, width=0.15, label=""];',
      '  "fetch.idle" [label="idle"];',
      '  "fetch.loading" [label="loading"];',
      '  "fetch.done" [shape=doublecircle, label="done"];',
      '  "fetch__initial" -> "fetch.idle";',
      '  "fetch.idle" -> "fetch.loading" [label="FETCH"];',
      '  "fetch.loading" -> "fetch.done" [label="RESOLVE"];',
      '  "fetch.loading" -> "fetch.idle" [label="REJECT [canRetry] / count"];',
      '}',
      '',
    ].join('\n'),
  );
});

test('compound states become clusters and edges are clipped to their border', () => {
  const machine = createMachine({
    id: 'm',
    initial: 'off',
    states: {
      off: { on: { POWER: 'on' } },
      on: {
        initial: 'low',
        on: { POWER: 'off' },
        states: { low: { on: { UP: 'high' } }, high: {} },
      },
    },
  });
  assert.deepEqual(lines(toDot(machine)), [
    'digraph "m" {',
    '  compound=true;',
    '  rankdir=TB;',
    '  node [shape=box, style=rounded];',
    '  "m__initial" [shape=point, width=0.15, label=""];',
    '  "m.off" [label="off"];',
    '  subgraph "cluster_m.on" {',
    '    label="on";',
    '    style=rounded;',
    '    "m.on__initial" [shape=point, width=0.15, label=""];',
    '    "m.on.low" [label="low"];',
    '    "m.on.high" [label="high"];',
    '  }',
    '  "m__initial" -> "m.off";',
    '  "m.off" -> "m.on__initial" [label="POWER", lhead="cluster_m.on"];',
    '  "m.on__initial" -> "m.on.low";',
    '  "m.on__initial" -> "m.off" [label="POWER", ltail="cluster_m.on"];',
    '  "m.on.low" -> "m.on.high" [label="UP"];',
    '}',
  ]);
});

test('parallel states get an invisible anchor and dashed region clusters', () => {
  const machine = createMachine({
    id: 'p',
    initial: 'idle',
    states: {
      idle: { on: { GO: 'work' } },
      work: {
        type: 'parallel',
        on: { ABORT: 'idle' },
        states: {
          left: { initial: 'a', states: { a: {} } },
          right: { initial: 'x', states: { x: {} } },
        },
      },
    },
  });
  const text = lines(toDot(machine));
  assert.ok(text.includes('    "p.work__anchor" [shape=point, style=invis, label=""];'));
  assert.ok(text.includes('    subgraph "cluster_p.work.left" {'));
  assert.equal(text.filter((line) => line === '      style="rounded,dashed";').length, 2);
  assert.ok(text.includes('  "p.idle" -> "p.work__anchor" [label="GO", lhead="cluster_p.work"];'));
  assert.ok(text.includes('  "p.work__anchor" -> "p.idle" [label="ABORT", ltail="cluster_p.work"];'));
});

test('the root is drawn as a cluster when it has transitions of its own', () => {
  const machine = createMachine({
    id: 'app',
    initial: 'a',
    on: { RESET: '.a' },
    states: { a: {} },
  });
  const text = lines(toDot(machine));
  assert.ok(text.includes('  subgraph "cluster_app" {'));
  assert.ok(text.includes('    label="app";'));
  assert.ok(text.includes('  "app__initial" -> "app.a" [label="RESET", ltail="cluster_app"];'));
});

test('history states are circles with a dashed default edge', () => {
  const machine = createMachine({
    id: 'h',
    initial: 'off',
    states: {
      off: { on: { BACK: 'on.last' } },
      on: {
        initial: 'low',
        states: {
          low: {},
          high: {},
          last: { type: 'history', target: 'high' },
          deep: { type: 'history', history: 'deep' },
        },
      },
    },
  });
  const text = lines(toDot(machine));
  assert.ok(text.includes('    "h.on.last" [shape=circle, label="H"];'));
  assert.ok(text.includes('    "h.on.deep" [shape=circle, label="H*"];'));
  assert.ok(text.includes('  "h.on.last" -> "h.on.high" [label="default", style=dashed];'));
  assert.ok(text.includes('  "h.off" -> "h.on.last" [label="BACK"];'));
});

test('entry and exit actions go into the node label, targetless transitions loop', () => {
  const machine = createMachine({
    id: 'a',
    initial: 'x',
    states: { x: { entry: 'hello', exit: ['bye', 'log'], on: { PING: { actions: 'pong' } } } },
  });
  const withActions = lines(toDot(machine));
  assert.ok(withActions.includes('  "a.x" [label="x\\nentry / hello\\nexit / bye, log"];'));
  assert.ok(withActions.includes('  "a.x" -> "a.x" [label="PING / pong"];'));
  const without = lines(toDot(machine, { actions: false, direction: 'LR' }));
  assert.ok(without.includes('  rankdir=LR;'));
  assert.ok(without.includes('  "a.x" [label="x"];'));
  assert.ok(without.includes('  "a.x" -> "a.x" [label="PING"];'));
});

test('quotes and backslashes are escaped', () => {
  const machine = createMachine({
    id: 'q"id',
    initial: 'a',
    states: { a: { on: { 'say "hi"': 'b\\c' } }, 'b\\c': {} },
  });
  const text = lines(toDot(machine));
  assert.equal(text[0], 'digraph "q\\"id" {');
  assert.ok(text.includes('  "q\\"id.b\\\\c" [label="b\\\\c"];'));
  assert.ok(text.includes('  "q\\"id.a" -> "q\\"id.b\\\\c" [label="say \\"hi\\""];'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, isDescendant, properAncestors } from '../src/node';
import type { EventObject, MachineConfig } from '../src/types';

type Config = MachineConfig<unknown, EventObject>;

const player: Config = {
  id: 'player',
  initial: 'stopped',
  states: {
    stopped: {},
    active: {
      initial: 'playing',
      states: {
        playing: {},
        paused: { id: 'pausedState' },
        memory: { type: 'history', history: 'deep' },
      },
    },
    done: { type: 'final' },
  },
};

function codes(config: Config): string[] {
  return buildTree(config).issues.map((issue) => `${issue.severity}:${issue.code}`);
}

test('builds nodes in document order with inferred kinds and default ids', () => {
  const tree = buildTree(player);
  assert.deepEqual(tree.issues, []);
  assert.deepEqual(
    tree.nodes.map((node) => [node.order, node.id, node.kind]),
    [
      [0, 'player', 'compound'],
      [1, 'player.stopped', 'atomic'],
      [2, 'player.active', 'compound'],
      [3, 'player.active.playing', 'atomic'],
      [4, 'pausedState', 'atomic'],
      [5, 'player.active.memory', 'history'],
      [6, 'player.done', 'final'],
    ],
  );
  assert.equal(tree.root.initial?.key, 'stopped');
  assert.equal(tree.byId.get('player.active')?.initial?.key, 'playing');
  assert.equal(tree.byId.get('player.active.memory')?.historyKind, 'deep');
  assert.equal(tree.byId.get('pausedState')?.label, 'active.paused');
  assert.equal(tree.root.label, '(root)');
});

test('uses a default machine id when none is given', () => {
  const tree = buildTree({ initial: 'a', states: { a: {} } });
  assert.equal(tree.root.id, 'machine');
  assert.equal(tree.nodes[1].id, 'machine.a');
});

test('ancestor helpers walk the tree', () => {
  const tree = buildTree(player);
  const playing = tree.byId.get('player.active.playing')!;
  const active = tree.byId.get('player.active')!;
  assert.equal(isDescendant(playing, active), true);
  assert.equal(isDescendant(playing, tree.root), true);
  assert.equal(isDescendant(active, playing), false);
  assert.equal(isDescendant(active, active), false);
  assert.deepEqual(properAncestors(playing).map((node) => node.id), ['player.active', 'player']);
  assert.deepEqual(properAncestors(playing, tree.root).map((node) => node.id), ['player.active']);
  assert.deepEqual(properAncestors(tree.root), []);
});

test('reports a compound state without an initial child', () => {
  assert.deepEqual(codes({ states: { a: {}, b: {} } }), ['error:missing-initial']);
});

test('reports an initial that is not a child', () => {
  const tree = buildTree({ initial: 'nope', states: { a: {} } });
  assert.equal(tree.issues.length, 1);
  assert.equal(tree.issues[0].code, 'unknown-initial');
  assert.equal(tree.issues[0].path, '(root)');
  assert.match(tree.issues[0].message, /"nope"/);
});

test('reports duplicate ids, including a custom id clashing with a default one', () => {
  const tree = buildTree({
    id: 'm',
    initial: 'a',
    states: { a: {}, b: { id: 'm.a' }, c: { id: 'same' }, d: { id: 'same' } },
  });
  assert.deepEqual(
    tree.issues.map((issue) => [issue.code, issue.path]),
    [
      ['duplicate-id', 'b'],
      ['duplicate-id', 'd'],
    ],
  );
});

test('reports invalid keys', () => {
  assert.deepEqual(codes({ initial: 'a.b', states: { 'a.b': {}, '#x': {} } }), [
    'error:invalid-key',
    'error:invalid-key',
  ]);
});

test('reports structural problems per state type', () => {
  assert.deepEqual(codes({ type: 'final' }), ['error:invalid-structure']);
  assert.deepEqual(codes({ initial: 'a', states: { a: { type: 'final', states: { x: {} } } } }), [
    'error:invalid-structure',
  ]);
  assert.deepEqual(codes({ initial: 'a', states: { a: { type: 'parallel' } } }), ['error:invalid-structure']);
  assert.deepEqual(codes({ initial: 'a', states: { a: { type: 'compound' } } }), ['error:invalid-structure']);
});

test('warns about fields that have no effect', () => {
  assert.deepEqual(codes({ type: 'parallel', initial: 'a', states: { a: {}, b: {} } }), [
    'warning:invalid-structure',
  ]);
  assert.deepEqual(codes({ initial: 'a', states: { a: { history: 'deep' } } }), ['warning:invalid-history']);
});

test('rejects history states with behaviour or a bad history kind', () => {
  assert.deepEqual(
    codes({
      initial: 'a',
      states: { a: {}, h: { type: 'history', entry: 'log' } },
    }),
    ['error:invalid-history'],
  );
  assert.deepEqual(
    codes({
      initial: 'a',
      states: { a: {}, h: { type: 'history', history: 'sideways' as 'deep' } },
    }),
    ['error:invalid-history'],
  );
});

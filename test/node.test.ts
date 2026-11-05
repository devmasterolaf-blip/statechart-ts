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

// ---------------------------------------------------------------------------
// Transitions and target resolution
// ---------------------------------------------------------------------------

const lights: Config = {
  id: 'lights',
  initial: 'off',
  on: { RESET: '.off', BREAK: '#broken' },
  states: {
    off: { on: { ON: 'on', DEEP: 'on.bright' } },
    on: {
      initial: 'dim',
      entry: 'power',
      exit: ['unpower', 'log'],
      on: { OFF: 'off', BRIGHT: { target: '.bright', actions: 'flash' } },
      after: { 5000: 'off', COOL_DOWN: { target: 'off', guard: 'isHot' } },
      onDone: 'off',
      always: [{ target: 'off', guard: 'noPower' }],
      states: {
        dim: { on: { TOGGLE: 'bright', NOOP: { actions: 'beep' }, UP: '#lights.on.bright' } },
        bright: { on: { TOGGLE: 'dim', BREAK: '#broken' } },
        blown: { type: 'final' },
        last: { type: 'history', target: 'bright' },
      },
    },
    faulty: { id: 'broken' },
  },
};

test('normalizes transitions from on, always, after and onDone', () => {
  const tree = buildTree(lights);
  assert.deepEqual(tree.issues, []);
  const on = tree.byId.get('lights.on')!;
  assert.deepEqual(
    on.transitions.map((t) => [t.eventType, t.targets.map((n) => n.id), t.internal]),
    [
      ['OFF', ['lights.off'], false],
      ['BRIGHT', ['lights.on.bright'], true],
      ['', ['lights.off'], false],
      ['after(5000)#lights.on', ['lights.off'], false],
      ['after(COOL_DOWN)#lights.on', ['lights.off'], false],
      ['done.state.lights.on', ['lights.off'], false],
    ],
  );
  assert.deepEqual(on.delays, [
    { key: '5000', eventType: 'after(5000)#lights.on', delay: 5000 },
    { key: 'COOL_DOWN', eventType: 'after(COOL_DOWN)#lights.on', delay: 'COOL_DOWN' },
  ]);
  assert.deepEqual(on.entry, ['power']);
  assert.deepEqual(on.exit, ['unpower', 'log']);
  assert.deepEqual(on.transitions[1].actions, ['flash']);
  assert.equal(on.transitions[4].guard, 'isHot');
});

test('resolves sibling, relative, id and id-with-path targets', () => {
  const tree = buildTree(lights);
  const dim = tree.byId.get('lights.on.dim')!;
  const byEvent = new Map(dim.transitions.map((t) => [t.eventType, t]));
  assert.equal(byEvent.get('TOGGLE')!.targets[0].id, 'lights.on.bright');
  assert.equal(byEvent.get('UP')!.targets[0].id, 'lights.on.bright');
  assert.deepEqual(byEvent.get('NOOP')!.targets, []);
  assert.equal(tree.byId.get('lights.off')!.transitions[1].targets[0].id, 'lights.on.bright');
  assert.equal(tree.byId.get('lights.on.bright')!.transitions[1].targets[0].id, 'broken');
  // Root transitions resolve plain names against the root's own children.
  assert.deepEqual(
    tree.root.transitions.map((t) => [t.targets[0].id, t.internal]),
    [
      ['lights.off', true],
      ['broken', false],
    ],
  );
  assert.equal(tree.byId.get('lights.on.last')!.historyDefault?.id, 'lights.on.bright');
});

test('reports unknown targets and drops the transition', () => {
  const tree = buildTree({
    initial: 'a',
    states: {
      a: { on: { GO: 'missing', DEEP: '#machine.b.nope', REL: '.child', ROOT: '#machine' }, always: 'gone' },
      b: {},
    },
  });
  assert.deepEqual(
    tree.issues.map((issue) => issue.code),
    ['unknown-target', 'unknown-target', 'unknown-target', 'unknown-target', 'unknown-target'],
  );
  assert.match(tree.issues[0].message, /"missing" of the transition on "GO"/);
  assert.match(tree.issues[3].message, /root state/);
  assert.match(tree.issues[4].message, /eventless/);
  assert.equal(tree.byId.get('machine.a')!.transitions.length, 0);
});

test('reports invalid delays and transitions on final states', () => {
  const tree = buildTree({
    initial: 'a',
    states: {
      a: { after: { '-5': 'b', Infinity: 'b', ' ': 'b' } },
      b: { type: 'final', on: { X: 'a' } },
    },
  });
  assert.deepEqual(
    tree.issues.map((issue) => [issue.code, issue.path]),
    [
      ['invalid-delay', 'a'],
      ['invalid-delay', 'a'],
      ['invalid-delay', 'a'],
      ['invalid-structure', 'b'],
    ],
  );
});

test('checks the default target of a history state', () => {
  const tree = buildTree({
    initial: 'a',
    states: {
      a: {
        initial: 'x',
        states: {
          x: {},
          h1: { type: 'history', target: '#machine.b' },
          h2: { type: 'history', target: 'nowhere' },
        },
      },
      b: {},
    },
  });
  assert.deepEqual(
    tree.issues.map((issue) => [issue.code, issue.path]),
    [
      ['invalid-history', 'a.h1'],
      ['unknown-target', 'a.h2'],
    ],
  );
});

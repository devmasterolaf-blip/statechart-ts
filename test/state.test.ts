import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/node';
import { State, matchesValue, pathToValue } from '../src/state';
import type { EventObject, MachineConfig } from '../src/types';

const config: MachineConfig<{ n: number }, EventObject> = {
  id: 'app',
  initial: 'idle',
  states: {
    idle: {},
    editor: {
      type: 'parallel',
      states: {
        mode: { initial: 'insert', states: { insert: {}, visual: { initial: 'line', states: { line: {}, block: {} } } } },
        saving: { initial: 'clean', states: { clean: {}, dirty: {} } },
        spell: {},
      },
    },
  },
};

const tree = buildTree(config);

function stateOf(...ids: string[]): State<{ n: number }, EventObject> {
  return new State({
    root: tree.root,
    configuration: ids.map((id) => tree.byId.get(id)!),
    context: { n: 1 },
    event: { type: 'test' },
  });
}

test('value is a string for a single active leaf', () => {
  const state = stateOf('app', 'app.idle');
  assert.equal(state.value, 'idle');
  assert.deepEqual(state.leafIds, ['app.idle']);
});

test('value nests compound states and lists every parallel region', () => {
  const state = stateOf(
    'app.editor.spell',
    'app.editor.saving.dirty',
    'app.editor.saving',
    'app.editor.mode.visual.block',
    'app.editor.mode.visual',
    'app.editor.mode',
    'app.editor',
    'app',
  );
  assert.deepEqual(state.value, {
    editor: { mode: { visual: 'block' }, saving: 'dirty', spell: {} },
  });
  // The configuration is kept in document order whatever the input order was.
  assert.deepEqual(
    state.configuration.map((node) => node.key),
    ['', 'editor', 'mode', 'visual', 'block', 'saving', 'dirty', 'spell'],
  );
  assert.deepEqual(state.leafIds, ['app.editor.mode.visual.block', 'app.editor.saving.dirty', 'app.editor.spell']);
});

test('matches accepts dotted paths and partial values', () => {
  const state = stateOf(
    'app',
    'app.editor',
    'app.editor.mode',
    'app.editor.mode.insert',
    'app.editor.saving',
    'app.editor.saving.clean',
    'app.editor.spell',
  );
  assert.equal(state.matches('editor'), true);
  assert.equal(state.matches('editor.mode'), true);
  assert.equal(state.matches('editor.mode.insert'), true);
  assert.equal(state.matches('editor.mode.visual'), false);
  assert.equal(state.matches('editor.spell'), true);
  assert.equal(state.matches('idle'), false);
  assert.equal(state.matches({ editor: { mode: 'insert', saving: 'clean' } }), true);
  assert.equal(state.matches({ editor: { mode: 'insert', saving: 'dirty' } }), false);
  assert.equal(state.matches({ editor: { spell: {} } }), true);
  assert.equal(state.matches({ editor: { mode: { insert: {} } } }), true);
  assert.equal(state.matches({ editor: { mode: { insert: 'deeper' } } }), false);
  assert.equal(state.matches({}), true);
});

test('isActive looks states up by id', () => {
  const state = stateOf('app', 'app.idle');
  assert.equal(state.isActive('app.idle'), true);
  assert.equal(state.isActive('app'), true);
  assert.equal(state.isActive('app.editor'), false);
  assert.equal(state.isActive('#app.idle'), false);
});

test('pathToValue and matchesValue handle the basic shapes', () => {
  assert.equal(pathToValue('a'), 'a');
  assert.deepEqual(pathToValue('a.b.c'), { a: { b: 'c' } });
  assert.equal(matchesValue('a', 'a'), true);
  assert.equal(matchesValue('a', 'b'), false);
  assert.equal(matchesValue('a', { a: 'x' }), true);
  assert.equal(matchesValue({ a: 'x' }, 'a'), false);
  assert.equal(matchesValue('toString', {}), false);
});

test('defaults: unchanged, not done, empty history', () => {
  const state = stateOf('app', 'app.idle');
  assert.equal(state.changed, false);
  assert.equal(state.done, false);
  assert.equal(state.history.size, 0);
  assert.deepEqual(state.context, { n: 1 });
});

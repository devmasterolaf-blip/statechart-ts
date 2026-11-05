import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTORE_EVENT_TYPE,
  RestoreError,
  assign,
  createMachine,
  type PersistedState,
  type StateJSON,
} from '../src/index';

type PlayerEvent = { type: 'PLAY' | 'PAUSE' | 'STOP' | 'RESUME' | 'MUTE' | 'UNMUTE' | 'EJECT' };
interface PlayerContext {
  plays: number;
}

const player = createMachine<PlayerContext, PlayerEvent>({
  id: 'player',
  context: { plays: 0 },
  initial: 'stopped',
  states: {
    stopped: { on: { PLAY: 'active', RESUME: 'active.memory', EJECT: 'ejected' } },
    active: {
      type: 'parallel',
      on: { STOP: 'stopped' },
      states: {
        transport: {
          initial: 'playing',
          states: {
            playing: { entry: assign({ plays: (context) => context.plays + 1 }), on: { PAUSE: 'paused' } },
            paused: { on: { PLAY: 'playing' } },
          },
        },
        sound: {
          initial: 'on',
          states: { on: { on: { MUTE: 'off' } }, off: { on: { UNMUTE: 'on' } } },
        },
        memory: { type: 'history', history: 'deep' },
      },
    },
    ejected: { type: 'final' },
  },
});

function roundTrip(json: StateJSON<PlayerContext>): PersistedState<PlayerContext> {
  return JSON.parse(JSON.stringify(json)) as PersistedState<PlayerContext>;
}

function restoreError(run: () => unknown, path: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RestoreError, `expected a RestoreError, got ${String(error)}`);
    assert.equal(error.code, 'invalid-snapshot');
    assert.equal(error.path, path);
    assert.match(error.message, pattern);
    return true;
  });
}

test('toJSON keeps value, context, history and done', () => {
  let state = player.transition(player.initialState, 'PLAY');
  state = player.transition(state, 'MUTE');
  assert.deepEqual(state.toJSON(), {
    value: { active: { transport: 'playing', sound: 'off' } },
    context: { plays: 1 },
    history: {},
    done: false,
  });
  state = player.transition(state, 'STOP');
  assert.deepEqual(state.toJSON(), {
    value: 'stopped',
    context: { plays: 1 },
    history: { 'player.active.memory': ['player.active.transport.playing', 'player.active.sound.off'] },
    done: false,
  });
});

test('JSON.stringify uses toJSON', () => {
  const text = JSON.stringify(player.initialState);
  assert.deepEqual(JSON.parse(text), { value: 'stopped', context: { plays: 0 }, history: {}, done: false });
});

test('a restored state continues exactly like the original', () => {
  let original = player.transition(player.initialState, 'PLAY');
  original = player.transition(original, 'PAUSE');
  original = player.transition(original, 'MUTE');
  let restored = player.restoreState(roundTrip(original.toJSON()));
  assert.deepEqual(restored.value, original.value);
  assert.deepEqual(restored.context, original.context);
  assert.deepEqual(restored.leafIds, original.leafIds);
  assert.equal(restored.event.type, RESTORE_EVENT_TYPE);
  assert.equal(restored.changed, false);
  assert.deepEqual(restored.effects, []);

  for (const event of ['STOP', 'RESUME', 'UNMUTE'] as const) {
    original = player.transition(original, event);
    restored = player.transition(restored, event);
    assert.deepEqual(restored.toJSON(), original.toJSON());
  }
  assert.deepEqual(restored.value, { active: { transport: 'paused', sound: 'on' } });
});

test('recorded history survives the round trip', () => {
  let state = player.transition(player.initialState, 'PLAY');
  state = player.transition(state, 'PAUSE');
  state = player.transition(state, 'STOP');
  const restored = player.restoreState(roundTrip(state.toJSON()));
  assert.deepEqual(player.transition(restored, 'RESUME').value, { active: { transport: 'paused', sound: 'on' } });
});

test('restoring does not run entry actions', () => {
  const restored = player.restoreState({ value: { active: { transport: 'playing', sound: 'on' } }, context: { plays: 7 } });
  assert.equal(restored.context.plays, 7);
  assert.equal(restored.history.size, 0);
});

test('done is derived from the configuration', () => {
  const finished = player.restoreState({ value: 'ejected', context: { plays: 0 }, done: false });
  assert.equal(finished.done, true);
  assert.equal(player.transition(finished, 'PLAY').value, 'ejected');
  const running = player.restoreState({ value: 'stopped', context: { plays: 0 }, done: true });
  assert.equal(running.done, false);
});

test('rejects values that do not fit the machine', () => {
  const context = { plays: 0 };
  restoreError(() => player.restoreState({ value: 'nowhere', context }), '(root)', /"nowhere" is not a child state/);
  restoreError(() => player.restoreState({ value: 'active', context }), '(root)', /its value must be an object/);
  restoreError(
    () => player.restoreState({ value: { active: { transport: 'playing' } }, context }),
    'active',
    /Region "sound"/,
  );
  restoreError(
    () => player.restoreState({ value: { active: { transport: 'playing', sound: 'loud' } }, context }),
    'active.sound',
    /"loud" is not a child state/,
  );
  restoreError(
    () => player.restoreState({ value: { active: { transport: 'playing', sound: 'on', memory: {} } }, context }),
    'active',
    /"memory" is not a child state/,
  );
  restoreError(
    () => player.restoreState({ value: { stopped: {}, ejected: {} }, context }),
    '(root)',
    /Exactly one child must be active, got 2/,
  );
  restoreError(() => player.restoreState({ value: { stopped: 'x' }, context }), 'stopped', /must have the value \{\}/);
  restoreError(
    () => player.restoreState({ value: 42 as never, context }),
    '(root)',
    /child key or an object keyed by child/,
  );
  restoreError(() => player.restoreState(null as never), '(root)', /must be an object/);
});

test('an object value may spell out a leaf child as {}', () => {
  const restored = player.restoreState({ value: { stopped: {} }, context: { plays: 0 } });
  assert.equal(restored.value, 'stopped');
});

test('rejects history that does not fit the machine', () => {
  const base = { value: 'stopped', context: { plays: 0 } };
  restoreError(() => player.restoreState({ ...base, history: [] as never }), '(history)', /must be an object/);
  restoreError(
    () => player.restoreState({ ...base, history: { 'player.active': ['player.active.sound.on'] } }),
    '(history)',
    /not the id of a history state/,
  );
  restoreError(
    () => player.restoreState({ ...base, history: { 'player.active.memory': [] } }),
    'active.memory',
    /non-empty array/,
  );
  restoreError(
    () => player.restoreState({ ...base, history: { 'player.active.memory': ['player.stopped'] } }),
    'active.memory',
    /"player.stopped" is not a state inside "active"/,
  );
  restoreError(
    () => player.restoreState({ ...base, history: { 'player.active.memory': [5 as never] } }),
    'active.memory',
    /"5" is not a state inside/,
  );
});

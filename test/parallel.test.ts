import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, createMachine, stateIn, type MachineConfig } from '../src/index';
import { effectNames, noopActions } from './helpers/trace';

type Ev =
  | { type: 'BOLD' }
  | { type: 'ITALIC' }
  | { type: 'RESET' }
  | { type: 'CLOSE' }
  | { type: 'OPEN' }
  | { type: 'OPEN_STYLED' }
  | { type: 'OPEN_ITALIC' };

const editorConfig: MachineConfig<undefined, Ev> = {
  id: 'editor',
  initial: 'closed',
  states: {
    closed: {
      on: {
        OPEN: 'open',
        OPEN_STYLED: { target: ['open.bold.on', 'open.italic.on'] },
        OPEN_ITALIC: 'open.italic.on',
      },
    },
    open: {
      type: 'parallel',
      entry: 'enterOpen',
      exit: 'exitOpen',
      on: { CLOSE: 'closed' },
      states: {
        bold: {
          initial: 'off',
          entry: 'enterBold',
          exit: 'exitBold',
          states: {
            off: { entry: 'enterBoldOff', exit: 'exitBoldOff', on: { BOLD: 'on' } },
            on: { entry: 'enterBoldOn', exit: 'exitBoldOn', on: { BOLD: 'off', RESET: 'off' } },
          },
        },
        italic: {
          initial: 'off',
          entry: 'enterItalic',
          exit: 'exitItalic',
          states: {
            off: { entry: 'enterItalicOff', exit: 'exitItalicOff', on: { ITALIC: 'on' } },
            on: { entry: 'enterItalicOn', exit: 'exitItalicOn', on: { ITALIC: 'off', RESET: 'off' } },
          },
        },
      },
    },
  },
};

const names = [
  'enterOpen',
  'exitOpen',
  'enterBold',
  'exitBold',
  'enterBoldOff',
  'exitBoldOff',
  'enterBoldOn',
  'exitBoldOn',
  'enterItalic',
  'exitItalic',
  'enterItalicOff',
  'exitItalicOff',
  'enterItalicOn',
  'exitItalicOn',
];
const editor = createMachine(editorConfig, { actions: noopActions(...names) });
const opened = editor.transition(editor.initialState, 'OPEN');

test('entering a parallel state enters every region in document order', () => {
  assert.deepEqual(opened.value, { open: { bold: 'off', italic: 'off' } });
  assert.deepEqual(effectNames(opened), ['enterOpen', 'enterBold', 'enterBoldOff', 'enterItalic', 'enterItalicOff']);
});

test('an event handled by one region leaves the other untouched', () => {
  const state = editor.transition(opened, 'ITALIC');
  assert.deepEqual(state.value, { open: { bold: 'off', italic: 'on' } });
  assert.deepEqual(effectNames(state), ['exitItalicOff', 'enterItalicOn']);
});

test('one event can move several regions in the same microstep', () => {
  const styled = editor.transition(editor.transition(opened, 'BOLD'), 'ITALIC');
  const state = editor.transition(styled, 'RESET');
  assert.deepEqual(state.value, { open: { bold: 'off', italic: 'off' } });
  assert.deepEqual(effectNames(state), ['exitItalicOn', 'exitBoldOn', 'enterBoldOff', 'enterItalicOff']);
});

test('leaving the parallel state exits all regions innermost first, last region first', () => {
  const state = editor.transition(opened, 'CLOSE');
  assert.equal(state.value, 'closed');
  assert.deepEqual(effectNames(state), ['exitItalicOff', 'exitItalic', 'exitBoldOff', 'exitBold', 'exitOpen']);
});

test('multiple targets select a child in each region', () => {
  const state = editor.transition(editor.initialState, 'OPEN_STYLED');
  assert.deepEqual(state.value, { open: { bold: 'on', italic: 'on' } });
  assert.deepEqual(effectNames(state), ['enterOpen', 'enterBold', 'enterBoldOn', 'enterItalic', 'enterItalicOn']);
});

test('targeting inside one region enters the other regions by default', () => {
  const state = editor.transition(editor.initialState, 'OPEN_ITALIC');
  assert.deepEqual(state.value, { open: { bold: 'off', italic: 'on' } });
});

test('a parallel root state activates all regions initially', () => {
  const machine = createMachine<{ ticks: number }, { type: 'TICK' }>({
    type: 'parallel',
    context: { ticks: 0 },
    states: {
      clock: { on: { TICK: { actions: assign({ ticks: (c) => c.ticks + 1 }) } } },
      light: { initial: 'red', states: { red: { on: { TICK: 'green' } }, green: { on: { TICK: 'red' } } } },
    },
  });
  assert.deepEqual(machine.initialState.value, { clock: {}, light: 'red' });
  const state = machine.transition(machine.initialState, 'TICK');
  assert.deepEqual(state.value, { clock: {}, light: 'green' });
  assert.equal(state.context.ticks, 1);
});

test('conflicting transitions: the earlier region wins and the other is dropped', () => {
  const machine = createMachine(
    {
      initial: 'both',
      states: {
        both: {
          type: 'parallel',
          states: {
            first: { initial: 'a', states: { a: { on: { GO: { target: '#out', actions: 'fromFirst' } } } } },
            second: {
              initial: 'x',
              states: { x: { on: { GO: { target: 'y', actions: 'fromSecond' } } }, y: {} },
            },
          },
        },
        out: { id: 'out' },
      },
    },
    { actions: noopActions('fromFirst', 'fromSecond') },
  );
  const state = machine.transition(machine.initialState, 'GO');
  assert.equal(state.value, 'out');
  assert.deepEqual(effectNames(state), ['fromFirst']);
});

test('conflicting transitions: a later region leaving the parallel state is preempted by the earlier one', () => {
  const machine = createMachine({
    initial: 'both',
    states: {
      both: {
        type: 'parallel',
        states: {
          first: { initial: 'a', states: { a: { on: { GO: 'b' } }, b: {} } },
          second: { initial: 'x', states: { x: { on: { GO: '#elsewhere' } } } },
        },
      },
      elsewhere: { id: 'elsewhere' },
    },
  });
  assert.deepEqual(machine.transition(machine.initialState, 'GO').value, { both: { first: 'b', second: 'x' } });
});

test('targetless transitions never conflict', () => {
  const machine = createMachine<{ hits: string[] }, { type: 'HIT' }>({
    type: 'parallel',
    context: { hits: [] },
    states: {
      one: { on: { HIT: { actions: assign({ hits: (c) => [...c.hits, 'one'] }) } } },
      two: { on: { HIT: { actions: assign({ hits: (c) => [...c.hits, 'two'] }) } } },
    },
  });
  assert.deepEqual(machine.transition(machine.initialState, 'HIT').context.hits, ['one', 'two']);
});

test('a guard can make one region wait for another', () => {
  const machine = createMachine<undefined, { type: 'ARM' } | { type: 'FIRE' }>({
    id: 'gun',
    type: 'parallel',
    states: {
      safety: { initial: 'on', states: { on: { on: { ARM: 'off' } }, off: {} } },
      trigger: {
        initial: 'idle',
        states: { idle: { on: { FIRE: { target: 'fired', guard: stateIn('#gun.safety.off') } } }, fired: {} },
      },
    },
  });
  const blocked = machine.transition(machine.initialState, 'FIRE');
  assert.deepEqual(blocked.value, { safety: 'on', trigger: 'idle' });
  const fired = machine.transition(machine.transition(machine.initialState, 'ARM'), 'FIRE');
  assert.deepEqual(fired.value, { safety: 'off', trigger: 'fired' });
});

test('parallel states nest inside regions', () => {
  const machine = createMachine({
    type: 'parallel',
    states: {
      left: {
        initial: 'idle',
        states: {
          idle: { on: { SPLIT: 'split' } },
          split: { type: 'parallel', states: { up: {}, down: { initial: 'd1', states: { d1: { on: { NEXT: 'd2' } }, d2: {} } } } },
        },
      },
      right: { initial: 'r1', states: { r1: { on: { NEXT: 'r2' } }, r2: {} } },
    },
  });
  const split = machine.transition(machine.initialState, 'SPLIT');
  assert.deepEqual(split.value, { left: { split: { up: {}, down: 'd1' } }, right: 'r1' });
  assert.deepEqual(machine.transition(split, 'NEXT').value, { left: { split: { up: {}, down: 'd2' } }, right: 'r2' });
});

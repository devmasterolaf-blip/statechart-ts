import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, assign, createMachine, not, raise, stateIn, toMermaid } from '../src/index';

function lines(text: string): string[] {
  return text.trimEnd().split('\n');
}

test('flat machine: initial marker, states, transitions and final marker', () => {
  const machine = createMachine({
    id: 'fetch',
    initial: 'idle',
    states: {
      idle: { on: { FETCH: 'loading' } },
      loading: { on: { RESOLVE: 'done', REJECT: 'idle' } },
      done: { type: 'final' },
    },
  });
  assert.equal(
    toMermaid(machine),
    [
      'stateDiagram-v2',
      '    [*] --> idle',
      '    state "idle" as idle',
      '    state "loading" as loading',
      '    state "done" as done',
      '    done --> [*]',
      '    idle --> loading : FETCH',
      '    loading --> done : RESOLVE',
      '    loading --> idle : REJECT',
      '',
    ].join('\n'),
  );
});

test('labels show guards, actions, delays, eventless and done transitions', () => {
  const machine = createMachine<{ n: number }>({
    context: { n: 0 },
    initial: 'a',
    states: {
      a: {
        on: {
          GO: { target: 'b', guard: 'ready', actions: ['log', assign({ n: 1 }), raise('NEXT')] },
          CHECK: { target: 'b', guard: and('x', not('y'), stateIn('#machine.a')) },
          INLINE: { target: 'b', guard: () => true, actions: function named() {} },
          NOOP: { actions: 'log' },
        },
        after: { 250: 'b', SLOW: 'c' },
        always: { target: 'c', guard: 'skip' },
      },
      b: { initial: 'x', onDone: 'c', states: { x: { type: 'final' } } },
      c: {},
    },
  });
  const text = toMermaid(machine);
  for (const expected of [
    'a --> b : GO [ready] / log, assign, raise NEXT',
    'a --> b : CHECK [and(x, not(y), in machine.a)]',
    'a --> b : INLINE [guard] / named',
    'a --> a : NOOP / log',
    'a --> b : after 250ms',
    'a --> c : after SLOW',
    'a --> c : always [skip]',
    'b --> c : done',
  ]) {
    assert.ok(lines(text).includes(`    ${expected}`), `missing line: ${expected}\n${text}`);
  }
});

test('nested states become composite blocks with their own initial marker', () => {
  const machine = createMachine({
    initial: 'off',
    states: {
      off: { on: { POWER: 'on' } },
      on: {
        initial: 'low',
        on: { POWER: 'off' },
        states: { low: { on: { UP: 'high' } }, high: { on: { DOWN: 'low', BOOST: '#machine.off' } } },
      },
    },
  });
  assert.deepEqual(lines(toMermaid(machine)), [
    'stateDiagram-v2',
    '    [*] --> off',
    '    state "off" as off',
    '    state "on" as on {',
    '        [*] --> on_low',
    '        state "low" as on_low',
    '        state "high" as on_high',
    '        on_low --> on_high : UP',
    '        on_high --> on_low : DOWN',
    '    }',
    '    off --> on : POWER',
    '    on --> off : POWER',
    '    on_high --> off : BOOST',
  ]);
});

test('parallel regions are separated and the root is boxed when it is parallel', () => {
  const machine = createMachine({
    id: 'editor',
    type: 'parallel',
    states: {
      bold: { initial: 'off', states: { off: { on: { BOLD: 'on' } }, on: { on: { BOLD: 'off' } } } },
      italic: { initial: 'off', states: { off: { on: { ITALIC: 'on' } }, on: { on: { ITALIC: 'off' } } } },
    },
  });
  assert.deepEqual(lines(toMermaid(machine)), [
    'stateDiagram-v2',
    '    state "editor" as editor {',
    '        state "bold" as bold {',
    '            [*] --> bold_off',
    '            state "off" as bold_off',
    '            state "on" as bold_on',
    '            bold_off --> bold_on : BOLD',
    '            bold_on --> bold_off : BOLD',
    '        }',
    '        --',
    '        state "italic" as italic {',
    '            [*] --> italic_off',
    '            state "off" as italic_off',
    '            state "on" as italic_on',
    '            italic_off --> italic_on : ITALIC',
    '            italic_on --> italic_off : ITALIC',
    '        }',
    '    }',
  ]);
});

test('transitions of the root are drawn from a box around the machine', () => {
  const machine = createMachine({
    id: 'app',
    initial: 'a',
    on: { RESET: '.a' },
    states: { a: { on: { GO: 'b' } }, b: {} },
  });
  assert.deepEqual(lines(toMermaid(machine)), [
    'stateDiagram-v2',
    '    state "app" as app {',
    '        [*] --> a',
    '        state "a" as a',
    '        state "b" as b',
    '        a --> b : GO',
    '    }',
    '    app --> a : RESET',
  ]);
});

test('history states are drawn as H or H* with their default target', () => {
  const machine = createMachine({
    initial: 'off',
    states: {
      off: { on: { BACK: 'on.last', DEEP: 'on.deepest' } },
      on: {
        initial: 'low',
        states: {
          low: {},
          high: {},
          last: { type: 'history', target: 'high' },
          deepest: { type: 'history', history: 'deep' },
        },
      },
    },
  });
  const text = lines(toMermaid(machine));
  assert.ok(text.includes('        state "H" as on_last'));
  assert.ok(text.includes('        on_last --> on_high : default'));
  assert.ok(text.includes('        state "H*" as on_deepest'));
  assert.ok(text.includes('    off --> on_last : BACK'));
});

test('entry and exit actions are listed on leaf states unless actions are off', () => {
  const machine = createMachine({
    initial: 'a',
    states: { a: { entry: ['start', 'log'], exit: 'stop', on: { GO: { target: 'a', actions: 'count' } } } },
  });
  const withActions = lines(toMermaid(machine));
  assert.ok(withActions.includes('    a : entry / start, log'));
  assert.ok(withActions.includes('    a : exit / stop'));
  assert.ok(withActions.includes('    a --> a : GO / count'));
  const without = lines(toMermaid(machine, { actions: false }));
  assert.deepEqual(without, ['stateDiagram-v2', '    [*] --> a', '    state "a" as a', '    a --> a : GO']);
});

test('direction option and several targets', () => {
  const machine = createMachine({
    initial: 'idle',
    states: {
      idle: { on: { GO: { target: ['work.left.b', 'work.right.y'] } } },
      work: {
        type: 'parallel',
        states: {
          left: { initial: 'a', states: { a: {}, b: {} } },
          right: { initial: 'x', states: { x: {}, y: {} } },
        },
      },
    },
  });
  const text = lines(toMermaid(machine, { direction: 'LR' }));
  assert.equal(text[1], '    direction LR');
  assert.ok(text.includes('    idle --> work_left_b : GO'));
  assert.ok(text.includes('    idle --> work_right_y : GO'));
});

test('unusual keys get safe unique identifiers and escaped labels', () => {
  const machine = createMachine({
    initial: 'a b',
    states: {
      'a b': { on: { 'go;now': 'a_b', '#tag': '1st' } },
      a_b: {},
      '1st': {},
      'say "hi"': {},
    },
  });
  assert.deepEqual(lines(toMermaid(machine)), [
    'stateDiagram-v2',
    '    [*] --> a_b',
    '    state "a b" as a_b',
    '    state "a_b" as a_b_2',
    '    state "1st" as s_1st',
    '    state "say #quot;hi#quot;" as say__hi_',
    '    a_b --> a_b_2 : go#59;now',
    '    a_b --> s_1st : #35;tag',
  ]);
});

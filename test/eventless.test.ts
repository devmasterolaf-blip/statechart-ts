import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacrostepLimitError, assign, createMachine, raise } from '../src/index';
import { effectNames, noopActions } from './helpers/trace';

test('an eventless transition is taken as soon as its guard passes', () => {
  const machine = createMachine<{ count: number }, { type: 'INC' }>({
    context: { count: 0 },
    initial: 'counting',
    states: {
      counting: {
        on: { INC: { actions: assign({ count: (c) => c.count + 1 }) } },
        always: { target: 'full', guard: (c) => c.count >= 2 },
      },
      full: {},
    },
  });
  const one = machine.transition(machine.initialState, 'INC');
  assert.equal(one.value, 'counting');
  const two = machine.transition(one, 'INC');
  assert.equal(two.value, 'full');
  assert.equal(two.event.type, 'INC');
});

test('eventless transitions chain through transient states on entry', () => {
  const machine = createMachine<{ role: string }, { type: 'LOGIN'; role: string }>(
    {
      context: { role: 'none' },
      initial: 'loggedOut',
      states: {
        loggedOut: { on: { LOGIN: { target: 'routing', actions: assign({ role: (_c, e) => e.role }) } } },
        routing: {
          entry: 'enterRouting',
          exit: 'exitRouting',
          always: [
            { target: 'admin', guard: (c) => c.role === 'admin' },
            { target: 'checking', guard: (c) => c.role === 'user' },
            'guest',
          ],
        },
        checking: { always: 'member' },
        admin: {},
        member: { entry: 'enterMember' },
        guest: {},
      },
    },
    { actions: noopActions('enterRouting', 'exitRouting', 'enterMember') },
  );
  const login = (role: string) => machine.transition(machine.initialState, { type: 'LOGIN', role });
  assert.equal(login('admin').value, 'admin');
  assert.equal(login('visitor').value, 'guest');
  const member = login('user');
  assert.equal(member.value, 'member');
  assert.deepEqual(effectNames(member), ['enterRouting', 'exitRouting', 'enterMember']);
});

test('the initial state settles eventless transitions too', () => {
  const machine = createMachine({
    initial: 'boot',
    states: { boot: { always: 'ready' }, ready: {} },
  });
  assert.equal(machine.initialState.value, 'ready');
});

test('eventless transitions run before the next raised event is handled', () => {
  const machine = createMachine<{ trail: string[] }, { type: 'GO' } | { type: 'PING' }>({
    context: { trail: [] },
    initial: 'a',
    states: {
      a: { on: { GO: { target: 'b', actions: raise('PING') } } },
      b: { always: 'c', on: { PING: { actions: assign({ trail: (c) => [...c.trail, 'ping in b'] }) } } },
      c: { on: { PING: { actions: assign({ trail: (c) => [...c.trail, 'ping in c'] }) } } },
    },
  });
  const state = machine.transition(machine.initialState, 'GO');
  assert.equal(state.value, 'c');
  assert.deepEqual(state.context.trail, ['ping in c']);
});

test('an eventless transition on an ancestor applies to its descendants', () => {
  const machine = createMachine<{ stop: boolean }, { type: 'STOP' }>({
    context: { stop: false },
    initial: 'working',
    states: {
      working: {
        initial: 'step1',
        always: { target: 'halted', guard: (c) => c.stop },
        on: { STOP: { actions: assign({ stop: true }) } },
        states: { step1: {} },
      },
      halted: {},
    },
  });
  assert.equal(machine.transition(machine.initialState, 'STOP').value, 'halted');
});

test('an endless eventless loop is reported instead of hanging', () => {
  const machine = createMachine({
    initial: 'ping',
    states: { ping: { always: 'pong' }, pong: { always: 'ping' } },
  });
  assert.throws(
    () => machine.initialState,
    (error: unknown) => error instanceof MacrostepLimitError && error.limit === 1000 && error.code === 'macrostep-limit',
  );
});

test('an endless raise loop is reported as well', () => {
  const machine = createMachine<undefined, { type: 'TICK' }>({
    initial: 'a',
    states: { a: { on: { TICK: { actions: raise('TICK') } } } },
  });
  assert.throws(() => machine.transition(machine.initialState, 'TICK'), MacrostepLimitError);
});

test('a bounded loop below the limit completes', () => {
  const machine = createMachine<{ n: number }, { type: 'RUN' }>({
    context: { n: 0 },
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'loop' } },
      loop: {
        always: [
          { target: 'done', guard: (c) => c.n >= 500 },
          { target: 'loop', actions: assign({ n: (c) => c.n + 1 }) },
        ],
      },
      done: {},
    },
  });
  const state = machine.transition(machine.initialState, 'RUN');
  assert.equal(state.value, 'done');
  assert.equal(state.context.n, 500);
});

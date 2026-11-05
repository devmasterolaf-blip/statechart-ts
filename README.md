# statechart-ts

A small statechart (hierarchical finite-state machine) library for TypeScript
with no runtime dependencies.

You describe a machine as a plain object: states, events, transitions, guards,
actions and an extended context. The library checks the definition, computes
state changes as pure functions, and offers a small interpreter that runs the
machine, queues events and drives delayed transitions through a clock you can
replace in tests.

Version 0.1.0. This is a young project: the API may still change, and the
[limitations](#limitations) section lists what it does not do.

## Features

- Typed definitions: `createMachine<Context, Event>()`; inside `on` the event
  passed to guards and actions is narrowed to the event of that key.
- Nested (compound) states with exit and entry actions in the order the SCXML
  algorithm prescribes, internal and external transitions, targetless
  transitions.
- Parallel regions, final states and `onDone` transitions.
- Shallow and deep history states.
- Guards as functions, named references or `not` / `and` / `or` / `stateIn`
  combinators.
- Eventless (`always`) transitions and raised internal events, handled within
  the same macrostep (run-to-completion).
- Delayed (`after`) transitions driven by an injectable `Clock`; a
  `SimulatedClock` is included.
- A `Service` with `send`, `subscribe`, `onDone`, `onError` and an event queue.
- Validation that collects every problem instead of stopping at the first:
  unknown targets, missing or unknown initial states, duplicate ids, invalid
  history states, shadowed transitions, unreachable states and more.
- Persisting a running service to JSON (state, history and pending timers) and
  resuming from it.
- Export of a machine as Mermaid (`stateDiagram-v2`) or Graphviz DOT text.
- A JSON loader with shape checks and a `statechart` command that validates a
  JSON machine file and prints its diagram.

## Install and build

The package is not published to npm. Build it from the source tree; you need
Node.js 20 or newer.

```sh
npm install
npm run build   # compiles src/ and test/ to dist/
npm test        # builds, then runs the tests with node:test
```

To use it from another project, point that project at the built checkout, for
example with `npm install ../statechart-ts`. The entry point is
`dist/src/index.js` with type declarations next to it. The output is CommonJS.

## Usage

The snippets below were compiled and run against this version; the comments
show the real output.

### A first machine

```ts
import { assign, createMachine, interpret } from 'statechart-ts';

type Ctx = { opened: number };
type Ev =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'LOCK'; code: string }
  | { type: 'UNLOCK'; code: string };

const door = createMachine<Ctx, Ev>({
  id: 'door',
  context: { opened: 0 },
  initial: 'closed',
  states: {
    closed: {
      on: {
        OPEN: { target: 'open', actions: assign({ opened: (ctx) => ctx.opened + 1 }) },
        // `event` is narrowed to the LOCK event here, so `event.code` type-checks.
        LOCK: { target: 'locked', guard: (_ctx, event) => event.code.length === 4 },
      },
    },
    open: { on: { CLOSE: 'closed' } },
    locked: { on: { UNLOCK: 'closed' } },
  },
});

const service = interpret(door);
service.subscribe((state) => console.log(state.value, state.context.opened));
service.start(); //                              closed 0
service.send('OPEN'); //                         open 1
service.send('CLOSE'); //                        closed 1
service.send({ type: 'LOCK', code: '12' }); //   closed 1   (guard failed, state.changed is false)
service.send({ type: 'LOCK', code: '1234' }); // locked 1
```

The machine itself is pure. `machine.transition(state, event)` returns a new
immutable `State` and never runs an action; the side effects to run are listed
in `state.effects`, which is what the service executes.

```ts
const next = door.transition(door.initialState, 'OPEN');
console.log(next.value, next.changed); // open true
```

### Nested states, parallel regions and history

```ts
import { createMachine, interpret } from 'statechart-ts';

const player = createMachine({
  id: 'player',
  initial: 'stopped',
  states: {
    stopped: { on: { PLAY: 'active' } },
    active: {
      type: 'parallel',
      on: { STOP: 'stopped', RESUME: 'active.playback.memory' },
      states: {
        playback: {
          initial: 'playing',
          states: {
            playing: { on: { PAUSE: 'paused' } },
            paused: { on: { PLAY: 'playing' } },
            memory: { type: 'history', history: 'shallow', target: 'playing' },
          },
        },
        volume: {
          initial: 'normal',
          states: {
            normal: { on: { MUTE: 'muted' } },
            muted: { on: { MUTE: 'normal' } },
          },
        },
      },
    },
  },
});

const service = interpret(player).start();
service.send('PLAY');
service.getSnapshot().value; // { active: { playback: 'playing', volume: 'normal' } }
service.send('PAUSE');
service.send('MUTE');
service.getSnapshot().value; // { active: { playback: 'paused', volume: 'muted' } }
service.getSnapshot().matches('active.volume.muted'); // true
```

Targets are resolved like this:

| Written as        | Means                                            |
| ----------------- | ------------------------------------------------ |
| `'sibling'`       | a sibling of the source state                    |
| `'sibling.child'` | a descendant of a sibling                        |
| `'.child'`        | a descendant of the source (internal by default) |
| `'#id'`           | the state with that id, anywhere in the machine  |

A state's id is its dotted path from the root (`player.active.volume`) unless
the definition gives it an `id` of its own.

### Delayed transitions and the clock

```ts
import { SimulatedClock, createMachine, interpret } from 'statechart-ts';

const light = createMachine(
  {
    id: 'light',
    initial: 'green',
    states: {
      green: { after: { 30000: 'yellow' } },
      yellow: { after: { 4000: 'red' } },
      red: { after: { RED_TIME: 'green' } },
    },
  },
  { delays: { RED_TIME: 20000 } },
);

const clock = new SimulatedClock();
const service = interpret(light, { clock }).start();
clock.advance(30000);
service.getSnapshot().value; // 'yellow'
clock.advance(4000);
service.getSnapshot().value; // 'red'
clock.advance(20000);
service.getSnapshot().value; // 'green'
```

Without the `clock` option a service uses `SystemClock` (`Date.now` and the
global timers). Any object with `now`, `setTimeout` and `clearTimeout` works.

### Persist and resume

Continuing with the traffic light from above:

```ts
clock.advance(12000); // 12 s into green
const saved = JSON.stringify(service.persist());
service.stop();

// Later, possibly in another process:
const clock2 = new SimulatedClock();
const resumed = interpret(light, { clock: clock2, snapshot: JSON.parse(saved) }).start();
clock2.advance(18000); // the 18 s that were left
resumed.getSnapshot().value; // 'yellow'
```

A snapshot holds the state value, the context, recorded history and the
pending timers with their remaining time. Entry actions are not run again on
resume. The context is stored as it is, so it has to be JSON-compatible. A
snapshot that does not fit the machine is rejected with a `RestoreError`.

`state.toJSON()` and `machine.restoreState()` do the same for a bare state
without timers.

### Validation

`createMachine` throws an `InvalidMachineError` that lists every structural
error. `validateMachine` returns the same findings without throwing and adds
warnings for shadowed transitions and unreachable states.

```ts
import { InvalidMachineError, createMachine, formatIssues, validateMachine } from 'statechart-ts';

const config = {
  id: 'job',
  initial: 'idle',
  states: {
    idle: { on: { START: 'runing' } },
    running: { on: { FINISH: 'finished' } },
    finished: { type: 'final' as const },
  },
};

console.log(formatIssues(validateMachine(config)));
// error [unknown-target] idle: Target "runing" of the transition on "START" does not exist.

try {
  createMachine(config);
} catch (error) {
  if (error instanceof InvalidMachineError) {
    console.log(error.code, error.issues.map((issue) => issue.code));
    // invalid-machine [ 'unknown-target' ]
  }
}
```

Each issue has a `code`, a `severity` (`error` or `warning`), a `message` and
the `path` of the state it belongs to. Unreachable states are only looked for
when the definition has no errors. Pass `{ implementations }` to
`validateMachine` to also check that every guard, action and delay name used
in the definition has an implementation.

Every error the library throws extends `StatechartError` and has a stable
`code`:

| Class                        | `code`                    | Thrown when                                          |
| ---------------------------- | ------------------------- | ---------------------------------------------------- |
| `InvalidMachineError`        | `invalid-machine`         | the definition has structural errors                 |
| `MissingImplementationError` | `missing-implementation`  | a named guard, action or delay has no implementation |
| `GuardEvaluationError`       | `guard-failed`            | a guard function throws                              |
| `ActionExecutionError`       | `action-failed`           | an action throws while a service runs it             |
| `InvalidDelayError`          | `invalid-delay`           | a delay is not a finite number >= 0                  |
| `MacrostepLimitError`        | `macrostep-limit`         | one event causes more than 1000 microsteps           |
| `RestoreError`               | `invalid-snapshot`        | a persisted state does not fit the machine           |
| `ServiceStateError`          | `invalid-service-state`   | a service method is called in the wrong status       |
| `ConfigParseError`           | `invalid-config`          | a JSON definition is malformed                       |
| `ClockError`                 | `invalid-clock-operation` | a `SimulatedClock` method gets a bad argument        |

Errors from guards, actions and listeners inside a service go to `onError`
listeners. Without one, the first error of a run is rethrown from `send()` or
`start()` once the queue is empty.

### Machines from JSON

A definition that refers to guards and actions by name is plain JSON.
`parseMachineConfig` parses the text and checks its shape; problems are
reported with their place in the document.

```ts
import { readFileSync } from 'node:fs';
import {
  SimulatedClock,
  assign,
  createMachine,
  interpret,
  parseMachineConfig,
  type EventObject,
  type MachineConfig,
} from 'statechart-ts';

type Ctx = { cycles: number };

const text = readFileSync('examples/traffic-light.json', 'utf8');
const config = parseMachineConfig(text) as MachineConfig<Ctx, EventObject>;
const machine = createMachine(config, {
  guards: { minGreenElapsed: () => true },
  actions: {
    countCycle: assign<Ctx>({ cycles: (ctx) => ctx.cycles + 1 }),
    startFlashing: () => console.log('flashing on'),
    stopFlashing: () => console.log('flashing off'),
  },
  delays: { RED_TIME: 20000 },
});

const clock = new SimulatedClock();
const service = interpret(machine, { clock }).start();
service.send('PEDESTRIAN');
clock.advance(4000);
service.getSnapshot().value; // { working: 'red' }
service.getSnapshot().context.cycles; // 1
```

In JSON, guards are names or `{ "type": "not" | "and" | "or" | "in", ... }`
objects, and actions are names or `{ "type": "raise", "event": ... }` /
`{ "type": "assign", "assignment": { ... } }` objects with constant values.

### Diagrams

```ts
import { toDot, toMermaid } from 'statechart-ts';

console.log(toMermaid(door)); // the door machine from the first example
```

```
stateDiagram-v2
    [*] --> closed
    state "closed" as closed
    state "open" as open
    state "locked" as locked
    closed --> open : OPEN / assign
    closed --> locked : LOCK [guard]
    open --> closed : CLOSE
    locked --> closed : UNLOCK
```

Labels read `TRIGGER [guard] / actions`. Named guards and actions show their
name; a function shows its function name, which for an arrow function written
in place is just the property it sits in (`guard` above).

`toDot(machine, { direction: 'LR' })` produces Graphviz text with clusters for
compound and parallel states. Both functions take `{ direction, actions }`;
`actions: false` leaves entry, exit and transition actions out of the labels.

### Command line

```sh
node dist/src/cli.js examples/traffic-light.json
```

```
examples/traffic-light.json: valid (5 state(s), 6 transition(s), 0 warning(s))
stateDiagram-v2
    [*] --> working
    state "working" as working {
        [*] --> working_green
        state "green" as working_green
        state "yellow" as working_yellow
        state "red" as working_red
        working_red : entry / countCycle
        working_green --> working_yellow : PEDESTRIAN [minGreenElapsed]
        working_green --> working_yellow : after 30000ms
        working_yellow --> working_red : after 4000ms
        working_red --> working_green : after RED_TIME
    }
    state "flashing" as flashing
    flashing : entry / startFlashing
    flashing : exit / stopFlashing
    working --> flashing : POWER_OUT
    flashing --> working : POWER_BACK
```

The diagram goes to standard output; issues and the summary line go to
standard error, so the diagram can be redirected to a file on its own.

```
Usage: statechart [options] <machine.json>

Options:
  -f, --format <mermaid|dot|none>  diagram to print (default: mermaid)
  -d, --direction <TB|LR>          layout direction of the diagram
      --no-actions                 leave actions out of the diagram
      --strict                     treat warnings as errors
  -h, --help                       show this help
  -v, --version                    show the version

Exit codes: 0 valid, 1 invalid definition, 2 bad usage or unreadable file.
```

`examples/broken.json` is invalid on purpose:

```sh
node dist/src/cli.js --format none examples/broken.json
```

```
error [missing-initial] (root): Compound state has no "initial" child.
error [unknown-target] idle: Target "runing" of the transition on "START" does not exist.
warning [shadowed-transition] running: A transition on "STOP" follows an unguarded one for the same event and can never be taken.
examples/broken.json: invalid (2 error(s), 1 warning(s))
```

When the package is installed as a dependency the same program is available
as `statechart`.

## How a step works

An event is handled as one macrostep:

1. For every active leaf state, the first enabled transition for the event is
   taken from the leaf or its nearest ancestor that has one. Transitions in the
   same state are tried in the order they are written.
2. Transitions selected in different parallel regions are all taken unless
   they would exit the same state; then the one found first in document order
   wins.
3. States are exited innermost first (reverse document order), transition
   actions run, then states are entered outermost first. History is recorded
   on exit.
4. Eventless transitions and raised events are handled until nothing is left.
   Only then does the service look at the next external event.

`assign` actions are applied while the step is computed, in order, so a later
action in the same step sees the updated context. Other actions are collected
as effects, each with the context and event it should be called with.

## Limitations

- No invoked actors, child machines or promises; a machine only reacts to the
  events it is sent.
- No wildcard event (`*`) and no event-name patterns.
- No delayed `send` or `cancel` actions; the only timers are `after`
  transitions.
- The limit of 1000 microsteps per event is fixed.
- When a service stops, or the machine reaches a top-level final state, the
  exit actions of the states that are still active are not run.
- `Service.persist()` does not include events that are still waiting in the
  queue; call it between events, not from an action.
- Persisting covers JSON-compatible contexts only.
- Mermaid has no notation for history states, so they are drawn as ordinary
  states labelled `H` (shallow) or `H*` (deep). State names that Mermaid
  itself treats specially have not been checked.
- The DOT output has been checked as text only; it was not rendered with
  Graphviz while this version was written.
- CommonJS output only.

## Project layout

```
src/
  index.ts          public entry point
  types.ts          definition types (states, transitions, guards, actions)
  node.ts           builds and checks the state tree from a definition
  step.ts           the transition algorithm (selection, exit, entry, history)
  machine.ts        Machine: initialState, transition, restoreState
  state.ts          State snapshot and effect types
  actions.ts        assign and raise
  guards.ts         guard combinators and evaluation
  interpreter.ts    Service: queue, subscriptions, timers, persist
  clock.ts          Clock, SystemClock, SimulatedClock
  validate.ts       validateMachine, assertValidMachine, formatIssues
  reachability.ts   reachable-state analysis used by validation
  serialize.ts      persisted state format and its checks
  json.ts           JSON definition loader
  errors.ts         error classes and issue types
  util.ts           small shared helpers
  cli.ts            the statechart command
  export/           Mermaid and DOT writers
test/               node:test suites, one file per area, plus integration tests
examples/           JSON machine files used by the tests and the CLI
```

## Running the tests

```sh
npm test
```

This compiles everything with `tsc` and runs `node --test` on the compiled
files in `dist/test`. To run one file after a build:

```sh
npm run build
node --test dist/test/history.test.js
```

The CLI tests start the compiled program as a child process, so they need the
build that `npm test` makes.

## License

MIT, see [LICENSE](LICENSE).

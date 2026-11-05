# Changelog

Notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-05

First version.

### Added

- Machine definitions as plain objects with typed context and events
  (`createMachine`), named or inline guards and actions, `assign` and `raise`.
- Compound, parallel, final and history (shallow and deep) states; internal,
  external and targetless transitions; eventless (`always`) transitions;
  `onDone` transitions.
- Pure `Machine.initialState` and `Machine.transition`, returning immutable
  `State` snapshots with the effects of the step.
- Guard combinators `not`, `and`, `or` and `stateIn`.
- `Service` (`interpret`) with an event queue, run-to-completion processing,
  `subscribe`, `onDone` and `onError`.
- Delayed (`after`) transitions with fixed or named delays, driven by a
  `Clock`; `SystemClock` and `SimulatedClock`.
- Validation: issues with codes and severities, `validateMachine`,
  `assertValidMachine`, `formatIssues`; warnings for shadowed transitions and
  unreachable states; optional check of implementation names.
- Typed errors, all extending `StatechartError`.
- Persistence: `State.toJSON`, `Machine.restoreState`, `Service.persist` and
  the `snapshot` option of `interpret`, including pending timers.
- Diagram export: `toMermaid` and `toDot`.
- JSON definitions: `parseMachineConfig` and `checkMachineConfig`.
- The `statechart` command, which validates a JSON machine file and prints
  its diagram.

### Fixed

Found by tests while this version was being written:

- A final state used directly as a region of a parallel state completed the
  parallel state at once; it is now reported as an `invalid-structure` error.
- An action that stopped the service could leave a timer of the same step
  pending on the clock.

# Contributing

Thanks for taking a look. This is a small project, so the process is light.

## Setup

You need Node.js 20 or newer.

```sh
npm install
npm test
```

`npm test` compiles `src/` and `test/` with `tsc` into `dist/` and runs the
compiled tests with `node --test`. There is no watch mode and no separate lint
step; the TypeScript compiler runs in strict mode and has to pass without
errors.

## Making a change

- Keep the library free of runtime dependencies. `typescript` and
  `@types/node` are the only development dependencies.
- Add or update tests with every behaviour change. Tests live in `test/`, one
  file per area (`history.test.ts`, `parallel.test.ts`, ...). A bug fix should
  come with a test that fails without the fix.
- Tests that involve time use `SimulatedClock`; do not wait on real timers.
- Everything the library throws on purpose extends `StatechartError` and has a
  stable `code`. Problems in a definition are reported as issues (see
  `src/errors.ts`) so that all of them can be listed at once.
- `Machine` stays pure: `transition()` must not run actions or touch timers.
  Side effects belong in the effect list that `Service` executes.
- Public API is whatever `src/index.ts` exports. Mention API changes in
  `CHANGELOG.md` under "Unreleased".
- Update the README when behaviour described there changes. Its examples are
  meant to be real: run them before you change their output.

## Where things are

The "Project layout" section of the README lists the modules. The transition
algorithm is in `src/step.ts`; the definition checks are split between
`src/node.ts` (while the state tree is built) and `src/validate.ts` (checks
over the finished tree).

## Commits

Use short conventional subjects (`feat:`, `fix:`, `test:`, `docs:`,
`refactor:`, `chore:`), optionally with a scope, for example
`fix(history): ...`. One logical change per commit, with the build and the
tests passing.

## Reporting a problem

Please include the machine definition (as small as you can make it), the
events you sent and what you expected to happen. For a definition in JSON, the
output of `node dist/src/cli.js --format none <file>` helps too.

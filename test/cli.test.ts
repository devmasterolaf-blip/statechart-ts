import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, USAGE, runCli } from '../src/cli';

const repoRoot = join(__dirname, '..', '..');

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process against an in-memory file system. */
function run(argv: string[], files: { [path: string]: string } = {}): Run {
  let out = '';
  let err = '';
  const code = runCli(
    argv,
    {
      readFile: (path) => {
        if (!Object.hasOwn(files, path)) {
          throw new Error(`ENOENT: no such file, open '${path}'`);
        }
        return files[path];
      },
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    '9.9.9',
  );
  return { code, out, err };
}

const toggle = JSON.stringify({
  id: 'toggle',
  initial: 'off',
  states: { off: { on: { FLIP: { target: 'on', actions: 'click' } } }, on: { on: { FLIP: 'off' } } },
});

const warned = JSON.stringify({ initial: 'a', states: { a: {}, orphan: {} } });

test('prints a Mermaid diagram by default and a summary on stderr', () => {
  const result = run(['toggle.json'], { 'toggle.json': toggle });
  assert.equal(result.code, EXIT_OK);
  assert.equal(
    result.out,
    [
      'stateDiagram-v2',
      '    [*] --> off',
      '    state "off" as off',
      '    state "on" as on',
      '    off --> on : FLIP / click',
      '    on --> off : FLIP',
      '',
    ].join('\n'),
  );
  assert.equal(result.err, 'toggle.json: valid (2 state(s), 2 transition(s), 0 warning(s))\n');
});

test('--format dot, --direction and --no-actions shape the diagram', () => {
  const result = run(['-f', 'dot', '--direction', 'LR', '--no-actions', 'toggle.json'], { 'toggle.json': toggle });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.out, /^digraph "toggle" \{\n {2}compound=true;\n {2}rankdir=LR;/);
  assert.match(result.out, /"toggle.off" -> "toggle.on" \[label="FLIP"\];/);
});

test('--format none only validates', () => {
  const result = run(['toggle.json', '--format', 'none'], { 'toggle.json': toggle });
  assert.deepEqual([result.code, result.out], [EXIT_OK, '']);
  assert.match(result.err, /valid/);
});

test('warnings are printed but do not fail unless --strict is given', () => {
  const lenient = run(['m.json'], { 'm.json': warned });
  assert.equal(lenient.code, EXIT_OK);
  assert.match(lenient.err, /^warning \[unreachable-state\] orphan: /);
  assert.match(lenient.err, /m\.json: valid \(2 state\(s\), 0 transition\(s\), 1 warning\(s\)\)\n$/);
  assert.match(lenient.out, /^stateDiagram-v2/);

  const strict = run(['--strict', 'm.json'], { 'm.json': warned });
  assert.equal(strict.code, EXIT_INVALID);
  assert.equal(strict.out, '');
  assert.match(strict.err, /m\.json: invalid \(0 error\(s\), 1 warning\(s\)\)\n$/);
});

test('definition errors are listed and exit with 1', () => {
  const result = run(['m.json'], { 'm.json': JSON.stringify({ states: { a: { on: { GO: 'b' } } } }) });
  assert.equal(result.code, EXIT_INVALID);
  assert.equal(result.out, '');
  assert.equal(
    result.err,
    'error [missing-initial] (root): Compound state has no "initial" child.\n' +
      'error [unknown-target] a: Target "b" of the transition on "GO" does not exist.\n' +
      'm.json: invalid (2 error(s), 0 warning(s))\n',
  );
});

test('malformed files are reported with the path of each problem', () => {
  const notJson = run(['m.json'], { 'm.json': '{ nope' });
  assert.equal(notJson.code, EXIT_INVALID);
  assert.match(notJson.err, /^m\.json: Invalid machine definition file \(1 problem\(s\)\):\n {2}- \(document\): Not valid JSON/);

  const badShape = run(['m.json'], { 'm.json': JSON.stringify({ initial: 'a', states: { a: { on: { GO: 7 } } } }) });
  assert.equal(badShape.code, EXIT_INVALID);
  assert.match(badShape.err, / {2}- states\.a\.on\.GO: A transition must be a target string or an object, got a number\./);
});

test('usage problems exit with 2 and show the usage text', () => {
  const cases: [string[], RegExp][] = [
    [[], /^No machine file given\./],
    [['--wat', 'm.json'], /^Unknown option "--wat"\./],
    [['a.json', 'b.json'], /^Only one machine file can be given\./],
    [['--format'], /^Option --format needs a value\./],
    [['--format', 'png', 'm.json'], /^Unknown format "png"/],
    [['-d', 'RL', 'm.json'], /^Unknown direction "RL"/],
  ];
  for (const [argv, pattern] of cases) {
    const result = run(argv, { 'm.json': toggle });
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.err, pattern);
    assert.ok(result.err.endsWith(USAGE));
    assert.equal(result.out, '');
  }
});

test('an unreadable file exits with 2', () => {
  const result = run(['missing.json']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /^Cannot read missing\.json: ENOENT/);
});

test('--help and --version print to stdout', () => {
  assert.deepEqual(run(['--help']), { code: EXIT_OK, out: USAGE, err: '' });
  assert.deepEqual(run(['-v']), { code: EXIT_OK, out: '9.9.9\n', err: '' });
});

// ---------------------------------------------------------------------------
// The compiled executable against the files in examples/
// ---------------------------------------------------------------------------

function spawnCli(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('executable: the valid examples produce diagrams', () => {
  const light = spawnCli(join('examples', 'traffic-light.json'));
  assert.equal(light.status, 0);
  assert.match(light.stdout, /^stateDiagram-v2\n/);
  assert.match(light.stdout, /working_green --> working_yellow : after 30000ms/);
  assert.match(light.stderr, /valid \(5 state\(s\), 6 transition\(s\), 0 warning\(s\)\)/);

  const player = spawnCli('--format', 'dot', join('examples', 'media-player.json'));
  assert.equal(player.status, 0);
  assert.match(player.stdout, /^digraph "player" \{/);
  assert.match(player.stdout, /"player\.active\.memory" \[shape=circle, label="H\*"\];/);
});

test('executable: the broken example fails with its issues', () => {
  const result = spawnCli(join('examples', 'broken.json'));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /error \[missing-initial\] \(root\)/);
  assert.match(result.stderr, /error \[unknown-target\] idle: Target "runing"/);
  assert.match(result.stderr, /warning \[shadowed-transition\] running/);
});

test('executable: version comes from package.json and a missing file exits with 2', () => {
  const version = spawnCli('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  const missing = spawnCli('no-such-file.json');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^Cannot read no-such-file\.json: /);
});

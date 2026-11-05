#!/usr/bin/env node
/**
 * Command line tool: validates a machine definition stored as JSON and
 * prints it as a diagram.
 *
 * The diagram goes to stdout, everything else (issues, summary) to stderr,
 * so the output can be piped straight into a file or a renderer.
 */

import { readFileSync } from 'node:fs';
import { toDot } from './export/dot';
import type { DiagramOptions } from './export/labels';
import { toMermaid } from './export/mermaid';
import { ConfigParseError, parseMachineConfig } from './json';
import { createMachine } from './machine';
import { formatIssues, validateMachine } from './validate';

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: statechart [options] <machine.json>

Validates a machine definition and prints it as a diagram.

Options:
  -f, --format <mermaid|dot|none>  diagram to print (default: mermaid)
  -d, --direction <TB|LR>          layout direction of the diagram
      --no-actions                 leave actions out of the diagram
      --strict                     treat warnings as errors
  -h, --help                       show this help
  -v, --version                    show the version

Exit codes: 0 valid, 1 invalid definition, 2 bad usage or unreadable file.
`;

/** Everything the tool touches outside of its own logic. */
export interface CliIO {
  readFile(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

type Format = 'mermaid' | 'dot' | 'none';

interface CliArguments {
  file: string | undefined;
  format: Format;
  direction: DiagramOptions['direction'];
  actions: boolean;
  strict: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArguments(argv: readonly string[]): CliArguments {
  const result: CliArguments = {
    file: undefined,
    format: 'mermaid',
    direction: undefined,
    actions: true,
    strict: false,
    help: false,
    version: false,
  };
  const valueOf = (index: number, option: string): string => {
    const value = argv[index];
    if (value === undefined) {
      throw new UsageError(`Option ${option} needs a value.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-v':
      case '--version':
        result.version = true;
        break;
      case '--strict':
        result.strict = true;
        break;
      case '--no-actions':
        result.actions = false;
        break;
      case '-f':
      case '--format': {
        const value = valueOf(++index, argument);
        if (value !== 'mermaid' && value !== 'dot' && value !== 'none') {
          throw new UsageError(`Unknown format "${value}"; expected mermaid, dot or none.`);
        }
        result.format = value;
        break;
      }
      case '-d':
      case '--direction': {
        const value = valueOf(++index, argument);
        if (value !== 'TB' && value !== 'LR') {
          throw new UsageError(`Unknown direction "${value}"; expected TB or LR.`);
        }
        result.direction = value;
        break;
      }
      default:
        if (argument.startsWith('-')) {
          throw new UsageError(`Unknown option "${argument}".`);
        }
        if (result.file !== undefined) {
          throw new UsageError('Only one machine file can be given.');
        }
        result.file = argument;
    }
  }
  return result;
}

/**
 * Runs the tool and returns its exit code. `version` is passed in so that
 * this module does not depend on the library entry point.
 */
export function runCli(argv: readonly string[], io: CliIO, version: string): number {
  let args: CliArguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (args.version) {
    io.stdout(`${version}\n`);
    return EXIT_OK;
  }
  if (args.file === undefined) {
    io.stderr(`No machine file given.\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  let text: string;
  try {
    text = io.readFile(args.file);
  } catch (error) {
    io.stderr(`Cannot read ${args.file}: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  let config;
  try {
    config = parseMachineConfig(text);
  } catch (error) {
    if (!(error instanceof ConfigParseError)) {
      throw error;
    }
    io.stderr(`${args.file}: ${error.message}\n`);
    return EXIT_INVALID;
  }

  const issues = validateMachine(config);
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  if (issues.length > 0) {
    io.stderr(`${formatIssues(issues)}\n`);
  }
  if (errors > 0 || (args.strict && warnings > 0)) {
    io.stderr(`${args.file}: invalid (${errors} error(s), ${warnings} warning(s))\n`);
    return EXIT_INVALID;
  }

  const machine = createMachine(config);
  const transitions = machine.nodes.reduce((count, node) => count + node.transitions.length, 0);
  io.stderr(
    `${args.file}: valid (${machine.nodes.length - 1} state(s), ${transitions} transition(s), ${warnings} warning(s))\n`,
  );
  const options: DiagramOptions = { direction: args.direction, actions: args.actions };
  if (args.format === 'mermaid') {
    io.stdout(toMermaid(machine, options));
  } else if (args.format === 'dot') {
    io.stdout(toDot(machine, options));
  }
  return EXIT_OK;
}

if (require.main === module) {
  // Read lazily so that importing this module never touches package.json.
  const { version } = JSON.parse(readFileSync(`${__dirname}/../../package.json`, 'utf8')) as { version: string };
  process.exitCode = runCli(
    process.argv.slice(2),
    {
      readFile: (path) => readFileSync(path, 'utf8'),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    version,
  );
}

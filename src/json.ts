/**
 * Loading definitions from JSON. A definition written by hand or produced by
 * another tool is checked shape-first, so that a typo is reported with the
 * place where it is instead of surfacing later as a confusing type error.
 *
 * Only the shape is checked here (types of fields, known keys). Whether
 * targets exist and the like is the job of validateMachine().
 */

import { StatechartError } from './errors';
import type { EventObject, MachineConfig } from './types';

export interface ConfigProblem {
  /** Where in the document, e.g. `states.idle.on.GO[1].target`; empty for the document itself. */
  path: string;
  message: string;
}

/** The JSON text is not a well-formed machine definition. */
export class ConfigParseError extends StatechartError {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const lines = problems.map((problem) => `  - ${problem.path || '(document)'}: ${problem.message}`);
    super('invalid-config', `Invalid machine definition file (${problems.length} problem(s)):\n${lines.join('\n')}`);
    this.problems = problems;
  }
}

/** A definition as it can be written in JSON: guards and actions by name. */
export type JsonMachineConfig = MachineConfig<unknown, EventObject>;

const STATE_KEYS = [
  'id',
  'type',
  'initial',
  'states',
  'on',
  'always',
  'after',
  'onDone',
  'entry',
  'exit',
  'history',
  'target',
  'description',
];
const TRANSITION_KEYS = ['target', 'guard', 'actions', 'internal', 'description'];
const STATE_TYPES = ['atomic', 'compound', 'parallel', 'final', 'history'];

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

function join(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

class Checker {
  readonly problems: ConfigProblem[] = [];

  private problem(path: string, message: string): void {
    this.problems.push({ path, message });
  }

  private unknownKeys(value: Json, allowed: readonly string[], path: string, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.problem(join(path, key), `Unknown ${what} property "${key}".`);
      }
    }
  }

  private optionalString(value: Json, key: string, path: string): void {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      this.problem(join(path, key), `Expected a string, got ${describe(value[key])}.`);
    }
  }

  state(value: unknown, path: string, isRoot: boolean): void {
    if (!isObject(value)) {
      this.problem(path, `A state must be an object, got ${describe(value)}.`);
      return;
    }
    this.unknownKeys(value, isRoot ? [...STATE_KEYS, 'context'] : STATE_KEYS, path, 'state');
    for (const key of ['id', 'initial', 'target', 'description']) {
      this.optionalString(value, key, path);
    }
    if (value.type !== undefined && !STATE_TYPES.includes(value.type as string)) {
      this.problem(join(path, 'type'), `Expected one of ${STATE_TYPES.join(', ')}.`);
    }
    if (value.history !== undefined && value.history !== 'shallow' && value.history !== 'deep') {
      this.problem(join(path, 'history'), 'Expected "shallow" or "deep".');
    }
    if (value.states !== undefined) {
      const statesPath = join(path, 'states');
      if (!isObject(value.states)) {
        this.problem(statesPath, `Expected an object keyed by state, got ${describe(value.states)}.`);
      } else {
        for (const [key, child] of Object.entries(value.states)) {
          this.state(child, join(statesPath, key), false);
        }
      }
    }
    for (const key of ['on', 'after']) {
      const mapPath = join(path, key);
      const map = value[key];
      if (map === undefined) {
        continue;
      }
      if (!isObject(map)) {
        this.problem(mapPath, `Expected an object, got ${describe(map)}.`);
        continue;
      }
      for (const [name, transitions] of Object.entries(map)) {
        this.transitions(transitions, join(mapPath, name));
      }
    }
    for (const key of ['always', 'onDone']) {
      if (value[key] !== undefined) {
        this.transitions(value[key], join(path, key));
      }
    }
    for (const key of ['entry', 'exit']) {
      if (value[key] !== undefined) {
        this.actions(value[key], join(path, key));
      }
    }
  }

  private transitions(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.transition(item, `${path}[${index}]`));
    } else {
      this.transition(value, path);
    }
  }

  private transition(value: unknown, path: string): void {
    if (typeof value === 'string') {
      return;
    }
    if (!isObject(value)) {
      this.problem(path, `A transition must be a target string or an object, got ${describe(value)}.`);
      return;
    }
    this.unknownKeys(value, TRANSITION_KEYS, path, 'transition');
    this.optionalString(value, 'description', path);
    const { target } = value;
    const targetOk =
      target === undefined ||
      typeof target === 'string' ||
      (Array.isArray(target) && target.every((item) => typeof item === 'string'));
    if (!targetOk) {
      this.problem(join(path, 'target'), 'Expected a string or an array of strings.');
    }
    if (value.internal !== undefined && typeof value.internal !== 'boolean') {
      this.problem(join(path, 'internal'), `Expected a boolean, got ${describe(value.internal)}.`);
    }
    if (value.guard !== undefined) {
      this.guard(value.guard, join(path, 'guard'));
    }
    if (value.actions !== undefined) {
      this.actions(value.actions, join(path, 'actions'));
    }
  }

  private guard(value: unknown, path: string): void {
    if (typeof value === 'string') {
      return;
    }
    if (!isObject(value)) {
      this.problem(path, `A guard must be a name or a combinator object, got ${describe(value)}.`);
      return;
    }
    switch (value.type) {
      case 'not':
        this.guard(value.guard, join(path, 'guard'));
        break;
      case 'and':
      case 'or':
        if (!Array.isArray(value.guards)) {
          this.problem(join(path, 'guards'), `Expected an array of guards, got ${describe(value.guards)}.`);
        } else {
          value.guards.forEach((item, index) => this.guard(item, `${join(path, 'guards')}[${index}]`));
        }
        break;
      case 'in':
        if (typeof value.state !== 'string') {
          this.problem(join(path, 'state'), `Expected a state id, got ${describe(value.state)}.`);
        }
        break;
      default:
        this.problem(join(path, 'type'), 'Expected one of not, and, or, in.');
    }
  }

  private actions(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.action(item, `${path}[${index}]`));
    } else {
      this.action(value, path);
    }
  }

  private action(value: unknown, path: string): void {
    if (typeof value === 'string') {
      return;
    }
    if (!isObject(value)) {
      this.problem(path, `An action must be a name or an action object, got ${describe(value)}.`);
      return;
    }
    if (value.type === 'raise') {
      if (!isObject(value.event) || typeof value.event.type !== 'string') {
        this.problem(join(path, 'event'), 'Expected an event object with a string "type".');
      }
    } else if (value.type === 'assign') {
      if (!isObject(value.assignment)) {
        this.problem(join(path, 'assignment'), `Expected an object of values, got ${describe(value.assignment)}.`);
      }
    } else {
      this.problem(join(path, 'type'), 'Expected "raise" or "assign".');
    }
  }
}

/**
 * Checks that an already parsed value has the shape of a machine definition
 * and returns it typed.
 *
 * @throws ConfigParseError listing every problem found.
 */
export function checkMachineConfig(value: unknown): JsonMachineConfig {
  const checker = new Checker();
  checker.state(value, '', true);
  if (checker.problems.length > 0) {
    throw new ConfigParseError(checker.problems);
  }
  return value as JsonMachineConfig;
}

/**
 * Parses JSON text into a machine definition.
 *
 * @throws ConfigParseError when the text is not JSON or not a definition.
 */
export function parseMachineConfig(text: string): JsonMachineConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError([{ path: '', message: `Not valid JSON: ${(error as Error).message}` }]);
  }
  return checkMachineConfig(value);
}

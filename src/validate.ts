/**
 * Definition validation. buildTree() already reports structural problems;
 * this module adds checks that look at the definition as a whole and offers
 * one entry point that returns every finding without throwing.
 */

import { InvalidMachineError, type Issue, type IssueCode, type IssueSeverity } from './errors';
import { ALWAYS_EVENT, buildTree, type MachineTree, type StateNode } from './node';
import type { ActionConfig, EventObject, GuardConfig, Implementations, MachineConfig } from './types';

export interface ValidateOptions<C, E extends EventObject> {
  /**
   * When given, every guard, action and delay name used in the definition
   * must have an implementation here.
   */
  implementations?: Implementations<C, E>;
}

/**
 * Validates a definition and returns all issues, errors and warnings, in the
 * order they were found. An empty array means the definition is clean.
 */
export function validateMachine<C, E extends EventObject>(
  config: MachineConfig<C, E>,
  options: ValidateOptions<C, E> = {},
): Issue[] {
  const tree = buildTree(config);
  const issues = [...tree.issues];
  const report = (code: IssueCode, node: StateNode<C, E>, message: string, severity: IssueSeverity = 'error'): void => {
    issues.push({ code, severity, message, path: node.label });
  };
  for (const node of tree.nodes) {
    checkShadowedTransitions(node, report);
    checkStateReferences(node, tree, report);
    if (options.implementations) {
      checkImplementations(node, options.implementations, report);
    }
  }
  return issues;
}

/**
 * Like validateMachine(), but throws when there is at least one error.
 *
 * @throws InvalidMachineError
 */
export function assertValidMachine<C, E extends EventObject>(
  config: MachineConfig<C, E>,
  options: ValidateOptions<C, E> = {},
): Issue[] {
  const issues = validateMachine(config, options);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new InvalidMachineError(issues);
  }
  return issues;
}

/** One line per issue: `error [code] path: message`. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `${issue.severity} [${issue.code}] ${issue.path}: ${issue.message}`).join('\n');
}

type Report<C, E extends EventObject> = (
  code: IssueCode,
  node: StateNode<C, E>,
  message: string,
  severity?: IssueSeverity,
) => void;

function eventLabel(eventType: string): string {
  return eventType === ALWAYS_EVENT ? 'eventless transition' : `transition on "${eventType}"`;
}

/** A transition after an unguarded one for the same event can never be taken. */
function checkShadowedTransitions<C, E extends EventObject>(node: StateNode<C, E>, report: Report<C, E>): void {
  const unguarded = new Set<string>();
  const reported = new Set<string>();
  for (const transition of node.transitions) {
    const { eventType } = transition;
    if (unguarded.has(eventType)) {
      if (!reported.has(eventType)) {
        reported.add(eventType);
        report(
          'shadowed-transition',
          node,
          `A ${eventLabel(eventType)} follows an unguarded one for the same event and can never be taken.`,
          'warning',
        );
      }
    } else if (transition.guard === undefined) {
      unguarded.add(eventType);
    }
  }
}

function collectGuards<C, E extends EventObject>(
  guard: GuardConfig<C, E> | undefined,
  names: Set<string>,
  stateIds: Set<string>,
): void {
  if (guard === undefined || typeof guard === 'function') {
    return;
  }
  if (typeof guard === 'string') {
    names.add(guard);
    return;
  }
  switch (guard.type) {
    case 'not':
      collectGuards(guard.guard, names, stateIds);
      break;
    case 'and':
    case 'or':
      for (const inner of guard.guards) {
        collectGuards(inner, names, stateIds);
      }
      break;
    case 'in':
      stateIds.add(guard.state);
      break;
  }
}

/** `in` guards must name a state that exists. */
function checkStateReferences<C, E extends EventObject>(
  node: StateNode<C, E>,
  tree: MachineTree<C, E>,
  report: Report<C, E>,
): void {
  const stateIds = new Set<string>();
  for (const transition of node.transitions) {
    collectGuards(transition.guard, new Set(), stateIds);
  }
  for (const stateId of stateIds) {
    if (!tree.byId.has(stateId)) {
      report('unknown-state-reference', node, `An "in" guard refers to the unknown state id "${stateId}".`);
    }
  }
}

function checkImplementations<C, E extends EventObject>(
  node: StateNode<C, E>,
  implementations: Implementations<C, E>,
  report: Report<C, E>,
): void {
  const guards = new Set<string>();
  const actions = new Set<string>();
  const addActions = (list: readonly ActionConfig<C, E>[]): void => {
    for (const action of list) {
      if (typeof action === 'string') {
        actions.add(action);
      }
    }
  };
  addActions(node.entry);
  addActions(node.exit);
  for (const transition of node.transitions) {
    addActions(transition.actions);
    collectGuards(transition.guard, guards, new Set());
  }
  for (const name of guards) {
    if (!Object.hasOwn(implementations.guards ?? {}, name)) {
      report('missing-guard', node, `Guard "${name}" has no implementation.`);
    }
  }
  for (const name of actions) {
    if (!Object.hasOwn(implementations.actions ?? {}, name)) {
      report('missing-action', node, `Action "${name}" has no implementation.`);
    }
  }
  for (const delay of node.delays) {
    if (typeof delay.delay === 'string' && !Object.hasOwn(implementations.delays ?? {}, delay.delay)) {
      report('missing-delay', node, `Delay "${delay.delay}" has no implementation.`);
    }
  }
}

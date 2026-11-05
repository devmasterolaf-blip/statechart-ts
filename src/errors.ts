/**
 * Typed errors. Every error thrown by the library extends StatechartError and
 * carries a stable `code`, so callers can branch without parsing messages.
 */

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'invalid-key'
  | 'duplicate-id'
  | 'missing-initial'
  | 'unknown-initial'
  | 'unknown-target'
  | 'invalid-structure'
  | 'invalid-history'
  | 'invalid-delay'
  | 'shadowed-transition'
  | 'unreachable-state'
  | 'unknown-state-reference'
  | 'missing-guard'
  | 'missing-action'
  | 'missing-delay';

/** One problem found in a machine definition. */
export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** Dotted path of the state the issue belongs to (`(root)` for the root). */
  path: string;
}

export class StatechartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The definition has structural errors; `issues` lists all of them. */
export class InvalidMachineError extends StatechartError {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const errors = issues.filter((issue) => issue.severity === 'error');
    const lines = errors.map((issue) => `  - [${issue.code}] ${issue.path}: ${issue.message}`);
    super('invalid-machine', `Invalid machine definition (${errors.length} error(s)):\n${lines.join('\n')}`);
    this.issues = issues;
  }
}

/** A name used in the definition has no implementation. */
export class MissingImplementationError extends StatechartError {
  readonly kind: 'action' | 'guard' | 'delay';
  readonly implementationName: string;

  constructor(kind: 'action' | 'guard' | 'delay', name: string, stateLabel: string) {
    super('missing-implementation', `No implementation for ${kind} "${name}" (used in state "${stateLabel}").`);
    this.kind = kind;
    this.implementationName = name;
  }
}

/** A guard function threw while a transition was being selected. */
export class GuardEvaluationError extends StatechartError {
  override readonly cause: unknown;

  constructor(guardName: string | undefined, stateLabel: string, eventType: string, cause: unknown) {
    const which = guardName === undefined ? 'An inline guard' : `Guard "${guardName}"`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    super('guard-failed', `${which} of state "${stateLabel}" threw on event "${eventType}": ${reason}`);
    this.cause = cause;
  }
}

/** A delay resolved to something that is not a finite, non-negative number. */
export class InvalidDelayError extends StatechartError {
  constructor(delayKey: string, stateLabel: string, value: unknown) {
    super(
      'invalid-delay',
      `Delay "${delayKey}" of state "${stateLabel}" resolved to ${String(value)}; expected a finite number >= 0.`,
    );
  }
}

/** One event caused more microsteps than allowed, most likely an endless loop. */
export class MacrostepLimitError extends StatechartError {
  readonly limit: number;

  constructor(limit: number, stateLabel: string) {
    super(
      'macrostep-limit',
      `More than ${limit} microsteps for a single event; eventless transitions or raised events ` +
        `probably loop (last transition taken from state "${stateLabel}").`,
    );
    this.limit = limit;
  }
}

/** An action function threw while a service was executing it. */
export class ActionExecutionError extends StatechartError {
  override readonly cause: unknown;
  readonly actionName: string | undefined;

  constructor(actionName: string | undefined, eventType: string, cause: unknown) {
    const which = actionName === undefined ? 'An inline action' : `Action "${actionName}"`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    super('action-failed', `${which} threw while handling event "${eventType}": ${reason}`);
    this.actionName = actionName;
    this.cause = cause;
  }
}

/** A service method was called in a status that does not allow it. */
export class ServiceStateError extends StatechartError {
  constructor(message: string) {
    super('invalid-service-state', message);
  }
}

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
  | 'invalid-delay';

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

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

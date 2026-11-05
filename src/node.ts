/**
 * The state node tree: the definition object turned into linked nodes with
 * ids, document order and resolved initial states.
 *
 * Building never throws on a bad definition. Problems are collected as issues
 * so that a caller can report all of them at once.
 */

import type { Issue, IssueCode, IssueSeverity } from './errors';
import type { EventObject, HistoryKind, MachineConfig, StateKind, StateNodeConfig } from './types';

export const DEFAULT_MACHINE_ID = 'machine';

export class StateNode<C, E extends EventObject> {
  readonly key: string;
  readonly id: string;
  /** Keys from the root down to this node; empty for the root. */
  readonly path: readonly string[];
  readonly kind: StateKind;
  readonly parent: StateNode<C, E> | undefined;
  readonly children: StateNode<C, E>[] = [];
  readonly config: StateNodeConfig<C, E>;
  /** Position in a depth-first, pre-order walk of the tree (document order). */
  order = -1;
  /** Default child of a compound state. */
  initial: StateNode<C, E> | undefined;
  readonly historyKind: HistoryKind | undefined;

  constructor(key: string, id: string, kind: StateKind, config: StateNodeConfig<C, E>, parent?: StateNode<C, E>) {
    this.key = key;
    this.id = id;
    this.kind = kind;
    this.config = config;
    this.parent = parent;
    this.path = parent ? [...parent.path, key] : [];
    this.historyKind = kind === 'history' ? (config.history ?? 'shallow') : undefined;
  }

  get depth(): number {
    return this.path.length;
  }

  /** Atomic and final states have no children and are the leaves of a configuration. */
  get isLeaf(): boolean {
    return this.kind === 'atomic' || this.kind === 'final';
  }

  /** Dotted path used in messages; the root is shown as `(root)`. */
  get label(): string {
    return this.path.length === 0 ? '(root)' : this.path.join('.');
  }

  child(key: string): StateNode<C, E> | undefined {
    return this.children.find((node) => node.key === key);
  }
}

/** True when `node` is a proper descendant of `ancestor`. */
export function isDescendant<C, E extends EventObject>(node: StateNode<C, E>, ancestor: StateNode<C, E>): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Ancestors of `node` from its parent upwards, stopping before `until` when it
 * is given (and is an ancestor), otherwise going up to and including the root.
 */
export function properAncestors<C, E extends EventObject>(
  node: StateNode<C, E>,
  until?: StateNode<C, E>,
): StateNode<C, E>[] {
  const result: StateNode<C, E>[] = [];
  let current = node.parent;
  while (current && current !== until) {
    result.push(current);
    current = current.parent;
  }
  return result;
}

export function byDocumentOrder<C, E extends EventObject>(a: StateNode<C, E>, b: StateNode<C, E>): number {
  return a.order - b.order;
}

export interface MachineTree<C, E extends EventObject> {
  root: StateNode<C, E>;
  /** Every node in document order. */
  nodes: StateNode<C, E>[];
  byId: Map<string, StateNode<C, E>>;
  issues: Issue[];
}

const KIND_VALUES: readonly StateKind[] = ['atomic', 'compound', 'parallel', 'final', 'history'];

class TreeBuilder<C, E extends EventObject> {
  readonly nodes: StateNode<C, E>[] = [];
  readonly byId = new Map<string, StateNode<C, E>>();
  readonly issues: Issue[] = [];
  private readonly rootId: string;

  constructor(private readonly config: MachineConfig<C, E>) {
    this.rootId = typeof config.id === 'string' && config.id.length > 0 ? config.id : DEFAULT_MACHINE_ID;
  }

  build(): MachineTree<C, E> {
    const root = this.createNode('', this.config, undefined);
    for (const node of this.nodes) {
      this.checkStructure(node);
    }
    return { root, nodes: this.nodes, byId: this.byId, issues: this.issues };
  }

  report(code: IssueCode, node: StateNode<C, E>, message: string, severity: IssueSeverity = 'error'): void {
    this.issues.push({ code, severity, message, path: node.label });
  }

  private createNode(
    key: string,
    config: StateNodeConfig<C, E>,
    parent: StateNode<C, E> | undefined,
  ): StateNode<C, E> {
    const childKeys = Object.keys(config.states ?? {});
    const kind: StateKind = config.type ?? (childKeys.length > 0 ? 'compound' : 'atomic');
    const defaultId = parent ? `${this.rootId}.${[...parent.path, key].join('.')}` : this.rootId;
    const id = typeof config.id === 'string' && config.id.length > 0 ? config.id : defaultId;
    const node = new StateNode<C, E>(key, id, kind, config, parent);
    node.order = this.nodes.length;
    this.nodes.push(node);

    if (parent && (key.length === 0 || key.includes('.') || key.startsWith('#'))) {
      this.report('invalid-key', node, `State key "${key}" must be non-empty, without "." and not start with "#".`);
    }
    if (id.startsWith('#')) {
      this.report('invalid-key', node, `State id "${id}" must not start with "#".`);
    }
    const existing = this.byId.get(id);
    if (existing) {
      this.report('duplicate-id', node, `Id "${id}" is already used by state "${existing.label}".`);
    } else {
      this.byId.set(id, node);
    }

    for (const childKey of childKeys) {
      const childConfig = (config.states as { [key: string]: StateNodeConfig<C, E> })[childKey];
      node.children.push(this.createNode(childKey, childConfig, node));
    }
    return node;
  }

  private checkStructure(node: StateNode<C, E>): void {
    const { config, kind } = node;
    if (!KIND_VALUES.includes(kind)) {
      this.report('invalid-structure', node, `Unknown state type "${String(kind)}".`);
      return;
    }
    if (!node.parent && (kind === 'final' || kind === 'history')) {
      this.report('invalid-structure', node, `The root state cannot be of type "${kind}".`);
    }
    if (node.isLeaf || kind === 'history') {
      if (node.children.length > 0) {
        this.report('invalid-structure', node, `A state of type "${kind}" cannot have child states.`);
      }
    } else if (node.children.length === 0) {
      this.report('invalid-structure', node, `A state of type "${kind}" needs at least one child state.`);
    }

    if (kind === 'compound' && node.children.length > 0) {
      this.resolveInitial(node);
    } else if (config.initial !== undefined) {
      this.report(
        'invalid-structure',
        node,
        `"initial" is ignored on a state of type "${kind}".`,
        'warning',
      );
    }

    if (kind === 'history') {
      this.checkHistory(node);
    } else if (config.history !== undefined) {
      this.report('invalid-history', node, `"history" is only meaningful on a state of type "history".`, 'warning');
    }
  }

  private resolveInitial(node: StateNode<C, E>): void {
    const initialKey = node.config.initial;
    if (initialKey === undefined) {
      this.report('missing-initial', node, 'Compound state has no "initial" child.');
      return;
    }
    const initial = node.child(initialKey);
    if (!initial) {
      const known = node.children.map((child) => child.key).join(', ');
      this.report('unknown-initial', node, `Initial state "${initialKey}" is not a child (children: ${known}).`);
      return;
    }
    node.initial = initial;
  }

  private checkHistory(node: StateNode<C, E>): void {
    const { config } = node;
    if (config.history !== undefined && config.history !== 'shallow' && config.history !== 'deep') {
      this.report('invalid-history', node, `History must be "shallow" or "deep", got "${String(config.history)}".`);
    }
    const hasBehaviour =
      config.on !== undefined ||
      config.always !== undefined ||
      config.after !== undefined ||
      config.onDone !== undefined ||
      config.entry !== undefined ||
      config.exit !== undefined;
    if (hasBehaviour) {
      this.report('invalid-history', node, 'A history state cannot have transitions or entry/exit actions.');
    }
  }
}

/** Builds the node tree for a definition, collecting every structural issue. */
export function buildTree<C, E extends EventObject>(config: MachineConfig<C, E>): MachineTree<C, E> {
  return new TreeBuilder<C, E>(config).build();
}

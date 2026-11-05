/**
 * Mermaid export: renders a machine as a `stateDiagram-v2` document.
 *
 * Mermaid has no notation for history states, so they are drawn as ordinary
 * states labelled `H` (shallow) or `H*` (deep).
 */

import type { Machine } from '../machine';
import { isDescendant, type StateNode, type TransitionDefinition } from '../node';
import type { EventObject } from '../types';
import { activityLines, needsRootBox, transitionLabel, type DiagramOptions } from './labels';

const INDENT = '    ';
const ESCAPES: { [char: string]: string } = { '#': '#35;', ';': '#59;', '"': '#quot;' };

function escapeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[#;"]/g, (char) => ESCAPES[char]);
}

class MermaidWriter<C, E extends EventObject> {
  private readonly lines: string[] = [];
  private readonly names = new Map<StateNode<C, E>, string>();
  /** Transitions grouped by the composite state they are written in. */
  private readonly edges = new Map<StateNode<C, E> | undefined, TransitionDefinition<C, E>[]>();
  private readonly withActions: boolean;

  constructor(
    private readonly machine: Machine<C, E>,
    private readonly options: DiagramOptions,
  ) {
    this.withActions = options.actions ?? true;
    this.assignNames();
    for (const node of machine.nodes) {
      for (const transition of node.transitions) {
        const scope = this.scopeOf(transition);
        const list = this.edges.get(scope) ?? [];
        list.push(transition);
        this.edges.set(scope, list);
      }
    }
  }

  /** Mermaid ids must be plain identifiers; state keys can be anything. */
  private assignNames(): void {
    const used = new Set<string>();
    for (const node of this.machine.nodes) {
      const raw = (node.parent ? node.path.join('_') : node.id).replace(/[^A-Za-z0-9_]/g, '_') || 'state';
      const base = /^[0-9]/.test(raw) ? `s_${raw}` : raw;
      let name = base;
      for (let suffix = 2; used.has(name); suffix++) {
        name = `${base}_${suffix}`;
      }
      used.add(name);
      this.names.set(node, name);
    }
  }

  private name(node: StateNode<C, E>): string {
    return this.names.get(node) as string;
  }

  /**
   * The innermost drawn composite that contains the source and all targets;
   * undefined stands for the top level of the diagram.
   */
  private scopeOf(transition: TransitionDefinition<C, E>): StateNode<C, E> | undefined {
    let scope = transition.source.parent;
    while (scope && !transition.targets.every((target) => isDescendant(target, scope as StateNode<C, E>))) {
      scope = scope.parent;
    }
    return scope && (scope.parent || needsRootBox(scope)) ? scope : undefined;
  }

  render(): string {
    const { root } = this.machine;
    this.lines.push('stateDiagram-v2');
    if (this.options.direction) {
      this.lines.push(`${INDENT}direction ${this.options.direction}`);
    }
    if (needsRootBox(root)) {
      this.composite(root, 1);
      this.writeEdges(undefined, 1);
    } else {
      this.body(root, 1);
      this.writeEdges(undefined, 1);
    }
    return `${this.lines.join('\n')}\n`;
  }

  private line(depth: number, text: string): void {
    this.lines.push(`${INDENT.repeat(depth)}${text}`);
  }

  private declare(node: StateNode<C, E>, depth: number): void {
    if (node.kind === 'compound' || node.kind === 'parallel') {
      this.composite(node, depth);
      return;
    }
    const label = node.kind === 'history' ? (node.historyKind === 'deep' ? 'H*' : 'H') : node.key;
    this.line(depth, `state "${escapeText(label)}" as ${this.name(node)}`);
    if (this.withActions) {
      for (const activity of activityLines(node)) {
        this.line(depth, `${this.name(node)} : ${escapeText(activity)}`);
      }
    }
  }

  private composite(node: StateNode<C, E>, depth: number): void {
    const label = node.parent ? node.key : node.id;
    this.line(depth, `state "${escapeText(label)}" as ${this.name(node)} {`);
    this.body(node, depth + 1);
    this.line(depth, '}');
  }

  /** The inside of a composite state: children, markers and transitions. */
  private body(node: StateNode<C, E>, depth: number): void {
    if (node.kind === 'parallel') {
      const regions = node.children.filter((child) => child.kind !== 'history');
      regions.forEach((region, index) => {
        if (index > 0) {
          this.line(depth, '--');
        }
        this.declare(region, depth);
      });
      for (const child of node.children.filter((item) => item.kind === 'history')) {
        this.declare(child, depth);
        this.historyDefault(child, depth);
      }
    } else {
      if (node.initial) {
        this.line(depth, `[*] --> ${this.name(node.initial)}`);
      }
      for (const child of node.children) {
        this.declare(child, depth);
        if (child.kind === 'final') {
          this.line(depth, `${this.name(child)} --> [*]`);
        }
        this.historyDefault(child, depth);
      }
    }
    if (node.parent || needsRootBox(node)) {
      this.writeEdges(node, depth);
    }
  }

  private historyDefault(node: StateNode<C, E>, depth: number): void {
    if (node.kind === 'history' && node.historyDefault) {
      this.line(depth, `${this.name(node)} --> ${this.name(node.historyDefault)} : default`);
    }
  }

  private writeEdges(scope: StateNode<C, E> | undefined, depth: number): void {
    for (const transition of this.edges.get(scope) ?? []) {
      const label = escapeText(transitionLabel(transition, this.withActions));
      const source = this.name(transition.source);
      // A targetless transition stays in its state and is drawn as a self-loop.
      const targets = transition.targets.length > 0 ? transition.targets : [transition.source];
      for (const target of targets) {
        this.line(depth, `${source} --> ${this.name(target)} : ${label}`);
      }
    }
  }
}

/** Renders the machine as Mermaid `stateDiagram-v2` text. */
export function toMermaid<C, E extends EventObject>(machine: Machine<C, E>, options: DiagramOptions = {}): string {
  return new MermaidWriter(machine, options).render();
}

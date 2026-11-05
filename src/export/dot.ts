/**
 * Graphviz export: renders a machine as a DOT `digraph`.
 *
 * Compound and parallel states become clusters. Graphviz cannot attach an
 * edge to a cluster, so every cluster owns a small anchor node (the initial
 * marker of a compound state, an invisible point in a parallel state) and
 * edges that start or end at the cluster are clipped to its border with
 * `ltail` / `lhead`.
 */

import type { Machine } from '../machine';
import type { StateNode } from '../node';
import type { EventObject } from '../types';
import { activityLines, needsRootBox, transitionLabel, type DiagramOptions } from './labels';

const INDENT = '  ';

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function isComposite<C, E extends EventObject>(node: StateNode<C, E>): boolean {
  return node.kind === 'compound' || node.kind === 'parallel';
}

class DotWriter<C, E extends EventObject> {
  private readonly lines: string[] = [];
  private readonly withActions: boolean;
  private readonly boxed: boolean;

  constructor(
    private readonly machine: Machine<C, E>,
    private readonly options: DiagramOptions,
  ) {
    this.withActions = options.actions ?? true;
    this.boxed = needsRootBox(machine.root);
  }

  render(): string {
    const { root } = this.machine;
    this.lines.push(`digraph ${quote(root.id)} {`);
    this.line(1, 'compound=true;');
    this.line(1, `rankdir=${this.options.direction ?? 'TB'};`);
    this.line(1, 'node [shape=box, style=rounded];');
    if (this.boxed) {
      this.cluster(root, 1);
    } else {
      this.contents(root, 1);
    }
    for (const node of this.machine.nodes) {
      this.edgesOf(node);
    }
    this.lines.push('}');
    return `${this.lines.join('\n')}\n`;
  }

  private line(depth: number, text: string): void {
    this.lines.push(`${INDENT.repeat(depth)}${text}`);
  }

  private clusterName(node: StateNode<C, E>): string {
    return quote(`cluster_${node.id}`);
  }

  /** The node an edge is attached to when it starts or ends at `node`. */
  private anchor(node: StateNode<C, E>): string {
    if (node.kind === 'compound') {
      return quote(`${node.id}__initial`);
    }
    return node.kind === 'parallel' ? quote(`${node.id}__anchor`) : quote(node.id);
  }

  private cluster(node: StateNode<C, E>, depth: number): void {
    this.line(depth, `subgraph ${this.clusterName(node)} {`);
    this.line(depth + 1, `label=${quote(node.parent ? node.key : node.id)};`);
    this.line(depth + 1, `style=${node.parent?.kind === 'parallel' ? '"rounded,dashed"' : 'rounded'};`);
    this.contents(node, depth + 1);
    this.line(depth, '}');
  }

  /** Anchor, child nodes and child clusters of a composite state. */
  private contents(node: StateNode<C, E>, depth: number): void {
    if (node.kind === 'parallel') {
      this.line(depth, `${this.anchor(node)} [shape=point, style=invis, label=""];`);
    } else {
      this.line(depth, `${this.anchor(node)} [shape=point, width=0.15, label=""];`);
    }
    for (const child of node.children) {
      if (isComposite(child)) {
        this.cluster(child, depth);
      } else {
        this.line(depth, `${quote(child.id)} [${this.leafAttributes(child)}];`);
      }
    }
  }

  private leafAttributes(node: StateNode<C, E>): string {
    if (node.kind === 'history') {
      return `shape=circle, label=${quote(node.historyKind === 'deep' ? 'H*' : 'H')}`;
    }
    const label = [node.key, ...(this.withActions ? activityLines(node) : [])].join('\n');
    return node.kind === 'final' ? `shape=doublecircle, label=${quote(label)}` : `label=${quote(label)}`;
  }

  private edge(from: StateNode<C, E>, to: StateNode<C, E>, attributes: string[], fromMarker = false): void {
    const all = [...attributes];
    if (isComposite(from) && !fromMarker) {
      all.push(`ltail=${this.clusterName(from)}`);
    }
    if (isComposite(to)) {
      all.push(`lhead=${this.clusterName(to)}`);
    }
    const suffix = all.length > 0 ? ` [${all.join(', ')}]` : '';
    this.line(1, `${this.anchor(from)} -> ${this.anchor(to)}${suffix};`);
  }

  private edgesOf(node: StateNode<C, E>): void {
    if (node.kind === 'compound' && node.initial) {
      // From the initial marker itself, not from the border of the cluster.
      this.edge(node, node.initial, [], true);
    }
    if (node.kind === 'history' && node.historyDefault) {
      this.edge(node, node.historyDefault, ['label="default"', 'style=dashed']);
    }
    for (const transition of node.transitions) {
      const label = `label=${quote(transitionLabel(transition, this.withActions))}`;
      // A targetless transition stays in its state and is drawn as a self-loop.
      const targets = transition.targets.length > 0 ? transition.targets : [node];
      for (const target of targets) {
        this.edge(node, target, [label]);
      }
    }
  }
}

/** Renders the machine as Graphviz DOT text. */
export function toDot<C, E extends EventObject>(machine: Machine<C, E>, options: DiagramOptions = {}): string {
  return new DotWriter(machine, options).render();
}

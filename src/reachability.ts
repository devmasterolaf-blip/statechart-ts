/**
 * Static reachability: which states can ever become active, judging by the
 * structure alone. Guards are assumed to be able to pass, so the result is an
 * over-approximation: a state reported as unreachable really is unreachable,
 * while a reachable one may still be blocked by a guard at run time.
 */

import type { MachineTree, StateNode } from './node';
import type { EventObject } from './types';

/**
 * Returns every state that can be entered, starting from the initial
 * configuration and following transition targets until nothing new is found.
 * A history state counts as reachable when it is targeted or used as initial.
 */
export function reachableStates<C, E extends EventObject>(tree: MachineTree<C, E>): Set<StateNode<C, E>> {
  const reached = new Set<StateNode<C, E>>();
  const pending: StateNode<C, E>[] = [];

  const mark = (node: StateNode<C, E>): boolean => {
    if (reached.has(node)) {
      return false;
    }
    reached.add(node);
    pending.push(node);
    return true;
  };

  /** Default entry of a node: what becomes active below it. */
  const enter = (node: StateNode<C, E>): void => {
    if (!mark(node)) {
      return;
    }
    if (node.kind === 'compound' && node.initial) {
      enter(node.initial);
    } else if (node.kind === 'parallel') {
      enterRegions(node);
    } else if (node.kind === 'history' && node.parent) {
      if (node.historyDefault) {
        enterTarget(node.historyDefault);
      } else if (node.parent.kind === 'parallel') {
        enterRegions(node.parent);
      } else if (node.parent.initial) {
        enter(node.parent.initial);
      }
    }
  };

  const enterRegions = (parallel: StateNode<C, E>): void => {
    for (const region of parallel.children) {
      if (region.kind !== 'history') {
        enter(region);
      }
    }
  };

  /** Entering a target also activates its ancestors and their other regions. */
  const enterTarget = (target: StateNode<C, E>): void => {
    enter(target);
    for (let ancestor = target.parent; ancestor; ancestor = ancestor.parent) {
      mark(ancestor);
      if (ancestor.kind === 'parallel') {
        enterRegions(ancestor);
      }
    }
  };

  enter(tree.root);
  while (pending.length > 0) {
    const node = pending.pop() as StateNode<C, E>;
    for (const transition of node.transitions) {
      for (const target of transition.targets) {
        enterTarget(target);
      }
    }
  }
  return reached;
}

/**
 * The topmost unreachable states in document order. Descendants of an
 * unreachable state are left out, since they are unreachable for that reason.
 */
export function unreachableStates<C, E extends EventObject>(tree: MachineTree<C, E>): StateNode<C, E>[] {
  const reached = reachableStates(tree);
  return tree.nodes.filter((node) => !reached.has(node) && (!node.parent || reached.has(node.parent)));
}

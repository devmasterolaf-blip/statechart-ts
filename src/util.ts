import type { SingleOrArray } from './types';

/** Normalizes an optional single-or-array value to an array. */
export function toArray<T>(value: SingleOrArray<T> | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Order keys for the page, grid and map layouts.
//
// An order key is a fractional index string ("a0", "a0V", "a1"), made by the
// `fractional-indexing` package (CC0). Keys sort by plain string comparison
// (code units, not locale). A new key can always go between two different
// keys, so a move changes one widget only.
//
// Two peers that insert at the same spot at the same time can make the same
// key. Then the widget id decides the order, so every peer sees the same list.

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

const KEY = /^[A-Za-z][0-9A-Za-z]*$/;

export function isOrderKey(key: unknown): key is string {
  if (typeof key !== "string" || !KEY.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** Plain code-unit comparison. `localeCompare` would break the key order. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort by order key, then by id. Items without a key go last, sorted by id. */
export function compareOrdered(a: { id: string; order?: string }, b: { id: string; order?: string }): number {
  if (a.order !== undefined && b.order !== undefined) return compareKeys(a.order, b.order) || compareKeys(a.id, b.id);
  if (a.order !== undefined) return -1;
  if (b.order !== undefined) return 1;
  return compareKeys(a.id, b.id);
}

/** `n` keys in ascending order, between `lo` and `hi` (null = open end). Needs `lo < hi`. */
export function keysBetween(lo: string | null, hi: string | null, n: number): string[] {
  if (lo !== null && hi !== null && compareKeys(lo, hi) >= 0) throw new Error(`Order key ${lo} is not before ${hi}`);
  return generateNKeysBetween(lo, hi, n);
}

export function keyBetween(lo: string | null, hi: string | null): string {
  return keysBetween(lo, hi, 1)[0];
}

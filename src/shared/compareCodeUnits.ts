/**
 * Code-unit lexical comparator — the ONE ordering primitive for every sort
 * whose result is persisted, hashed, or compared across hosts. `localeCompare`
 * is banned in src/ (check:shared-primitives): ICU collation varies with the
 * host locale, so a persisted array ordered by it hashes differently per
 * machine — the phantom-staleness class.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

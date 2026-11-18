// sites-pinned: tests/shared/task-affinity-artifacts.test.ts, tests/shared/content-coherence.test.ts, tests/shared/friction-run-linkage.test.ts
/**
 * Code-unit lexical comparator — the ONE ordering primitive for every sort
 * whose result is persisted, hashed, or compared across hosts. ICU collation
 * is banned in src/ (check:shared-primitives): it varies with the host locale,
 * so a persisted array ordered by it hashes differently per machine — the
 * phantom-staleness class.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The distinct values in code-unit order — the stable form of a persisted string set. */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

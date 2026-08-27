/**
 * One vocabulary for contract-pipeline obligation kinds. Definition order
 * preserves the observable TESTABLE_OBLIGATION_KINDS iteration order; the
 * explicit priority rank preserves the load-bearing lens/severity order.
 */
const OBLIGATION_KIND_DEFINITIONS = [
  { kind: "invariant", testable: true, priority: 3 },
  { kind: "behavioral", testable: true, priority: 2 },
  { kind: "structural", testable: false, priority: 1 },
  { kind: "test", testable: false, priority: 0 },
] as const;

export type ObligationKind = (typeof OBLIGATION_KIND_DEFINITIONS)[number]["kind"];

export const OBLIGATION_KIND_PRIORITY: readonly ObligationKind[] = [
  ...OBLIGATION_KIND_DEFINITIONS,
]
  .sort((left, right) => left.priority - right.priority)
  .map(({ kind }) => kind);

export const TESTABLE_OBLIGATION_KINDS = new Set<string>(
  OBLIGATION_KIND_DEFINITIONS.filter(({ testable }) => testable).map(({ kind }) => kind),
);

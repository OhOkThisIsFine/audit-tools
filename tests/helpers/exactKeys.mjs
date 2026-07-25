/**
 * Exact key-set assertion whose FAILURE HEADLINE names the offending field.
 *
 * An additive-hostile leak-guard (`expect(Object.keys(x).sort()).toEqual([...])`)
 * is the right shape — any new field on a persisted/asserted contract type should
 * red until someone decides whether it belongs on the wire. But when it fires,
 * the headline vitest prints is
 *
 *     expected [ 'access', 'complexity', …(6) ] to deeply equal [ 'access', … (5) ]
 *
 * where the `…(N)` are "N more items", not key counts, and NO field name appears.
 * The name is only in the +/- diff printed below. A log tail, a CI job-summary
 * line, or a truncated excerpt therefore reads as an opaque count mismatch, and
 * the reader has to go find the full output to learn which field leaked.
 *
 * This asserts on the sorted unexpected/missing DELTA instead, so the field name
 * is in the message itself and survives truncation.
 */
import { expect } from "vitest";

/**
 * Assert that `actual`'s own enumerable keys are exactly `expected`.
 *
 * @param {object} actual   The object whose key set is the contract.
 * @param {string[]} expected  The permitted keys, in any order.
 * @param {string} label    What the key set belongs to, e.g. "DispatchPlanEntry".
 */
export function expectExactKeys(actual, expected, label) {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = [...expected].sort();
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  const unexpected = actualKeys.filter((k) => !expectedSet.has(k));
  const missing = expectedKeys.filter((k) => !actualSet.has(k));

  // Assert the DELTA, not the key lists: on failure the message renders the
  // actual field names ({unexpected: ["file_paths"], missing: []}) rather than a
  // pair of elided arrays. On success both sides are empty and this is exact —
  // an empty delta is equivalent to an equal key set.
  expect(
    { unexpected, missing },
    `${label}: key set drifted — an added field must be deliberate (update this guard once it is)`,
  ).toEqual({ unexpected: [], missing: [] });
}

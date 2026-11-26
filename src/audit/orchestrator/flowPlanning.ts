// sites-pinned: tests/audit/flow-planning.test.ts
import type { Lens } from "../types.js";
import { isLens } from "../types.js";

/** Keep canonical flow concerns in their original order; ignore other labels. */
export function selectFlowLenses(concerns: readonly unknown[]): Lens[] {
  return concerns.filter((concern): concern is Lens => isLens(concern));
}

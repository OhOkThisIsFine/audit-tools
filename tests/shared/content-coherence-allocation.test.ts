import { expect, test, vi } from "vitest";
import {
  buildContentCoherenceTrace,
  TASK_DRAW_COHERENCE_POLICY,
} from "../../src/shared/decompose/contentCoherence.js";

test("coherence evidence does not allocate lookup sets for every item pair", () => {
  const count = 80;
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    file_paths: [`dir-${index}/file.ts`],
    unit_ids: [`unit-${index}`],
    critical_flow_ids: [`flow-${index}`],
    tags: [],
  }));
  const OriginalSet = globalThis.Set;
  let constructions = 0;
  class CountingSet<T> extends OriginalSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      constructions += 1;
    }
  }
  let trace: ReturnType<typeof buildContentCoherenceTrace>;
  vi.stubGlobal("Set", CountingSet);
  try {
    trace = buildContentCoherenceTrace({ items }, TASK_DRAW_COHERENCE_POLICY);
  } finally {
    vi.stubGlobal("Set", OriginalSet);
  }
  expect(trace.components).toHaveLength(count);
  expect(trace.components.every((component) => component.length === 1)).toBe(true);
  expect(trace.components.flat().sort()).toEqual(items.map((item) => item.id).sort());
  // Bounds temporary Set construction only; scoring still visits every pair.
  expect(constructions).toBeLessThanOrEqual(40 * count);
});

/**
 * A routing-filtered incompatible lane must be a VALUE the caller can read, not a
 * once-per-process stderr line.
 *
 * `collectDispatchableSources` drops a lane failing `laneWorkerKindConflict` and
 * reports it ONLY via `warnIncompatibleLaneOnce` — one stderr write per (lane,
 * reason) per PROCESS. Nothing in the returned value says the lane existed, so:
 *
 *   - source-resolution diagnostics cannot show it. That surface deliberately
 *     keeps a dropped-by-exclusion provider VISIBLE and marked so the operator can
 *     opt it back in (`buildSourcePools`' `excludedBackends` doc in apiPool.ts
 *     says exactly this: "display and routing diverge deliberately"). A
 *     worker-kind drop vanishes from that same surface instead.
 *   - a SECOND run in the same process is silent entirely — the `Set` guard has
 *     already fired for that (lane, reason).
 *
 * The sibling path already solved this: `resolveAmbientSources`
 * (`auditorSources.ts`) applies the SAME `laneWorkerKindConflict` predicate and
 * returns `{ sources, dropped: DroppedSource[] }`. This is that shape, at the
 * chokepoint descriptor-supplied `sources[]` actually reach.
 */

import { test, expect } from "vitest";
import {
  collectDispatchableSources,
  gatherDispatchableSources,
} from "../../src/shared/quota/apiPool.js";
import type { DispatchableSource, SessionConfig } from "../../src/shared/types/sessionConfig.js";

/**
 * A lane that trips `laneWorkerKindConflict`: `burst_limited` + an agentic
 * worker kind. `claude-worker` derives to agentic, so the pair conflicts.
 */
const CONFLICTING_SOURCE: DispatchableSource = {
  transport: "claude-worker",
  service: "nim",
  endpoint: "http://127.0.0.1:4000/v1",
  model: "conflicting-model",
  burst_limited: true,
};

/** A lane with no conflict — must survive untouched alongside the dropped one. */
const ROUTABLE_SOURCE: DispatchableSource = {
  transport: "openai-compatible",
  service: "nim",
  endpoint: "http://127.0.0.1:4000/v1",
  model: "routable-model",
};

const sessionConfig = (): SessionConfig => ({
  provider: "claude-code",
  sources: [structuredClone(CONFLICTING_SOURCE), structuredClone(ROUTABLE_SOURCE)],
});

test("collectDispatchableSources reports an incompatible lane as a VALUE, not only on stderr", () => {
  const result = collectDispatchableSources(sessionConfig(), "claude-code");

  // The contract: a pair, exactly like resolveAmbientSources returns.
  expect(
    Array.isArray(result),
    "collectDispatchableSources must return { sources, dropped } — a bare array cannot carry the drop",
  ).toBe(false);
  expect(result).toHaveProperty("sources");
  expect(result).toHaveProperty("dropped");

  // The routable lane survives; one incompatible lane never costs the rest of the pool.
  expect(result.sources.map((s) => s.model)).toEqual(["routable-model"]);

  // The dropped lane is named, WITH its reason — the operator-facing half.
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped[0].reason).toMatch(/agentic worker-kind on a burst-limited lane/);
  expect(
    result.dropped[0].id,
    "the drop must identify WHICH lane, or the operator cannot act on it",
  ).toMatch(/conflicting-model/);
});

test("the drop survives a SECOND call in the same process (the stderr Set guard does not)", () => {
  // warnIncompatibleLaneOnce dedupes per process, so the second call emits NOTHING
  // on stderr. A value-returning contract has no such memory.
  collectDispatchableSources(sessionConfig(), "claude-code");
  const second = collectDispatchableSources(sessionConfig(), "claude-code");

  expect(
    second.dropped,
    "a second gather in the same process must still report the drop",
  ).toHaveLength(1);
  expect(second.dropped[0].reason).toMatch(/agentic worker-kind on a burst-limited lane/);
});

test("gatherDispatchableSources carries the same pair — the wrapper is not a bypass", async () => {
  // Both are exported, so a contract enforced only on the inner function leaves the
  // wrapper as an escape hatch — the file's own stated reason for filtering inside
  // collectDispatchableSources rather than in the wrapper.
  const result = await gatherDispatchableSources(sessionConfig(), "claude-code");

  expect(Array.isArray(result), "the wrapper must expose the pair too").toBe(false);
  expect(result.sources.map((s) => s.model)).toEqual(["routable-model"]);
  expect(result.dropped).toHaveLength(1);
});

test("a pool with NO conflicting lane reports an empty dropped[], not a missing key", () => {
  // A success-shaped result must AFFIRM zero drops rather than omit the field —
  // an absent `dropped` is indistinguishable from an unwired call site.
  const result = collectDispatchableSources(
    { provider: "claude-code", sources: [structuredClone(ROUTABLE_SOURCE)] },
    "claude-code",
  );
  expect(result.dropped).toEqual([]);
  expect(result.sources).toHaveLength(1);
});

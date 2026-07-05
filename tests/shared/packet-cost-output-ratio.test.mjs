/**
 * packet-cost-output-ratio.test.mjs
 *
 * The output-envelope packet cost (src/shared/quota/packetCost.ts) and the learned
 * output/input ratio EWMA (foldOutputRatioObservation / recordOutputRatioObservation
 * in src/shared/quota/state.ts) — Resolved decision 1 of the admission-control
 * design: reserve `input_estimate + output_reservation`, where the envelope is the
 * learned ratio once measured, else the packet's declared output cap, else 0.
 */

import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveOutputReservation, estimatePacketCost } = await import(
  "../../src/shared/quota/packetCost.ts"
);
const {
  foldOutputRatioObservation,
  recordOutputRatioObservation,
  OUTPUT_RATIO_EWMA_ALPHA,
  setQuotaStateDir,
  readQuotaState,
} = await import("../../src/shared/quota/state.ts");

// ── resolveOutputReservation ────────────────────────────────────────────────

test("learned ratio scales the input estimate", () => {
  expect(resolveOutputReservation({ inputEstimate: 1000, learnedRatio: 0.4 })).toBe(400);
});

test("declared cap is the cold-start envelope when no ratio is learned", () => {
  expect(
    resolveOutputReservation({ inputEstimate: 1000, learnedRatio: null, declaredOutputCap: 2048 }),
  ).toBe(2048);
});

test("learned ratio wins over the declared cap once known", () => {
  expect(
    resolveOutputReservation({ inputEstimate: 1000, learnedRatio: 0.5, declaredOutputCap: 2048 }),
  ).toBe(500);
});

test("no ratio and no cap yields a zero envelope (input-only; reactive floor catches)", () => {
  expect(resolveOutputReservation({ inputEstimate: 1000 })).toBe(0);
});

test("non-positive input estimate yields a zero envelope regardless of ratio/cap", () => {
  expect(resolveOutputReservation({ inputEstimate: 0, learnedRatio: 0.5, declaredOutputCap: 2048 })).toBe(0);
  expect(resolveOutputReservation({ inputEstimate: -5, declaredOutputCap: 2048 })).toBe(0);
});

test("non-finite / non-positive ratio and cap are ignored", () => {
  expect(resolveOutputReservation({ inputEstimate: 1000, learnedRatio: Number.NaN, declaredOutputCap: 300 })).toBe(300);
  expect(resolveOutputReservation({ inputEstimate: 1000, learnedRatio: -1, declaredOutputCap: 0 })).toBe(0);
});

// ── estimatePacketCost ──────────────────────────────────────────────────────

test("cost is input estimate plus the output envelope", () => {
  const c = estimatePacketCost({ inputEstimate: 1000, learnedRatio: 0.3 });
  expect(c.inputEstimate).toBe(1000);
  expect(c.outputReservation).toBe(300);
  expect(c.cost).toBe(1300);
});

test("cost with declared cap fallback", () => {
  const c = estimatePacketCost({ inputEstimate: 1000, declaredOutputCap: 500 });
  expect(c.cost).toBe(1500);
});

test("non-positive input clamps to a zero-cost packet", () => {
  const c = estimatePacketCost({ inputEstimate: 0, declaredOutputCap: 500 });
  expect(c.inputEstimate).toBe(0);
  expect(c.outputReservation).toBe(0);
  expect(c.cost).toBe(0);
});

// ── foldOutputRatioObservation (pure EWMA) ──────────────────────────────────

test("first observation seeds the lens ratio directly", () => {
  const out = foldOutputRatioObservation(undefined, "security", 1000, 400);
  expect(out.security).toBeCloseTo(0.4, 10);
});

test("subsequent observation blends via EWMA alpha", () => {
  const prior = { security: 0.4 };
  const out = foldOutputRatioObservation(prior, "security", 1000, 800); // sample 0.8
  const expected = 0.4 * (1 - OUTPUT_RATIO_EWMA_ALPHA) + 0.8 * OUTPUT_RATIO_EWMA_ALPHA;
  expect(out.security).toBeCloseTo(expected, 10);
  // Pure: prior is not mutated.
  expect(prior.security).toBe(0.4);
});

test("distinct lenses learn independent ratios", () => {
  let map = foldOutputRatioObservation(undefined, "security", 1000, 200);
  map = foldOutputRatioObservation(map, "correctness", 1000, 900);
  expect(map.security).toBeCloseTo(0.2, 10);
  expect(map.correctness).toBeCloseTo(0.9, 10);
});

test("degrade-safe: non-positive / non-finite tokens leave the map unchanged", () => {
  const prior = { security: 0.4 };
  expect(foldOutputRatioObservation(prior, "security", 0, 400)).toBe(prior);
  expect(foldOutputRatioObservation(prior, "security", 1000, 0)).toBe(prior);
  expect(foldOutputRatioObservation(prior, "security", Number.NaN, 400)).toBe(prior);
});

// ── recordOutputRatioObservation (persisted under the state lock) ────────────

test("recordOutputRatioObservation persists and blends the lens ratio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "output-ratio-"));
  try {
    setQuotaStateDir(dir);
    const key = "claude-code#acct/sonnet";
    await recordOutputRatioObservation(key, "security", 1000, 500); // 0.5
    let state = await readQuotaState();
    expect(state.entries[key].output_per_input.security).toBeCloseTo(0.5, 10);

    await recordOutputRatioObservation(key, "security", 1000, 900); // sample 0.9
    state = await readQuotaState();
    const expected = 0.5 * (1 - OUTPUT_RATIO_EWMA_ALPHA) + 0.9 * OUTPUT_RATIO_EWMA_ALPHA;
    expect(state.entries[key].output_per_input.security).toBeCloseTo(expected, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

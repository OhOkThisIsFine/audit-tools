/**
 * packet-cost-output-ratio.test.ts
 *
 * The output-envelope packet cost (src/shared/quota/packetCost.ts) —
 * Resolved decision 1 of the admission-control design: reserve
 * `input_estimate + output_reservation`, where the envelope is the packet's
 * declared output cap, else 0.
 */

import { test, expect } from "vitest";
import { resolveOutputReservation, estimatePacketCost } from "../../src/shared/quota/packetCost.js";

// ── resolveOutputReservation ────────────────────────────────────────────────

test("declared cap is the cold-start envelope", () => {
  expect(
    resolveOutputReservation({ inputEstimate: 1000, declaredOutputCap: 2048 }),
  ).toBe(2048);
});

test("no cap yields a zero envelope (input-only; reactive floor catches)", () => {
  expect(resolveOutputReservation({ inputEstimate: 1000 })).toBe(0);
});

test("non-positive input estimate yields a zero envelope regardless of cap", () => {
  expect(resolveOutputReservation({ inputEstimate: 0, declaredOutputCap: 2048 })).toBe(0);
  expect(resolveOutputReservation({ inputEstimate: -5, declaredOutputCap: 2048 })).toBe(0);
});

test("non-finite / non-positive cap are ignored", () => {
  expect(resolveOutputReservation({ inputEstimate: 1000, declaredOutputCap: 0 })).toBe(0);
  expect(resolveOutputReservation({ inputEstimate: 1000, declaredOutputCap: -1 })).toBe(0);
  expect(resolveOutputReservation({ inputEstimate: 1000, declaredOutputCap: Number.NaN })).toBe(0);
});

// ── estimatePacketCost ──────────────────────────────────────────────────────

test("cost is input estimate plus the output envelope", () => {
  const c = estimatePacketCost({ inputEstimate: 1000, declaredOutputCap: 300 });
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


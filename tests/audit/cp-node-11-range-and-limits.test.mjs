import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerAuditTaskSchema } from "../../src/audit/contracts/workerSchemas.ts";
import { setQuotaStateDir } from "audit-tools/shared";
import {
  updateDiscoveredLimits,
  lookupDiscoveredLimits,
  mergeDiscoveredLimits,
  DISCOVERED_LIMIT_FIELDS,
} from "../../src/audit/quota/discoveredLimits.ts";

// ── CP-NODE-11: worker line-range refinement (end >= start) ──────────────────

const baseTask = {
  task_id: "t",
  unit_id: "u",
  pass_id: "p",
  lens: "security",
  file_paths: ["a.ts"],
  rationale: "r",
};

test("WorkerAuditTaskSchema accepts a forward line range (end >= start)", () => {
  assert.doesNotThrow(() =>
    WorkerAuditTaskSchema.parse({
      ...baseTask,
      line_ranges: [{ path: "a.ts", start: 10, end: 20 }],
    }),
  );
  // Single-line range (end === start) is valid.
  assert.doesNotThrow(() =>
    WorkerAuditTaskSchema.parse({
      ...baseTask,
      line_ranges: [{ path: "a.ts", start: 5, end: 5 }],
    }),
  );
});

test("WorkerAuditTaskSchema rejects a reversed line range (end < start)", () => {
  // RED before the refinement: a reversed range used to parse cleanly.
  assert.throws(
    () =>
      WorkerAuditTaskSchema.parse({
        ...baseTask,
        line_ranges: [{ path: "a.ts", start: 20, end: 10 }],
      }),
    /end must be >= start/,
  );
});

// ── CP-NODE-11: discovered-limit field set is single-sourced ─────────────────

async function withTempQuotaDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cp-node-11-limits-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("DISCOVERED_LIMIT_FIELDS includes the capability-handshake fields", () => {
  expect(DISCOVERED_LIMIT_FIELDS.includes("context_tokens")).toBeTruthy();
  expect(DISCOVERED_LIMIT_FIELDS.includes("output_tokens")).toBeTruthy();
});

test("updateDiscoveredLimits persists context_tokens/output_tokens through the cache round-trip", async () => {
  // RED before single-sourcing: update dropped context_tokens/output_tokens,
  // so lookup returned them as null even after they were discovered.
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("prov:m", {
      context_tokens: 200000,
      output_tokens: 8192,
      source: "capability_handshake",
    });
    const result = await lookupDiscoveredLimits("prov:m");
    expect(result !== null, "lookup should return non-null").toBeTruthy();
    expect(result.context_tokens).toBe(200000);
    expect(result.output_tokens).toBe(8192);
  });
});

test("mergeDiscoveredLimits fills context_tokens/output_tokens from later sources", () => {
  const result = mergeDiscoveredLimits(
    { requests_per_minute: 50, source: "provider_query" },
    { context_tokens: 128000, output_tokens: 4096, source: "handshake" },
  );
  expect(result.requests_per_minute).toBe(50);
  expect(result.context_tokens).toBe(128000);
  expect(result.output_tokens).toBe(4096);
});

/**
 * run-registry.test.mjs
 *
 * Slice 1 of multi-IDE concurrent runs (spec/multi-ide-concurrent-runs-design.md):
 * the cross-run registry + deterministic conversation-first run resolution.
 *
 * Contracts enforced:
 *   1. PATH LAYOUT: runDir/registry paths derive under the base artifacts dir;
 *      runId safety validator matches [A-Za-z0-9_-]+.
 *   2. RESOLUTION TRUTH TABLE (§Run resolution): explicit / explicit_unknown /
 *      new / resume-the-one / ambiguous-on-many, filtered by orchestrator +
 *      active status.
 *   3. REGISTRY ROUND-TRIP: register → load → update → retire persists through a
 *      real on-disk registry.json, and register/retire are lock-guarded RMW.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  runsContainerDir,
  runDir,
  registryPath,
  registryLockPath,
  isRunIdSafe,
} = await import("../../src/shared/io/auditToolsPaths.ts");

const {
  registerRun,
  updateRun,
  retireRun,
  loadRegistry,
  resolveRun,
} = await import("../../src/shared/io/runRegistry.ts");

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "run-registry-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("path layout derives under the base artifacts dir", () => {
  const base = "/repo/.audit-tools/audit";
  assert.equal(runsContainerDir(base), join(base, "runs"));
  assert.equal(runDir(base, "RUN-abc"), join(base, "runs", "RUN-abc"));
  assert.equal(registryPath(base), join(base, "registry.json"));
  assert.equal(registryLockPath(base), join(base, "registry.lock"));
});

test("isRunIdSafe accepts path/ref-safe ids and rejects the rest", () => {
  for (const ok of ["RUN-abc123", "a", "A_B-1"]) assert.equal(isRunIdSafe(ok), true, ok);
  for (const bad of ["", "a/b", "a b", "a.b", "a:b", "../x", "a\\b"]) {
    assert.equal(isRunIdSafe(bad), false, bad);
  }
});

test("resolveRun — explicit run-id present / unknown", () => {
  const registry = {
    runs: { R1: { orchestrator: "audit", started_at: "t", status: "active", coverage: "c" } },
  };
  assert.deepEqual(resolveRun(registry, "audit", "R1"), { kind: "explicit", runId: "R1" });
  assert.deepEqual(resolveRun(registry, "audit", "R9"), {
    kind: "explicit_unknown",
    runId: "R9",
  });
});

test("resolveRun — no run-id: new / resume-the-one / ambiguous", () => {
  // zero active → new
  assert.deepEqual(resolveRun({ runs: {} }, "audit", undefined), { kind: "new" });

  // exactly one active → resume it
  const one = {
    runs: { R1: { orchestrator: "audit", started_at: "t", status: "active", coverage: "c" } },
  };
  assert.deepEqual(resolveRun(one, "audit", undefined), { kind: "resume", runId: "R1" });

  // multiple active → ambiguous, candidates carry coverage for the manifest
  const many = {
    runs: {
      R1: { orchestrator: "audit", started_at: "t1", status: "active", coverage: "security" },
      R2: { orchestrator: "audit", started_at: "t2", status: "active", coverage: "perf" },
    },
  };
  const res = resolveRun(many, "audit", undefined);
  assert.equal(res.kind, "ambiguous");
  assert.equal(res.candidates.length, 2);
  assert.deepEqual(
    res.candidates.map((c) => c.runId).sort(),
    ["R1", "R2"],
  );
  assert.ok(res.candidates.every((c) => typeof c.coverage === "string"));
});

test("resolveRun — filters by orchestrator and active status", () => {
  const registry = {
    runs: {
      A1: { orchestrator: "audit", started_at: "t", status: "active", coverage: "c" },
      A2: { orchestrator: "audit", started_at: "t", status: "complete", coverage: "c" }, // not active
      R1: { orchestrator: "remediate", started_at: "t", status: "active", coverage: "c" },
    },
  };
  // Only the one active audit run → resume it (completed + remediate excluded).
  assert.deepEqual(resolveRun(registry, "audit", undefined), { kind: "resume", runId: "A1" });
  // Only the one active remediate run.
  assert.deepEqual(resolveRun(registry, "remediate", undefined), { kind: "resume", runId: "R1" });
});

test("registry round-trip: register → load → update → retire", async () => {
  const { dir, cleanup } = await makeTempDir();
  const base = join(dir, ".audit-tools", "audit");
  try {
    await registerRun(base, "RUN-1", {
      orchestrator: "audit",
      started_at: "2026-07-02T00:00:00.000Z",
      coverage: "security,perf",
    });
    let reg = await loadRegistry(base);
    assert.deepEqual(reg.runs["RUN-1"], {
      orchestrator: "audit",
      started_at: "2026-07-02T00:00:00.000Z",
      status: "active",
      coverage: "security,perf",
    });

    await updateRun(base, "RUN-1", { status: "complete", coverage: "security" });
    reg = await loadRegistry(base);
    assert.equal(reg.runs["RUN-1"].status, "complete");
    assert.equal(reg.runs["RUN-1"].coverage, "security");

    // update on unknown run is a no-op
    await updateRun(base, "GHOST", { status: "complete" });
    reg = await loadRegistry(base);
    assert.equal(reg.runs["GHOST"], undefined);

    await retireRun(base, "RUN-1");
    reg = await loadRegistry(base);
    assert.equal(reg.runs["RUN-1"], undefined);
  } finally {
    await cleanup();
  }
});

test("loadRegistry on a missing registry degrades to empty", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const reg = await loadRegistry(join(dir, "nope", "audit"));
    assert.deepEqual(reg, { runs: {} });
  } finally {
    await cleanup();
  }
});

test("registerRun rejects an unsafe runId", async () => {
  const { dir, cleanup } = await makeTempDir();
  const base = join(dir, ".audit-tools", "audit");
  try {
    await assert.rejects(
      registerRun(base, "bad/id", {
        orchestrator: "audit",
        started_at: "t",
        coverage: "c",
      }),
      /Unsafe runId/,
    );
  } finally {
    await cleanup();
  }
});

test("concurrent registerRun calls do not lose entries (lock-guarded RMW)", async () => {
  const { dir, cleanup } = await makeTempDir();
  const base = join(dir, ".audit-tools", "audit");
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        registerRun(base, `RUN-${i}`, {
          orchestrator: "audit",
          started_at: "t",
          coverage: `c${i}`,
        }),
      ),
    );
    const reg = await loadRegistry(base);
    assert.equal(Object.keys(reg.runs).length, 8);
  } finally {
    await cleanup();
  }
});

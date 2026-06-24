import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runEmitValidateRepair } = await import(
  "../../src/shared/repair/emitValidateRepair.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

// ── A tiny everything-agnostic contract used to drive the seam. ───────────────
// Validator: each element must carry a non-empty `unit_id` (REQUIRED) and an
// `opt` sub-object that, when present, must be an object (OPTIONAL).

function makeContract(overrides = {}) {
  return {
    contractId: "test_contract",
    validate(payload) {
      const errors = [];
      if (!Array.isArray(payload)) {
        errors.push({ path: "$", message: "must be array", required: true });
        return { errors };
      }
      payload.forEach((el, i) => {
        if (typeof el?.unit_id !== "string" || el.unit_id.length === 0) {
          errors.push({
            path: `[${i}].unit_id`,
            message: "unit_id required",
            required: true,
          });
        }
        if ("opt" in (el ?? {}) && (el.opt === null || typeof el.opt !== "object")) {
          errors.push({
            path: `[${i}].opt`,
            message: "opt must be object when present",
            required: false,
          });
        }
      });
      return { errors };
    },
    coercion: {
      coerce(payload) {
        const drops = [];
        const backfills = [];
        let unrecoverableIdentity = false;
        if (!Array.isArray(payload)) {
          return { payload, drops, backfills, unrecoverableIdentity };
        }
        const next = payload.map((el, i) => {
          const copy = { ...el };
          // Drop invalid OPTIONAL sub-object.
          if ("opt" in copy && (copy.opt === null || typeof copy.opt !== "object")) {
            delete copy.opt;
            drops.push(`[${i}].opt`);
          }
          return copy;
        });
        // Recoverable per-element identity backfill: single-element array whose
        // sole element is missing unit_id but a uniform coordinate is known.
        const missing = next.filter(
          (el) => typeof el.unit_id !== "string" || el.unit_id.length === 0,
        );
        if (missing.length > 0) {
          if (next.length === 1 && overrides.recoverableSingle) {
            next[0].unit_id = "recovered-unit";
            backfills.push("[0].unit_id");
          } else if (next.length > 1) {
            // Multi-element missing identity → escalate, never homogenize.
            unrecoverableIdentity = true;
          }
        }
        return { payload: next, drops, backfills, unrecoverableIdentity };
      },
    },
  };
}

async function frictionIds(dir, runId) {
  try {
    const raw = JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
    return raw.frictions.map((f) => f.id);
  } catch {
    return [];
  }
}

test("clean payload: no stages beyond validate, status clean, empty warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{ unit_id: "u1" }],
      artifactsDir: dir,
      runId: "r1",
    });
    assert.equal(out.status, "clean");
    assert.deepEqual(out.stages_applied, ["validate"]);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual(out.remaining_errors, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("coercion alone clears OPTIONAL errors: status coerced, NO LLM call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  let patcherCalled = false;
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{ unit_id: "u1", opt: "not-an-object" }],
      artifactsDir: dir,
      runId: "r1",
      patcher: async (p) => {
        patcherCalled = true;
        return p;
      },
    });
    assert.equal(out.status, "coerced");
    assert.deepEqual(out.stages_applied, ["validate", "coerce"]);
    assert.equal(patcherCalled, false, "cheapest-first: no LLM when coercion suffices");
    assert.ok(out.warnings.length > 0, "warnings non-empty when status != clean");
    // Identity preserved.
    assert.equal(out.repaired_payload[0].unit_id, "u1");
    assert.ok(!("opt" in out.repaired_payload[0]), "invalid optional dropped");
    const ids = await frictionIds(dir, "r1");
    assert.ok(ids.includes("repair:test_contract:attempt-1:drop:[0].opt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverable per-element identity is backfilled (single element)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract({ recoverableSingle: true }),
      payload: [{}],
      artifactsDir: dir,
      runId: "r1",
    });
    assert.equal(out.status, "coerced");
    assert.equal(out.repaired_payload[0].unit_id, "recovered-unit");
    const ids = await frictionIds(dir, "r1");
    assert.ok(ids.includes("repair:test_contract:attempt-1:backfill:[0].unit_id"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-element missing unit_id escalates to unrepairable, never homogenized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{ unit_id: "u1" }, {}],
      artifactsDir: dir,
      runId: "r1",
      // Even with a patcher available, an unrecoverable identity short-circuits.
      patcher: async (p) => p,
    });
    assert.equal(out.status, "unrepairable");
    assert.ok(out.stages_applied.includes("redispatch"));
    assert.ok(!out.stages_applied.includes("llm_patch"), "no LLM on unrecoverable identity");
    // The second element was NOT given a sibling's id.
    assert.notEqual(out.repaired_payload[1].unit_id, "u1");
    assert.equal(out.redispatch.attempt, 2);
    assert.ok(out.warnings.length > 0);
    const ids = await frictionIds(dir, "r1");
    assert.ok(ids.includes("repair:test_contract:attempt-1:unrecoverable-identity"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded LLM patch fixes remaining REQUIRED errors: status patched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  let calls = 0;
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{}],
      artifactsDir: dir,
      runId: "r1",
      patcher: async (payload, errors) => {
        calls += 1;
        assert.ok(errors.length > 0, "patcher receives errors-only");
        return payload.map((el) => ({ ...el, unit_id: "patched-unit" }));
      },
    });
    assert.equal(out.status, "patched");
    assert.equal(calls, 1, "bounded to a single attempt by default");
    assert.deepEqual(out.stages_applied, ["validate", "coerce", "llm_patch"]);
    assert.equal(out.repaired_payload[0].unit_id, "patched-unit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LLM patch fails to fix: stage3 re-dispatch signal with advanced attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{}],
      artifactsDir: dir,
      runId: "r1",
      attempt: 1,
      patcher: async (p) => p, // no-op patch
    });
    assert.equal(out.status, "unrepairable");
    assert.deepEqual(out.stages_applied, [
      "validate",
      "coerce",
      "llm_patch",
      "redispatch",
    ]);
    assert.equal(out.redispatch.attempt, 2);
    assert.ok(out.remaining_errors.length > 0);
    const ids = await frictionIds(dir, "r1");
    assert.ok(ids.includes("repair:test_contract:attempt-1:redispatch"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no patcher supplied: required errors after coercion go straight to re-dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    const out = await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{}],
      artifactsDir: dir,
      runId: "r1",
    });
    assert.equal(out.status, "unrepairable");
    assert.ok(!out.stages_applied.includes("llm_patch"));
    assert.ok(out.stages_applied.includes("redispatch"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repeated repair (attempt > 1) records a friction event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evr-"));
  try {
    await runEmitValidateRepair({
      contract: makeContract(),
      payload: [{}],
      artifactsDir: dir,
      runId: "r1",
      attempt: 2,
    });
    const ids = await frictionIds(dir, "r1");
    assert.ok(ids.includes("repair:test_contract:attempt-2:repeated"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("seam is exported from the shared barrel", async () => {
  const shared = await import("../../src/shared/index.ts");
  assert.equal(typeof shared.runEmitValidateRepair, "function");
});

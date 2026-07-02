import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runEmitValidateRepair } = await import(
  "../../src/shared/repair/emitValidateRepair.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);
const { stepBoundaryEventId } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);

// Repair events route through the CE-005 chokepoint as `repair_round` facts with
// a CE-006 structured percent-encoded id; the discriminator is the former raw
// id suffix (`<contractId>:attempt-N:<suffix>`).
const repairId = (discriminator) =>
  stepBoundaryEventId("repair_round", "r1", discriminator);

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
    expect(out.status).toBe("clean");
    expect(out.stages_applied).toEqual(["validate"]);
    expect(out.warnings).toEqual([]);
    expect(out.remaining_errors).toEqual([]);
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
    expect(out.status).toBe("coerced");
    expect(out.stages_applied).toEqual(["validate", "coerce"]);
    expect(patcherCalled, "cheapest-first: no LLM when coercion suffices").toBe(false);
    expect(out.warnings.length > 0, "warnings non-empty when status != clean").toBeTruthy();
    // Identity preserved.
    expect(out.repaired_payload[0].unit_id).toBe("u1");
    expect(!("opt" in out.repaired_payload[0]), "invalid optional dropped").toBeTruthy();
    const ids = await frictionIds(dir, "r1");
    expect(ids.includes(repairId("test_contract:attempt-1:drop:[0].opt"))).toBeTruthy();
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
    expect(out.status).toBe("coerced");
    expect(out.repaired_payload[0].unit_id).toBe("recovered-unit");
    const ids = await frictionIds(dir, "r1");
    expect(ids.includes(repairId("test_contract:attempt-1:backfill:[0].unit_id"))).toBeTruthy();
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
    expect(out.status).toBe("unrepairable");
    expect(out.stages_applied.includes("redispatch")).toBeTruthy();
    expect(!out.stages_applied.includes("llm_patch"), "no LLM on unrecoverable identity").toBeTruthy();
    // The second element was NOT given a sibling's id.
    expect(out.repaired_payload[1].unit_id).not.toBe("u1");
    expect(out.redispatch.attempt).toBe(2);
    expect(out.warnings.length > 0).toBeTruthy();
    const ids = await frictionIds(dir, "r1");
    expect(ids.includes(repairId("test_contract:attempt-1:unrecoverable-identity"))).toBeTruthy();
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
        expect(errors.length > 0, "patcher receives errors-only").toBeTruthy();
        return payload.map((el) => ({ ...el, unit_id: "patched-unit" }));
      },
    });
    expect(out.status).toBe("patched");
    expect(calls, "bounded to a single attempt by default").toBe(1);
    expect(out.stages_applied).toEqual(["validate", "coerce", "llm_patch"]);
    expect(out.repaired_payload[0].unit_id).toBe("patched-unit");
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
    expect(out.status).toBe("unrepairable");
    expect(out.stages_applied).toEqual([
      "validate",
      "coerce",
      "llm_patch",
      "redispatch",
    ]);
    expect(out.redispatch.attempt).toBe(2);
    expect(out.remaining_errors.length > 0).toBeTruthy();
    const ids = await frictionIds(dir, "r1");
    expect(ids.includes(repairId("test_contract:attempt-1:redispatch"))).toBeTruthy();
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
    expect(out.status).toBe("unrepairable");
    expect(!out.stages_applied.includes("llm_patch")).toBeTruthy();
    expect(out.stages_applied.includes("redispatch")).toBeTruthy();
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
    expect(ids.includes(repairId("test_contract:attempt-2:repeated"))).toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("seam is exported from the shared barrel", async () => {
  const shared = await import("../../src/shared/index.ts");
  expect(typeof shared.runEmitValidateRepair).toBe("function");
});

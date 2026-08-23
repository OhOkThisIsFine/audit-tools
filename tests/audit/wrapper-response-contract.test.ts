// Wrapper response contract (CP-NODE-29): `audit-code/v1alpha1` is the JSON
// contract `audit-code next-step` hands the host agent, single-sourced as
// AuditCodeResponseSchema in src/audit/contracts/wrapperResponse.ts. This test
// pins that schema to its real seams instead of letting it float free:
//
//   - the handoff half is built by `buildAuditCodeHandoff`, the one builder
//     every emission site calls;
//   - the review-run manifest half is the exact shape `materializeReviewRun`
//     persists and `loadCurrentActiveReviewRun` re-admits through its
//     schema-derived `isActiveReviewRun` guard;
//   - the progress fields mirror `AdvanceAuditResult` (the module has no other
//     TypeScript producer);
//   - schemas/audit-code-v1alpha1.schema.json is the GENERATED projection,
//     rendered from WORKER_SCHEMA_SOURCES like the worker-facing schemas.
//
// An envelope change no producer or consumer follows fails HERE rather than
// shipping silently to hosts.

import assert from "node:assert/strict";
import { test, expect, describe } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActiveReviewRunSchema,
  AuditCodeResponseSchema,
} from "../../src/audit/contracts/wrapperResponse.js";
import { WORKER_SCHEMA_SOURCES, renderWorkerJsonSchema } from "../../src/audit/contracts/workerSchemas.js";
import {
  buildAuditCodeHandoff,
  type ActiveReviewRun,
} from "../../src/audit/supervisor/operatorHandoff.js";

const WRAPPER_CONTRACT_VERSION = "audit-code/v1alpha1" as const;

const REVIEW_RUN: ActiveReviewRun = {
  contract_version: "audit-review-run/v1alpha1",
  run_id: "run-20260823T120000Z-semantic_review_current",
  review_run_path: "/repo/.audit-tools/audit/dispatch/run-1/review-run.json",
  pending_audit_tasks_path: "/repo/.audit-tools/audit/dispatch/run-1/current-tasks.json",
  host_workload_path: "/repo/.audit-tools/audit/dispatch/run-1/host-workload.json",
  host_result_map_path: "/repo/.audit-tools/audit/dispatch/run-1/host-result-map.json",
};

/** Real handoff payload, from the builder every emission site shares. */
function buildBlockedHandoff() {
  return buildAuditCodeHandoff({
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    state: {
      status: "blocked",
      last_executor: "semantic_review_executor",
      last_obligation: "semantic_review_current",
      blockers: [],
      obligations: [
        { id: "semantic_review_current", state: "blocked", reason: "awaiting host results" },
      ],
    },
    bundle: {},
    progressSummary: "Semantic-review work is ready for host execution.",
    activeReviewRun: REVIEW_RUN,
  });
}

function buildEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: WRAPPER_CONTRACT_VERSION,
    audit_state: {
      status: "blocked",
      last_executor: "semantic_review_executor",
      last_obligation: "semantic_review_current",
      blockers: [],
      obligations: [
        { id: "semantic_review_current", state: "blocked", reason: "awaiting host results" },
      ],
    },
    selected_obligation: "semantic_review_current",
    selected_executor: "semantic_review_executor",
    progress_made: true,
    artifacts_written: ["/repo/.audit-tools/audit/operator-handoff.json"],
    progress_summary: "Paused for semantic-review host execution.",
    next_likely_step: null,
    handoff: buildBlockedHandoff(),
    ...overrides,
  };
}

describe("wrapper response contract (audit-code/v1alpha1)", () => {
  test("accepts the builder-assembled envelope", () => {
    const parsed = AuditCodeResponseSchema.parse(buildEnvelope());
    expect(parsed.handoff?.active_review_run?.run_id).toBe(REVIEW_RUN.run_id);
    expect(parsed.audit_state.status).toBe("blocked");
  });

  test("accepts a complete-state envelope with no handoff", () => {
    assert.doesNotThrow(() =>
      AuditCodeResponseSchema.parse(
        buildEnvelope({
          audit_state: {
            status: "complete",
            obligations: [{ id: "synthesis_narrative_current", state: "satisfied" }],
          },
          selected_obligation: null,
          selected_executor: null,
          progress_made: true,
          next_likely_step: null,
          handoff: undefined,
        }),
      ),
    );
  });

  test("rejects envelope drift on every axis the .strict() source declares", () => {
    const base = buildEnvelope();
    // Wrong envelope version.
    expect(
      AuditCodeResponseSchema.safeParse({ ...base, contract_version: "audit-code/v1beta1" })
        .success,
    ).toBe(false);
    // Unknown top-level key.
    expect(AuditCodeResponseSchema.safeParse({ ...base, prompt_content: "x" }).success).toBe(false);
    // Non-canonical audit_state status / obligation state.
    expect(
      AuditCodeResponseSchema.safeParse({ ...base, audit_state: { ...base.audit_state, status: "bogus" } })
        .success,
    ).toBe(false);
    expect(
      AuditCodeResponseSchema.safeParse({
        ...base,
        audit_state: {
          ...base.audit_state,
          obligations: [{ id: "o", state: "finished" }],
        },
      }).success,
    ).toBe(false);
    // progress_made must be boolean; artifacts_written must be strings.
    expect(AuditCodeResponseSchema.safeParse({ ...base, progress_made: "yes" }).success).toBe(false);
    expect(AuditCodeResponseSchema.safeParse({ ...base, artifacts_written: [1] }).success).toBe(false);
    // A handoff carrying an unversioned review run is rejected.
    expect(
      AuditCodeResponseSchema.safeParse({
        ...base,
        handoff: { ...base.handoff, active_review_run: { ...REVIEW_RUN, contract_version: "v2" } },
      }).success,
    ).toBe(false);
  });
});

describe("active review-run manifest (the guard's source)", () => {
  test("accepts exactly the shape materializeReviewRun persists", () => {
    expect(ActiveReviewRunSchema.parse(REVIEW_RUN)).toEqual(REVIEW_RUN);
  });

  test("rejects what loadCurrentActiveReviewRun must refuse", () => {
    expect(ActiveReviewRunSchema.safeParse(null).success).toBe(false);
    expect(ActiveReviewRunSchema.safeParse([REVIEW_RUN]).success).toBe(false);
    expect(
      ActiveReviewRunSchema.safeParse({ ...REVIEW_RUN, host_result_map_path: undefined }).success,
    ).toBe(false);
    expect(ActiveReviewRunSchema.safeParse({ ...REVIEW_RUN, run_id: 7 }).success).toBe(false);
    // Strict: an extra key is a foreign manifest generation, not ours.
    expect(ActiveReviewRunSchema.safeParse({ ...REVIEW_RUN, legacy_field: true }).success).toBe(false);
  });
});

describe("generated schemas/audit-code-v1alpha1.schema.json projection", () => {
  const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

  test("stays registered in WORKER_SCHEMA_SOURCES", () => {
    const entry = WORKER_SCHEMA_SOURCES["audit-code-v1alpha1.schema.json"];
    expect(entry, "wrapper envelope must render into the generated schemas dir").toBeDefined();
    const rendered = renderWorkerJsonSchema("audit-code-v1alpha1.schema.json");
    expect(rendered.$id).toBe("audit-code-v1alpha1.schema.json");
    expect(JSON.stringify(rendered)).toContain(WRAPPER_CONTRACT_VERSION);
  });

  test("committed projection matches its zod source", async () => {
    const { readFile } = await import("node:fs/promises");
    const committed = JSON.parse(
      await readFile(join(schemasDir, "audit-code-v1alpha1.schema.json"), "utf8"),
    );
    expect(committed).toEqual(renderWorkerJsonSchema("audit-code-v1alpha1.schema.json"));
  });
});

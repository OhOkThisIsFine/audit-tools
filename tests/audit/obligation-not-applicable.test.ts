import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

const { deriveAuditState } = await import(
  "../../src/audit/orchestrator/state.js"
);
const { buildAuditCodeHandoff } = await import(
  "../../src/audit/supervisor/operatorHandoff.js"
);
const { ObligationStateSchema } = await import(
  "../../src/shared/engine/obligationEngine.js"
);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("non-actionable obligations", () => {
  it("does not revive retired executor obligations from historical artifacts", () => {
    const bundle: ArtifactBundle = {
      audit_tasks: [],
      runtime_validation_tasks: { tasks: [{
        id: "historical-runtime-check", kind: "unit-risk-check",
        target_paths: ["src/fixture.ts"], reason: "Archived evidence.", priority: "medium",
      }] },
    };
    const ids = deriveAuditState(bundle).obligations.map(({ id }) => id);
    expect(ids).not.toContain("audit_results_ingested");
    expect(ids).not.toContain("runtime_validation_current");
    expect(ids).toEqual(expect.arrayContaining([
      "planning_artifacts", "audit_tasks_completed", "synthesis_current", "synthesis_narrative_current",
    ]));
  });

  it("does not report a not_applicable obligation as PENDING on the operator handoff", () => {
    // <!-- comment-citation-exempt: names the literal set this test's fix replaced -->
    // `NON_PENDING_OBLIGATION_STATES` was a `Set<ObligationState>` LITERAL, so
    // widening the union is not a compile error there: a new non-actionable
    // member silently falls through to pending and ships on the host-facing
    // handoff. Pending is now DERIVED from the engine's actionable states, so
    // there is no second list to widen.
    const handoff = buildAuditCodeHandoff({
      root: "/repo",
      artifactsDir: "/repo/.audit-tools/audit",
      state: {
        status: "active",
        obligations: [
          { id: "synthesis_narrative_current", state: "not_applicable" },
          { id: "synthesis_current", state: "missing" },
        ],
      } as AuditState,
      bundle: {} as ArtifactBundle,
      progressSummary: "",
    });

    expect(handoff.pending_obligations).toEqual(["synthesis_current"]);
  });

  it("keeps the SHIPPED host-facing schema's obligation enum equal to the source of truth", async () => {
    // schemas/audit-code-v1alpha1.schema.json is a GENERATED projection of
    // `ObligationViewSchema`, which hand-copied the five state names. A
    // persisted audit_state.json now carries `not_applicable` while that
    // projection would refuse it — the hand-copied-vocabulary drift class the
    // lens registry's header exists to record.
    const shipped = JSON.parse(
      await readFile(
        join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const definitions = shipped as {
      properties: {
        audit_state: {
          properties: {
            obligations: {
              items: { properties: { state: { enum: string[] } } };
            };
          };
        };
      };
    };
    expect(
      definitions.properties.audit_state.properties.obligations.items.properties
        .state.enum,
    ).toEqual([...ObligationStateSchema.options]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  createNextStepHarness,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-outcomes-contract");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } = harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});
describe("decideNextStep — retryable remediation-outcomes contract", () => {
    const OUTCOMES_PATH = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");

    function makeFinding(
      id: string,
      title: string,
      lens: string,
      path: string,
    ): NonNullable<RemediationState["plan"]>["findings"][number] {
      return {
        id,
        title,
        category: lens,
        severity: "high",
        confidence: "high",
        lens,
        summary: `Fix ${title.toLowerCase()}.`,
        affected_files: [{ path }],
        evidence: [`${path}:1 evidence`],
      };
    }

    function makeItemSpec(findingId: string, file: string) {
      return {
        finding_id: findingId,
        concrete_change: `fix ${file}`,
        no_change: false,
        touched_files: [file],
        tests_to_write: [{ name: `${findingId} regression`, assertions: ["holds"] }],
        not_applicable_steps: [],
      };
    }

    function makeRetryableClosingState(): RemediationState {
      return {
        status: "closing",
        plan: {
          plan_id: "PLAN-RETRY",
          findings: [
            makeFinding("F-001", "First", "correctness", "src/a.ts"),
            makeFinding("F-002", "Second", "security", "src/b.ts"),
            makeFinding("F-003", "Third", "tests", "src/c.ts"),
            makeFinding("F-004", "Fourth", "maintainability", "src/d.ts"),
          ],
          blocks: [
            { block_id: "B-001", items: ["F-001"], parallel_safe: true },
            {
              block_id: "B-002",
              items: ["F-002"],
              parallel_safe: false,
              dependencies: ["B-001"],
            },
            { block_id: "B-003", items: ["F-003", "F-004"], parallel_safe: true },
          ],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items: {
          "F-001": {
            finding_id: "F-001",
            status: "resolved",
            block_id: "B-001",
            item_spec: makeItemSpec("F-001", "src/a.ts"),
          },
          "F-002": {
            finding_id: "F-002",
            status: "blocked",
            block_id: "B-002",
            item_spec: makeItemSpec("F-002", "src/b.ts"),
            failure_reason: "Implementation failed: unit tests did not pass.",
          },
          "F-003": {
            finding_id: "F-003",
            status: "ignored",
            block_id: "B-003",
            failure_reason: "Ignored by user decision.",
          },
          "F-004": {
            finding_id: "F-004",
            status: "deemed_inappropriate",
            block_id: "B-003",
            // No failure_reason on purpose: skipped entries must still carry a
            // non-empty reason in the outcomes contract.
          },
        },
        closing_plan: { action: "none" },
      } as RemediationState;
    }

    async function readOutcomesReport(): Promise<any> {
      return JSON.parse(await readFile(OUTCOMES_PATH, "utf8"));
    }

    it("every terminal item carries its full finding payload, item-spec summary, block refs, and final status", async () => {
      const state = makeRetryableClosingState();
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing state runs close and returns present_report in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const byId = new Map<string, any>(
        report.outcomes.map((entry: any) => [entry.finding_id, entry]),
      );

      // (a) Full original Finding payload, identical to the planned finding.
      for (const finding of state.plan!.findings) {
        expect(byId.get(finding.id)?.finding).toEqual(finding);
      }

      // (b) Item-spec summary matching the documented ItemSpec.
      expect(byId.get("F-001")?.item_spec).toEqual({
        concrete_change: "fix src/a.ts",
        no_change: false,
        touched_files: ["src/a.ts"],
        tests_to_write: ["F-001 regression"],
      });
      expect(byId.get("F-002")?.item_spec).toEqual({
        concrete_change: "fix src/b.ts",
        no_change: false,
        touched_files: ["src/b.ts"],
        tests_to_write: ["F-002 regression"],
      });

      // (c) Owning block id and that block's dependency ids.
      expect(byId.get("F-001")?.block_id).toBe("B-001");
      expect(byId.get("F-001")?.block_dependencies).toEqual([]);
      expect(byId.get("F-002")?.block_id).toBe("B-002");
      expect(byId.get("F-002")?.block_dependencies).toEqual(["B-001"]);
      expect(byId.get("F-003")?.block_id).toBe("B-003");

      // (d) Final status per terminal state.
      expect(byId.get("F-001")?.final_status).toBe("fixed");
      expect(byId.get("F-002")?.final_status).toBe("failed");
      expect(byId.get("F-003")?.final_status).toBe("ignored");
      expect(byId.get("F-004")?.final_status).toBe("skipped");

      // (e) Skipped and ignored items each carry a non-empty reason.
      expect(byId.get("F-003")?.reason).toBeTruthy();
      expect(byId.get("F-003")?.reason).toMatch(/ignored by user decision/i);
      expect(byId.get("F-004")?.reason).toBeTruthy();
    });

    it("force-close records non-terminal items as failed with the original state preserved", async () => {
      const state = makeRetryableClosingState();
      state.items!["F-002"] = {
        finding_id: "F-002",
        status: "pending",
        block_id: "B-002",
        item_spec: makeItemSpec("F-002", "src/b.ts"),
      };
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const entry = report.outcomes.find((e: any) => e.finding_id === "F-002");
      expect(entry?.final_status).toBe("failed");
      expect(entry?.outcome).toBe("blocked");
      expect(entry?.original_state).toBe("pending");
      expect(entry?.reason).toMatch(/force-closed/i);
      expect(entry?.reason).toMatch(/non-terminal/i);
      expect(entry?.reason).toMatch(/pending/);
      // The force-closed item still carries its full payload for retry.
      expect(entry?.finding?.id).toBe("F-002");
    });

    it("never-planned findings appear in the coverage-ledger section with payloads and drop reasons", async () => {
      const fPlanned = makeFinding("F-001", "First", "correctness", "src/a.ts");
      const fDup = makeFinding("F-DUP", "First duplicate", "security", "src/a.ts");
      const fChk = makeFinding("F-CHK", "Checkpointed", "tests", "src/c.ts");

      // The structured-audit intake source is the payload authority for findings
      // that were dropped before the plan was written.
      const sourcePath = join(REPO_DIR, "audit-findings.json");
      await writeFile(
        sourcePath,
        JSON.stringify({
          contract_version: "audit-tools/audit-findings/v1alpha1",
          findings: [fPlanned, fDup, fChk],
          work_blocks: [],
        }),
        "utf8",
      );
      const intakeDir = join(ARTIFACTS_DIR, "intake");
      await mkdir(intakeDir, { recursive: true });
      await writeFile(
        join(intakeDir, "source-manifest.json"),
        JSON.stringify({
          schema_version: "remediate-code-intake-source-manifest/v1alpha1",
          created_from: "input",
          sources: [
            { type: "structured_audit", path: sourcePath, label: "audit-findings" },
          ],
        }),
        "utf8",
      );

      const state: RemediationState = {
        status: "closing",
        plan: {
          plan_id: "PLAN-COVERAGE",
          findings: [fPlanned],
          blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items: {
          "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
        },
        closing_plan: { action: "none" },
        plan_coverage: {
          contract_version: "remediate-code-coverage/v1alpha1",
          plan_id: "PLAN-COVERAGE",
          source_finding_count: 3,
          planned_count: 1,
          folded_count: 1,
          dropped_count: 0,
          checkpoint_dropped_count: 1,
          phantom_dropped_count: 0,
          entries: [
            {
              finding_id: "F-001",
              title: "First",
              disposition: "planned",
              block_id: "B-001",
            },
            {
              finding_id: "F-DUP",
              title: "First duplicate",
              disposition: "folded_into",
              folded_into: "F-001",
            },
            {
              finding_id: "F-CHK",
              title: "Checkpointed",
              disposition: "dropped_by_checkpoint",
              rationale:
                "Finding excluded by the intent checkpoint (filter or excluded scope).",
            },
          ],
        },
      } as RemediationState;
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      const report = await readOutcomesReport();
      const coverageEntries: any[] = report.plan_coverage.entries;

      const dup = coverageEntries.find((e) => e.finding_id === "F-DUP");
      expect(dup?.drop_reason).toBe("cross_lens_dedup");
      expect(dup?.finding).toEqual(fDup);

      const chk = coverageEntries.find((e) => e.finding_id === "F-CHK");
      expect(chk?.drop_reason).toBe("intent_checkpoint");
      expect(chk?.finding).toEqual(fChk);

      // No planned-or-dropped finding id from intake is absent from the union of
      // item entries and the coverage-ledger section.
      const recordedIds = new Set<string>([
        ...report.outcomes.map((e: any) => e.finding_id),
        ...coverageEntries.map((e) => e.finding_id),
      ]);
      for (const id of ["F-001", "F-DUP", "F-CHK"]) {
        expect(recordedIds.has(id)).toBe(true);
      }
    });

    it("close writes the enriched outcomes before deleting state.json", async () => {
      const state = makeRetryableClosingState();
      await saveState(state);
      await acknowledgeResume();
      await writeIntentCheckpoint();

      // Folded: closing runs to completion in one call.
      const step = await decideNextStep({ root: REPO_DIR });
      expect(step.step_kind).toBe("present_report");

      // This state has a `blocked` item (F-002), so the run is NOT fully green:
      // the CE-003 force-close guard PRESERVES the artifacts dir (state.json
      // survives) for diagnosis rather than landing a blocked suite as "complete
      // and green". The durable outcomes file is still written, from the live
      // pre-cleanup state, carrying payloads that exist only in state.json.
      expect(existsSync(join(ARTIFACTS_DIR, "state.json"))).toBe(true);
      const report = await readOutcomesReport();
      expect(report.outcomes).toHaveLength(4);
      for (const entry of report.outcomes) {
        expect(entry.finding?.id).toBe(entry.finding_id);
        expect(entry.finding?.summary).toBeTruthy();
        expect(entry.block_id).toBeTruthy();
      }
    });
});

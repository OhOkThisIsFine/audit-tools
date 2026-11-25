import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
// sites-pinned: tests/audit/audit-cli-correctness.test.ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_FINDINGS_FILENAME, AUDIT_REPORT_FILENAME, auditToolsDir, writeTextFile } from "audit-tools/shared";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAcceptedAnswer, type ReviewFindingClaim, type ReviewPlan } from "../../shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";
import { buildQuestionAuditFindingsReport } from "../reporting/questionReport.js";
import { renderAuditReportMarkdown } from "../reporting/synthesis.js";
import { getArtifactsDir, getFlag, getRootDir, hasFlag } from "./args.js";
import { outputJson } from "./cliHelpers.js";

const version = { schema_version: REVIEW_QUESTION_CONTRACT_VERSION } as const;
const identity = { ...version, question_id: "sample-review-queue", revision_id: "sample-v1", snapshot_id: "fabricated-sample" };
const source = { path: "src/queue.ts", start_line: 12, end_line: 16 };
const dependency = { kind: "source", key: source.path, fingerprint: "fabricated-queue-v1" } as const;

/** Benign fabricated finding for the README generator, not a finding in any real repository. */
export const SAMPLE_REPORT_FINDING: ReviewFindingClaim = {
  ...version, question_id: identity.question_id, revision_id: identity.revision_id, finding_id: "sample-queue-001",
  kind: "confirmed_defect", observation_ids: ["sample-source-observation"], severity: "medium", confidence: "high",
  claim: "Queue summary omits pending entries",
  consequence: "The reported total differs from the number of queued entries.",
  next_step: "Count pending entries in the same total.",
  source_refs: [source], evidence_ids: [],
  verification: [{ kind: "assertion", obligation_id: "queue-summary-total", expected: "Both ready and pending entries count toward the total.", source_refs: [source] }],
};

/** Fabricate only inputs to the production v2 report projection; never a live ledger or planner. */
export function buildSampleAuditBundle(findings: ReviewFindingClaim[] = []) {
  const part = { part_id: "queue-summary", expectation: "Count every queued entry once." };
  const plan: ReviewPlan = {
    ...version, snapshot_id: identity.snapshot_id,
    inventory: [{ inventory_item_id: "sample-queue", kind: "operation", title: "Synthetic queue summary",
      contract_refs: [], source_refs: [source], scope: "in_scope" }],
    questions: [{ ...identity, lens: "behavior", inventory_item_ids: ["sample-queue"],
      expected_outcome: part.expectation, requested_parts: [part],
      plan_status: "active", source_dependencies: [dependency], evidence_dependencies: [] }],
    lens_decisions: [{ lens: "behavior", decision: "selected", reason: "Illustrative fabricated fixture only; no repository was inspected." }],
    omissions: [],
  };
  const accepted: ReviewAcceptedAnswer[] = findings.length === 0 ? [] : [{
    ...version, accepted_at: "2026-01-01T00:00:00.000Z", dependency_bindings: [dependency],
    submission: {
      ...identity, assignment_id: "sample-assignment", submission_id: "sample-answer",
      inspected_sources: [source], evidence_ids: [], limitations: ["Fabricated source evidence for documentation; no runtime check was executed."],
      answer: {
        outcome: "findings", findings,
        parts: [{ part_id: part.part_id, outcome: "findings", observation_ids: ["sample-source-observation"] }],
        observations: [{ ...identity, observation_id: "sample-source-observation", part_id: part.part_id,
          kind: "source_confirmed", statement: "The fabricated counter includes ready entries only.", source_refs: [source], evidence_refs: [] }],
      },
    },
  }];
  const auditFindings = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted, evidence: [], dependenciesByQuestion: new Map([[identity.question_id, [dependency]]]), auditRead: null,
  }));
  return { plan, auditFindings, auditReport: renderAuditReportMarkdown(auditFindings) };
}

export async function runSample(argv: string[] = process.argv): Promise<void> {
  const artifactsDir = getFlag(argv, "--artifacts-dir") === undefined
    ? join(auditToolsDir(getRootDir(argv)), "sample")
    : getArtifactsDir(argv);
  await withArtifactTreeHold(artifactsDir, undefined, async assertOwnership => {
    await assertNoPendingFoldReceipt(artifactsDir);
    const { auditFindings, auditReport } = buildSampleAuditBundle();
    const findingsPath = join(artifactsDir, AUDIT_FINDINGS_FILENAME);
    const reportPath = join(artifactsDir, AUDIT_REPORT_FILENAME);
    const findingsText = JSON.stringify(auditFindings, null, 2) + "\n";
    const force = hasFlag(argv, "--force");
    const findingsExist = existsSync(findingsPath);
    if (!force) {
      const protectedNames = ["audit_state.json", "review_session.json", "review_plan.json", AUDIT_REPORT_FILENAME];
      // Normal publication writes findings first. Resume only the exact
      // deterministic sample output, never an unrelated partial or an audit.
      if (protectedNames.some(name => existsSync(join(artifactsDir, name))) ||
          (findingsExist && !(await readFile(findingsPath)).equals(Buffer.from(findingsText)))) {
        console.error("Refusing to overwrite an audit state or report. Use --force only for a disposable sample target.");
        process.exitCode = 1;
        return;
      }
    }
    if (force || !findingsExist) {
      await assertOwnership();
      await writeTextFile(findingsPath, findingsText);
    }
    await assertOwnership();
    await writeTextFile(reportPath, auditReport);
    outputJson({ sample: true, artifacts_dir: artifactsDir, findings: findingsPath, report: reportPath });
  });
}

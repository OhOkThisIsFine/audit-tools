import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import type { ReviewAssignment, ReviewQuestion } from "../../src/shared/types/reviewQuestion.js";
import { test, expect } from "vitest";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Disk-load + staleness wiring for the opt-in worker feedback channel
// (agent-feedback.jsonl → bundle.agent_reflections → "Process Feedback").
// Workers own the file; the orchestrator only reads it. The feedback file is
// deliberately NOT a registry artifact: persist must never rewrite or prune it,
// and a change to it must re-stale exactly one downstream (audit-report.md).

import type { AgentReflection } from "audit-tools/shared";

const { loadArtifactBundle, writeCoreArtifacts, getArtifactValue, hasCurrentQuestionReport } =
  await import("../../src/audit/io/artifacts.js");
const { computeArtifactMetadata } = await import("../../src/audit/orchestrator/artifactMetadata.js");
const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
const { runSynthesisExecutor } = await import("../../src/audit/orchestrator/synthesisExecutors.js");
const { renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.js");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

const FEEDBACK_FILE = "agent-feedback.jsonl";

const REFLECTION: AgentReflection = {
  task_id: "u:security",
  lens: "security",
  instruction_clarity: "ambiguous",
  severity: "medium",
  tool_friction: ["packet path was stale"],
};

test("loadArtifactBundle parses agent-feedback.jsonl leniently and persist never touches it", async () => {
  await withTempDir("audit-code-feedback-", async (dir) => {
    // Absent file → no bundle key (normal, non-meta-audit runs unaffected).
    expect((await loadArtifactBundle(dir)).agent_reflections).toBe(undefined);

    const raw =
      JSON.stringify(REFLECTION) +
      "\n" +
      "not json — worker scribble\n" +
      JSON.stringify({ task_id: "u:tests", instruction_clarity: "clear", severity: "info" }) +
      "\n";
    await writeFile(join(dir, FEEDBACK_FILE), raw);

    const bundle = await loadArtifactBundle(dir);
    expect(bundle.agent_reflections?.length).toBe(2);
    expect(bundle.agent_reflections![0].task_id).toBe("u:security");

    // The staleness machinery resolves the pseudo-artifact by file name.
    expect(getArtifactValue(bundle, FEEDBACK_FILE)).toBe(bundle.agent_reflections);

    // Workers own the file: a full persist — even pruning, even with the key
    // absent from the written bundle — must leave the raw bytes untouched
    // (a rewrite would drop the malformed-but-human-readable line; a prune
    // would delete lines appended after load).
    await writeCoreArtifacts(dir, { repo_manifest: { repository: { name: "t" }, generated_at: "t", files: [] } }, { prune: true });
    expect(await readFile(join(dir, FEEDBACK_FILE), "utf8")).toBe(raw);
  });
});

test("capability preflight reflections render as detailed audit limitations", () => {
  const preflight: AgentReflection = {
    task_id: "audit-capability-preflight",
    instruction_clarity: "clear",
    severity: "high",
    tool_friction: ["No structural graph tool was available on this host."],
    ambiguities: ["Coverage of call relationships could not be established."],
    suggestions: ["Run a structural-capability-enabled host before claiming comprehensive coverage."],
  };
  const run = runSynthesisExecutor({ coverage_matrix: { files: [] }, agent_reflections: [REFLECTION, preflight] }, undefined, { auditRead: null });
  expect(run.updated.audit_report).toMatch(/## Audit Limitations/);
  expect(run.updated.audit_report).toMatch(/No structural graph tool was available/);
  expect(run.updated.audit_report).toMatch(/## Process Feedback[\s\S]*packet path was stale/);
  expect((run.updated.audit_report?.match(/## Audit Limitations/g) ?? []).length).toBe(1);
});

test("audit limitations precede process feedback when drift is present", () => {
  const preflight: AgentReflection = { task_id: "audit-capability-preflight", instruction_clarity: "clear", severity: "critical", tool_friction: ["missing graph"] };
  const report = renderAuditReportMarkdown({ summary: { finding_count: 0, work_block_count: 0, severity_breakdown: {}, audited_file_count: 0, excluded_file_count: 0, runtime_validation_status_breakdown: {} }, findings: [], work_blocks: [], work_block_seams: [] }, {
    reflections: [preflight],
    submission_ledger: [{ contract_version: "submission-ledger-event/v1alpha1", run_id: "r", submission_id: "s", lane: "x", kind: "rejected", recorded_at: "2026-01-01T00:00:00Z", issue_code: "submission_rejected" }],
  });
  expect(report.indexOf("## Audit Limitations")).toBeLessThan(report.indexOf("## Process Feedback"));
  expect(report).toMatch(/## Audit Limitations[\s\S]*missing graph/);
  expect(report).toMatch(/## Process Feedback[\s\S]*Submission drift/);
});

test("synthesis renders Process Feedback from bundle reflections; machine contract carries none", () => {
  const run = runSynthesisExecutor(
    { coverage_matrix: { files: [] }, agent_reflections: [REFLECTION] },
    undefined,
    { auditRead: null },
  );
  expect(run.updated.audit_report).toMatch(/## Process Feedback/);
  expect(run.updated.audit_report).toMatch(/packet path was stale/);
  // audit-findings.json is the machine contract — reflections are render-only.
  expect(!JSON.stringify(run.updated.audit_findings).includes("packet path was stale"), "reflections must not leak into audit-findings.json").toBeTruthy();

  const without = runSynthesisExecutor({ coverage_matrix: { files: [] } }, undefined, { auditRead: null });
  expect(without.updated.audit_report).not.toMatch(/## Process Feedback/);
});

test("changed reflections re-stale audit-report.md exactly once; unchanged reflections never churn", () => {
  // Simulate the advance-loop metadata flow: agent-feedback.jsonl is in the
  // always-updated set (no executor ever lists it in artifacts_written).
  const alwaysUpdated = ["audit-report.md", FEEDBACK_FILE];

  const synthesized = { audit_report: "# Audit Report\n", agent_reflections: [REFLECTION] };
  const metadata = computeArtifactMetadata(synthesized, undefined, alwaysUpdated);
  expect(metadata.artifacts[FEEDBACK_FILE], "feedback gets a metadata entry when present").toBeTruthy();

  // Converged: same content re-hashed on a later advance → nothing stale.
  const settled = computeArtifactMetadata({ ...synthesized, artifact_metadata: metadata }, metadata, [FEEDBACK_FILE]);
  expect(settled.artifacts[FEEDBACK_FILE].revision, "unchanged feedback must keep its revision").toBe(metadata.artifacts[FEEDBACK_FILE].revision);
  expect(computeStaleArtifacts({ ...synthesized, artifact_metadata: metadata }).size).toBe(0);

  // A worker appends a reflection → only the report re-stales.
  const appendedReflection: AgentReflection = { task_id: "u:tests", instruction_clarity: "unclear", severity: "high" };
  const appended = {
    ...synthesized,
    agent_reflections: [...synthesized.agent_reflections, appendedReflection],
    artifact_metadata: metadata,
  };
  const stale = computeStaleArtifacts(appended);
  expect([...stale]).toEqual(["audit-report.md"]);

  // Re-synthesis records the new feedback revision → converged again.
  const afterResynthesis = computeArtifactMetadata(appended, metadata, alwaysUpdated);
  expect(computeStaleArtifacts({ ...appended, artifact_metadata: afterResynthesis }).size, "one re-synthesis must fully converge").toBe(0);

  // No feedback file at all: the report records the dependency at revision 0
  // and stays satisfied (normal runs see zero behavior change).
  const noFeedback = { audit_report: "# Audit Report\n" };
  const noFeedbackMetadata = computeArtifactMetadata(noFeedback, undefined, alwaysUpdated);
  expect(noFeedbackMetadata.artifacts["audit-report.md"].dependency_revisions[FEEDBACK_FILE]).toBe(0);
  expect(computeStaleArtifacts({ ...noFeedback, artifact_metadata: noFeedbackMetadata }).size).toBe(0);
});

// Exercise the real question-review next-step loop and promoted pair.
test("a reflection appended after synthesis re-synthesizes once and the run still converges", async () => {
  await withTempRepo(async (root) => {
    const call = async (...args: string[]) => JSON.parse((await runWrapper(args, { cwd: root })).stdout);
    const artDir = join(root, ".audit-tools", "audit");
    const reportPath = join(artDir, "audit-report.md");
    const findingsPath = join(artDir, "audit-findings.json");
    const dispatch = await advancePastDesignReview(root);
    expect(dispatch.step_kind).toBe("dispatch_review");
    const workload = JSON.parse(await readFile(dispatch.artifact_paths.host_workload, "utf8")) as {
      contract_version: string; run_id: string;
      work_items: { binding: { question: ReviewQuestion; assignment: ReviewAssignment } }[];
    };
    expect(workload.work_items.length).toBeGreaterThan(0);
    const submissionPath = join(root, "feedback-smoke-answer.json");
    const submissions: string[] = [];
    for (const { binding: { question, assignment } } of workload.work_items) {
      const submission_id = `feedback-${assignment.assignment_id}`;
      await writeFile(submissionPath, JSON.stringify({
        schema_version: workload.contract_version, submission_id, assignment_id: assignment.assignment_id,
        question_id: question.question_id, revision_id: question.revision_id, snapshot_id: question.snapshot_id,
        inspected_sources: [], evidence_ids: [], limitations: ["Synthetic feedback fixture."],
        answer: { outcome: "inconclusive", findings: [], observations: [],
          parts: question.requested_parts.map(({ part_id }) => ({
            part_id, outcome: "inconclusive", observation_ids: [], reason: "No behavioral observation.",
          })) },
      }));
      const receipt = await call("submit", "--work-item", assignment.assignment_id, "--from", submissionPath);
      expect(receipt.disposition).toBe("accepted");
      submissions.push(submission_id);
    }

    const before = await call("next-step");
    expect(before.step_kind).toBe("synthesis_narrative");
    expect(await hasCurrentQuestionReport(artDir)).toBe(true);
    expect(await readFile(reportPath, "utf8")).not.toMatch(/## Process Feedback/);
    const machine = await readFile(findingsPath, "utf8");
    expect(JSON.parse(machine).question_review.accepted.map(
      (entry: { submission: { submission_id: string } }) => entry.submission.submission_id,
    ).sort()).toEqual(submissions.sort());
    const ledgerPath = join(artDir, "runs", workload.run_id, "host-accepted-results-ledger.json");
    const ledger = await readFile(ledgerPath, "utf8");

    await appendFile(join(artDir, FEEDBACK_FILE), JSON.stringify(REFLECTION) + "\nworker crashed mid-line{\n");
    expect(await hasCurrentQuestionReport(artDir)).toBe(false);
    const resynthesized = await call("next-step");
    expect(resynthesized.step_kind).toBe("synthesis_narrative");
    expect(await hasCurrentQuestionReport(artDir)).toBe(true);
    const rendered = await readFile(reportPath, "utf8");
    expect(rendered.match(/## Process Feedback/g)).toHaveLength(1);
    expect(rendered.match(/packet path was stale/g)).toHaveLength(1);
    expect(await readFile(findingsPath, "utf8")).toBe(machine);

    await appendFile(join(artDir, FEEDBACK_FILE), "malformed-only-line{\n");
    expect(await hasCurrentQuestionReport(artDir)).toBe(true);
    const unchanged = await call("next-step");
    expect(unchanged.step_kind).toBe("synthesis_narrative");
    expect(await readFile(reportPath, "utf8")).toBe(rendered);
    const narrativePath = unchanged.artifact_paths.synthesis_narrative_results;
    await mkdir(dirname(narrativePath), { recursive: true });
    await writeFile(narrativePath, JSON.stringify({ themes: [], top_risks: [] }));

    const trail: string[] = [];
    let complete = false;
    for (let i = 0; i < 8; i++) {
      const step = await call("next-step");
      trail.push(`${step.step_kind}:${step.status}`);
      if (step.step_kind === "present_report" && step.status === "complete") { complete = true; break; }
      const friction = step.artifact_paths?.friction_record;
      if (step.step_kind === "present_report" && friction) {
        const existing = JSON.parse(await readFile(friction, "utf8").catch(() => "{}"));
        existing.category_attestations = ["ambiguous_direction", "tool_should_decide", "inefficient_feeding"]
          .map(category => ({ category, note: "Synthetic feedback fixture." }));
        await mkdir(dirname(friction), { recursive: true });
        await writeFile(friction, JSON.stringify(existing));
      }
    }
    expect(complete, trail.join(" -> ")).toBe(true);
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toBe(rendered);
    expect(await readFile(join(root, ".audit-tools", "audit-findings.json"), "utf8")).toBe(machine);
    expect(await readFile(ledgerPath, "utf8")).toBe(ledger);
    expect(await readFile(join(root, ".audit-tools", "audit-agent-feedback.jsonl"), "utf8"))
      .toBe(await readFile(join(artDir, FEEDBACK_FILE), "utf8"));
    expect(await hasCurrentQuestionReport(artDir)).toBe(true);
    await call("resynthesize");
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toBe(rendered);
  });
});

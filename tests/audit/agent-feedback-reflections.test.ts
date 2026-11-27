import { advanceToDispatchReady, callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { presentQuestionReport, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { cmdResynthesize } from "../../src/audit/cli/resynthesizeCommand.js";
import { test, expect } from "vitest";
import { writeFile, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

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
  const markdown = renderAuditReportMarkdown({ summary: { finding_count: 0, work_block_count: 0, severity_breakdown: {}, audited_file_count: 0, excluded_file_count: 0, runtime_validation_status_breakdown: {} }, findings: [], work_blocks: [], work_block_seams: [] }, { reflections: [REFLECTION, preflight] });
  expect(markdown).toMatch(/## Audit Limitations/);
  expect(markdown).toMatch(/No structural graph tool was available/);
  expect(markdown).toMatch(/## Process Feedback[\s\S]*packet path was stale/);
  expect((markdown?.match(/## Audit Limitations/g) ?? []).length).toBe(1);
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

// Exercise the real review loop once for feedback refresh, narrative admission and terminal promotion.
test("feedback refreshes one paused synthesis before narrative and reports are promoted", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const workload = await readQuestionWorkload(await advanceToDispatchReady(root));
    const answers = await submitQuestions(root, workload.work_items);
    const index = workload.work_items.findIndex(item => item.binding.assignment.suggested_sources
      .some(ref => ref.path === "src/api/auth.ts"));
    expect(index).toBeGreaterThanOrEqual(0);
    const item = workload.work_items[index]!;
    const submitted = answers[index]!;
    const source = { path: "src/api/auth.ts", start_line: 1 };
    const part = item.binding.question.requested_parts[0]!;
    const observationId = "auth-source-observation";
    const findingAnswer: ReviewSubmission = {
      ...submitted,
      inspected_sources: [source],
      limitations: [],
      answer: {
        outcome: "findings",
        observations: [{
          schema_version: submitted.schema_version,
          question_id: submitted.question_id, revision_id: submitted.revision_id, snapshot_id: submitted.snapshot_id,
          observation_id: observationId, part_id: part.part_id, kind: "source_confirmed",
          statement: "The fixture checks the string length without recording a structured rejection.",
          source_refs: [source], evidence_refs: [],
        }],
        parts: [{ part_id: part.part_id, outcome: "findings", observation_ids: [observationId] }],
        findings: [{
          schema_version: submitted.schema_version, question_id: submitted.question_id, revision_id: submitted.revision_id,
          finding_id: "fixture-auth", kind: "confirmed_defect", observation_ids: [observationId],
          severity: "medium", confidence: "medium",
          claim: "Auth path lacks structured rejection telemetry",
          consequence: "Authentication failures have no structured context.",
          next_step: "Record the rejected attempt at the existing boundary.",
          evidence_ids: [], source_refs: [source], verification: [],
        }],
      },
    };
    await writeFile(resolve(root, item.result_path), JSON.stringify(findingAnswer));

    // First next-step lands on the narrative pause.
    const paused = await callNextStep(root, artifactsDir);
    expect(paused.step_kind).toBe("synthesis_narrative");
    expect(paused.status).toBe("ready");
    if (!paused.artifact_paths) {
      throw new TypeError("synthesis narrative artifact paths were not emitted");
    }
    const narrativeResultsPath = paused.artifact_paths.synthesis_narrative_results;
    // The submission lands at the TOOL-computed path, not a name the host
    // could type. (The registered `synthesis-narrative.json` artifact the
    // executor writes afterwards keeps its own name.)
    expect(String(narrativeResultsPath).replaceAll("\\", "/")).toMatch(
      /\/submissions\/[0-9a-f]{64}\.json$/u,
    );
    if (typeof narrativeResultsPath !== "string") {
      throw new TypeError("synthesis narrative results path was not emitted");
    }
    // Always-materialized (design resolution 2): the findings digest lives in
    // the LANE file; the step prompt is the capability-neutral instruction.
    const stepPrompt = await readFile(paused.prompt_path, "utf8");
    expect(stepPrompt).toMatch(/synthesis narrative/i);
    const lanePromptPath = paused.artifact_paths.synthesis_narrative_prompt;
    expect(lanePromptPath).toMatch(/synthesis-narrative-prompt\.md$/);
    if (typeof lanePromptPath !== "string") {
      throw new TypeError("synthesis narrative lane prompt path was not emitted");
    }
    const prompt = await readFile(lanePromptPath, "utf8");
    expect(prompt).toMatch(/Synthesis narrative/i);

    // Findings are re-keyed to content-derived ids at synthesis, so discover the
    // synthesized id and reference it the way the narrative LLM would (the
    // worker-packet id "finding-auth-1" no longer exists post-synthesis).
    const synthesized = await readQuestionFindings(join(artifactsDir, "audit-findings.json"));
    const authFinding = synthesized.findings.find(
      (f) => f.title === "Auth path lacks structured rejection telemetry",
    );
    expect(authFinding, "synthesized findings must include the auth finding").toBeTruthy();
    if (!authFinding) {
      throw new TypeError("synthesized auth finding was not emitted");
    }
    expect(prompt).toMatch(new RegExp(authFinding.id));

    // Feedback arrives after the first synthesis, while narrative is pending.
    // It may refresh Markdown, but never change accepted answers or findings.
    const workingReport = join(artifactsDir, "audit-report.md");
    const machinePath = join(artifactsDir, "audit-findings.json");
    const feedbackPath = join(artifactsDir, FEEDBACK_FILE);
    const ledgerPath = join(artifactsDir, "runs", workload.run_id, "host-accepted-results-ledger.json");
    const machine = await readFile(machinePath, "utf8");
    const ledger = await readFile(ledgerPath, "utf8");
    expect(synthesized.question_review.accepted.map(({ submission }) => submission.submission_id).sort())
      .toEqual(answers.map(answer => answer.submission_id).sort());
    expect(await hasCurrentQuestionReport(artifactsDir)).toBe(true);
    expect(await readFile(workingReport, "utf8")).not.toMatch(/## Process Feedback/);

    await appendFile(feedbackPath, JSON.stringify(REFLECTION) + "\nworker crashed mid-line{\n");
    expect(await hasCurrentQuestionReport(artifactsDir)).toBe(false);
    const refreshed = await callNextStep(root, artifactsDir);
    expect(refreshed.step_kind).toBe("synthesis_narrative");
    expect(await hasCurrentQuestionReport(artifactsDir)).toBe(true);
    const withFeedback = await readFile(workingReport, "utf8");
    expect(withFeedback.match(/## Process Feedback/g)).toHaveLength(1);
    expect(withFeedback.match(/packet path was stale/g)).toHaveLength(1);
    expect(await readFile(machinePath, "utf8")).toBe(machine);

    await appendFile(feedbackPath, "malformed-only-line{\n");
    expect(await hasCurrentQuestionReport(artifactsDir)).toBe(true);
    const unchanged = await callNextStep(root, artifactsDir);
    expect(unchanged.step_kind).toBe("synthesis_narrative");
    expect(await readFile(workingReport, "utf8")).toBe(withFeedback);
    expect(unchanged.artifact_paths.synthesis_narrative_results).toBe(narrativeResultsPath);

    // Host supplies the narrative referencing the synthesized id.
    await writeFile(
      narrativeResultsPath,
      JSON.stringify(
        {
          themes: [
            {
              theme_id: "T-1",
              title: "Authentication observability gaps",
              root_cause: "Auth failures are not recorded with structured context.",
              finding_ids: [authFinding.id],
              suggested_fix_pattern: "Emit structured rejection telemetry at the auth boundary.",
            },
          ],
          executive_summary: "A single auth-observability theme was identified.",
          top_risks: ["Undetected authentication abuse"],
        },
        null,
        2,
      ) + "\n",
    );

    // Second next-step ingests the narrative; subsequent calls clear the
    // friction-triage pause and complete.
    const done = await presentQuestionReport(root, async (step) => {
      expect(step.step_kind).not.toBe("synthesis_narrative");
    });
    expect(done.step_kind).toBe("present_report");
    expect(done.status).toBe("complete");

    // The canonical contract was promoted to the repo root with the narrative.
    const findings = await readQuestionFindings(join(root, ".audit-tools", "audit-findings.json"));
    expect(findings.themes).toMatchObject([{ theme_id: "T-1", finding_ids: [authFinding.id] }]);
    expect(findings.findings).toEqual(synthesized.findings);
    expect(findings.question_review).toEqual(synthesized.question_review);
    expect(findings.executive_summary).toBe("A single auth-observability theme was identified.");

    const report = await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8");
    expect(report).toContain("## Narrative (does not change coverage or findings)");
    expect(report).toContain("Authentication observability gaps: Auth failures are not recorded with structured context.");
    expect(report.match(/## Process Feedback/g)).toHaveLength(1);
    expect(report.match(/packet path was stale/g)).toHaveLength(1);
    expect(await readFile(workingReport, "utf8")).toBe(report);
    expect(await readFile(join(root, ".audit-tools", "audit-findings.json"), "utf8"))
      .toBe(await readFile(machinePath, "utf8"));
    expect(await readFile(ledgerPath, "utf8")).toBe(ledger);
    expect(await readFile(join(root, ".audit-tools", "audit-agent-feedback.jsonl"), "utf8"))
      .toBe(await readFile(feedbackPath, "utf8"));
    expect(await hasCurrentQuestionReport(artifactsDir)).toBe(true);
    await cmdResynthesize(["--root", root, "--artifacts-dir", artifactsDir]);
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toBe(report);
  });
});

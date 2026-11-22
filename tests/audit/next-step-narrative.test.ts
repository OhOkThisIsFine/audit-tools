import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { advanceToDispatchReady, callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { presentQuestionReport, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import type { ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

test("next-step pauses for the synthesis narrative, then completes after it is provided", async () => {
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
  });
});

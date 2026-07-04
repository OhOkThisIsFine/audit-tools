import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import {
  writeFixtureRepo,
  buildSyntheticResults,
  advanceFixtureToPlanning,
} from "./helpers/fixture.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");

/** Drive the deterministic pipeline in-process up to (and including) synthesis,
 * leaving synthesis_narrative_current as the only outstanding obligation, and
 * persist the resulting bundle so the next-step CLI resumes from that state. */
async function persistSynthesisReadyState(root, artifactsDir) {
  const { planning, lineIndex } = await advanceFixtureToPlanning(root);
  const ingest = await advanceAudit(planning.updated_bundle, {
    preferredExecutor: "result_ingestion_executor",
    auditResults: buildSyntheticResults(planning.updated_bundle.audit_tasks, lineIndex),
  });
  const synthesis = await advanceAudit(ingest.updated_bundle, {
    preferredExecutor: "synthesis_executor",
  });
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, synthesis.updated_bundle);
  return synthesis;
}

/** Run next-step until present_report emits status:"complete", clearing the
 * mandatory friction-triage pause (write ≥1 open_observation, then re-call) the
 * way a host would. promoteFinalAuditReport deletes artifactsDir, so recreate
 * the friction subdir before writing. Returns the completed present_report step. */
async function nextStepToComplete(root) {
  for (let i = 0; i < 5; i++) {
    const step = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    if (
      step.step_kind === "present_report" &&
      step.status === "ready" &&
      step.artifact_paths?.friction_record
    ) {
      let record = {};
      try {
        record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8"));
      } catch { /* new record */ }
      record.category_attestations = [
        { category: "ambiguous_direction", note: "none this run" },
        { category: "tool_should_decide", note: "none this run" },
        { category: "inefficient_feeding", note: "none this run" },
      ];
      await mkdir(dirname(step.artifact_paths.friction_record), { recursive: true });
      await writeFile(step.artifact_paths.friction_record, JSON.stringify(record) + "\n");
      continue;
    }
    return step;
  }
  throw new Error("next-step did not reach present_report:complete within 5 calls");
}

test("next-step pauses for the synthesis narrative, then completes after it is provided", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-narrative-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistSynthesisReadyState(root, artifactsDir);
    // This fixture has no local `typescript`; skip the optional analyzer so the
    // resume does not pause on the graph-enrichment install prompt.
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        { provider: "local-subprocess", analyzers: { typescript: "skip" } },
        null,
        2,
      ) + "\n",
    );

    // First next-step lands on the narrative pause.
    const paused = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    expect(paused.step_kind).toBe("synthesis_narrative");
    expect(paused.status).toBe("ready");
    const narrativeResultsPath = paused.artifact_paths.synthesis_narrative_results;
    expect(narrativeResultsPath).toMatch(/synthesis-narrative\.json$/);
    const prompt = await readFile(paused.prompt_path, "utf8");
    expect(prompt).toMatch(/Synthesis narrative/i);

    // Findings are re-keyed to content-derived ids at synthesis, so discover the
    // synthesized id and reference it the way the narrative LLM would (the
    // worker-packet id "finding-auth-1" no longer exists post-synthesis).
    const synthesized = JSON.parse(
      await readFile(join(artifactsDir, "audit-findings.json"), "utf8"),
    );
    const authFinding = synthesized.findings.find(
      (f) => f.title === "Auth path lacks structured rejection telemetry",
    );
    expect(authFinding, "synthesized findings must include the auth finding").toBeTruthy();
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
    const done = await nextStepToComplete(root);
    expect(done.step_kind).toBe("present_report");
    expect(done.status).toBe("complete");

    // The canonical contract was promoted to the repo root with the narrative.
    const findings = JSON.parse(
      await readFile(join(root, ".audit-tools", "audit-findings.json"), "utf8"),
    );
    expect(findings.themes.length).toBe(1);
    expect(findings.themes[0].theme_id).toBe("T-1");
    const tagged = findings.findings.find((f) => f.id === authFinding.id);
    expect(tagged.theme_id).toBe("T-1");
    expect(findings.executive_summary).toBe("A single auth-observability theme was identified.");

    const report = await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8");
    expect(report).toMatch(/## Themes/);
    expect(report).toMatch(/### T-1 — Authentication observability gaps/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step omits the narrative when synthesis.narrative is disabled", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-narrative-off-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistSynthesisReadyState(root, artifactsDir);
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          provider: "local-subprocess",
          synthesis: { narrative: false },
          analyzers: { typescript: "skip" },
        },
        null,
        2,
      ) + "\n",
    );

    const done = await nextStepToComplete(root);
    expect(done.step_kind).toBe("present_report");
    expect(done.status).toBe("complete");

    const findings = JSON.parse(
      await readFile(join(root, ".audit-tools", "audit-findings.json"), "utf8"),
    );
    expect(findings.themes).toBe(undefined);
    const report = await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8");
    expect(report).not.toMatch(/## Themes/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

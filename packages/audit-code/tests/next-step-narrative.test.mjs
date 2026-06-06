import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import {
  writeFixtureRepo,
  buildSyntheticResults,
  advanceFixtureToPlanning,
} from "./helpers/fixture.mjs";

const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const { writeCoreArtifacts } = await import("../src/io/artifacts.ts");

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

test("next-step pauses for the synthesis narrative, then completes after it is provided", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-narrative-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-artifacts");
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
    assert.equal(paused.step_kind, "synthesis_narrative");
    assert.equal(paused.status, "ready");
    const narrativeResultsPath = paused.artifact_paths.synthesis_narrative_results;
    assert.match(narrativeResultsPath, /synthesis-narrative\.json$/);
    const prompt = await readFile(paused.prompt_path, "utf8");
    assert.match(prompt, /Synthesis narrative/i);

    // Findings are re-keyed to content-derived ids at synthesis, so discover the
    // synthesized id and reference it the way the narrative LLM would (the
    // worker-packet id "finding-auth-1" no longer exists post-synthesis).
    const synthesized = JSON.parse(
      await readFile(join(artifactsDir, "audit-findings.json"), "utf8"),
    );
    const authFinding = synthesized.findings.find(
      (f) => f.title === "Auth path lacks structured rejection telemetry",
    );
    assert.ok(authFinding, "synthesized findings must include the auth finding");
    assert.match(prompt, new RegExp(authFinding.id));

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

    // Second next-step ingests the narrative and completes.
    const done = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    assert.equal(done.step_kind, "present_report");
    assert.equal(done.status, "complete");

    // The canonical contract was promoted to the repo root with the narrative.
    const findings = JSON.parse(
      await readFile(join(root, "audit-findings.json"), "utf8"),
    );
    assert.equal(findings.themes.length, 1);
    assert.equal(findings.themes[0].theme_id, "T-1");
    const tagged = findings.findings.find((f) => f.id === authFinding.id);
    assert.equal(tagged.theme_id, "T-1");
    assert.equal(findings.executive_summary, "A single auth-observability theme was identified.");

    const report = await readFile(join(root, "audit-report.md"), "utf8");
    assert.match(report, /## Themes/);
    assert.match(report, /### T-1 — Authentication observability gaps/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step omits the narrative when synthesis.narrative is disabled", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-narrative-off-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-artifacts");
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

    const done = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    assert.equal(done.step_kind, "present_report");
    assert.equal(done.status, "complete");

    const findings = JSON.parse(
      await readFile(join(root, "audit-findings.json"), "utf8"),
    );
    assert.equal(findings.themes, undefined);
    const report = await readFile(join(root, "audit-report.md"), "utf8");
    assert.doesNotMatch(report, /## Themes/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

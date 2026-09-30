import { persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import { persistAnalyzerConsent } from "../../src/shared/analyzerPolicy.js";
import { declineDefaultAcquiredAnalyzers } from "../helpers/analyzerConsentFixture.js";
import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  writeFixtureRepo,
  buildSyntheticResults,
  advanceFixtureToPlanning,
} from "./helpers/fixture.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");

interface WrapperStep {
  step_kind: string;
  status: string;
  prompt_path: string;
  artifact_paths?: {
    friction_record?: string;
    synthesis_narrative_prompt?: string;
    synthesis_narrative_results?: string;
  };
}

interface FindingDocument {
  findings: Array<{
    id: string;
    title: string;
    theme_id?: string;
  }>;
  themes?: Array<{ theme_id: string }>;
  executive_summary?: string;
}

/** Drive the deterministic pipeline in-process up to (and including) synthesis,
 * leaving synthesis_narrative_current as the only outstanding obligation, and
 * persist the resulting bundle so the next-step CLI resumes from that state. */
async function persistSynthesisReadyState(
  root: string,
  artifactsDir: string,
) {
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
  await persistDesignReviewSnapshots(artifactsDir, synthesis.updated_bundle);
  return synthesis;
}

/** Product completion requires no development friction reflection. */
async function nextStepToComplete(
  root: string,
  extraArgs: string[] = [],
): Promise<WrapperStep> {
  const step: WrapperStep = JSON.parse((await runWrapper(["next-step", ...extraArgs], { cwd: root })).stdout);
  expect(step.step_kind).toBe("present_report");
  expect(step.status).toBe("complete");
  return step;
}

test.concurrent("next-step pauses for the synthesis narrative, then completes after it is provided", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-narrative-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistSynthesisReadyState(root, artifactsDir);
    await declineDefaultAcquiredAnalyzers(root);
    await persistAnalyzerConsent(root, { semgrep: "declined", eslint: "declined", knip: "declined", jscpd: "declined", "osv-scanner": "declined" });
    // This fixture has no local `typescript`; skip the optional analyzer so the
    // resume does not pause on the graph-enrichment install prompt.
    await writeFile(
      join(artifactsDir, "analyzer-policy.json"),
      JSON.stringify(
        {
          analyzers: { typescript: "skip" },
        },
        null,
        2,
      ) + "\n",
    );

    // First next-step lands on the narrative pause.
    const paused: WrapperStep = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
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
    const synthesized: FindingDocument = JSON.parse(
      await readFile(join(artifactsDir, "audit-findings.json"), "utf8"),
    );
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
    const done = await nextStepToComplete(root);
    expect(done.step_kind).toBe("present_report");
    expect(done.status).toBe("complete");

    // The canonical contract was promoted to the repo root with the narrative.
    const findings: FindingDocument & {
      themes: Array<{ theme_id: string }>;
    } = JSON.parse(
      await readFile(join(root, ".audit-tools", "audit-findings.json"), "utf8"),
    );
    expect(findings.themes.length).toBe(1);
    expect(findings.themes[0].theme_id).toBe("T-1");
    const tagged = findings.findings.find((f) => f.id === authFinding.id);
    if (!tagged) {
      throw new TypeError("promoted auth finding was not emitted");
    }
    expect(tagged.theme_id).toBe("T-1");
    expect(findings.executive_summary).toBe("A single auth-observability theme was identified.");

    const report = await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8");
    expect(report).toMatch(/## Themes/);
    expect(report).toMatch(/### T-1 — Authentication observability gaps/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

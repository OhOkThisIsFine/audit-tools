import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const { writeCoreArtifacts } = await import("../src/io/artifacts.ts");

const FIXTURE_LINE_INDEX = {
  "src/api/auth.ts": 4,
  "src/lib/session.ts": 8,
  "infra/deploy.yml": 5,
  "package.json": 4,
};

function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanEnv, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

async function writeFixtureRepo(root) {
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "infra"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "0.0.0" }, null, 2) + "\n",
  );
  await writeFile(
    join(root, "src", "api", "auth.ts"),
    [
      "export function authenticate(token: string): boolean {",
      "  return token.trim().length > 0;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "lib", "session.ts"),
    [
      "export interface Session {",
      "  id: string;",
      "}",
      "",
      "export function createSession(id: string): Session {",
      "  return { id };",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "infra", "deploy.yml"),
    ["name: deploy", "on: [push]", "jobs:", "  release:", "    runs-on: ubuntu-latest", ""].join("\n"),
  );
}

function buildSyntheticResults(tasks) {
  return tasks.map((task, index) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "fixture-reviewer",
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: FIXTURE_LINE_INDEX[path],
    })),
    findings:
      index === 0
        ? [
            {
              id: "finding-auth-1",
              title: "Auth path lacks structured rejection telemetry",
              category: "security",
              severity: "medium",
              confidence: "medium",
              lens: task.lens,
              summary: "Authentication failures are not recorded with enough context.",
              affected_files: [{ path: task.file_paths[0], line_start: 1, line_end: 3 }],
              evidence: [`${task.file_paths[0]}:1 - no structured failure event`],
            },
          ]
        : [],
    notes: ["fixture ingestion"],
    requires_followup: false,
  }));
}

/** Drive the deterministic pipeline in-process up to (and including) synthesis,
 * leaving synthesis_narrative_current as the only outstanding obligation, and
 * persist the resulting bundle so the next-step CLI resumes from that state. */
async function persistSynthesisReadyState(root, artifactsDir) {
  const intake = await advanceAudit({}, { root });
  const prepared = {
    ...intake.updated_bundle,
    auto_fixes_applied: { executed_tools: [], timestamp: "2026-04-22T00:00:00Z" },
    external_analyzer_results: { tool: "syntax_resolution_executor", results: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  };
  const structure = await advanceAudit(prepared);
  // Graph enrichment runs between structure and design assessment; with no root
  // it writes an "omitted" marker and leaves the regex-floor graph unchanged.
  const enrichment = await advanceAudit(structure.updated_bundle);
  const designAssessment = await advanceAudit(enrichment.updated_bundle);
  const designReview = await advanceAudit(designAssessment.updated_bundle);
  const planning = await advanceAudit(designReview.updated_bundle, {
    root,
    lineIndex: FIXTURE_LINE_INDEX,
  });
  const ingest = await advanceAudit(planning.updated_bundle, {
    preferredExecutor: "result_ingestion_executor",
    auditResults: buildSyntheticResults(planning.updated_bundle.audit_tasks),
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { advanceAudit } = await import("../../../src/audit/orchestrator/advance.ts");
const { buildAdvancedBundle } = await import("./advancedBundle.mjs");

/**
 * The canonical line-index for the shared fixture repository.
 * Both orchestration.test.mjs and next-step-narrative.test.mjs used this
 * identical object — it is now single-sourced here.
 */
export const FIXTURE_LINE_INDEX = {
  "src/api/auth.ts": 4,
  "src/lib/session.ts": 8,
  "infra/deploy.yml": 5,
  "package.json": 4,
};

/**
 * Write the canonical fixture repository files into `root`.
 * Both test files contained verbatim copies of this function.
 */
export async function writeFixtureRepo(root) {
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "infra"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "0.0.0",
      },
      null,
      2,
    ) + "\n",
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
    [
      "name: deploy",
      "on: [push]",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n"),
  );
}

/**
 * Build synthetic audit results for the given tasks using the provided
 * line index. Does no async work; synchronous for callers that don't need await.
 *
 * Unified from the nearly-identical copies in orchestration.test.mjs (async)
 * and next-step-narrative.test.mjs (sync with FIXTURE_LINE_INDEX closure).
 */
export function buildSyntheticResults(tasks, lineIndex) {
  return tasks.map((task, index) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "fixture-reviewer",
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: lineIndex[path],
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
              summary:
                "Authentication failures are not recorded with enough context.",
              affected_files: [
                { path: task.file_paths[0], line_start: 1, line_end: 3 },
              ],
              evidence: [`${task.file_paths[0]}:1 - no structured failure event`],
            },
          ]
        : [],
    notes: ["fixture ingestion"],
    requires_followup: false,
  }));
}

/**
 * Analyzer policy that forces graph enrichment to stay hermetic (no analyzer
 * subprocess / dependency acquisition) even when a real `root` is supplied — every
 * registered analyzer is set to `skip`. `advanceAudit` now drains the whole
 * deterministic regen frontier (intake → structure → graph_enrichment →
 * design_assessment → structure_decomposition) within a single call, so
 * graph_enrichment runs WITH the root that intake/planning require; `skip` keeps
 * it on the floor graph the old rootless "absent" path produced, so the pipeline
 * stays offline-hermetic. The five ids are the stable ANALYZER_REGISTRY set.
 */
const FIXTURE_SKIP_ANALYZERS = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

/**
 * Drive the deterministic audit pipeline in-process up to (and including) the
 * planning step. Returns `{ planning, lineIndex }` where `lineIndex` is
 * `FIXTURE_LINE_INDEX`.
 *
 * `advanceAudit` drains the consecutive deterministic regen frontier within one
 * call, stopping only at host-delegation boundaries (provider_confirmation,
 * intent_checkpoint, charter, both design-review passes). So the whole
 * deterministic chain collapses into a handful of host-boundary round-trips — this
 * helper is chain-length-agnostic: it loops `advanceAudit` until the planning
 * artifacts are built (planning_executor is the deterministic tail that the
 * conceptual design-review round-trip drains into), never hard-coding the exact
 * intermediate step count. Every call passes the same options (root + lineIndex +
 * a skip-all analyzer policy for hermeticity), mirroring the real CLI path.
 */
export async function advanceFixtureToPlanning(root) {
  // Drive the deterministic pipeline up to (but not through) planning via the
  // single target-keyed stage list in advancedBundle.mjs — adding a PRIORITY
  // phase is a one-line stage insert there, never a re-edit of this sequence.
  const preplanningBundle = await buildAdvancedBundle(root, "planning_artifacts");
  const planning = await advanceAudit(preplanningBundle, {
    root,
    lineIndex: FIXTURE_LINE_INDEX,
    analyzers: FIXTURE_SKIP_ANALYZERS,
  });

  return { planning, lineIndex: FIXTURE_LINE_INDEX };
}

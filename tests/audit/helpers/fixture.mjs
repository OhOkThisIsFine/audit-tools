import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { advanceAudit } = await import("../../../src/audit/orchestrator/advance.ts");
const { buildAdvancedBundle } = await import("./advancedBundle.mjs");
const { declineDefaultAcquiredAnalyzers } = await import(
  "../../helpers/analyzerConsentFixture.ts"
);

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

  // Hermeticity: state the operator's decline of the DEFAULT acquired-analyzer
  // set before any CLI call, so `admitSpawn` refuses outright and no fixture
  // reaches npx or a release download. See tests/helpers/analyzerConsentFixture.ts.
  await declineDefaultAcquiredAnalyzers(root);
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
    // The contract requires a zero-finding result to AFFIRM it was reviewed, and
    // refuses the affirmation alongside findings — so this mirrors the same
    // index === 0 split the findings array uses.
    ...(index === 0 ? {} : { reviewed_clean: true }),
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
 * Prepare scoped work and explicitly settle the fixture's architectural host
 * evidence, then return a forced planning pass with the canonical line index.
 * This helper supports tests whose next boundary is inspection/synthesis; the
 * concurrent frontier tests separately retain pending architecture lanes.
 */
export async function advanceFixtureToPlanning(root) {
  const preplanningBundle = await buildAdvancedBundle(root, "audit_tasks_completed");
  const planning = await advanceAudit(preplanningBundle, {
    preferredExecutor: "planning_executor",
    root,
    lineIndex: FIXTURE_LINE_INDEX,
    analyzers: FIXTURE_SKIP_ANALYZERS,
  });

  return { planning, lineIndex: FIXTURE_LINE_INDEX };
}

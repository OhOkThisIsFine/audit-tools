import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { advanceAudit } = await import("../../../src/audit/orchestrator/advance.ts");

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
 * Drive the deterministic audit pipeline in-process up to (and including) the
 * planning step. Returns `{ planning, lineIndex }` where `lineIndex` is
 * `FIXTURE_LINE_INDEX`.
 *
 * The 8-step sequence (intake → preparedBundle construction → structure →
 * enrichment → designAssessment → designReview → intentCheckpoint → planning)
 * was duplicated verbatim in both orchestration.test.mjs and
 * next-step-narrative.test.mjs.
 */
export async function advanceFixtureToPlanning(root) {
  // Provider confirmation is the first session-level gate; headless, it
  // auto-completes deterministically and writes provider_confirmation.json.
  const providerConfirmation = await advanceAudit({}, { root });

  const intake = await advanceAudit(providerConfirmation.updated_bundle, { root });
  const preparedBundle = {
    ...intake.updated_bundle,
    auto_fixes_applied: {
      executed_tools: [],
      timestamp: "2026-04-22T00:00:00Z",
    },
    external_analyzer_results: [
      {
        tool: "syntax_resolution_executor",
        results: [],
      },
    ],
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
    // Mark external-analyzer acquisition (Slice D) as already satisfied so the
    // hand-built step sequence below proceeds straight to structure (acquisition
    // is a hermetic no-op without an enabled gate; the fixture skips it like the
    // injected auto-fix / syntax-resolution markers above).
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
  };

  const structure = await advanceAudit(preparedBundle);

  // Graph enrichment runs between structure and design assessment. With no root
  // the optional analyzers are unavailable, so it writes an "omitted" marker and
  // leaves the regex-floor graph unchanged.
  const enrichment = await advanceAudit(structure.updated_bundle);

  const designAssessment = await advanceAudit(enrichment.updated_bundle);

  // The intent checkpoint now sits after design assessment and before design
  // review. Headless, it auto-completes a default full-scope checkpoint; the
  // executor requires a root for scope resolution.
  const intentCheckpoint = await advanceAudit(designAssessment.updated_bundle, {
    root,
  });

  // Design review is now split into two passes: contract (adversarial) and
  // conceptual (generative). Both auto-complete headlessly.
  const designReviewContract = await advanceAudit(intentCheckpoint.updated_bundle);
  const designReviewConceptual = await advanceAudit(designReviewContract.updated_bundle);

  const planning = await advanceAudit(designReviewConceptual.updated_bundle, {
    root,
    lineIndex: FIXTURE_LINE_INDEX,
  });

  return { planning, lineIndex: FIXTURE_LINE_INDEX };
}

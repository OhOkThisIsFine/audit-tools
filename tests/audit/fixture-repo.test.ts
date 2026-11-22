import { test, expect } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveQuestionCycleUnlocked } from "../../src/audit/cli/questionReviewCycle.js";
import { hashAnalyzerSnippet } from "../../src/shared/analyzers/provenance.js";
import { countLines } from "./helpers/countLines.mjs";
import type { AnalyzerSetting } from "audit-tools/shared";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

// Analyzer policy that keeps graph enrichment hermetic (no analyzer subprocess /
// dependency acquisition) even with a real root — advanceAudit drains the whole
// deterministic frontier in one call, so graph_enrichment runs with the root that
// intake/planning require. The five ids are the stable ANALYZER_REGISTRY set.
const SKIP_ANALYZERS: Record<string, AnalyzerSetting> = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple-app");

async function withFixtureRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "auditor-lambda-fixture-"));
  const repoRoot = join(tempDir, "repo");
  try {
    await cp(fixtureRoot, repoRoot, { recursive: true });
    return await fn(repoRoot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildFixtureLineIndex(root: string): Promise<Record<string, number>> {
  const paths = [
    "src/api/auth.ts",
    "src/lib/session.ts",
    "infra/deploy.yml",
    "README.md",
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await countLines(root, path)]),
    ),
  );
}

test("committed fixture repo supports external analyzer import and deterministic planning without synthetic runtime placeholders", async () => {
  await withFixtureRepo(async (root) => {
    const lineIndex = await buildFixtureLineIndex(root);
    const analyzerPath = "src/api/auth.ts";
    const source = await readFile(join(root, analyzerPath), "utf8");
    const snippetHash = hashAnalyzerSnippet(source, 1, 4);
    expect(snippetHash).toBeTruthy();
    const options = { root, lineIndex, analyzers: SKIP_ANALYZERS };

    // Build the real pre-planning frontier through the shared scripted-host
    // fixture. Direct advanceAudit calls intentionally stop at host-delegation
    // boundaries and cannot manufacture semantic checkpoint/review artifacts.
    let bundle = await buildAdvancedBundle(root, "planning_artifacts");

    // Force the external-analyzer import BEFORE planning consumes
    // external_analyzer_results. The import is a forced-only executor (no
    // priority obligation); injecting it here re-stales the planning artifacts so
    // the drive-to-planning below regenerates them WITH the analyzer signal.
    const imported = await advanceAudit(bundle, {
      ...options,
      preferredExecutor: "external_analyzer_import_executor",
      externalAnalyzerResults: {
        tool: "semgrep",
        generated_at: "2026-03-23T00:00:00Z",
        results: [
          {
            id: "sg-auth-1",
            category: "security",
            severity: "warning",
            path: analyzerPath,
            line_start: 1,
            line_end: 4,
            provenance: { analyzer_id: "semgrep", path: analyzerPath, snippet_hash: snippetHash! },
            summary:
              "Authentication path may be missing structured audit logging.",
          },
        ],
      },
    });
    expect(imported.selected_executor).toBe("external_analyzer_import_executor");
    bundle = imported.updated_bundle;

    const planning = await advanceAudit(bundle, { ...options, preferredExecutor: "planning_executor" });
    expect(planning.selected_executor).toBe("planning_executor");
    const plan = planning.updated_bundle.review_plan!;
    expect(plan.questions.length).toBeGreaterThan(0);
    const cycle = await deriveQuestionCycleUnlocked({
      root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), bundle: planning.updated_bundle,
    });
    const security = cycle.bindings.find(binding => binding.question.lens === "security" &&
      binding.assignment.suggested_sources.some(ref => ref.path === analyzerPath));
    expect(security).toBeDefined();
    expect(security?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "source", status: "observed", snapshot_id: plan.snapshot_id,
      source_refs: [{ path: analyzerPath, start_line: 1, end_line: 4 }],
    })]));
    expect(security?.assignment.available_evidence_ids).toEqual(security?.evidence.map(row => row.evidence_id));
    // Analyzer evidence is invitation to inspect, not an answer or a run test.
    expect(cycle.evidence.some(row => row.kind === "command")).toBe(false);
    expect(cycle.answers).toEqual([]);
    expect(cycle.pending).toContain(security);
    expect(planning.artifacts_written).not.toContain("runtime_validation_tasks.json");
  });
});

test("committed simple-app fixture stays production-shaped and explicitly test-only", async () => {
  const authSource = await readFile(join(fixtureRoot, "src", "api", "auth.ts"), "utf8");
  const sessionSource = await readFile(
    join(fixtureRoot, "src", "lib", "session.ts"),
    "utf8",
  );
  const deploySource = await readFile(
    join(fixtureRoot, "infra", "deploy.yml"),
    "utf8",
  );

  expect(authSource).toMatch(/Fixture-only authentication helper/i);
  expect(authSource).toMatch(/AuthenticationError/);
  expect(authSource).toMatch(/timingSafeEqual/);
  expect(authSource).toMatch(/\[fixture-auth\]/);

  expect(sessionSource).toMatch(/Fixture-only session helper/i);
  expect(sessionSource).toMatch(/randomUUID/);
  expect(sessionSource).toMatch(/expiresAt/);
  expect(sessionSource).toMatch(/revokeSession/);
  expect(sessionSource).toMatch(/isSessionActive/);

  expect(deploySource).toMatch(/concurrency:/);
  expect(deploySource).toMatch(/needs: validate/);
  expect(deploySource).toMatch(/rollback/i);
  expect(deploySource).toMatch(/npm test/);
});

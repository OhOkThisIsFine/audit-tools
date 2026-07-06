import { test, expect } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countLines } from "./helpers/countLines.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.ts");

// Analyzer policy that keeps graph enrichment hermetic (no analyzer subprocess /
// dependency acquisition) even with a real root — advanceAudit drains the whole
// deterministic frontier in one call, so graph_enrichment runs with the root that
// intake/planning require. The five ids are the stable ANALYZER_REGISTRY set.
const SKIP_ANALYZERS = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple-app");

async function withFixtureRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "auditor-lambda-fixture-"));
  const repoRoot = join(tempDir, "repo");
  try {
    await cp(fixtureRoot, repoRoot, { recursive: true });
    return await fn(repoRoot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildFixtureLineIndex(root) {
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
    const options = { root, lineIndex, analyzers: SKIP_ANALYZERS };

    // advanceAudit now DRAINS the consecutive deterministic regen frontier within
    // one call, stopping only at host-delegation boundaries. So the first call
    // (provider_confirmation) drains intake → auto_fix → syntax_resolution →
    // external_analyzer_acquisition → structure → graph_enrichment →
    // design_assessment → structure_decomposition in one round-trip, halting at
    // the intent_checkpoint host boundary.
    let result = await advanceAudit({}, options);
    let bundle = result.updated_bundle;

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
            path: "src/api/auth.ts",
            line_start: 1,
            line_end: 4,
            summary:
              "Authentication path may be missing structured audit logging.",
          },
        ],
      },
    });
    expect(imported.selected_executor).toBe("external_analyzer_import_executor");
    bundle = imported.updated_bundle;

    // Drive across the remaining host-delegation boundaries (intent_checkpoint,
    // charter, both design-review passes) until the deterministic planning tail
    // runs. Chain-length-agnostic: loop until planning_executor is the resolved
    // step rather than hard-coding the intermediate host-boundary count.
    let planning = null;
    for (let i = 0; i < 32; i += 1) {
      const decision = decideNextStep(bundle);
      if (decision.state.status === "complete") break;
      const step = await advanceAudit(bundle, options);
      bundle = step.updated_bundle;
      if (step.selected_executor === "planning_executor") {
        planning = step;
        break;
      }
    }

    expect(planning, "planning_executor should be reached").toBeTruthy();
    expect(planning.selected_executor).toBe("planning_executor");
    expect(planning.updated_bundle.audit_tasks.length > 0).toBeTruthy();

    const analyzerDrivenTask = planning.updated_bundle.audit_tasks.find(
      (task) =>
        task.lens === "security" &&
        task.file_paths.includes("src/api/auth.ts") &&
        task.tags?.includes("external_analyzer_signal"),
    );
    expect(analyzerDrivenTask).toBeTruthy();
    expect(analyzerDrivenTask.priority).toBe("high");
    expect(analyzerDrivenTask.tags.includes("external_analyzer_signal")).toBeTruthy();
    expect(planning.updated_bundle.runtime_validation_tasks.tasks.length).toBe(0);
    expect(planning.updated_bundle.runtime_validation_report).toBe(undefined);
    expect(planning.audit_state.obligations.find(
        (item) => item.id === "runtime_validation_current",
      )?.state).toBe("satisfied");
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

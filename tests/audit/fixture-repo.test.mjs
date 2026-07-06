import { test, expect } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countLines } from "./helpers/countLines.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");

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
    let bundle = {};

    // Provider confirmation gate auto-completes headlessly.
    const providerConf = await advanceAudit(bundle, { root });
    bundle = providerConf.updated_bundle;

    const intake = await advanceAudit(bundle, { root });
    bundle = intake.updated_bundle;

    const imported = await advanceAudit(bundle, {
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

    const autoFix = await advanceAudit(bundle, { root });
    bundle = autoFix.updated_bundle;

    const syntaxResolution = await advanceAudit(bundle, { root });
    bundle = syntaxResolution.updated_bundle;

    // External-analyzer acquisition (Slice D) runs before structure; not enabled
    // here (no externalAcquisition option), so it writes a hermetic empty marker.
    const acquisition = await advanceAudit(bundle, { root });
    bundle = acquisition.updated_bundle;
    expect(acquisition.selected_executor).toBe("external_analyzer_acquisition_executor");

    const structure = await advanceAudit(bundle);
    bundle = structure.updated_bundle;

    const designAssessment = await advanceAudit(bundle);
    bundle = {
      ...designAssessment.updated_bundle,
      design_assessment: {
        ...designAssessment.updated_bundle.design_assessment,
        reviewed: true,
        review_findings: [],
      },
    };

    // Structure decomposition is a deterministic step between design assessment
    // and the intent checkpoint; it runs fine without a root.
    const structureDecomposition = await advanceAudit(bundle);
    bundle = structureDecomposition.updated_bundle;

    const intentCheckpoint = await advanceAudit(bundle, { root });
    bundle = intentCheckpoint.updated_bundle;

    const planning = await advanceAudit(bundle, {
      root,
      lineIndex: await buildFixtureLineIndex(root),
    });

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

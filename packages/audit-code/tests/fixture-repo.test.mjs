import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countLines } from "./helpers/countLines.mjs";

const { advanceAudit } = await import("../src/orchestrator/advance.ts");

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
    assert.equal(
      imported.selected_executor,
      "external_analyzer_import_executor",
    );
    bundle = imported.updated_bundle;

    const autoFix = await advanceAudit(bundle, { root });
    bundle = autoFix.updated_bundle;

    const syntaxResolution = await advanceAudit(bundle, { root });
    bundle = syntaxResolution.updated_bundle;

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

    const intentCheckpoint = await advanceAudit(bundle, { root });
    bundle = intentCheckpoint.updated_bundle;

    const planning = await advanceAudit(bundle, {
      root,
      lineIndex: await buildFixtureLineIndex(root),
    });

    assert.equal(planning.selected_executor, "planning_executor");
    assert.ok(planning.updated_bundle.audit_tasks.length > 0);

    const analyzerDrivenTask = planning.updated_bundle.audit_tasks.find(
      (task) =>
        task.lens === "security" &&
        task.file_paths.includes("src/api/auth.ts") &&
        task.tags?.includes("external_analyzer_signal"),
    );
    assert.ok(analyzerDrivenTask);
    assert.equal(analyzerDrivenTask.priority, "high");
    assert.ok(analyzerDrivenTask.tags.includes("external_analyzer_signal"));
    assert.equal(planning.updated_bundle.runtime_validation_tasks.tasks.length, 0);
    assert.equal(planning.updated_bundle.runtime_validation_report, undefined);
    assert.equal(
      planning.audit_state.obligations.find(
        (item) => item.id === "runtime_validation_current",
      )?.state,
      "satisfied",
    );
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

  assert.match(authSource, /Fixture-only authentication helper/i);
  assert.match(authSource, /AuthenticationError/);
  assert.match(authSource, /timingSafeEqual/);
  assert.match(authSource, /\[fixture-auth\]/);

  assert.match(sessionSource, /Fixture-only session helper/i);
  assert.match(sessionSource, /randomUUID/);
  assert.match(sessionSource, /expiresAt/);
  assert.match(sessionSource, /revokeSession/);
  assert.match(sessionSource, /isSessionActive/);

  assert.match(deploySource, /concurrency:/);
  assert.match(deploySource, /needs: validate/);
  assert.match(deploySource, /rollback/i);
  assert.match(deploySource, /npm test/);
});

import { test, describe, it, beforeAll, afterAll, onTestFinished, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { detectMisScopeSmells, runIntakeExecutor } = await import("../../src/audit/orchestrator/intakeExecutors.ts");

async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), "audit-scope-"));
}

describe("detectMisScopeSmells: no-.git root whose ancestor is a git repo", () => {
  let base;

  beforeAll(async () => {
    base = await makeTempDir();
  });

  afterAll(async () => rm(base, { recursive: true, force: true }));

  it("ancestor has .git, root does not → exactly one smell", async () => {
    // base/ (the git repo)  ->  base/sub/  ->  base/sub/leaf (the audit root)
    await mkdir(join(base, ".git"), { recursive: true });
    const root = join(base, "sub", "leaf");
    await mkdir(root, { recursive: true });

    const smells = detectMisScopeSmells(root);
    const ancestorSmells = smells.filter((s) => s.includes("git repository"));
    expect(ancestorSmells.length, `smells: ${JSON.stringify(smells)}`).toBe(1);
    // The smell names the ancestor's absolute path.
    expect(ancestorSmells[0].includes(base), ancestorSmells[0]).toBeTruthy();
  });
});

test("detectMisScopeSmells: root with its own .git → no smell", async (t) => {
  const root = await makeTempDir();
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"), { recursive: true });

  const smells = detectMisScopeSmells(root);
  expect(smells.length, `smells: ${JSON.stringify(smells)}`).toBe(0);
});

test("detectMisScopeSmells: workspace-member root → exactly one smell naming the parent", async (t) => {
  const parent = await makeTempDir();
  onTestFinished(async () => rm(parent, { recursive: true, force: true }));
  // Give the parent its own .git so the ancestor smell does not also fire,
  // isolating the workspace-member detection.
  await mkdir(join(parent, ".git"), { recursive: true });
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["*"] }),
  );

  // The member must be a DIRECT child of the workspaces root: the smell checks
  // root.dirname (one level up) for a workspaces field.
  const root = join(parent, "member");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "member-pkg" }),
  );

  const smells = detectMisScopeSmells(root);
  const wsSmells = smells.filter((s) => s.includes("workspace member"));
  expect(wsSmells.length, `smells: ${JSON.stringify(smells)}`).toBe(1);
  expect(wsSmells[0].includes(parent), wsSmells[0]).toBeTruthy();
});

test("detectMisScopeSmells: parent has package.json but no workspaces → no workspace smell", async (t) => {
  const parent = await makeTempDir();
  onTestFinished(async () => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, ".git"), { recursive: true });
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({ name: "plain-parent" }),
  );
  const root = join(parent, "member");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "member" }));

  const smells = detectMisScopeSmells(root);
  expect(smells.filter((s) => s.includes("workspace member")).length, `smells: ${JSON.stringify(smells)}`).toBe(0);
});

test("detectMisScopeSmells: root with no package.json → no workspace smell", async (t) => {
  const parent = await makeTempDir();
  onTestFinished(async () => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, ".git"), { recursive: true });
  const root = join(parent, "member");
  await mkdir(root, { recursive: true });

  const smells = detectMisScopeSmells(root);
  expect(smells.filter((s) => s.includes("workspace member")).length, `smells: ${JSON.stringify(smells)}`).toBe(0);
});

// ---------------------------------------------------------------------------
// TST-c4496274: nested workspace member detection (packages/ subdirectory)
// ---------------------------------------------------------------------------

test("detectMisScopeSmells: nested workspace member (packages/ subdirectory) → exactly one smell naming the monorepo root", async (t) => {
  // Layout: monorepoRoot/ (.git + package.json with workspaces: ["packages/*"])
  //           packages/          (plain dir, no package.json)
  //             member/          (package.json with a name) ← audit root
  const monorepoRoot = await makeTempDir();
  onTestFinished(async () => rm(monorepoRoot, { recursive: true, force: true }));

  // Monorepo root has .git (so ancestor-git smell does NOT fire for the member,
  // since the member is inside the .git boundary and we stop at .git when walking).
  await mkdir(join(monorepoRoot, ".git"), { recursive: true });
  await writeFile(
    join(monorepoRoot, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["packages/*"] }),
  );

  // Intermediate directory with no package.json
  const packagesDir = join(monorepoRoot, "packages");
  await mkdir(packagesDir, { recursive: true });

  // The member package — this is the audit root
  const root = join(packagesDir, "member");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "my-member-pkg" }),
  );

  const smells = detectMisScopeSmells(root);
  const wsSmells = smells.filter((s) => s.includes("workspace member"));
  expect(wsSmells.length, `smells: ${JSON.stringify(smells)}`).toBe(1);
  // The smell must reference the monorepo root (the ancestor with workspaces)
  expect(wsSmells[0].includes(monorepoRoot), `expected monorepo root '${monorepoRoot}' in smell: ${wsSmells[0]}`).toBeTruthy();
});

test("detectMisScopeSmells: nested workspace member under apps/ subdirectory → exactly one smell naming the monorepo root", async (t) => {
  // Layout: monorepoRoot/ (.git + package.json with workspaces: ["apps/*"])
  //           apps/              (plain dir, no package.json)
  //             my-app/          (package.json with a name) ← audit root
  // This confirms detection is not specific to the 'packages/' directory name.
  const monorepoRoot = await makeTempDir();
  onTestFinished(async () => rm(monorepoRoot, { recursive: true, force: true }));

  await mkdir(join(monorepoRoot, ".git"), { recursive: true });
  await writeFile(
    join(monorepoRoot, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["apps/*"] }),
  );

  const appsDir = join(monorepoRoot, "apps");
  await mkdir(appsDir, { recursive: true });

  const root = join(appsDir, "my-app");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "my-app" }),
  );

  const smells = detectMisScopeSmells(root);
  const wsSmells = smells.filter((s) => s.includes("workspace member"));
  expect(wsSmells.length, `smells: ${JSON.stringify(smells)}`).toBe(1);
  expect(wsSmells[0].includes(monorepoRoot), `expected monorepo root '${monorepoRoot}' in smell: ${wsSmells[0]}`).toBeTruthy();
});

test("runIntakeExecutor progress_summary contains no SCOPE_SUMMARY sentinel", async (t) => {
  const base = await makeTempDir();
  onTestFinished(async () => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, ".git"), { recursive: true });
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.js"), "export const x = 1;\n");

  const result = await runIntakeExecutor({}, root);

  expect(!result.progress_summary.startsWith("SCOPE_SUMMARY:"), `progress_summary must not start with SCOPE_SUMMARY: but got: ${result.progress_summary.slice(0, 80)}`).toBeTruthy();
  // Must not contain any embedded JSON blob.
  expect(!result.progress_summary.includes("{"), `progress_summary must not contain a JSON blob but got: ${result.progress_summary.slice(0, 80)}`).toBeTruthy();
  // Must be human-readable text mentioning the file count and repo root.
  expect(result.progress_summary.includes("Created intake artifacts for"), `progress_summary should mention file count: ${result.progress_summary}`).toBeTruthy();
  expect(result.progress_summary.includes(root), `progress_summary should mention repo root: ${result.progress_summary}`).toBeTruthy();
  // The typed scope_summary field must be the ScopeSummary object.
  expect(result.scope_summary, "result must carry scope_summary").toBeTruthy();
  expect(result.scope_summary.repo_root).toBe(root);
});

test("advanceAudit intake_executor writes scope_summary.json to the artifacts dir", async (t) => {
  // Regression: the conversation-first loader instructs the host to read
  // scope_summary.json after intake, but the intake_executor runner never
  // threaded artifactsDir into runIntakeExecutor, so the file was never produced.
  const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
  const { readFile } = await import("node:fs/promises");

  const base = await makeTempDir();
  onTestFinished(async () => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, ".git"), { recursive: true });
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.js"), "export const x = 1;\n");
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });

  const result = await advanceAudit(
    {},
    { root, artifactsDir, preferredExecutor: "intake_executor" },
  );

  expect(result.artifacts_written.includes("scope_summary.json"), `artifacts_written should list scope_summary.json: ${JSON.stringify(result.artifacts_written)}`).toBeTruthy();
  const parsed = JSON.parse(await readFile(join(artifactsDir, "scope_summary.json"), "utf8"));
  expect(parsed.repo_root).toBe(root);
  expect(typeof parsed.auditable_file_count).toBe("number");
});

test("runIntakeExecutor includes a scope_summary in its result", async (t) => {
  const base = await makeTempDir();
  onTestFinished(async () => rm(base, { recursive: true, force: true }));
  // A self-contained repo with one auditable source file.
  await mkdir(join(base, ".git"), { recursive: true });
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.js"), "export const x = 1;\n");

  const result = await runIntakeExecutor({}, root);

  expect(result.scope_summary, "result should carry a scope_summary").toBeTruthy();
  const s = result.scope_summary;
  expect(s.repo_root).toBe(root);
  expect(typeof s.auditable_file_count).toBe("number");
  expect(s.auditable_file_count >= 1).toBeTruthy();
  expect(typeof s.git_available).toBe("boolean");
  expect(Array.isArray(s.mis_scope_smells)).toBeTruthy();

  // auditable_file_count matches the non-excluded disposition files.
  const { isAuditExcludedStatus } = await import("../../src/audit/extractors/disposition.ts");
  const auditable = result.updated.file_disposition.files.filter(
    (f) => !isAuditExcludedStatus(f.status),
  ).length;
  expect(s.auditable_file_count).toBe(auditable);
});

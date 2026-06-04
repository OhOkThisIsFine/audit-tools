import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { detectMisScopeSmells, runIntakeExecutor } = await import(
  "../src/orchestrator/intakeExecutors.ts"
);

async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), "audit-scope-"));
}

test("detectMisScopeSmells: no-.git root whose ancestor is a git repo", async (t) => {
  const base = await makeTempDir();
  t.after(async () => rm(base, { recursive: true, force: true }));

  await t.test("ancestor has .git, root does not → exactly one smell", async () => {
    // base/ (the git repo)  ->  base/sub/  ->  base/sub/leaf (the audit root)
    await mkdir(join(base, ".git"), { recursive: true });
    const root = join(base, "sub", "leaf");
    await mkdir(root, { recursive: true });

    const smells = detectMisScopeSmells(root);
    const ancestorSmells = smells.filter((s) => s.includes("git repository"));
    assert.equal(ancestorSmells.length, 1, `smells: ${JSON.stringify(smells)}`);
    // The smell names the ancestor's absolute path.
    assert.ok(ancestorSmells[0].includes(base), ancestorSmells[0]);
  });
});

test("detectMisScopeSmells: root with its own .git → no smell", async (t) => {
  const root = await makeTempDir();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"), { recursive: true });

  const smells = detectMisScopeSmells(root);
  assert.equal(smells.length, 0, `smells: ${JSON.stringify(smells)}`);
});

test("detectMisScopeSmells: workspace-member root → exactly one smell naming the parent", async (t) => {
  const parent = await makeTempDir();
  t.after(async () => rm(parent, { recursive: true, force: true }));
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
  assert.equal(wsSmells.length, 1, `smells: ${JSON.stringify(smells)}`);
  assert.ok(wsSmells[0].includes(parent), wsSmells[0]);
});

test("detectMisScopeSmells: parent has package.json but no workspaces → no workspace smell", async (t) => {
  const parent = await makeTempDir();
  t.after(async () => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, ".git"), { recursive: true });
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({ name: "plain-parent" }),
  );
  const root = join(parent, "member");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "member" }));

  const smells = detectMisScopeSmells(root);
  assert.equal(
    smells.filter((s) => s.includes("workspace member")).length,
    0,
    `smells: ${JSON.stringify(smells)}`,
  );
});

test("detectMisScopeSmells: root with no package.json → no workspace smell", async (t) => {
  const parent = await makeTempDir();
  t.after(async () => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, ".git"), { recursive: true });
  const root = join(parent, "member");
  await mkdir(root, { recursive: true });

  const smells = detectMisScopeSmells(root);
  assert.equal(
    smells.filter((s) => s.includes("workspace member")).length,
    0,
    `smells: ${JSON.stringify(smells)}`,
  );
});

test("runIntakeExecutor includes a scope_summary in its result", async (t) => {
  const base = await makeTempDir();
  t.after(async () => rm(base, { recursive: true, force: true }));
  // A self-contained repo with one auditable source file.
  await mkdir(join(base, ".git"), { recursive: true });
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.js"), "export const x = 1;\n");

  const result = await runIntakeExecutor({}, root);

  assert.ok(result.scope_summary, "result should carry a scope_summary");
  const s = result.scope_summary;
  assert.equal(s.repo_root, root);
  assert.equal(typeof s.auditable_file_count, "number");
  assert.ok(s.auditable_file_count >= 1);
  assert.equal(typeof s.git_available, "boolean");
  assert.ok(Array.isArray(s.mis_scope_smells));

  // auditable_file_count matches the non-excluded disposition files.
  const { isAuditExcludedStatus } = await import(
    "../src/extractors/disposition.ts"
  );
  const auditable = result.updated.file_disposition.files.filter(
    (f) => !isAuditExcludedStatus(f.status),
  ).length;
  assert.equal(s.auditable_file_count, auditable);
});

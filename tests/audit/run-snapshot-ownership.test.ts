import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { hashContent } from "audit-tools/shared";
import { ensureRunSnapshot, removeRunSnapshot, repinRunSnapshot, runSnapshotPath, type RunSnapshot } from "../../src/audit/io/runSnapshot.js";

// No destructive filesystem or Git operation runs, even for the deliberately
// inconsistent records. Every path used below is beneath a fresh fixture root.
const mocks = vi.hoisted(() => ({ tree: vi.fn(async () => "d".repeat(40)), deleted: new Set<string>(), rm: vi.fn(async (_path?: unknown, _options?: { recursive?: boolean; force?: boolean }) => {}), unlink: vi.fn(async () => {}), run: vi.fn() }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, rm: mocks.rm, unlink: mocks.unlink, rmdir: mocks.unlink,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (mocks.deleted.has(String(args[0]))) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
      return actual.readFile(...args);
    },
  };
});
vi.mock("../../src/shared/tooling/exec.js", async (load) => ({
  ...await load<typeof import("../../src/shared/tooling/exec.js")>(), runTrackedAsync: mocks.run,
}));
vi.mock("../../src/shared/git.js", async (load) => ({
  ...await load<typeof import("../../src/shared/git.js")>(), workingTreeTree: mocks.tree,
}));
const originalState = process.env.AUDIT_CODE_STATE_DIR;
afterEach(() => { process.env.AUDIT_CODE_STATE_DIR = originalState; vi.clearAllMocks(); mocks.deleted.clear(); });

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "snapshot-ownership-")));
  const root = join(base, "repo");
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  process.env.AUDIT_CODE_STATE_DIR = join(base, "state");
  const key = hashContent(`${root}\0${artifactsDir}`).slice(0, 12);
  const dir = join(base, "state", "snapshots", key);
  const tree = join(dir, "tree");
  await mkdir(tree, { recursive: true });
  const record: RunSnapshot = { schema_version: "audit-run-snapshot/v1", repository_root: root, source_root: tree, kind: "copy", pins: [], linked: [], since: {} };
  mocks.rm.mockImplementation(async (path?: unknown) => { mocks.deleted.add(String(path)); });
  mocks.run.mockResolvedValue({ status: 1, stdout: "", stderr: "not a git repository" });
  const save = () => writeFile(runSnapshotPath(artifactsDir), JSON.stringify(record));
  await save();
  return { base, root, artifactsDir, key, dir, tree, record, save };
}

test("cleanup refuses a record selecting a foreign copy before any mutation", async () => {
  const f = await fixture();
  f.record.source_root = join(f.base, "foreign", "tree");
  await f.save();
  const problems = await removeRunSnapshot(f.artifactsDir, f.root);
  expect(problems.join(" ")).toMatch(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(await readFile(runSnapshotPath(f.artifactsDir), "utf8")).toContain("foreign");
});

test("owned copy cleanup deletes only the derived directory and record, and repeats as a no-op", async () => {
  const f = await fixture();
  await symlink(f.root, join(f.tree, "dependency"), process.platform === "win32" ? "junction" : "dir");
  f.record.linked = ["dependency"];
  await f.save();
  expect(await ensureRunSnapshot(f.root, f.artifactsDir)).toEqual(f.record);
  expect(await removeRunSnapshot(f.artifactsDir, f.root)).toEqual([]);
  expect(mocks.rm.mock.calls).toEqual([[f.dir, { recursive: true, force: true }], [runSnapshotPath(f.artifactsDir), { force: true }]]);
  expect(mocks.unlink).toHaveBeenCalledWith(join(f.tree, "dependency"));
  vi.clearAllMocks();
  expect(await removeRunSnapshot(f.artifactsDir, f.root)).toEqual([]);
  expect(mocks.rm).not.toHaveBeenCalled();
});

test.each(["repository", "linked", "copy-pins", "state", "identity"])("refuses inconsistent %s before cleanup or resume writes", async (kind) => {
  const f = await fixture();
  if (kind === "repository") f.record.repository_root = f.base;
  if (kind === "linked") f.record.linked = ["../outside"];
  if (kind === "copy-pins") f.record.pins = [{ repository: f.root, path: f.tree, base: null, index: "a".repeat(40), commit: "b".repeat(40), ref: `refs/audit-tools/snapshots/${f.key}` }];
  await f.save();
  if (kind === "state") process.env.AUDIT_CODE_STATE_DIR = join(f.base, "other-state");
  expect((await removeRunSnapshot(f.artifactsDir, kind === "identity" ? undefined : f.root)).join(" ")).toMatch(/ownership/i);
  if (kind !== "identity") await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  await expect(repinRunSnapshot(f.artifactsDir, kind === "identity" ? undefined : f.root)).rejects.toThrow(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mocks.unlink).not.toHaveBeenCalled();
});

test.each(["snapshots", "key", "tree"])("refuses a symlink at the owned %s boundary", async (level) => {
  const f = await fixture();
  // Rename only our empty fixture boundary; destructive operations remain mocked.
  const { rename } = await import("node:fs/promises");
  const path = level === "snapshots" ? join(f.base, "state", "snapshots") : level === "key" ? f.dir : f.tree;
  await rename(path, `${path}-saved`);
  await symlink(f.root, path, process.platform === "win32" ? "junction" : "dir");
  expect((await removeRunSnapshot(f.artifactsDir, f.root)).join(" ")).toMatch(/ownership/i);
  await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mocks.unlink).not.toHaveBeenCalled();
});

async function gitFixture(nested = false) {
  const f = await fixture();
  f.record.kind = "git";
  const repositories = nested ? [f.root, join(f.root, "sub"), join(f.root, "sub", "nested")] : [f.root];
  f.record.pins = repositories.map((repository, i) => ({ repository, path: join(f.tree, ...["sub", "nested"].slice(0, i)), base: "a".repeat(40), index: "b".repeat(40), commit: "c".repeat(40), ref: `refs/audit-tools/snapshots/${f.key}` }));
  for (const pin of f.record.pins) {
    await mkdir(join(pin.repository, ".git"), { recursive: true });
    await mkdir(pin.path, { recursive: true });
  }
  mocks.run.mockImplementation(async (argv: string[], options: { cwd: string }) => {
    let stdout = "";
    if (argv.includes("--show-toplevel")) stdout = options.cwd;
    else if (argv.includes("--git-common-dir")) stdout = join(options.cwd, ".git");
    else if (argv.includes("HEAD")) stdout = "a".repeat(40);
    else if (argv.includes("commit-tree")) stdout = "e".repeat(40);
    else if (argv.includes("ls-tree")) {
      const i = repositories.indexOf(options.cwd);
      if (i < repositories.length - 1) stdout = `160000 commit ${"a".repeat(40)}\t${i === 0 ? "sub" : "nested"}\0`;
    }
    return { status: 0, stdout, stderr: "" };
  });
  await f.save();
  return f;
}

const mutatingGitCalls = () => mocks.run.mock.calls.filter(([argv]) => argv.some((arg: string) =>
  ["update-ref", "read-tree", "checkout-index", "commit-tree", "add", "remove", "write-tree", "update-index"].includes(arg)));

test.each(["root-path", "nested-path", "repository", "ref", "oid", "order", "duplicate", "empty"])("Git %s inconsistency refuses all destructive operations", async (kind) => {
  const f = await gitFixture(true);
  if (kind === "root-path") f.record.pins[0].path = join(f.base, "other", "tree");
  if (kind === "nested-path") f.record.pins[1].path = join(f.tree, "..", "other");
  if (kind === "repository") f.record.pins[1].repository = f.root;
  if (kind === "ref") f.record.pins[2].ref = "refs/heads/main";
  if (kind === "oid") f.record.pins[2].commit = "--all";
  if (kind === "order") [f.record.pins[1], f.record.pins[2]] = [f.record.pins[2], f.record.pins[1]];
  if (kind === "duplicate") f.record.pins.push(f.record.pins[0]);
  if (kind === "empty") f.record.pins = [];
  await f.save();
  expect((await removeRunSnapshot(f.artifactsDir, f.root)).join(" ")).toMatch(/ownership/i);
  await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  await expect(repinRunSnapshot(f.artifactsDir, f.root)).rejects.toThrow(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(mutatingGitCalls()).toEqual([]);
});

test("valid nested Git cleanup removes only the owned checkouts and refs, deepest first", async () => {
  const f = await gitFixture(true);
  expect(await removeRunSnapshot(f.artifactsDir, f.root)).toEqual([]);
  const updates = mutatingGitCalls().map(([argv, options]) => ({ cwd: options.cwd, args: argv.slice(3) }));
  expect(updates).toEqual([...f.record.pins].reverse().flatMap((pin) => [
    { cwd: pin.repository, args: ["worktree", "remove", "--force", "--force", pin.path] },
    { cwd: pin.repository, args: ["update-ref", "-d", pin.ref] },
  ]));
});

async function registerCheckouts(f: Awaited<ReturnType<typeof gitFixture>>) {
  for (const pin of f.record.pins) {
    const registration = join(pin.repository, ".git", "worktrees", "snapshot");
    await mkdir(registration, { recursive: true });
    await writeFile(join(pin.path, ".git"), `gitdir: ${registration}\n`);
    await writeFile(join(registration, "gitdir"), `${join(pin.path, ".git")}\n`);
    await writeFile(join(registration, "commondir"), "../..\n");
  }
}

test("intact nested checkouts retain their record; repin uses only their owned refs", async () => {
  const f = await gitFixture(true);
  await registerCheckouts(f);
  expect(await ensureRunSnapshot(f.root, f.artifactsDir)).toEqual(f.record);
  expect(mutatingGitCalls()).toEqual([]);
  await repinRunSnapshot(f.artifactsDir, f.root);
  expect(mocks.tree.mock.calls).toHaveLength(3);
  const refs = mutatingGitCalls().filter(([args]) => args.includes("update-ref"));
  expect(refs.map(([args, options]) => [options.cwd, args.slice(-2)])).toEqual(
    [...f.record.pins].reverse().map(pin => [pin.repository, [pin.ref, "e".repeat(40)]]),
  );
  expect((JSON.parse(await readFile(runSnapshotPath(f.artifactsDir), "utf8")) as RunSnapshot).pins.every(pin => pin.commit === "e".repeat(40))).toBe(true);
});

test("lost nested checkouts restore parent-first exclusively within the owned tree", async () => {
  const f = await gitFixture(true);
  expect(await ensureRunSnapshot(f.root, f.artifactsDir)).toEqual(f.record);
  const adds = mutatingGitCalls().filter(([args]) => args.includes("add"));
  expect(adds.map(([args, options]) => [options.cwd, args.at(-2)])).toEqual(f.record.pins.map(pin => [pin.repository, pin.path]));
  expect(mocks.rm.mock.calls.filter(([, options]) => options?.recursive).map(([path]) => path)).toEqual(f.record.pins.map(pin => pin.path));
});

test.each(["foreign", "backlink", "commondir", "symlink"])("refuses %s Git checkout metadata before any mutation", async (kind) => {
  const f = await gitFixture(true);
  await registerCheckouts(f);
  const pin = f.record.pins[2];
  const registration = join(pin.repository, ".git", "worktrees", "snapshot");
  if (kind === "foreign") await writeFile(join(pin.path, ".git"), `gitdir: ${join(f.root, ".git")}\n`);
  if (kind === "backlink") await writeFile(join(registration, "gitdir"), `${join(f.root, ".git")}\n`);
  if (kind === "commondir") await writeFile(join(registration, "commondir"), `${join(f.root, ".git")}\n`);
  if (kind === "symlink") {
    const { rename } = await import("node:fs/promises");
    await rename(join(pin.path, ".git"), join(pin.path, ".git-saved"));
    // Windows file symlinks require privileges; a junction exercises the same
    // metadata-link refusal without changing OS security or skipping the case.
    await symlink(process.platform === "win32" ? registration : join(pin.path, ".git-saved"),
      join(pin.path, ".git"), process.platform === "win32" ? "junction" : "file");
  }
  expect((await removeRunSnapshot(f.artifactsDir, f.root)).join(" ")).toMatch(/ownership/i);
  await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  await expect(repinRunSnapshot(f.artifactsDir, f.root)).rejects.toThrow(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mutatingGitCalls()).toEqual([]);
});

test("restoration rechecks a child boundary after materializing its parent", async () => {
  const f = await gitFixture(true);
  const previous = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation(async (argv: string[], options: { cwd: string }) => {
    if (argv.includes("checkout-index") && options.cwd === f.tree) {
      const { rename } = await import("node:fs/promises");
      await rename(join(f.tree, "sub"), join(f.tree, "sub-saved"));
      await symlink(join(f.root, "sub"), join(f.tree, "sub"), process.platform === "win32" ? "junction" : "dir");
    }
    return previous(argv, options);
  });
  await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  expect(mocks.rm.mock.calls.map(([path]) => path)).toEqual([f.tree]);
  expect(mocks.unlink).not.toHaveBeenCalled();
});

test("refuses a symlinked worktree registration directory", async () => {
  const f = await gitFixture();
  await registerCheckouts(f);
  const registration = join(f.root, ".git", "worktrees", "snapshot");
  const { rename } = await import("node:fs/promises");
  await rename(registration, `${registration}-saved`);
  await symlink(`${registration}-saved`, registration, process.platform === "win32" ? "junction" : "dir");
  expect((await removeRunSnapshot(f.artifactsDir, f.root)).join(" ")).toMatch(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
  expect(mutatingGitCalls()).toEqual([]);
});

test.each([false, true])("frozen submodule ownership survives live-index changes (capture fallback: %s)", async (indexFallback) => {
  const f = await gitFixture(true);
  await registerCheckouts(f);
  const previous = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation(async (argv: string[], options: { cwd: string }) => {
    if (argv.includes("--stage") || (indexFallback && argv.includes("ls-tree") && argv.includes("b".repeat(40)))) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return previous(argv, options);
  });
  expect(await ensureRunSnapshot(f.root, f.artifactsDir)).toEqual(f.record);
  await repinRunSnapshot(f.artifactsDir, f.root);
  expect(await removeRunSnapshot(f.artifactsDir, f.root)).toEqual([]);
});

test.each(["src", "src/"])("the caller's repository subdirectory owns Git source prefix %s (including a Win32 trailing separator)", async (prefix) => {
  const f = await gitFixture();
  const callerRoot = join(f.root, "src");
  await mkdir(callerRoot);
  const key = hashContent(`${callerRoot}\0${f.artifactsDir}`).slice(0, 12);
  const dir = join(f.base, "state", "snapshots", key);
  const tree = join(dir, "tree");
  await mkdir(join(tree, "src"), { recursive: true });
  f.record.repository_root = callerRoot;
  f.record.source_root = join(tree, prefix);
  f.record.pins[0].path = tree;
  f.record.pins[0].ref = `refs/audit-tools/snapshots/${key}`;
  await f.save();
  const previous = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation(async (argv: string[], options: { cwd: string }) => {
    if (argv.includes("--is-inside-work-tree")) return { status: 0, stdout: "true", stderr: "" };
    if (argv.includes("--show-toplevel")) return { status: 0, stdout: f.root, stderr: "" };
    return previous(argv, options);
  });
  await registerCheckouts(f);
  expect(await ensureRunSnapshot(callerRoot, f.artifactsDir)).toEqual(f.record);
  await repinRunSnapshot(f.artifactsDir, callerRoot);
  vi.clearAllMocks();
  expect(await removeRunSnapshot(f.artifactsDir, callerRoot)).toEqual([]);
  expect(mocks.rm.mock.calls[0]).toEqual([dir, { recursive: true, force: true }]);
});

test("a record copied to another artifacts directory grants no ownership there", async () => {
  const f = await fixture();
  const otherArtifacts = join(f.root, "other-artifacts");
  await mkdir(otherArtifacts);
  await writeFile(runSnapshotPath(otherArtifacts), JSON.stringify(f.record));
  expect((await removeRunSnapshot(otherArtifacts, f.root)).join(" ")).toMatch(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
});


test("source ownership does not normalize persisted dot-segment aliases", async () => {
  const f = await fixture();
  f.record.source_root = `${f.tree}/../tree/`;
  await f.save();
  await expect(ensureRunSnapshot(f.root, f.artifactsDir)).rejects.toThrow(/ownership/i);
  await expect(repinRunSnapshot(f.artifactsDir, f.root)).rejects.toThrow(/ownership/i);
  expect((await removeRunSnapshot(f.artifactsDir, f.root)).join(" ")).toMatch(/ownership/i);
  expect(mocks.rm).not.toHaveBeenCalled();
});

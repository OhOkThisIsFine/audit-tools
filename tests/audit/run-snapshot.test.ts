import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { git, submoduleRepo } from "./helpers/submoduleRepo.mjs";
import { hashContent } from "audit-tools/shared";
import { readAuditReadState } from "../../src/shared/git.js";
import {
  ensureRunSnapshot,
  ensureRunSourceRoot,
  lookupRunSince,
  removeRunSnapshot,
  repinRunSnapshot,
  resolveRunSince,
  runSnapshotPath,
  writeBackSnapshotEdits,
} from "../../src/audit/io/runSnapshot.js";

async function gitOut(cwd: string, args: string[]): Promise<string> {
  return String(execFileSyncHidden("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * A committed repo with tracked dirt, an untracked file, a STAGED new file, a
 * staged deletion kept on disk, an ignored directory and an ignored file.
 */
async function dirtyRepo(): Promise<{ root: string; artifactsDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "audit-run-snapshot-"));
  const root = join(base, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n.audit-tools/\n");
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "old.ts"), "export const o = 1;\n");
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(root, "src", "new.ts"), "export const n = 1;\n");
  await writeFile(join(root, "src", "staged.ts"), "export const s = 1;\n");
  await git(root, ["add", "src/staged.ts"]);
  await git(root, ["rm", "-q", "--cached", "src/old.ts"]);
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(root, ".env"), "KEY=1\n");
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  cleanups.push(async () => {
    await removeRunSnapshot(artifactsDir);
    await rm(base, { recursive: true, force: true });
  });
  return { root, artifactsDir };
}

describe("ensureRunSnapshot — git root", () => {
  test("pins the working tree as it is, dirt included, without touching the live index or HEAD", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const headBefore = await gitOut(root, ["rev-parse", "HEAD"]);
    const statusBefore = await gitOut(root, ["status", "--porcelain"]);
    const snapshot = await ensureRunSnapshot(root, artifactsDir);

    expect(snapshot.kind).toBe("git");
    expect(await readFile(join(snapshot.source_root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await readFile(join(snapshot.source_root, "src", "new.ts"), "utf8")).toBe("export const n = 1;\n");
    // The snapshot's HEAD is the user's real commit; the content pin is internal.
    expect(await gitOut(snapshot.source_root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(snapshot.pins[0].base).toBe(headBefore);
    expect(snapshot.pins[0].commit).not.toBe(headBefore);
    expect(await gitOut(root, ["rev-parse", `${snapshot.pins[0].commit}^`])).toBe(headBefore);
    expect(await gitOut(root, ["rev-parse", snapshot.pins[0].ref])).toBe(snapshot.pins[0].commit);
    expect(await gitOut(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await gitOut(root, ["status", "--porcelain"])).toBe(statusBefore);
    expect(existsSync(join(snapshot.source_root, ".audit-tools"))).toBe(false);
  });

  test("git inside the snapshot answers as the live tree did: tracked set, history and audit-read state", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const liveTracked = await gitOut(root, ["ls-files"]);
    const liveLog = await gitOut(root, ["log", "--format=%H %an"]);
    const liveRead = await readAuditReadState(root);
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    // An untracked live file stays untracked (the disposition rule keys on it).
    expect(await gitOut(snapshot.source_root, ["ls-files"])).toBe(liveTracked);
    // No synthetic commit reaches history mining.
    expect(await gitOut(snapshot.source_root, ["log", "--format=%H %an"])).toBe(liveLog);
    expect(await readAuditReadState(snapshot.source_root, null, { excludePaths: snapshot.linked })).toEqual(liveRead);
  });

  test("a root that is a subdirectory of the repository reads from the same subdirectory of the snapshot", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const sub = join(root, "src");
    const snapshot = await ensureRunSnapshot(sub, artifactsDir);
    expect(await readFile(join(snapshot.source_root, "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  test("a repository with no commit yet is snapshotted with its files", async () => {
    const base = await mkdtemp(join(tmpdir(), "audit-run-snapshot-empty-"));
    const root = join(base, "repo");
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    cleanups.push(async () => {
      await removeRunSnapshot(artifactsDir);
      await rm(base, { recursive: true, force: true });
    });
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(await readFile(join(snapshot.source_root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await gitOut(snapshot.source_root, ["ls-files", "--others", "--exclude-standard"])).toBe("a.ts");
    // HEAD stays unborn, as live: no synthetic commit reaches audit_read or history.
    expect(await readAuditReadState(snapshot.source_root)).toBeNull();
    expect(snapshot.pins[0].base).toBeNull();
  });

  test.skipIf(process.platform === "win32")("an ignored dangling symlink is skipped, never fatal", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n.audit-tools/\nresult\n");
    await symlink(join(root, "no-such-target"), join(root, "result"));
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(await readFile(join(snapshot.source_root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  test("a --since ref is resolved once against the live root and kept for the run", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await ensureRunSnapshot(root, artifactsDir);
    const head = await gitOut(root, ["rev-parse", "HEAD"]);
    expect(await resolveRunSince(root, artifactsDir, "HEAD")).toBe(head);
    await git(root, ["add", "-A"]);
    await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "moved"]);
    expect(await resolveRunSince(root, artifactsDir, "HEAD")).toBe(head);
    expect(await lookupRunSince(artifactsDir, "HEAD")).toBe(head);
  });

  test("links ignored directories and copies ignored files", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect((await lstat(join(snapshot.source_root, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(snapshot.source_root, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    const env = await lstat(join(snapshot.source_root, ".env"));
    expect(env.isFile() && !env.isSymbolicLink()).toBe(true);
  });

  test("a live edit after run start does not reach the snapshot; a second call returns the same pin", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const first = await ensureRunSnapshot(root, artifactsDir);
    await writeFile(join(root, "src", "a.ts"), "export const a = 3;\n");
    const second = await ensureRunSnapshot(root, artifactsDir);
    expect(second).toEqual(first);
    expect(await readFile(join(second.source_root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  test("a clean tree's snapshot sits at HEAD with a clean status", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await git(root, ["add", "-A"]);
    await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "clean"]);
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(snapshot.pins[0].base).toBe(await gitOut(root, ["rev-parse", "HEAD"]));
    expect(await readAuditReadState(snapshot.source_root, null, { excludePaths: snapshot.linked }))
      .toEqual({ commit: snapshot.pins[0].base, dirty_paths: [] });
  });

  test("a completed run is given the live root and no snapshot", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "complete", obligations: [] }));
    expect(await ensureRunSourceRoot(root, artifactsDir)).toBe(root);
    expect(existsSync(runSnapshotPath(artifactsDir))).toBe(false);
  });

  test("a missing checkout is re-created from its pin on resume", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    // A restored checkout comes from the pin through a normal checkout; with
    // line-ending conversion off it reproduces the copied bytes exactly.
    await git(root, ["config", "core.autocrlf", "false"]);
    const first = await ensureRunSnapshot(root, artifactsDir);
    await removeRunSnapshotDirOnly(first.pins[0].path);
    await writeFile(join(root, "src", "a.ts"), "export const a = 9;\n");
    const resumed = await ensureRunSnapshot(root, artifactsDir);
    expect(resumed).toEqual(first);
    expect(await readFile(join(resumed.source_root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  test("removal deletes the checkout, the ref and the worktree registration, never the linked live directory", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(await removeRunSnapshot(artifactsDir)).toEqual([]);
    expect(existsSync(snapshot.source_root)).toBe(false);
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    await expect(gitOut(root, ["rev-parse", "--verify", "--quiet", snapshot.pins[0].ref])).rejects.toThrow();
    expect(await gitOut(root, ["worktree", "list", "--porcelain"])).not.toContain(snapshot.source_root.replace(/\\/g, "/"));
  });

  test("a held live index.lock loses no staged path, and the live index is never written", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const liveTracked = await gitOut(root, ["ls-files"]);
    await writeFile(join(root, ".git", "index.lock"), "");
    const indexBefore = await readFile(join(root, ".git", "index"));
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(await gitOut(snapshot.source_root, ["ls-files"])).toBe(liveTracked);
    expect((await readFile(join(root, ".git", "index"))).equals(indexBefore)).toBe(true);
    await rm(join(root, ".git", "index.lock"));
  });

  test("a TRACKED file under a nested .audit-tools segment is snapshot content", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await mkdir(join(root, "pkg", ".audit-tools"), { recursive: true });
    await writeFile(join(root, "pkg", ".audit-tools", "keep.json"), "{}\n");
    await git(root, ["add", "-f", "pkg/.audit-tools/keep.json"]);
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(await readFile(join(snapshot.source_root, "pkg", ".audit-tools", "keep.json"), "utf8")).toBe("{}\n");
    expect((await readAuditReadState(snapshot.source_root, null, { excludePaths: snapshot.linked }))?.dirty_paths)
      .toEqual((await readAuditReadState(root))?.dirty_paths);
  });

  test("an untracked nested repository is copied as its own git lists it; its ignored output is linked, never copied", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    const nested = join(root, "vendor", "lib");
    await mkdir(join(nested, "build"), { recursive: true });
    await git(nested, ["init", "-q"]);
    await writeFile(join(nested, ".gitignore"), "build/\n");
    await writeFile(join(nested, "x.ts"), "export const x = 1;\n");
    await writeFile(join(nested, "build", "out.js"), "built\n");
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    const snapNested = join(snapshot.source_root, "vendor", "lib");
    expect(await readFile(join(snapNested, "x.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(existsSync(join(snapNested, ".git"))).toBe(false);
    expect((await lstat(join(snapNested, "build"))).isSymbolicLink()).toBe(true);
    expect(snapshot.linked).toContain("vendor/lib/build");
  });

  test.skipIf(process.platform === "win32")("a symlink with an ABSOLUTE target inside the repository points into the snapshot", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await symlink(join(await realpath(root), "src", "a.ts"), join(root, "src", "abs-link.ts"));
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    await writeFile(join(root, "src", "a.ts"), "export const a = 'live';\n");
    expect(await readFile(join(snapshot.source_root, "src", "abs-link.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  test("an unborn checkout whose .git link went missing is restored, not taken as intact", async () => {
    const base = await mkdtemp(join(tmpdir(), "audit-run-snapshot-unborn-"));
    const root = join(base, "repo");
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    cleanups.push(async () => {
      await removeRunSnapshot(artifactsDir);
      await rm(base, { recursive: true, force: true });
    });
    const first = await ensureRunSnapshot(root, artifactsDir);
    await rm(join(first.source_root, ".git"), { force: true });
    await ensureRunSnapshot(root, artifactsDir);
    expect(await gitOut(first.source_root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/audit-tools-unborn-snapshot");
  });

  test("a populated submodule is pinned inside the snapshot, so ls-files still recurses into it", async () => {
    const fixture = await submoduleRepo();
    const artifactsDir = join(fixture.root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    cleanups.push(async () => {
      await removeRunSnapshot(artifactsDir);
      await fixture.dispose();
    });
    await writeFile(join(fixture.root, "sub", "a.ts"), "export const x = 2;\n");
    const snapshot = await ensureRunSnapshot(fixture.root, artifactsDir);
    expect(snapshot.pins).toHaveLength(2);
    expect(await readFile(join(snapshot.source_root, "sub", "a.ts"), "utf8")).toBe("export const x = 2;\n");
    const listed = (await gitOut(snapshot.source_root, ["ls-files", "--recurse-submodules"])).split(/\r?\n/);
    expect(listed).toContain("sub/a.ts");
  });
});

describe("the tool's own snapshot edits (opted-in auto-fix)", () => {
  test("write back only files whose live bytes are still the run-start bytes, then re-pin", async () => {
    const { root, artifactsDir } = await dirtyRepo();
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
    const first = await ensureRunSnapshot(root, artifactsDir);
    const startHashes = new Map<string, string>();
    for (const path of ["src/a.ts", "src/b.ts"]) {
      startHashes.set(path, hashContent(await readFile(join(first.source_root, path))));
    }
    // The user edits b.ts after the run started; the "formatter" rewrites both in the snapshot.
    await writeFile(join(root, "src", "b.ts"), "export const b = 'user';\n");
    await writeFile(join(first.source_root, "src", "a.ts"), "export const a = 2; // formatted\n");
    await writeFile(join(first.source_root, "src", "b.ts"), "export const b = 1; // formatted\n");

    const outcome = await writeBackSnapshotEdits({
      sourceRoot: first.source_root,
      repositoryRoot: root,
      paths: ["src/b.ts", "src/a.ts", "src/new.ts"],
      startHashes,
    });
    expect(outcome).toEqual({ written: ["src/a.ts"], skipped: ["src/b.ts"] });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2; // formatted\n");
    expect(await readFile(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 'user';\n");

    await repinRunSnapshot(artifactsDir);
    const repinned = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { pins: Array<{ commit: string; ref: string }> };
    const pin = repinned.pins[0];
    expect(pin.commit).not.toBe(first.pins[0].commit);
    // A re-pin replaces the internal content pin; the checkout's HEAD stays the base.
    expect(await gitOut(root, ["rev-parse", `${pin.commit}^`])).toBe(first.pins[0].base);
    expect(await gitOut(root, ["rev-parse", pin.ref])).toBe(pin.commit);
    expect(await gitOut(first.source_root, ["rev-parse", "HEAD"])).toBe(first.pins[0].base);
    expect(await gitOut(root, ["show", `${pin.commit}:src/a.ts`])).toBe("export const a = 2; // formatted");
  });
});

describe("ensureRunSnapshot — non-git root", () => {
  async function plainDir(): Promise<{ root: string; artifactsDir: string }> {
    const base = await mkdtemp(join(tmpdir(), "audit-run-snapshot-copy-"));
    const root = join(base, "repo");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    cleanups.push(async () => {
      await removeRunSnapshot(artifactsDir);
      await rm(base, { recursive: true, force: true });
    });
    return { root, artifactsDir };
  }

  test("copies the tree, links default-ignored directories, and skips .audit-tools", async () => {
    const { root, artifactsDir } = await plainDir();
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    expect(snapshot.kind).toBe("copy");
    await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
    expect(await readFile(join(snapshot.source_root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect((await lstat(join(snapshot.source_root, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(existsSync(join(snapshot.source_root, ".audit-tools"))).toBe(false);
    expect(await removeRunSnapshot(artifactsDir)).toEqual([]);
    expect(existsSync(join(root, "node_modules", "dep", "index.js"))).toBe(true);
  });

  test("a missing copy fails closed and names the recovery", async () => {
    const { root, artifactsDir } = await plainDir();
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    await removeRunSnapshotDirOnly(snapshot.source_root);
    await expect(ensureRunSnapshot(root, artifactsDir)).rejects.toThrow(/audit-code cleanup --force/);
    expect(existsSync(runSnapshotPath(artifactsDir))).toBe(true);
  });
});

/** Delete a snapshot checkout the way an OS temp cleaner would: links unlinked, never followed. */
async function removeRunSnapshotDirOnly(dir: string): Promise<void> {
  for (const name of ["node_modules"]) {
    const link = join(dir, name);
    if (existsSync(link) && (await lstat(link)).isSymbolicLink()) await rm(link, { force: true });
  }
  await rm(dir, { recursive: true, force: true });
}

import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { workingTreeTree } from "../../src/shared/git.js";

async function fixture(run: (root: string, git: (...args: string[]) => string) => Promise<void>, options: { trackedScratch?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "working-tree-scratch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.longpaths", "false");
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".audit-tools"));
    await writeFile(join(root, "src/a.ts"), "before\n");
    await writeFile(join(root, "src/deleted.ts"), "delete me\n");
    if (options.trackedScratch !== false) await writeFile(join(root, ".audit-tools/seed.txt"), "tracked scratch\n");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const indexBefore = await readFile(join(root, ".git/index"));
    const headBefore = git("rev-parse", "HEAD");
    await run(root, git);
    expect(await readFile(join(root, ".git/index"))).toEqual(indexBefore);
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ignored untracked scratch does not invalidate the working-tree identity", async () => {
  await fixture(async (root, git) => {
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".audit-tools/");
    await writeFile(join(root, ".gitignore"), ".audit-tools/\n");
    const scratch = join(root, ".audit-tools/observation.json");
    await writeFile(scratch, "first\n");
    const first = await workingTreeTree(root);
    expect(first).toMatch(/^[a-f0-9]{40,64}$/);
    const paths = git("ls-tree", "-r", "--name-only", first!).trim().split(/\r?\n/);
    expect(paths).toContain(".gitignore");
    expect(paths).toContain("src/a.ts");
    expect(paths.some(path => path.startsWith(".audit-tools/"))).toBe(false);
    await writeFile(scratch, "changed scratch\n");
    expect(await workingTreeTree(root)).toBe(first);
    await writeFile(join(root, "src/a.ts"), "changed source\n");
    const changed = await workingTreeTree(root);
    expect(changed).toMatch(/^[a-f0-9]{40,64}$/);
    expect(changed).not.toBe(first);
  }, { trackedScratch: false });
});

test("deep unignored scratch is excluded before staging and HEAD scratch is removed", async () => {
  await fixture(async (root, git) => {
    const directory = join(root, ".audit-tools", "deep-segment-".repeat(6));
    await mkdir(directory, { recursive: true });
    const scratch = join(directory, "x".repeat(Math.max(1, 271 - directory.length - 6)) + ".json");
    expect(scratch.length).toBeGreaterThanOrEqual(271);
    await writeFile(scratch, "first\n");
    const first = await workingTreeTree(root);
    expect(first).toMatch(/^[a-f0-9]{40,64}$/);
    expect(git("ls-tree", "-r", "--name-only", first!)).not.toContain(".audit-tools/");
    await writeFile(scratch, "changed scratch\n");
    expect(await workingTreeTree(root)).toBe(first);
    await writeFile(join(root, "src/a.ts"), "changed source\n");
    expect(await workingTreeTree(root)).not.toBe(first);
  });
});

test("real source additions deletions edits and near-match scratch directories remain included", async () => {
  await fixture(async (root, git) => {
    await mkdir(join(root, ".audit-tools-keep"));
    await mkdir(join(root, "nested/.audit-tools"), { recursive: true });
    await writeFile(join(root, ".audit-tools-keep/keep.ts"), "one\n");
    await writeFile(join(root, "nested/.audit-tools/keep.ts"), "one\n");
    const first = await workingTreeTree(root);
    await writeFile(join(root, ".audit-tools-keep/keep.ts"), "two\n");
    const second = await workingTreeTree(root);
    expect(second).not.toBe(first);
    await writeFile(join(root, "nested/.audit-tools/keep.ts"), "two\n");
    const third = await workingTreeTree(root);
    expect(third).not.toBe(second);
    await writeFile(join(root, "src/a.ts"), "edited\n");
    await writeFile(join(root, "src/new.ts"), "new\n");
    await rm(join(root, "src/deleted.ts"));
    const changed = await workingTreeTree(root);
    expect(changed).not.toBe(third);
    const paths = git("ls-tree", "-r", "--name-only", changed!).trim().split(/\r?\n/);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/new.ts");
    expect(paths).not.toContain("src/deleted.ts");
    expect(paths).toContain(".audit-tools-keep/keep.ts");
    expect(paths).toContain("nested/.audit-tools/keep.ts");
    expect(git("show", `${changed!}:src/a.ts`)).toBe("edited\n");
  });
});

test("explicit excluded placements retain their existing semantics", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "placement"));
    await writeFile(join(root, "placement/generated.ts"), "one\n");
    const options = { excludePaths: ["placement"] };
    const first = await workingTreeTree(root, options);
    expect(first).toMatch(/^[a-f0-9]{40,64}$/);
    await writeFile(join(root, "placement/generated.ts"), "two\n");
    expect(await workingTreeTree(root, options)).toBe(first);
    await writeFile(join(root, "src/a.ts"), "changed\n");
    expect(await workingTreeTree(root, options)).not.toBe(first);
  });
});

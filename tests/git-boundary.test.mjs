import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { worktreeTree, worktreeTrees } from "../scripts/shared/worktree-tree.mjs";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

test("audit sees staged and unstaged changes and remediation uses the same dirty-tree boundary", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "git-contract-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("git-contract-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  const { readAuditReadState, stagedAndUntracked } = await load("shared/git.js");
  assert.equal(await readAuditReadState(root), null);
  git("init","-q","--template=");
  await mkdir(join(root,"src"));
  await writeFile(join(root,"src","base.ts"),"export const version = 1;\n");
  git("add","src/base.ts");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","Fixture baseline","--no-gpg-sign");
  const head=git("rev-parse","HEAD").trim();
  await writeFile(join(root,"src","index.ts"),"export const staged = 1;\n");
  git("add","src/index.ts");
  await writeFile(join(root,"src","base.ts"),"export const version = 2;\n");
  await writeFile(join(root,"src","new.ts"),"export const untracked = 1;\n");
  const paths=["src/base.ts","src/index.ts","src/new.ts"];
  const originalIndex=await readFile(join(root,".git","index"));
  assert.deepEqual(await readAuditReadState(root),{commit:head,dirty_paths:paths});
  assert.deepEqual((await stagedAndUntracked(root)).sort(),paths);
  assert.equal(await readAuditReadState(join(root,"src")),null);
  await assert.rejects(stagedAndUntracked(join(root,"src")),/top-level/);
  assert.deepEqual(await readFile(join(root,".git","index")),originalIndex);
});

async function releaseFixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "git-contract-release-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("git-contract-release-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" });
  git("init", "-q", "--template=");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Fixture baseline", "--allow-empty", "--no-gpg-sign");
  return root;
}

async function writeReleaseFiles(root, version, includeLock = true) {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version, private: true }, null, 2));
  if (includeLock) {
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      name: "fixture", version, packages: { "": { version } },
    }, null, 2));
  }
}

test("masking changes only the release identity, including with an optional file absent", async t => {
  for (const includeLock of [true, false]) {
    const root = await releaseFixture(t);
    await writeReleaseFiles(root, "1.0.0", includeLock);
    const before = worktreeTrees(root);
    assert.equal(before?.tree, worktreeTree(root));
    assert.ok(before?.bumpAgnosticTree);
    await writeReleaseFiles(root, "2.0.0", includeLock);
    const after = worktreeTrees(root);
    assert.equal(after?.tree, worktreeTree(root));
    assert.notEqual(after?.tree, before.tree);
    assert.equal(after?.bumpAgnosticTree, before.bumpAgnosticTree);
  }
});

test("a later masking failure returns only the proven exact tree", async t => {
  const root = await releaseFixture(t);
  await writeReleaseFiles(root, "1.0.0");
  const expectedTree = worktreeTree(root);
  assert.ok(expectedTree);
  const steps = [
    ["second presence lookup", args => args[0] === "ls-files" && args.at(-1) === "package-lock.json"],
    ["second present blob read", args => args[0] === "cat-file" && args.at(-1) === ":package-lock.json"],
    ["second hash", (args, count) => args[0] === "hash-object" && count >= 1],
    ["second index replacement", (args, count) => args[0] === "update-index" && count >= 1],
    ["final write-tree", (args, count) => args[0] === "write-tree" && count >= 2],
  ];
  for (const [label, fails] of steps) {
    await t.test(label, subtest => {
      let replacements = 0;
      let injected = false;
      let temporaryIndex;
      const realSpawn = childProcess.spawnSync;
      const patch = subtest.mock.method(childProcess, "spawnSync", (command, args, options) => {
        assert.equal(command, "git");
        temporaryIndex = options.env.GIT_INDEX_FILE;
        if (fails(args, replacements)) {
          injected = true;
          // A plausible object ID does not make a failed command successful.
          return { status: 1, stdout: expectedTree + "\n" };
        }
        const result = realSpawn(command, args, options);
        if (args[0] === "update-index" && result.status === 0) replacements++;
        return result;
      });
      syncBuiltinESMExports();
      let captured;
      try {
        captured = worktreeTrees(root);
      } finally {
        patch.mock.restore();
        syncBuiltinESMExports();
      }
      assert.ok(injected);
      assert.equal(replacements, label === "final write-tree" ? 2 : 1);
      assert.deepEqual(captured, { tree: expectedTree, bumpAgnosticTree: null });
      assert.ok(temporaryIndex);
      assert.equal(existsSync(temporaryIndex), false);
    });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const { runTrackedAsync } = await import(pathToFileURL(join(checkout,"dist","shared","tooling","exec.js")).href);

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "audit-boundary-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("audit-boundary-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("the npm tarball contains both commands and its own canonical audit prompt", async t => {
  const root = await fixture(t);
  const packed = await runTrackedAsync(["npm","pack","--offline","--ignore-scripts","--json","--pack-destination",root],{cwd:checkout,timeout:20000});
  assert.equal(packed.status,0,packed.stderr);
  assert.equal(packed.error,undefined);
  const metadata = JSON.parse(packed.stdout);
  const entry = Array.isArray(metadata) ? metadata[0] : metadata["audit-tools"];
  assert.equal(entry?.name,"audit-tools");
  assert.match(entry.filename,/^audit-tools-[0-9][a-z0-9.-]*\.tgz$/i);
  const files = entry.files.map(({path})=>path);
  for (const path of ["audit-code.mjs","remediate-code.mjs","dist/audit/index.js","dist/remediate/index.js"]) assert.ok(files.includes(path),path);
  assert.ok(files.every(path=>!path.split("/").includes("..") && !isAbsolute(path) && !path.includes("\\")));
  assert.ok(!files.some(path=>/^(experiments|tests|src|\.audit-tools)\//.test(path)));
  const extracted = await runTrackedAsync(["tar","-xf",join(root,entry.filename),"-C",root],{cwd:root,timeout:10000});
  assert.equal(extracted.status,0,extracted.stderr);
  const packaged = join(root,"package");
  // Use already-installed dependencies, never install or fetch during this smoke.
  // The shipped wrapper, built code and prompt themselves come from the tarball.
  const dependencies = join(packaged,"node_modules");
  const installed = await realpath(join(checkout,"node_modules"));
  let linked = false;
  try {
    await symlink(installed,dependencies,process.platform==="win32"?"junction":"dir");
    linked = true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    // A restricted Windows fixture may forbid junction creation. Copy only
    // top-level runtime packages; cp includes any dependencies nested in them.
    const { packages } = JSON.parse(await readFile(join(checkout, "package-lock.json"), "utf8"));
    for (const [path, { dev, optional }] of Object.entries(packages)) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
      if (dev || !match) continue;
      try {
        await cp(join(installed, match[1]), join(dependencies, match[1]), { recursive: true, dereference: true });
      } catch (error) {
        if (!optional || error.code !== "ENOENT") throw error;
      }
    }
  }
  try {
    const prompt = await runTrackedAsync([process.execPath,join(packaged,"audit-code.mjs"),"prompt-path"],{cwd:root,timeout:10000});
    assert.equal(prompt.status,0,prompt.stderr);
    const target = await realpath(prompt.stdout.trim());
    const sub = relative(await realpath(packaged),target);
    assert.ok(sub && sub !== ".." && !sub.startsWith(".."+sep) && !isAbsolute(sub));
    assert.ok((await readFile(target,"utf8")).includes("audit-code"));
  } finally {
    if (linked) await unlink(dependencies);
  }
});

test("a tool-owned child can't keep working past its execution deadline", async t => {
  const root = await fixture(t);
  const child = join(root,"wait.mjs");
  const pidPath = join(root,"fixture.pid");
  await writeFile(child,'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{}, 500);');
  const result = await runTrackedAsync([process.execPath,child,pidPath],{cwd:root,timeout:1800});
  assert.equal(result.error?.code,"ETIMEDOUT");
  assert.equal(result.cleanup?.scope,process.platform==="win32"?"windows_job":"process_group");
  const pid = Number(await readFile(pidPath,"utf8"));
  assert.ok(pid>0 && pid!==process.pid);
  assert.throws(()=>process.kill(pid,0), {code:"ESRCH"});
});

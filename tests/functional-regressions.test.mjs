import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

test("audit route evidence comes from executable code, not comments or a closing-tag prefix", async () => {
  const { extractConventionalRouteEvidence } = await load("audit/extractors/graphRoutes.js");
  const { routeScriptSource } = await load("audit/extractors/graphRouteSources.js");
  const source = '/*\nexport function DELETE() {}\n*/\nexport function GET() {}';
  const routes = extractConventionalRouteEvidence("app/api/orders/route.ts", source);
  assert.deepEqual(routes.map(route => route.method), ["GET"]);
  const script = routeScriptSource("Orders.vue", '<script>\nconst example = "</script-not-a-close>";\nconst marker = 42;\n</script><aside>outside</aside>');
  assert.match(script,/const marker = 42/);
  assert.doesNotMatch(script,/outside/);
});

test("verification can suggest a declared Make test without running or taking authority from it", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "verify-discovery-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("verify-discovery-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const { suggestDeclaredMakeTest, discoverProjectCommands } = await load("shared/tooling/testCommand.js");
  await writeFile(join(root,"Makefile"), "test:\n\t@echo fixture\n");
  assert.deepEqual(suggestDeclaredMakeTest(root), ["make","test"]);
  assert.notDeepEqual(discoverProjectCommands(root).test, ["make","test"]);
  await writeFile(join(root,"GNUmakefile"), "build:\n\t@echo fixture\n");
  assert.equal(suggestDeclaredMakeTest(root),undefined);
});

test("operator lifecycle writes require a fresh phase ownership assertion", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "operator-lifecycle-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("operator-lifecycle-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const { StateStore, OPERATOR_LIFECYCLE_FILENAME } = await load("remediate/state/store.js");
  const store = new StateStore(root);
  const refused = new Error("fixture phase ownership assertion refused");
  const deny = async () => { throw refused; };
  const allow = async () => {};
  const compareRefusal = { message: refused.message };
  await assert.rejects(store.setOperatorLifecycleUnderPhaseLock(deny, "plan-only"), compareRefusal);
  assert.equal(await store.loadOperatorLifecycle(), null);
  await store.setOperatorLifecycleUnderPhaseLock(allow, "plan-only");
  const file = join(root, OPERATOR_LIFECYCLE_FILENAME);
  const before = await readFile(file, "utf8");
  assert.equal(JSON.parse(before).plan_only, true);
  await assert.rejects(store.setOperatorLifecycleUnderPhaseLock(deny, "pause", undefined, "plan-only"), compareRefusal);
  assert.equal(await readFile(file, "utf8"), before);
  await store.setOperatorLifecycleUnderPhaseLock(allow, "pause", undefined, "plan-only");
  assert.equal((await store.loadOperatorLifecycle()).mode, "paused");
  await assert.rejects(store.setOperatorLifecycleUnderPhaseLock(deny, "resume"), compareRefusal);
  assert.equal((await store.loadOperatorLifecycle()).mode, "paused");
});

test("local command resolution skips unusable entries without hiding a tool exit or bypassing consent", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "local-command-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const { resolveNodeTool, runFirstAvailableCommand } = await load("audit/orchestrator/localCommands.js");
  const windows = process.platform === "win32";
  const bin = windows ? "fixture-command.cmd" : "fixture-command";
  const earlier = join(root, "earlier");
  const later = join(root, "later");
  await mkdir(earlier);
  await mkdir(later);
  await mkdir(join(earlier, bin));
  const tool = windows ? "@echo later path\r\n" : "#!/bin/sh\nprintf 'later path\\n'\n";
  await writeFile(join(later, bin), tool, { mode: 0o755 });
  const savedPath = process.env.PATH;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });
  process.env.PATH = [earlier, later, savedPath].filter(Boolean).join(delimiter);

  const success = { command: process.execPath, args: ["-e", "process.stdout.write('fallback')"] };
  const byPath = { command: bin, args: [] };
  assert.equal((await runFirstAvailableCommand(root, [byPath, success])).stdout.trim(), "later path");
  assert.deepEqual(resolveNodeTool(root, join("earlier", bin), [], "directory shim"), []);
  assert.equal(
    (await runFirstAvailableCommand(root, [{ command: join(earlier, bin), args: [] }, success])).stdout,
    "fallback",
  );

  await rmdir(join(earlier, bin));
  if (!windows) {
    await writeFile(join(earlier, bin), "#!/bin/sh\nexit 9\n", { mode: 0o644 });
    assert.equal((await runFirstAvailableCommand(root, [byPath, success])).stdout.trim(), "later path");
  }
  // A regular executable-looking file can still fail before the tool starts.
  const invalid = windows ? "invalid-fixture.exe" : "invalid-fixture";
  await writeFile(join(root, invalid), "#!/audit-tools-fixture-interpreter-not-present\n", { mode: 0o755 });
  assert.equal(
    (await runFirstAvailableCommand(root, [{ command: join(root, invalid), args: [] }, success])).stdout,
    "fallback",
  );

  const nonzero = { command: process.execPath, args: ["-e", "process.stderr.write('tool diagnostic'); process.exit(7)"], toolId: "fixture-tool" };
  const result = await runFirstAvailableCommand(root, [nonzero, success]);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "tool diagnostic");
  assert.equal(result.error, undefined);
  assert.equal(
    (await runFirstAvailableCommand(root, [nonzero, success], { analyzerConsent: { "fixture-tool": "declined" } })).stdout,
    "fallback",
  );
});

test("both wrappers detect base-config-only changes and preserve source-less and missing-config rules", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "wrapper-freshness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "src");
  const distDir = join(root, "dist", "remediate");
  const dist = join(distDir, "index.js");
  const config = join(root, "tsconfig.json");
  const base = join(root, "tsconfig.base.json");
  const wrapper = join(root, "remediate-code.mjs");
  await copyFile(join(checkout, "remediate-code.mjs"), wrapper);
  await mkdir(source);
  await mkdir(distDir, { recursive: true });
  await writeFile(dist, "");
  await writeFile(config, '{"extends":"./tsconfig.base.json"}');
  await writeFile(base, "{}");
  const old = new Date("2020-01-01");
  const built = new Date("2020-01-02");
  const newer = new Date("2020-01-03");
  await utimes(source, old, old);
  await utimes(config, old, old);
  await utimes(base, old, old);
  await utimes(dist, built, built);

  const { shouldBuildDist: remediateBuild } = await import(pathToFileURL(wrapper).href);
  const { shouldBuildDistForPaths } = await import(pathToFileURL(join(checkout, "wrapper", "audit-code-wrapper-build.mjs")).href);
  const auditBuild = () => shouldBuildDistForPaths({ distEntryPath: dist, sourceRootPath: source, tsconfigPath: config });
  async function expectFreshness(remediate, audit) {
    assert.equal(remediateBuild(), remediate);
    assert.equal(await auditBuild(), audit);
  }
  await expectFreshness(false, false);
  await utimes(base, newer, newer);
  await expectFreshness(true, true);

  await unlink(base);
  await expectFreshness(false, false);
  await unlink(config);
  await writeFile(base, "{}");
  await utimes(base, newer, newer);
  await expectFreshness(false, false);
  await utimes(source, newer, newer);
  await expectFreshness(true, false);

  await rmdir(source);
  await writeFile(config, "{}");
  await writeFile(base, "{}");
  await expectFreshness(false, false);
  await unlink(dist);
  assert.equal(remediateBuild(), false);
  await assert.rejects(auditBuild, /Bundled dist is missing and source files are unavailable/);
});

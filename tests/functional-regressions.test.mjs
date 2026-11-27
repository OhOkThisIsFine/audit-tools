import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

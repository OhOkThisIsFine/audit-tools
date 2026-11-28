import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildGraphBundle,
  GRAPH_EDGE_CACHE_KEY_VERSION,
} from "../dist/audit/extractors/graph.js";
import {
  bindWorkerPrompt,
  workerPromptBindingHolds,
} from "../dist/shared/submission/workerPromptBinding.js";

test("graph reuses current cache keys, but re-extracts old versions and entries without source", () => {
  const from = "src/from.ts";
  const to = "src/to.ts";
  const contents = {
    [from]: "import { value } from './to';\nexport const answer = value;",
    [to]: "export const value = 42;",
  };
  const manifest = {
    files: Object.entries(contents).map(([path, source]) => ({
      path,
      language: "typescript",
      size_bytes: source.length,
      hash: createHash("sha256").update(source).digest("hex"),
    })),
  };
  const cachedBuild = (fileContents, priorEdgeCache) => {
    const edgeCacheSink = {};
    const bundle = buildGraphBundle(manifest, undefined, { fileContents, priorEdgeCache, edgeCacheSink });
    return { bundle, cache: edgeCacheSink.cache };
  };

  const fresh = cachedBuild(contents);
  const key = fresh.cache.entries[from].content_key;
  assert.ok(key.startsWith(`${GRAPH_EDGE_CACHE_KEY_VERSION}:content:`));
  assert.ok(fresh.bundle.graphs.imports.some(edge => edge.from === from && edge.to === to));
  const replayed = cachedBuild(contents, fresh.cache);
  assert.equal(replayed.cache.entries[from].contribution, fresh.cache.entries[from].contribution);
  assert.deepEqual(replayed.bundle, fresh.bundle);

  const stale = structuredClone(fresh.cache);
  stale.entries[from].content_key = "old-fixture-version" + key.slice(key.indexOf(":"));
  stale.entries[from].contribution.imports = [];
  assert.deepEqual(cachedBuild(contents, stale).bundle, fresh.bundle);

  const degraded = cachedBuild({ [to]: contents[to] });
  assert.deepEqual(degraded.bundle.graphs.imports, []);
  assert.deepEqual(cachedBuild(contents, degraded.cache).bundle, fresh.bundle);
});

test("graph bundle publishes the registered framework route and its handler", () => {
  const path = "src/cats.controller.ts";
  const manifest = { files: [{ path, language: "typescript", size_bytes: 256 }] };
  const { graphs } = buildGraphBundle(manifest, undefined, {
    fileContents: {
      [path]: "import { Controller, Get } from '@nestjs/common';\n@Controller('cats')\n" +
        "export class CatsController {\n  @Get(':id')\n  findOne() {}\n}",
    },
  });
  assert.deepEqual(
    graphs.routes.map(({ method, path, handler }) => ({ method, path, handler })),
    [{ method: "GET", path: "/cats/:id", handler: path }],
  );
});

test("worker prompt digest covers the exact body and validation binds the rendered tail", () => {
  const body = "Fixture assignment\n\nKeep this spacing.\n";
  const renderTail = digest => JSON.stringify({ prompt_sha256: digest, result_id: digest.slice(0, 12) });
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const prompt = bindWorkerPrompt(body, renderTail);
  assert.deepEqual(prompt, { sha256, text: `${body}\n\n${renderTail(sha256)}` });
  assert.equal(workerPromptBindingHolds(prompt, renderTail), true);
  assert.equal(workerPromptBindingHolds({ ...prompt, text: prompt.text.replace("Fixture", "Changed") }, renderTail), false);
  assert.equal(workerPromptBindingHolds({ ...prompt, text: prompt.text + " " }, renderTail), false);
  assert.equal(workerPromptBindingHolds(prompt, () => renderTail("0".repeat(64))), false);
});

test("the real changed-site checker binds both graph sites and the prompt site to the discovered witness", async t => {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const witness = "tests/audit-changed-site-pins-cycle3.test.mjs";
  const graph = "src/audit/extractors/graph.ts";
  const prompt = "src/shared/submission/workerPromptBinding.ts";
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "cycle3-site-pins-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("cycle3-site-pins-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" });
  const gate = () => spawnSync(process.execPath, [join(checkout, "scripts/check-sites-pinned.mjs"), "--root", root], {
    cwd: root, windowsHide: true, encoding: "utf8",
  });
  const write = async (path, source) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };

  git("init", "-q");
  git("config", "core.autocrlf", "false");
  for (const path of [graph, prompt, witness]) {
    await write(path, await readFile(join(checkout, path), "utf8"));
  }
  const graphSource = await readFile(join(root, graph), "utf8");
  const promptSource = await readFile(join(root, prompt), "utf8");
  // Only actual executable changed lines count; declaration-only diffs do not.
  const graphLines = [
    "export function buildPathLookup(",
    "export const GRAPH_EDGE_CACHE_KEY_VERSION =",
  ].map(prefix => graphSource.split(/\r?\n/).find(line => line.startsWith(prefix)));
  const promptLine = promptSource.split(/\r?\n/).find(line => line.includes("const digest = promptSha256(body);"));
  const stageSites = async (graphText, promptText) => {
    const onlySites = (source, siteLines) => source.split(/\r?\n/)
      .map(line => siteLines.includes(line) || /^\/\/ sites-pinned:/.test(line) ? line : "")
      .join("\n");
    await write(graph, onlySites(graphText, graphLines));
    await write(prompt, onlySites(promptText, [promptLine]));
    git("add", "--", graph, prompt);
  };
  assert.ok(graphLines.every(Boolean) && promptLine);
  git("add", "--", witness);
  await stageSites(graphSource, promptSource);
  const accepted = gate();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /graph\.ts \S 2 site\(s\) bound to tests\/audit-changed-site-pins-cycle3\.test\.mjs/);
  assert.match(accepted.stdout, /workerPromptBinding\.ts \S 1 site\(s\) bound to tests\/audit-changed-site-pins-cycle3\.test\.mjs/);

  // Same changed sites, but the declaration is either absent or names an old file.
  await stageSites(graphSource, promptSource.replace(/^\/\/ sites-pinned:.*\r?\n/m, ""));
  const missing = gate();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /workerPromptBinding\.ts:\d+ has no .*declaration ABOVE/);

  await stageSites(graphSource.replaceAll(witness, "tests/audit/graph-edge-cache.test.ts"), promptSource);
  const stale = gate();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /graph-edge-cache\.test\.ts", which is NOT a tracked file/);

  // A tracked .test.mjs with no actual test case is not admitted by the gate.
  await stageSites(graphSource, promptSource);
  await write(witness, "export const notATest = true;\n");
  git("add", "--", witness);
  const empty = gate();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /which declares no test\(\.\.\.\) case/);
});

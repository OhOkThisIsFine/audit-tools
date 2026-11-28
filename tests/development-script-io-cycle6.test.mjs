import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH, renderBaseline } from "../scripts/check-review-routing.mjs";
import { REVIEW_ROUTING_ROWS } from "../scripts/review-routing-data.mjs";
import { BEGIN_MARKER, END_MARKER } from "../scripts/shared/generate-ci-trigger-paths.mjs";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const routing = join(checkout, "scripts/check-review-routing.mjs");
const generator = "scripts/shared/generate-ci-trigger-paths.mjs";
const workflow = ".github/workflows/ci.yml";

async function tempFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-dev-io-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, path, bytes) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function run(cwd, file, ...args) {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("routing reads quoted Git paths literally and preserves their baseline spelling", async t => {
  const root = await tempFixture(t);
  assertSuccess(run(root, "git", "init", "-q"));
  assertSuccess(run(root, "git", "config", "--local", "core.quotePath", "true"));
  const literal = "docs/reviews/r\u00e9sum\u00e9.md";
  const declared = "docs/reviews/declared.md";
  await put(root, literal, "# An older review\n");
  await put(root, declared, "<!-- review-routing: no-forward-work -->\n");
  await put(root, BASELINE_PATH, renderBaseline([literal, declared]));
  for (const row of REVIEW_ROUTING_ROWS) {
    if (row.destination !== null) await put(root, row.destination, "# Destination\n");
  }
  assertSuccess(run(root, "git", "add", "--", "."));
  assert.match(assertSuccess(run(root, "git", "ls-files", "--", literal)), /^"docs\/reviews\/.*\\[0-7]{3}/);
  assert.match(assertSuccess(run(root, process.execPath, routing, "--update-baseline")), /1 pre-mechanism record/);
  assert.equal(await readFile(join(root, BASELINE_PATH), "utf8"), renderBaseline([literal]));
  assert.match(assertSuccess(run(root, process.execPath, routing)), /1 review record\(s\) declare a routing row/);
});

test("CI trigger generator only accepts write mode and exact read-only --check", async t => {
  const root = await tempFixture(t);
  for (const path of [
    generator,
    "scripts/guard-reach-data.mjs",
    ".claude/hooks/loop-core-patterns.mjs",
    "scripts/shared/generate-runtime-artifact-names.mjs",
    "scripts/shared/generatedArtifacts.mjs",
    "scripts/shared/spec-mirror-data.mjs",
    "scripts/shared/guard-reach-derived-paths.generated.mjs",
  ]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(checkout, path), target);
  }
  const invoke = (...args) => run(root, process.execPath, generator, ...args);
  const target = join(root, workflow);
  const stale = `on:\n  push:\n    ${BEGIN_MARKER}\n    paths: ["stale-marker"]\n    ${END_MARKER}\n`;
  const absent = invoke("--chek");
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /usage:.*\[--check\]/);
  assert.doesNotMatch(absent.stderr, /is missing/);
  await put(root, workflow, stale);
  for (const args of [["--chek"], ["extra"], ["--check", "extra"], ["--check", "--check"], ["--"], ["--help"]]) {
    const refused = invoke(...args);
    assert.notEqual(refused.status, 0, JSON.stringify(args));
    assert.match(refused.stderr, /usage:.*\[--check\]/);
    assert.equal(await readFile(target, "utf8"), stale);
  }
  const staleCheck = invoke("--check");
  assert.notEqual(staleCheck.status, 0);
  assert.match(staleCheck.stderr, /trigger paths are STALE/);
  assert.equal(await readFile(target, "utf8"), stale);
  assert.match(assertSuccess(invoke()), /wrote .github\/workflows\/ci.yml/);
  const generated = await readFile(target, "utf8");
  assert.doesNotMatch(generated, /stale-marker/);
  assert.match(generated, /"package-lock.json"/);
  assert.match(assertSuccess(invoke("--check")), /derived paths rendered/);
  assert.equal(await readFile(target, "utf8"), generated);
});

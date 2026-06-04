#!/usr/bin/env node
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(pkgRoot, "remediate-code.mjs");
const packageVersion = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
).version;

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    failed++;
  }
}

function run(...args) {
  return spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8" });
}

console.log("smoke:linked-remediate-code");

check("--version exits 0", () => {
  const r = run("--version");
  if (r.status !== 0) throw new Error(`exit ${r.status}`);
  if (!r.stdout.trim()) throw new Error("empty version output");
});

check(`--version prints ${packageVersion}`, () => {
  const r = run("--version");
  if (!r.stdout.includes(packageVersion))
    throw new Error(`got: ${r.stdout.trim()}`);
});

check("--help exits 0", () => {
  const r = run("--help");
  if (r.status !== 0) throw new Error(`exit ${r.status}`);
});

check("--help mentions run command", () => {
  const r = run("--help");
  const out = r.stdout + r.stderr;
  if (!out.includes("run")) throw new Error('missing "run" in help output');
});

check("--help mentions install command", () => {
  const r = run("--help");
  const out = r.stdout + r.stderr;
  if (!out.includes("install"))
    throw new Error('missing "install" in help output');
});

check("--help mentions ensure command", () => {
  const r = run("--help");
  const out = r.stdout + r.stderr;
  if (!out.includes("ensure"))
    throw new Error('missing "ensure" in help output');
});

check("--help mentions validate command", () => {
  const r = run("--help");
  const out = r.stdout + r.stderr;
  if (!out.includes("validate"))
    throw new Error('missing "validate" in help output');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

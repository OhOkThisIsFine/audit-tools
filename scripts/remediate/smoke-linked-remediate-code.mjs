#!/usr/bin/env node
import "../shared/hermetic-state-dir.mjs";
import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const wrapper = join(pkgRoot, "remediate-code.mjs");
const packageVersion = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
).version;

let passed = 0;
let failed = 0;
const smokeStart = Date.now();

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}: ${/** @type {any} */ (err).message}`);
    failed++;
  }
}

function run(...args) {
  // windowsHide: a windowless parent spawning a console child (node) flashes a console
  // window on win32 — INV-WH.
  return spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8", windowsHide: true });
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

// sites-pinned: tests/remediate/smoke-fixtures.test.ts
function checkStep(root, kind, status, ...args) {
  const result = run("next-step", "--root", root, ...args);
  if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.stderr || result.error?.message}`);
  const step = JSON.parse(result.stdout);
  if (step?.contract_version !== "remediate-code-step/v1alpha1" || step.step_kind !== kind ||
      step.status !== status || !Array.isArray(step.allowed_commands)) {
    throw new Error(`Expected ${kind} (${status}) with the remediation step contract and allowed_commands, got ${result.stdout}`);
  }
}

let nextStepTmp;
try {
  nextStepTmp = mkdtempSync(join(tmpdir(), "remediate-smoke-next-step-"));
  check("fresh next-step requests a starting point", () => {
    checkStep(nextStepTmp, "collect_starting_point", "blocked");
  });
  check("supplying feedback advances next-step to intake synthesis", () => {
    const input = join(nextStepTmp, "feedback.md");
    writeFileSync(input, "# Feedback\n\nPlease improve the error message.\n");
    checkStep(nextStepTmp, "synthesize_intake", "ready", "--input", input);
  });
} finally {
  if (nextStepTmp) rmSync(nextStepTmp, { recursive: true, force: true });
}

// ── ensure: exits 0 (TST-97e61b4d) ──────────────────────────────────────
check("ensure --quiet exits 0", () => {
  const r = run("ensure", "--quiet");
  if (r.status !== 0)
    throw new Error(`exit ${r.status}; stderr: ${r.stderr.slice(0, 200)}`);
});

console.log(`\n${passed} passed, ${failed} failed (${Date.now() - smokeStart}ms total)`);
if (failed > 0) process.exit(1);

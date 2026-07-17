#!/usr/bin/env node
import "../shared/hermetic-state-dir.mjs";
import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync, rmSync } from "fs";
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
    console.error(`  FAIL ${label}: ${err.message}`);
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

// ── next-step: well-formed JSON output (TST-97e61b4d) ────────────────────
let nextStepTmp;
try {
  nextStepTmp = mkdtempSync(join(tmpdir(), "remediate-smoke-next-step-"));
  check("next-step exits 0 on fresh root", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0)
      throw new Error(`exit ${r.status}; stderr: ${r.stderr.slice(0, 200)}`);
  });

  check("next-step stdout is valid JSON", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0) throw new Error(`exit ${r.status}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error(`stdout is not JSON: ${r.stdout.slice(0, 200)}`);
    }
    if (typeof parsed !== "object" || parsed === null)
      throw new Error("parsed output is not an object");
  });

  check("next-step JSON has contract_version field", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0) throw new Error(`exit ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    if (parsed.contract_version !== "remediate-code-step/v1alpha1")
      throw new Error(`unexpected contract_version: ${parsed.contract_version}`);
  });

  check("next-step JSON has step_kind field", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0) throw new Error(`exit ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    if (typeof parsed.step_kind !== "string" || !parsed.step_kind)
      throw new Error(`missing or empty step_kind: ${JSON.stringify(parsed.step_kind)}`);
  });

  check("next-step JSON has status field", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0) throw new Error(`exit ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    if (typeof parsed.status !== "string" || !parsed.status)
      throw new Error(`missing or empty status: ${JSON.stringify(parsed.status)}`);
  });

  check("next-step JSON has allowed_commands array", () => {
    const r = run("next-step", "--root", nextStepTmp);
    if (r.status !== 0) throw new Error(`exit ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed.allowed_commands))
      throw new Error(`allowed_commands is not an array: ${JSON.stringify(parsed.allowed_commands)}`);
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

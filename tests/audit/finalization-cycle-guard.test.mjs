/**
 * Tests for the finalization cycle guard in nextStepCommand.ts.
 *
 * The guard (checkFinalizationCycle) fires when the deterministic loop revisits
 * a prior artifact state FINALIZATION_CYCLE_TOLERANCE times without net progress.
 * These tests exercise the guard in-process via the exported helpers, confirming:
 *   - checkFinalizationCycle writes deterministic-progress.json with cycle_detected: true
 *   - buildTerminalStep routes to "blocked" when no report is present
 *   - buildTerminalStep routes to "present_report" (via cmdNextStep) when a report exists
 *
 * A second set of tests invokes the next-step CLI wrapper in a pre-seeded "complete"
 * state (audit-report.md present) to confirm the final step_kind routing.
 */

import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

// Import the exported helpers directly for in-process unit tests.
const { checkFinalizationCycle } = await import("../../src/audit/cli/nextStepCommand.ts");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const {
  loadArtifactBundle,
  writeCoreArtifacts,
} = await import("../../src/audit/io/artifacts.ts");
const { writeJsonFile } = await import("audit-tools/shared");
const { computeArtifactStateSignature } = await import("../../src/audit/orchestrator/artifactMetadata.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cycle-guard-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanEnv, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

// Minimal artifact state with a repo_manifest so the loop can start ticking.
async function writeMinimalArtifacts(artDir, extraBundle = {}) {
  await mkdir(join(artDir, "steps"), { recursive: true });
  const repoManifest = {
    repository: { name: "cycle-fixture" },
    generated_at: new Date().toISOString(),
    files: [],
  };
  await writeCoreArtifacts(artDir, { repo_manifest: repoManifest, ...extraBundle });
}

// Build a fake AdvanceAuditResult that checkFinalizationCycle accepts.
// The bundle's artifact_metadata controls the state signature.
async function makeFakeResult(artDir, bundle) {
  const audit_state = deriveAuditState(bundle);
  return {
    updated_bundle: bundle,
    audit_state,
    selected_executor: "deterministic_executor",
    progress_summary: "fake progress",
    progress_made: true,
    artifacts_written: [],
  };
}

// ── Shared helper ────────────────────────────────────────────────────────────
// Builds the seenStateSignatures / obligationTrail pair that trips the cycle
// guard on the first call when index >= tolerance - 1.
//
// The guard fires when: index + 1 - seenStateSignatures.size >= tolerance.
// To trigger it with tolerance=16, pre-seed one already-seen signature so that
// size stays 1 even after the call adds its own (duplicate) sig, then use
// index = tolerance - 1:  (tolerance) - 1 = tolerance - 1 >= tolerance? No.
// Correct: index = tolerance  → index+1=tolerance+1, size=1
//   → tolerance+1 - 1 = tolerance >= tolerance ✓
//
// So: seed with sig×1, call with index = tolerance (here: 16).

/**
 * Builds a seenStateSignatures/obligationTrail pair that will trip the guard
 * on the very first call when index = TOLERANCE (default 16).
 *
 * @param {string} sig  The content-hash signature of the bundle under test.
 * @param {number} [tolerance=16]
 */
function makeCycleTrigger(sig, tolerance = 16) {
  const seenStateSignatures = new Set([sig]);
  const obligationTrail = Array.from({ length: tolerance }, (_, i) =>
    i % 2 === 0 ? "synthesis_current" : "runtime_validation_current"
  );
  return { seenStateSignatures, obligationTrail, index: tolerance };
}

// ── In-process unit tests for checkFinalizationCycle ─────────────────────────

test("checkFinalizationCycle returns undefined while loop is still progressing", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir);
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);
    const result = await makeFakeResult(artDir, bundle);

    const seenStateSignatures = new Set();
    const obligationTrail = [];

    // First call: 1 iteration, 1 seen state → 1 - 1 = 0 < 16, no cycle
    const outcome = await checkFinalizationCycle({
      index: 0,
      obligationTrail,
      seenStateSignatures,
      tolerance: 16,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      result,
      selectedObligation: "synthesis_current",
    });
    expect(outcome, "should return undefined when not cycling").toBe(undefined);
  });
});

test("checkFinalizationCycle fires and writes deterministic-progress.json with cycle_detected when tolerance breached", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir);
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);
    const result = await makeFakeResult(artDir, bundle);

    const { seenStateSignatures, obligationTrail, index } =
      makeCycleTrigger(computeArtifactStateSignature(bundle));

    const outcome = await checkFinalizationCycle({
      index,
      obligationTrail,
      seenStateSignatures,
      tolerance: 16,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      result,
      selectedObligation: "synthesis_current",
    });

    expect(outcome !== undefined, "checkFinalizationCycle should fire").toBeTruthy();
    const progressPath = join(artDir, "steps", "deterministic-progress.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8"));
    expect(progress.cycle_detected, "cycle_detected must be true").toBe(true);
    expect(Array.isArray(progress.cycling_obligations) && progress.cycling_obligations.length > 0, "cycling_obligations must be a non-empty array").toBeTruthy();
  });
});

test("checkFinalizationCycle routes to blocked when no report is present", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir);
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);
    const result = await makeFakeResult(artDir, bundle);

    const { seenStateSignatures, obligationTrail, index } =
      makeCycleTrigger(computeArtifactStateSignature(bundle));

    const outcome = await checkFinalizationCycle({
      index,
      obligationTrail,
      seenStateSignatures,
      tolerance: 16,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      result,
      selectedObligation: "synthesis_current",
    });

    expect(outcome !== undefined, "guard should fire").toBeTruthy();
    expect(outcome.kind, "routes to blocked when no audit_report in bundle").toBe("blocked");
  });
});

test("checkFinalizationCycle routes to complete when audit_report is present in bundle", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir, {
      audit_report: "# Audit Report\n\n## Work blocks\n\n- Done\n",
    });
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);
    const result = await makeFakeResult(artDir, bundle);

    const { seenStateSignatures, obligationTrail, index } =
      makeCycleTrigger(computeArtifactStateSignature(bundle));

    const outcome = await checkFinalizationCycle({
      index,
      obligationTrail,
      seenStateSignatures,
      tolerance: 16,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      result,
      selectedObligation: "synthesis_current",
    });

    expect(outcome !== undefined, "guard should fire").toBeTruthy();
    // With audit_report present, buildTerminalStep routes to complete (not blocked).
    expect(outcome.kind, "routes to complete when audit_report is present").toBe("complete");
    expect(typeof outcome.finalReportPath === "string" && outcome.finalReportPath.includes("audit-report.md"), "finalReportPath resolves to audit-report.md").toBeTruthy();
  });
});

// ── CLI integration: present_report when report is already written ────────────

test("next-step CLI routes to present_report when audit is complete and report exists", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "repo");
    await mkdir(root, { recursive: true });
    const artDir = join(root, ".audit-tools/audit");
    await mkdir(artDir, { recursive: true });
    await writeFile(
      join(artDir, "audit_state.json"),
      JSON.stringify({ status: "complete", obligations: [] }, null, 2) + "\n",
    );
    await writeFile(
      join(artDir, "audit-report.md"),
      "# Audit report\n\n## Work blocks\n\n- Done\n",
    );

    const { stdout } = await runWrapper(["next-step"], { cwd: root });
    const step = JSON.parse(stdout);
    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.step_kind).toBe("present_report");
    expect(step.artifact_paths.final_report).toMatch(/audit-report\.md$/);
  });
});

// ── deterministic-progress.json format ──────────────────────────────────────

test("deterministic-progress.json written by checkFinalizationCycle has required fields", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir);
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);
    const result = await makeFakeResult(artDir, bundle);

    const { seenStateSignatures, obligationTrail, index } =
      makeCycleTrigger(computeArtifactStateSignature(bundle));

    await checkFinalizationCycle({
      index,
      obligationTrail,
      seenStateSignatures,
      tolerance: 16,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      result,
      selectedObligation: "synthesis_current",
    });

    const progressPath = join(artDir, "steps", "deterministic-progress.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8"));

    expect(progress.cycle_detected).toBe(true);
    expect(Array.isArray(progress.cycling_obligations), "cycling_obligations is an array").toBeTruthy();
    expect(progress.cycling_obligations.length > 0, "cycling_obligations is non-empty").toBeTruthy();
    expect(typeof progress.iteration === "number", "iteration is a number").toBeTruthy();
    expect(typeof progress.summary === "string", "summary is a string").toBeTruthy();
    expect(typeof progress.timestamp === "string", "timestamp is a string").toBeTruthy();
  });
});

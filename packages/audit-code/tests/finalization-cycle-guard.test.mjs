/**
 * Tests for audit-code's cycle / no-progress termination.
 *
 * The deterministic fold now runs on the shared `advance` engine (A3 step 4
 * slice 2b). Cycle detection is `advance`'s visited-state-signature primitive
 * (unit-tested generically in `@audit-tools/shared` —
 * obligation-engine.test.mjs), keyed by audit's `nextStepStateSignature`:
 *
 *   - The signature is a *dispatch identity* —
 *     `artifact-signature | obligation | executor` — NOT the bare artifact
 *     signature, so a no-op-but-satisfying step (auto-fix with nothing to fix,
 *     syntax-resolution with no errors) that leaves artifact content unchanged
 *     while advancing the obligation chain is PROGRESS (distinct selection), not
 *     a false cycle. Only a literal re-entry of the SAME obligation+executor on
 *     the SAME unchanged artifact state is the no-progress cycle.
 *   - The `no-metadata` bootstrap signature is salted with the transition
 *     counter so early steps that legitimately dispatch from it never false-trip.
 *
 * When `advance` returns `stopped: "cycle"`, `runDeterministicForNextStep` routes
 * through `buildTerminalStep`: a rendered report → present_report (complete); no
 * report → blocked. These tests pin that audit-specific signature + terminal
 * routing via the surviving public surface, plus the end-to-end CLI behaviour.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

const { nextStepStateSignature, buildTerminalStep } = await import(
  "../src/cli/nextStepCommand.ts"
);
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { computeArtifactStateSignature } = await import(
  "../src/orchestrator/artifactMetadata.ts"
);
const { decideNextStep } = await import("../src/orchestrator/nextStep.ts");
const {
  loadArtifactBundle,
  writeCoreArtifacts,
} = await import("../src/io/artifacts.ts");

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

// ── nextStepStateSignature: the dispatch-identity recurrence key ──────────────

test("nextStepStateSignature folds the selected obligation+executor into the key (no-op-satisfying steps stay distinct)", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    // A bundle far enough along to carry artifact_metadata (a real, non-bootstrap
    // signature) yet still have several pending obligations so the selected
    // obligation is well-defined.
    await writeMinimalArtifacts(artDir, {
      artifact_metadata: {
        artifacts: {
          "file_disposition.json": {
            revision: 1,
            content_hash: "h-fixed",
            dependency_revisions: {},
          },
        },
      },
    });
    const bundle = await loadArtifactBundle(artDir);
    const iterationRef = { value: 0 };

    const sig = nextStepStateSignature(bundle, iterationRef);
    // Idempotent for the SAME bundle/selection (a genuine revisit is a cycle).
    assert.equal(
      sig,
      nextStepStateSignature(bundle, iterationRef),
      "same content + same selection must yield the same key (revisit = cycle)",
    );
    // Teeth: the key is EXACTLY `artifact-signature | obligation | executor` — it
    // embeds the live selection, NOT just the bare artifact hash. So a no-op-but-
    // satisfying step (same artifact content, but the obligation chain advanced to
    // a different selection) yields a DISTINCT key = progress, never a false cycle.
    // Reverting `nextStepStateSignature` to the bare `computeArtifactStateSignature`
    // drops the suffix and fails this assertion (the regression the fix prevents).
    const artSig = computeArtifactStateSignature(bundle);
    const decision = decideNextStep(bundle);
    assert.notEqual(
      artSig,
      "no-metadata",
      "fixture must carry a real (non-bootstrap) signature",
    );
    assert.equal(
      sig,
      `${artSig}|${decision.selected_obligation ?? ""}|${decision.selected_executor ?? ""}`,
      "key must be the dispatch identity artifact-sig|obligation|executor",
    );
    assert.ok(
      decision.selected_obligation && sig.includes(decision.selected_obligation),
      "key must embed the actually-selected obligation (distinct selections → distinct keys)",
    );
  });
});

test("nextStepStateSignature salts the no-metadata bootstrap state with the transition counter", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    // No artifact_metadata → computeArtifactStateSignature returns "no-metadata".
    await writeMinimalArtifacts(artDir);
    const bundle = await loadArtifactBundle(artDir);

    const ref = { value: 0 };
    const s0 = nextStepStateSignature(bundle, ref);
    ref.value = 1;
    const s1 = nextStepStateSignature(bundle, ref);
    ref.value = 2;
    const s2 = nextStepStateSignature(bundle, ref);

    // Each bootstrap-state scan is distinct (salted) so early deterministic steps
    // that legitimately revisit "no-metadata" never false-trip the cycle guard.
    assert.notEqual(s0, s1, "bootstrap scans must be salted distinct");
    assert.notEqual(s1, s2, "bootstrap scans must be salted distinct");
    assert.match(s0, /no-metadata/, "bootstrap key carries the no-metadata signature");
    assert.match(s0, /boot:0/, "bootstrap key salts with the transition counter");
  });
});

// ── buildTerminalStep: the cycle's terminal destination ──────────────────────

test("cycle terminal routes to blocked when no report is present", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir);
    await writeFile(
      join(artDir, "operator-handoff.json"),
      JSON.stringify({ progress_summary: "" }),
      "utf8",
    );
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);

    const outcome = await buildTerminalStep(
      { root: dir, artifactsDir: artDir },
      bundle,
      state,
      "Finalization is not converging.",
    );
    assert.equal(outcome.kind, "blocked", "no audit_report → blocked terminal");
    assert.equal(outcome.reason, "Finalization is not converging.");
  });
});

test("cycle terminal routes to complete when a report is already rendered", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await writeMinimalArtifacts(artDir, {
      audit_report: "# Audit Report\n\n## Work blocks\n\n- Done\n",
    });
    await writeFile(
      join(artDir, "operator-handoff.json"),
      JSON.stringify({ progress_summary: "" }),
      "utf8",
    );
    const bundle = await loadArtifactBundle(artDir);
    const state = deriveAuditState(bundle);

    const outcome = await buildTerminalStep(
      { root: dir, artifactsDir: artDir },
      bundle,
      state,
      "Finalization is not converging.",
    );
    // With a rendered report present, convergence resolves to complete
    // (present_report) — a completed audit must never surface as blocked.
    assert.equal(outcome.kind, "complete", "rendered report → complete terminal");
    assert.ok(
      typeof outcome.finalReportPath === "string" && outcome.finalReportPath.includes("audit-report.md"),
      "finalReportPath resolves to audit-report.md",
    );
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
    assert.equal(step.contract_version, "audit-code-step/v1alpha1");
    assert.equal(step.step_kind, "present_report");
    assert.match(step.artifact_paths.final_report, /audit-report\.md$/);
  });
});

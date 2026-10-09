import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAnalyzerPolicy, getAnalyzerPolicyPath } from "../../src/shared/analyzerPolicy.js";
import { buildExternalAcquisitionOptions } from "../../src/audit/cli/nextStepCommand.js";
import { pendingAnalyzerConsent } from "../../src/audit/orchestrator/hostInputPause.js";
test("legacy durable declines cannot veto a new run's consent offer", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, ".audit-tools", "audit"), { recursive: true });
    await writeFile(getAnalyzerPolicyPath(root), JSON.stringify({ analyzers: { knip: "repo" }, analyzer_consent: { eslint: "declined" } }));
    const policy = await loadAnalyzerPolicy(root);
    expect(policy.analyzers).toEqual({ knip: "repo" });
    const options = buildExternalAcquisitionOptions(policy);
    expect(pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true, analyzerConsent: options.analyzerConsent }).map(c => c.id)).toContain("eslint");
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { readRunConsentUnlocked, updateRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { persistAnalyzerConsent } from "../../src/shared/analyzerPolicy.js";
import { admitSpawn } from "../../src/shared/analyzers/acquisitionEngine.js";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../../src/shared/analyzers/candidates.js";

test("resume retains both answers, while the actual cleanup/new-run lifecycle invalidates them", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-reset-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  try {
    const first = await updateRunConsentUnlocked(root, artifactsDir, { eslint: "granted", knip: "declined" }, true);
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "active", obligations: [] }));
    expect((await cleanupStaleArtifactsDir(artifactsDir)).action).toBe("skipped");
    const resumed = await readRunConsentUnlocked(root, artifactsDir);
    expect(resumed).toEqual(first);
    expect((await cleanupStaleArtifactsDir(artifactsDir, { force: true })).action).toBe("deleted");
    const next = await readRunConsentUnlocked(root, artifactsDir);
    expect(next.run_id).not.toBe(first.run_id);
    expect(next.decisions).toEqual({});
    expect(next.auto_fix).toBe(false);
    expect(next.dry_run).toBe(false);
    const eslint = EXTERNAL_ANALYZER_CANDIDATES.find(c => c.id === "eslint")!;
    expect(admitSpawn(eslint, "auto", undefined)).toBeTruthy();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent current-run declines are serialized without losing answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-race-"));
  try {
    await Promise.all([persistAnalyzerConsent(root, { eslint: "declined" }), persistAnalyzerConsent(root, { knip: "declined" })]);
    expect((await readRunConsentUnlocked(root, join(root, ".audit-tools", "audit"))).decisions).toEqual({ eslint: "declined", knip: "declined" });
    expect((await loadAnalyzerPolicy(root)).analyzer_consent).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("dry-run is sticky across continuations, including a later formatting opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-dry-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  try {
    await updateRunConsentUnlocked(root, artifactsDir, {}, true, true);
    expect((await readRunConsentUnlocked(root, artifactsDir)).dry_run).toBe(true);
    expect((await updateRunConsentUnlocked(root, artifactsDir, {}, true, false)).dry_run).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { handleAnalyzerConsentBranch } from "../../src/audit/cli/nextStepHelpers.js";
import { createFoldTransaction, commitFold } from "../../src/audit/cli/foldTransaction.js";
import { GATE_LANES, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import type { ExternalAcquisitionAdvanceOptions } from "../../src/audit/orchestrator/acquisitionExecutor.js";
import { dirname } from "node:path";
test("an accepted current-run answer replaces an earlier decline without a stale in-memory veto", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-change-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  try {
    await writeFile(join(root, "package.json"), "{}");
    await updateRunConsentUnlocked(root, artifactsDir, { eslint: "declined" });
    const path = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_consent);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ eslint: "granted", knip: "declined" }));
    const externalAcquisition: ExternalAcquisitionAdvanceOptions = { enabled: true, analyzerConsent: { eslint: "declined" } };
    const tx = createFoldTransaction();
    const branch = await handleAnalyzerConsentBranch({ root, sourceRoot: root, artifactsDir, externalAcquisition }, {}, { status: "active", obligations: [] }, { value: undefined }, tx);
    await commitFold(artifactsDir, {}, tx);
    expect(branch.action).toBe("continue");
    expect(externalAcquisition.analyzerConsent).toEqual({ knip: "declined" });
    expect(externalAcquisition.consentToken?.tools).toEqual(["eslint"]);
    expect(admitSpawn(EXTERNAL_ANALYZER_CANDIDATES.find(c => c.id === "eslint")!, "auto", externalAcquisition.consentToken, externalAcquisition.analyzerConsent?.eslint)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
test("real folds retain dry-run and consent across separate continuation parameter objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-fold-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const original = EXECUTOR_RUNNERS.auto_fix_executor;
  const seen: Array<unknown> = [];
  try {
    await writeFile(join(root, "package.json"), '{"name":"consent-fold"}');
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await updateRunConsentUnlocked(root, artifactsDir, { eslint: "granted", knip: "declined" });
    EXECUTOR_RUNNERS.auto_fix_executor = async (_bundle, { options }) => {
      seen.push(options.autoFix);
      expect(options.externalAcquisition?.analyzerConsent).toEqual({ knip: "declined" });
      expect(options.externalAcquisition?.consentToken?.tools).toEqual(["eslint"]);
      throw new Error("stop at formatter boundary");
    };
    const base = { root, sourceRoot: root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000 };
    await expect(runDeterministicForNextStep({ ...base, autoFix: { enabled: true, dryRun: true }, externalAcquisition: { enabled: true } })).rejects.toThrow("stop at formatter boundary");
    await expect(runDeterministicForNextStep({ ...base, externalAcquisition: { enabled: true } })).rejects.toThrow("stop at formatter boundary");
    expect(seen).toEqual([{ enabled: true, dryRun: true }, { enabled: true, dryRun: true }]);
  } finally { EXECUTOR_RUNNERS.auto_fix_executor = original!; await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("late formatting opt-in reruns the formatter obligation once, not on every continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-consent-late-format-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const original = EXECUTOR_RUNNERS.auto_fix_executor;
  const seen: unknown[] = [];
  try {
    await writeFile(join(root, "notes.txt"), "auditable notes\n");
    EXECUTOR_RUNNERS.auto_fix_executor = async (bundle, context) => {
      seen.push(context.options.autoFix);
      return original!(bundle, context);
    };
    const base = { root, sourceRoot: root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000 };
    await runDeterministicForNextStep({ ...base });
    await runDeterministicForNextStep({ ...base, autoFix: { enabled: true } });
    await runDeterministicForNextStep({ ...base, autoFix: { enabled: true } });
    expect(seen).toEqual([{ enabled: false, dryRun: false }, { enabled: true, dryRun: false }]);
  } finally { EXECUTOR_RUNNERS.auto_fix_executor = original!; await rm(root, { recursive: true, force: true }); }
}, 60_000);

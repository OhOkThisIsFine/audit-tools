import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import type { ExternalAnalyzerToolStatus } from "../../src/shared/analyzers/types.js";

import {
  appendNdjsonFile,
  readJsonFile,
  readNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeJsonFile,
  writeNdjsonFile,
} from "audit-tools/shared/io/json";
import {
  getArtifactValue,
  loadArtifactBundle,
  promoteFinalAuditReport,
  writeCoreArtifacts,
  ARTIFACT_DEFINITIONS,
  ArtifactSchemaVersionError,
  type ArtifactBundle,
} from "../../src/audit/io/artifacts.js";
import { buildToolingManifest } from "../../src/audit/io/toolingManifest.js";
import {
  buildRunId,
  ensureSupervisorDirs,
  getRunPaths,
  writeReviewRunFiles,
} from "../../src/audit/io/runArtifacts.js";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";
import type { ToolingManifest } from "../../src/audit/types/toolingManifest.js";
import type { AuditTask } from "../../src/audit/types.js";

import { withTempDir } from "./helpers/withTempDir.mjs";

function stableToolingManifestValues(manifest?: ToolingManifest) {
  if (!manifest) return {};
  return {
    package_root: manifest.package_root,
    package_version: manifest.package_version,
    implementation_hash: manifest.implementation_hash,
    inputs: manifest.inputs,
  };
}

test("JSON readers and writers surface path-aware failures and optional readers stay permissive", async () => {
  await withTempDir("audit-code-io-json-", async (tempDir: string) => {
    const brokenJsonPath = join(tempDir, "broken.json");
    const missingJsonPath = join(tempDir, "missing.json");
    const blockingFilePath = join(tempDir, "blocking-parent");
    const impossibleWritePath = join(
      blockingFilePath,
      "nested",
      "value.json",
    );

    await writeFile(brokenJsonPath, "{oops");
    await writeFile(blockingFilePath, "occupied");

    await assert.rejects(
      readJsonFile(brokenJsonPath),
      new RegExp(`Invalid JSON in .*broken\\.json`, "i"),
    );
    await assert.rejects(
      writeJsonFile(impossibleWritePath, { ok: true }),
      new RegExp(`Failed to prepare parent directory .*value\\.json`, "i"),
    );
    await expect(await readOptionalJsonFile(missingJsonPath)).toBe(undefined);
    await expect(await readOptionalNdjsonFile(join(tempDir, "missing.jsonl"))).toBe(undefined);
  });
});

test("NDJSON parsing preserves physical line numbers and append/write helpers round-trip", async () => {
  await withTempDir("audit-code-io-ndjson-", async (tempDir: string) => {
    const brokenNdjsonPath = join(tempDir, "broken.jsonl");
    const validNdjsonPath = join(tempDir, "valid.jsonl");

    await writeFile(
      brokenNdjsonPath,
      ['{"id":1}', "", '{"id":2}', "not-json"].join("\n") + "\n",
    );
    await assert.rejects(
      readNdjsonFile(brokenNdjsonPath),
      /line 4/i,
    );

    await writeNdjsonFile(validNdjsonPath, [{ id: 1 }]);
    await appendNdjsonFile(validNdjsonPath, { id: 2 });

    expect(await readNdjsonFile(validNdjsonPath)).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });
});

test("artifact bundle definitions round-trip joined paths, falsey values, and cleanup metadata", async () => {
  await withTempDir("audit-code-io-artifacts-", async (tempDir: string) => {
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "fixture" },
        generated_at: "2026-04-22T00:00:00.000Z",
        files: [{ path: "src/index.ts", language: "ts", size_bytes: 10 }],
      },
      auto_fixes_applied: false,
      audit_results: [
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass-1",
          lens: "correctness",
          file_coverage: [{ path: "src/index.ts", total_lines: 10 }],
          findings: [],
          reviewed_clean: true,
        },
      ],
      audit_report: "# Audit Report\n",
      audit_tasks: [],
    };

    await writeCoreArtifacts(tempDir, bundle);

    const loaded = await loadArtifactBundle(`${tempDir}${sep}`);
    expect(loaded.repo_manifest).toEqual(bundle.repo_manifest);
    expect(loaded.auto_fixes_applied).toBe(false);
    expect(loaded.audit_results).toEqual(bundle.audit_results);
    expect(getArtifactValue(loaded, "audit-report.md")).toBe("# Audit Report\n");
    expect(getArtifactValue(loaded, "missing.json")).toBe(undefined);
    expect(loaded.tooling_manifest).toBeTruthy();

    const expectedManifest = await buildToolingManifest();
    expect(loaded.tooling_manifest!.package_version).toBe(expectedManifest.package_version);
    expect(loaded.tooling_manifest!.implementation_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.tooling_manifest!.implementation_hash).not.toBe("0".repeat(64));
    expect(loaded.tooling_manifest!.inputs).toEqual(expectedManifest.inputs);
    expect(stableToolingManifestValues(loaded.tooling_manifest)).toEqual(stableToolingManifestValues(expectedManifest));

    const loadedAgain = await loadArtifactBundle(`${tempDir}${sep}`);
    expect(stableToolingManifestValues(loadedAgain.tooling_manifest)).toEqual(stableToolingManifestValues(loaded.tooling_manifest));

  });
});

test("final report promotion preserves artifacts when destination is not writable", async () => {
  await withTempDir("audit-code-report-promotion-", async (tempDir: string) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

    const warnings: string[] = [];
    const promoteParams = { artifactsDir, repoRoot };
    const result = await promoteFinalAuditReport(
      promoteParams,
      {
        copy: async () => {
          throw new Error("EPERM: operation not permitted");
        },
        warn: (message: string) => warnings.push(message),
      },
    );

    expect(result.promoted).toBe(false);
    expect(result.cleaned).toBe(false);
    expect(result.warning).toMatch(/could not promote final report/i);
    expect(warnings.length).toBe(1);
    expect(existsSync(join(artifactsDir, "audit-report.md"))).toBe(true);
  });
});

test("promoteFinalAuditReport archives the friction record with the promoted deliverables before deleting the artifacts dir", async () => {
  // The friction close-out walk completes BEFORE promotion (the close gate
  // enforces it), then promotion rm-rf'd the whole artifacts dir — destroying
  // the record no consumer had read (2026-08-05 + 2026-08-06 dogfoods). The
  // record must ride along with the promoted deliverables.
  await withTempDir("audit-code-report-promotion-friction-", async (tempDir: string) => {
    const artifactsDir = join(tempDir, "artifacts");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });
    const record = {
      open_observations: [{ category: "tool_should_decide", note: "observed" }],
      category_attestations: [
        { category: "ambiguous_direction", disposition: "none" },
        { category: "inefficient_feeding", disposition: "none" },
      ],
    };
    await mkdir(join(artifactsDir, "friction"), { recursive: true });
    await writeFile(join(artifactsDir, "friction", "run.json"), JSON.stringify(record), "utf8");

    const result = await promoteFinalAuditReport({ artifactsDir });

    expect(result.promoted).toBe(true);
    expect(result.cleaned).toBe(true);
    expect(existsSync(artifactsDir)).toBe(false);
    const archived = join(tempDir, "audit-friction-run.json");
    expect(existsSync(archived), "friction record must be archived beside the promoted report").toBe(true);
    expect(JSON.parse(await readFile(archived, "utf8"))).toEqual(record);
  });
});

// OBS-24e78e9d's PURPOSE — a failed audit-findings.json copy is announced, and
// the human report still promotes — is preserved and strengthened here. Its two
// literal pins (copy count === 3; `warning` undefined on primary success) were
// incidental characterization of the pre-contract behavior and are SUPERSEDED by
// the audit-artifact-promotion-lifecycle contract's INV 1-3 (DAT-4802dc9e /
// -2 / -3, REL-4802dc9e): a genuine archive failure now aborts the cleanup and
// is expressed in the returned shape rather than swallowed into a console warn.
test("promoteFinalAuditReport announces a failed audit-findings.json copy AND expresses the loss (OBS-24e78e9d, superseded pins per INV 1-3)", async () => {
  await withTempDir("audit-code-report-promotion-findings-warn-", async (tempDir: string) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
      // The findings file must EXIST for the copy stub below to be the thing
      // that fails: the archive reads its source first, so an absent source is
      // the ordinary legacy branch, not the real-failure branch under test.
      audit_findings: { contract_version: "audit-findings/v1alpha1" },
    } as never);
    // Every archive SOURCE must exist, or its archive short-circuits at the
    // source read and never reaches the copy — which would silently weaken the
    // four-copies-attempted pin below into a two-copies pin.
    await writeFile(join(artifactsDir, "agent-feedback.jsonl"), "{}\n", "utf8");
    await mkdir(join(artifactsDir, "submissions"), { recursive: true });
    await writeFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      "",
      "utf8",
    );

    const warnings: string[] = [];
    let copyCallCount = 0;
    const promoteParams = { artifactsDir, repoRoot };
    const result = await promoteFinalAuditReport(
      promoteParams,
      {
        copy: async (_src: any, dest: any, _opts?: any) => {
          copyCallCount++;
          // First copy (audit-report.md) succeeds; second (audit-findings.json) fails.
          if (typeof dest === "string" && dest.endsWith("audit-findings.json")) {
            // EACCES, with a real `.code`. The old fixture threw an Error whose
            // TEXT said "ENOENT" but carried no code, so `isFileMissingError`
            // read it as the absent-source branch — the branch this test does
            // NOT test. A permission failure is the genuine-failure case.
            const failure = new Error(
              "EACCES: permission denied",
            ) as NodeJS.ErrnoException;
            failure.code = "EACCES";
            throw failure;
          }
          // Everything else copies for REAL. A no-op stub makes every verified
          // archive fail (the destination never appears), which would put three
          // entries in `unarchived` and stop this test from pinning that the
          // FINDINGS failure specifically is the one reported.
          const { cp } = await import("node:fs/promises");
          await cp(_src as string, dest as string, { force: true });
        },
        warn: (message: string) => warnings.push(message),
      },
    );

    // Primary report copy succeeded — promoted must be true. (Purpose, kept.)
    expect(result.promoted, "promoted must be true when only audit-findings.json copy fails").toBe(true);
    // SUPERSEDES the old `warning === undefined` pin: a caller must be able to
    // tell a lossy promotion from a clean one, so the loss is in the RESULT.
    expect(result.cleaned, "a promotion that could not archive the contract must not report clean").toBe(false);
    expect(result.unarchived, "the loss must be nameable by the caller").toEqual([
      expect.stringContaining("audit-findings.json"),
    ]);
    expect(result.warning, "the returned warning names the unarchived artifact").toMatch(/audit-findings\.json/);
    // The copy failure is announced (the purpose OBS-24e78e9d exists for), and
    // the abort is announced separately — two warns, not one, because "the copy
    // failed" and "so the directory is being kept" are different facts an
    // operator needs.
    expect(warnings.length, "the copy failure and the aborted cleanup are both announced").toBe(2);
    expect(warnings[0], "warn message must mention audit-findings.json").toMatch(/audit-findings\.json/);
    expect(warnings[0], "warn message must include the error text").toMatch(/EACCES/);
    // Every copy is attempted, in order and independently: the report, the
    // failing findings contract, agent-feedback.jsonl (added by INV 2 — it was
    // destroyed unarchived before), then the submission ledger. A failure in one
    // must not skip the others, since each rescues a different deliverable.
    expect(
      copyCallCount,
      "report, findings, agent-feedback and ledger copies are each attempted",
    ).toBe(4);
  });
});

test("run artifact helpers persist only provider-neutral review identity and canonical pending tasks", async () => {
  await withTempDir("audit-code-run-artifacts-", async (tempDir: string) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    const fixedNow = new Date("2026-04-22T15:16:17.089Z");
    const runId = buildRunId(" flow:auth/entry ", 7, fixedNow);
    const paths = getRunPaths(artifactsDir, runId);

    expect(runId).toBe("20260422T151617089Z_flow-auth-entry_007");
    expect(buildRunId("", 1, fixedNow)).toBe("20260422T151617089Z_terminal_001");

    await ensureSupervisorDirs(artifactsDir);

    const run: ActiveReviewRun = {
      contract_version: "audit-review-run/v1alpha1",
      run_id: runId,
      review_run_path: paths.reviewRunPath,
      pending_audit_tasks_path: paths.pendingTasksPath,
      host_workload_path: paths.hostWorkloadPath,
      host_result_map_path: paths.hostResultMapPath,
    };
    const pendingTasks: AuditTask[] = [
      {
        task_id: "audit-2",
        unit_id: "unit-2",
        pass_id: "pass-2",
        lens: "correctness",
        file_paths: ["src/z.ts", "src/other.ts"],
        file_line_counts: { "src/z.ts": 5, "src/other.ts": 8 },
        rationale: "second fixture",
      },
      {
        task_id: "audit-1",
        unit_id: "unit-1",
        pass_id: "pass-1",
        lens: "security",
        file_paths: ["src/index.ts"],
        file_line_counts: { "src/index.ts": 12 },
        rationale: "fixture",
      },
    ];

    await writeReviewRunFiles(artifactsDir, run, pendingTasks);

    expect(JSON.parse(await readFile(paths.reviewRunPath, "utf8"))).toEqual(run);
    expect(JSON.parse(
      await readFile(join(artifactsDir, "dispatch", "current-review-run.json"), "utf8"),
    )).toEqual(run);

    const canonicalTasks = [
      pendingTasks[1],
      {
        ...pendingTasks[0],
        file_paths: ["src/other.ts", "src/z.ts"],
      },
    ];
    expect(JSON.parse(await readFile(paths.pendingTasksPath, "utf8"))).toEqual(canonicalTasks);
    expect(JSON.parse(
      await readFile(join(artifactsDir, "dispatch", "current-tasks.json"), "utf8"),
    )).toEqual(canonicalTasks);

    expect(Object.keys(run).sort()).toEqual([
      "contract_version",
      "host_result_map_path",
      "host_workload_path",
      "pending_audit_tasks_path",
      "review_run_path",
      "run_id",
    ]);
    expect(existsSync(paths.hostWorkloadPath)).toBe(false);
    expect(existsSync(paths.hostResultMapPath)).toBe(false);
  });
});

test("io/artifacts remains independent from cli dispatch", async () => {
  const { readFile: readFileFs } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pathJoin } = await import("node:path");
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = await readFileFs(pathJoin(__dir, "../../src/audit/io/artifacts.ts"), "utf8");
  expect(!src.includes("../cli/dispatch"), "io/artifacts.ts must not import from ../cli/dispatch").toBeTruthy();
});

// This test previously asserted on an INLINE REIMPLEMENTATION of the
// parse/catch/stderr logic written inside the test body (TST-0e3fc2e0,
// TST-0e3fc2e0-2): production readPackageVersion could be deleted outright and
// it stayed green. readPackageVersion is now exported and root-parameterized, so
// the guard calls the real function against a temp directory.
test("readPackageVersion logs to stderr on JSON parse error and returns null (OBS-9335faf6)", async () => {
  const { readPackageVersion } = await import("../../src/audit/io/toolingManifest.js");

  await withTempDir("audit-code-tooling-manifest-parse-err-", async (tempDir: string) => {
    const packageJsonPath = join(tempDir, "package.json");
    await writeFile(packageJsonPath, "{invalid json}", "utf8");

    const stderrLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let result: string | null;
    try {
      result = await readPackageVersion(tempDir);
    } finally {
      process.stderr.write = orig;
    }

    expect(result, "parse error must return null").toBe(null);
    const matchingLine = stderrLines.find((l: string) => l.includes("readPackageVersion"));
    expect(matchingLine, "the production catch branch must report the failure to stderr").toBeTruthy();
    expect(matchingLine).toMatch(/readPackageVersion/);
    // The offending path is named, so an operator can find the broken manifest.
    expect(matchingLine).toContain(packageJsonPath);
  });
});

test("readPackageVersion returns the version from a well-formed package.json, and null when absent (OBS-9335faf6)", async () => {
  const { readPackageVersion } = await import("../../src/audit/io/toolingManifest.js");

  await withTempDir("audit-code-tooling-manifest-ok-", async (tempDir: string) => {
    // Absent package.json — the pre-parse existence branch.
    expect(await readPackageVersion(tempDir)).toBe(null);

    await writeFile(join(tempDir, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");
    expect(await readPackageVersion(tempDir)).toBe("9.9.9");

    // Present but non-string version — parses cleanly, still no version.
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ version: 42 }), "utf8");
    expect(await readPackageVersion(tempDir)).toBe(null);
  });
});

test("ARTIFACT_DEFINITIONS each have a non-null phase field from the 5 valid audit phases (ARC-dd468422)", async () => {
  // Regression: ArtifactBundle was originally a flat bag of 30+ optional fields
  // with no phase-based grouping. This test asserts that every artifact definition
  // carries an explicit phase from the canonical set, so the grouping cannot regress.
  const validPhases = new Set<string>(["intake", "analysis", "execution", "reporting", "supervisor"]);
  const entries = Object.entries(ARTIFACT_DEFINITIONS);
  expect(entries.length >= 25, `expected at least 25 artifact definitions, got ${entries.length}`).toBeTruthy();
  const missingPhase: string[] = [];
  const badPhase: string[] = [];
  for (const [key, def] of entries) {
    if (def.phase === undefined || def.phase === null) {
      missingPhase.push(key);
    } else if (!validPhases.has(def.phase)) {
      badPhase.push(`${key}: '${def.phase}'`);
    }
  }
  expect(missingPhase, `artifact definitions missing phase: ${missingPhase.join(", ")}`).toEqual([]);
  expect(badPhase, `artifact definitions with invalid phase: ${badPhase.join(", ")}`).toEqual([]);
  // Each phase must be represented — the grouping is meaningful, not nominal.
  const presentPhases = new Set<string>(entries.map(([, def]) => def.phase));
  for (const phase of validPhases) {
    expect(presentPhases.has(phase), `phase '${phase}' has no artifact definitions`).toBeTruthy();
  }
});

test("loadArtifactBundle throws ArtifactSchemaVersionError for mismatched intent_checkpoint schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load } = await import("../../src/audit/io/artifacts.js");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-", async (dir: string) => {
    // Write intent_checkpoint.json with wrong schema_version
    const stale = {
      schema_version: "intent-checkpoint/v0",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "all files",
      intent_summary: "full audit",
    };
    await wf(join(dir, "intent_checkpoint.json"), JSON.stringify(stale), "utf8");

    await assert.rejects(
      load(dir),
      (err: any) => {
        expect(err instanceof ArtifactSchemaVersionError, "must be ArtifactSchemaVersionError").toBeTruthy();
        expect(err.message).toMatch(/intent_checkpoint\.json/);
        expect(err.message).toMatch(/intent-checkpoint\/v0/);
        expect(err.message).toMatch(/intent-checkpoint\/v1/);
        return true;
      },
    );
  });
});

test("loadArtifactBundle succeeds for correct intent_checkpoint schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load } = await import("../../src/audit/io/artifacts.js");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-ok-", async (dir: string) => {
    const valid = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "all files",
      intent_summary: "full audit",
    };
    await wf(join(dir, "intent_checkpoint.json"), JSON.stringify(valid), "utf8");

    const bundle = await load(dir);
    expect(bundle.intent_checkpoint?.schema_version).toBe("intent-checkpoint/v1");
  });
});

test("audit-code src/ has no circular imports — in-process cycle check reports zero cycles (ARC-1fa005bb)", async () => {
  // ARC-1fa005bb: a dep-cycle was alleged (index.ts -> cli.ts -> io/ -> index.ts).
  // The STILL-REAL verdict confirmed the cycle does NOT exist in current source.
  // This regression guard keeps it that way: if any future edit closes a real cycle,
  // the check fails deterministically here before it can reach production.
  //
  // The check is fully in-process (built-ins only). It replaces the former
  // `npx madge --circular` guard — madge is not a declared dependency, so npx
  // fetched it on demand: the guard was network/cache-dependent and silently
  // passed when madge failed to resolve. The deterministic walker reads the same
  // relative-import graph and detects cycles with a colored DFS.
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pathJoin } = await import("node:path");
  const { findImportCycles, formatCycle } = await import("./helpers/importCycles.mjs");

  const __dir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = pathJoin(__dir, "..", "..");
  const entrypoint = pathJoin(__dir, "../../src/audit/index.ts");

  const cycles = await findImportCycles(entrypoint);

  expect(cycles, `Circular imports detected in src/audit/. ` +
      `Cycles:\n${cycles.map((c: string[]) => "  " + formatCycle(c, repoRoot)).join("\n")}\n` +
      `Fix by ensuring no import chain forms a cycle. (ARC-1fa005bb regression guard)`).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV 9: the ExternalAnalyzerToolStatus write-then-read round-trip.
//
// A failed tool and a tool that found nothing are the SAME shape on disk unless
// the status survives persist-then-reload distinguishably. That persisted record
// is the only post-run evidence a tool failed rather than found nothing, so a
// status coerced to `success`, dropped, or collapsed into a bare [] erases the
// distinction permanently (the T-002 / T-006 classes in one place).
// ─────────────────────────────────────────────────────────────────────────────

test("INV 9: checksum_mismatch round-trips through the registry, distinguishable from not_resolved", async () => {
  await withTempDir("audit-code-analyzer-status-roundtrip-", async (tempDir: string) => {
    const { writeCoreArtifacts, loadArtifactBundle } = await import(
      "../../src/audit/io/artifacts.js"
    );
    const artifactsDir = join(tempDir, "artifacts");

    // TYPED AT THE STATUS LEVEL, deliberately. A blanket `as never` on the
    // fixture would make this test inert against the very thing it guards:
    // deleting `checksum_mismatch` from the vocabulary would leave the literal
    // below compiling happily as an arbitrary string. Typed as
    // ExternalAnalyzerToolStatus[], that deletion is a COMPILE ERROR here.
    const statuses: ExternalAnalyzerToolStatus[] = [
      {
        tool: "semgrep",
        resolved: false,
        status: "checksum_mismatch",
        error: "pinned release checksum did not match the downloaded asset",
      },
      {
        tool: "gitleaks",
        resolved: false,
        status: "not_resolved",
        error: "no network",
      },
    ];

    await writeCoreArtifacts(artifactsDir, {
      external_analyzer_results: [{ tool: "semgrep", statuses }],
      external_analyzer_acquisition: { statuses },
      // The boundary cast covers ONLY the envelope shape (which registry keys a
      // partial bundle carries); the status vocabulary inside it is guarded by
      // the typing above, not by this cast.
    } as never);

    const bundle = await loadArtifactBundle(artifactsDir);
    const reloaded = (bundle.external_analyzer_results as never as {
      statuses: { tool: string; status: string; error?: string }[];
    }[])[0]!.statuses;

    const back = reloaded.find((s) => s.tool === "semgrep")!;
    // Byte-exact on the status field — not merely "some failure was recorded".
    expect(back.status, "checksum_mismatch must survive persist-then-reload").toBe(
      "checksum_mismatch",
    );
    // And UNEQUAL to the offline cause: the two are different facts about why a
    // tool produced nothing, and collapsing them is the defect.
    expect(
      back.status,
      "a checksum mismatch is not the same fact as never having resolved",
    ).not.toBe(reloaded.find((s) => s.tool === "gitleaks")!.status);
    // Never success-shaped-empty: the statuses list itself must survive.
    expect(reloaded.length, "the status list must not collapse to []").toBe(2);

    // The acquisition marker carries the same vocabulary through its own entry.
    const acquisition = bundle.external_analyzer_acquisition as never as {
      statuses: { status: string }[];
    };
    expect(acquisition.statuses.map((s) => s.status)).toEqual([
      "checksum_mismatch",
      "not_resolved",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV 7: artifact:canonical-audit-deliverable-write-path.
// ─────────────────────────────────────────────────────────────────────────────

test("INV 7: the canonical write path archives and VERIFIES before replacing", async () => {
  await withTempDir("audit-code-canonical-write-", async (tempDir: string) => {
    const { writeCanonicalAuditDeliverables } = await import(
      "../../src/audit/io/artifacts.js"
    );
    const { readFile, mkdir } = await import("node:fs/promises");
    const artifactsDir = join(tempDir, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const root = join(tempDir, ".audit-tools");

    // First write: nothing to archive.
    const first = await writeCanonicalAuditDeliverables({
      artifactsDir,
      findings: { contract_version: "audit-findings/v1", n: 1 },
      report: "# first\n",
    });
    expect(first.archived, "a first write archives nothing").toEqual([]);
    expect(await readFile(join(root, "audit-report.md"), "utf8")).toBe("# first\n");

    // Second write: the PRIOR pair must be archived, verified, then replaced.
    const second = await writeCanonicalAuditDeliverables({
      artifactsDir,
      findings: { contract_version: "audit-findings/v1", n: 2 },
      report: "# second\n",
    });
    expect(second.archived.length, "both prior deliverables are archived").toBe(2);
    for (const archivePath of second.archived) {
      // Verified means read back: the archive holds the PRIOR content.
      const body = await readFile(archivePath, "utf8");
      expect(body.includes("first") || body.includes('"n": 1')).toBe(true);
    }
    expect(await readFile(join(root, "audit-report.md"), "utf8")).toBe("# second\n");
  });
});

test("INV 7: the canonical pair has ONE writer in src/ (import-anchored scan)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const srcRoot = join(__dirname, "..", "..", "src");
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };

  // ANCHORED ON THE IMPORT, not on the call shape. A call-shape scan is porous
  // by construction and this one was: the copy family takes its DESTINATION
  // SECOND (`cp(src, dest)`), so a destination-blind regex only ever matched the
  // canonical path as a READ; and writeFileSync, appendFile, rename,
  // createWriteStream, an open() handle write, an aliased import and a property
  // binding all slip past any fixed list of call shapes. Imports are far more
  // regular. So: ANY module that imports either promoted-path helper is a
  // candidate writer, and the pin is the candidate SET.
  //
  // UNCOVERED HALVES, stated outright - both are real evasions, not theoretical:
  //   1. LITERAL PATH CONSTRUCTION. A module that never imports the helpers and
  //      builds the path itself - join(root, ".audit-tools", "audit-report.md")
  //      - is invisible here; closing it needs a path-construction scan this
  //      test does not attempt.
  //   2. NON-DECLARATION BINDING. The bound-name extraction below reads
  //      const/let/var only, so a helper result assigned to an object property
  //      or field (`this.dest = promotedAuditReportPath(d)`) is not tracked and
  //      a later write through that property is not flagged.
  const HELPER = /promotedAudit(?:Findings|Report)Path/u;
  // Destination-FIRST family: the path is argument 1.
  const DEST_FIRST =
    "writeFile|writeFileSync|writeFileAtomic|writeJsonFile|writeTextFile|appendFile|appendFileSync|appendNdjsonFile|writeNdjsonFile|createWriteStream|open|unlink|rm";
  // Destination-SECOND family: `cp(src, dest)`, `copyFile(src, dest)`,
  // `rename(from, to)`. This is the position the first scan was blind to, which
  // is why it matched the canonical path only ever as a READ.
  const DEST_SECOND = "cp|cpSync|copyFile|copyFileSync|rename|renameSync";

  const candidates: string[] = [];
  for (const file of await walk(srcRoot)) {
    const body = await readFile(file, "utf8");
    if (!HELPER.test(body)) continue;
    // A pure re-export barrel names the helper but binds and writes nothing.
    if (/^\s*export\s*\{[^}]*promotedAudit/mu.test(body) && !/=\s*promotedAudit/u.test(body)) {
      continue;
    }
    // Local names the helper is reachable under: its exported name PLUS any
    // import alias. Extracted from the import clause because the call site uses
    // the LOCAL name — `import { promotedAuditReportPath as canonicalReport }`
    // is invisible to a pattern that only knows the exported one, which is
    // exactly how an aliased writer slipped past the previous version.
    const aliases = [
      ...body.matchAll(/promotedAudit(?:Findings|Report)Path\s+as\s+(\w+)/gu),
    ].map((m) => m[1]!);
    const helperAlt = [
      "promotedAuditFindingsPath",
      "promotedAuditReportPath",
      ...aliases,
    ].join("|");

    // Every local name one of those is bound to.
    const bound = [
      ...body.matchAll(
        new RegExp(
          `(?:const|let|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*(?:await\\s+)?(?:${helperAlt})\\s*\\(`,
          "gu",
        ),
      ),
    ].map((m) => m[1]!);

    const writesTo = (name: string): boolean =>
      new RegExp(`(?:${DEST_FIRST})\\s*\\(\\s*${name}\\b`, "u").test(body) ||
      new RegExp(`(?:${DEST_SECOND})\\s*\\([^,()]*,\\s*${name}\\b`, "u").test(body);

    const inlineDestFirst = new RegExp(
      `(?:${DEST_FIRST})\\s*\\(\\s*(?:${helperAlt})\\s*\\(`,
      "u",
    );
    const inlineDestSecond = new RegExp(
      `(?:${DEST_SECOND})\\s*\\([^,()]*,\\s*(?:${helperAlt})\\s*\\(`,
      "u",
    );

    if (
      bound.some(writesTo) ||
      inlineDestFirst.test(body) ||
      inlineDestSecond.test(body)
    ) {
      candidates.push(file.split("\\").join("/").replace(/^.*\/src\//u, "src/"));
    }
  }

  expect(candidates.sort()).toEqual([
    "src/audit/cli/resynthesizeCommand.ts",
    "src/audit/io/artifacts.ts",
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV 11: the ArtifactBundle field-set pin.
//
// The typechecker covers a rename within one build. It cannot see a bundle
// WRITTEN in one phase and READ BACK in another, which is the case these
// consumers are in — so this test, not the compiler, is the enforcement.
// ─────────────────────────────────────────────────────────────────────────────

test("INV 11: the bundle exposes every field its named consumers read", async () => {
  await withTempDir("audit-code-bundle-field-set-", async (tempDir: string) => {
    const { writeCoreArtifacts, loadArtifactBundle, ARTIFACT_DEFINITIONS } =
      await import("../../src/audit/io/artifacts.js");
    const artifactsDir = join(tempDir, "artifacts");

    // DERIVED from the registry, not hand-copied: every registry key is a field
    // a materialized bundle may carry.
    const registryKeys = new Set(Object.keys(ARTIFACT_DEFINITIONS));

    // ONE declared list of the fields the named consumers read BY NAME, compared
    // for SET EQUALITY against what the registry carries.
    //
    // WHAT THIS CATCHES: a declared field RENAMED (or dropped) in the registry —
    // INV 11's named mutation. WHAT IT DOES NOT: a field removed from
    // CONSUMER_READ_FIELDS itself. Both sides of the comparison derive from that
    // one list, so deleting an entry shrinks both and the assertion is
    // unaffected. Pinning the list against drift needs a committed baseline that
    // does not re-derive from it; that is tracked in the consolidated pass
    // alongside the CP-NODE-26 duplicate baseline, not built here.
    const CONSUMER_READ_FIELDS = [
      // structureExecutors.ts + syntaxResolutionExecutor.ts
      "repo_manifest",
      "file_disposition",
      "external_analyzer_results",
      "artifact_metadata",
      // conceptualDispatch.ts (nested paths asserted below)
      "intent_checkpoint",
      "charter_register",
    ] as const;
    expect(
      CONSUMER_READ_FIELDS.filter((field) => registryKeys.has(field)).sort(),
      "every consumer-read bundle field must still be a registry key — a rename under a consumer",
    ).toEqual([...CONSUMER_READ_FIELDS].sort());
    // graph_edge_cache is loaded specially (not a registry entry), so it is
    // pinned against the materialized bundle instead of the registry.
    await writeCoreArtifacts(artifactsDir, {
      repo_manifest: { repository: { name: "f" }, generated_at: "t", files: [] },
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1",
        design_review: { mode: "conceptual" },
      },
      charter_register: {
        schema_version: "charter-register/v3",
        subsystems: [{ name: "s", charters: [] }],
      },
      graph_edge_cache: { schema_version: "graph-edge-cache/v1", entries: [] },
    } as never);
    const bundle = await loadArtifactBundle(artifactsDir);
    // ROUND-TRIP, not a tautology. `"x" in bundle || bundle.x === undefined` is
    // true for every object ever constructed, and this was the one leg INV 11's
    // verification obligation actually names — so it pinned nothing at all.
    expect(
      bundle.graph_edge_cache,
      "graph_edge_cache must survive writeCoreArtifacts -> loadArtifactBundle",
    ).toBeDefined();
    expect(
      (bundle.graph_edge_cache as never as { entries?: unknown[] }).entries,
      "the cache's own payload must round-trip, not just the key",
    ).toBeDefined();

    // The NESTED paths conceptualDispatch.ts reads must survive a round-trip.
    expect(
      (bundle.intent_checkpoint as never as { design_review?: unknown })?.design_review,
      "conceptualDispatch reads intent_checkpoint.design_review",
    ).toBeDefined();
    expect(
      (bundle.charter_register as never as { subsystems?: { charters?: unknown }[] })
        ?.subsystems?.[0]?.charters,
      "conceptualDispatch reads charter_register.subsystems[].charters",
    ).toBeDefined();
  });
});

// INV 4, MECHANIZED. The rewritten runSample test proves ONE caller pairs the
// right reader with audit_results.jsonl; it cannot stop the next `.jsonl` entry
// from being registered with the JSON reader. This does: the registry is the
// single place the pairing is declared, so the pairing is checked there.
test("INV 4: every .jsonl registry entry binds the NDJSON reader, not readJsonFile", async () => {
  const { ARTIFACT_DEFINITIONS } = await import("../../src/audit/io/artifacts.js");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    join(__dirname, "..", "..", "src", "audit", "io", "artifacts.ts"),
    "utf8",
  );

  const jsonlKeys = Object.entries(
    ARTIFACT_DEFINITIONS as Record<string, { fileName: string }>,
  )
    .filter(([, definition]) => definition.fileName.endsWith(".jsonl"))
    .map(([key]) => key);

  expect(
    jsonlKeys.length,
    "the registry must actually carry .jsonl entries for this check to mean anything",
  ).toBeGreaterThan(0);

  for (const key of jsonlKeys) {
    // The declaration site: `<key>: ndjsonArtifact("<name>.jsonl", ...)`. A
    // future `.jsonl` registered through jsonArtifact reds here, because
    // JSON.parse on a multi-record NDJSON body throws and the mismatch would
    // otherwise surface only as a swallowed read at some caller.
    // Match the FACTORY CALL directly. Searching for `<key>:` alone finds the
    // ArtifactPayloadMap TYPE declaration higher in the same file, not the
    // registry entry, and then "found no factory" for the wrong reason.
    const ndjsonDecl = key + ": ndjsonArtifact(";
    const jsonDecl = key + ": jsonArtifact(";
    expect(
      source.includes(jsonDecl),
      "'" + key + "' is a .jsonl artifact registered with jsonArtifact — JSON.parse on a " +
        "multi-record NDJSON body throws, so this pairing can only fail at a caller",
    ).toBe(false);
    expect(
      source.includes(ndjsonDecl),
      "'" + key + "' is a .jsonl artifact and must be registered with ndjsonArtifact",
    ).toBe(true);
  }
});

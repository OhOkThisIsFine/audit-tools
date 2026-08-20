import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";

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

test("promoteFinalAuditReport warns when audit-findings.json copy fails (OBS-24e78e9d)", async () => {
  await withTempDir("audit-code-report-promotion-findings-warn-", async (tempDir: string) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

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
            throw new Error("ENOENT: no such file or directory");
          }
        },
        warn: (message: string) => warnings.push(message),
      },
    );

    // Primary report copy succeeded — promoted must be true.
    expect(result.promoted, "promoted must be true when only audit-findings.json copy fails").toBe(true);
    // warning field must NOT be set when only the secondary contract copy failed.
    expect(result.warning, "warning field must be undefined when primary report copy succeeded").toBe(undefined);
    // warn callback must have been called once with a message about audit-findings.json.
    expect(warnings.length, "warn must be called exactly once").toBe(1);
    expect(warnings[0], "warn message must mention audit-findings.json").toMatch(/audit-findings\.json/);
    expect(warnings[0], "warn message must include the error text").toMatch(/ENOENT/);
    // Every copy was attempted, in order and independently: the report, then
    // the failing findings contract, then the submission ledger (the durable
    // drift/repair record, archived out of the tree before it is destroyed).
    // A failure in one must not skip the others — that is what "best-effort"
    // has to mean here, since each rescues a different deliverable.
    expect(copyCallCount, "report, findings, and ledger copies are each attempted").toBe(3);
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

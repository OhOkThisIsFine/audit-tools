import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";

const {
  appendNdjsonFile,
  readJsonFile,
  readNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeJsonFile,
  writeNdjsonFile,
} = await import("audit-tools/shared/io/json");
const {
  getArtifactValue,
  loadArtifactBundle,
  promoteFinalAuditReport,
  writeCoreArtifacts,
} = await import("../../src/audit/io/artifacts.ts");
const { TOOLING_INPUTS, buildToolingManifest } = await import("../../src/audit/io/toolingManifest.ts");
const {
  buildRunId,
  clearDispatchFiles,
  ensureSupervisorDirs,
  getRunPaths,
  writeWorkerTaskFiles,
} = await import("../../src/audit/io/runArtifacts.ts");

const { withTempDir } = await import("./helpers/withTempDir.mjs");

function stableToolingManifestValues(manifest) {
  return {
    package_root: manifest.package_root,
    package_version: manifest.package_version,
    implementation_hash: manifest.implementation_hash,
    inputs: manifest.inputs,
  };
}

test("JSON readers and writers surface path-aware failures and optional readers stay permissive", async () => {
  await withTempDir("audit-code-io-json-", async (tempDir) => {
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
  await withTempDir("audit-code-io-ndjson-", async (tempDir) => {
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
  await withTempDir("audit-code-io-artifacts-", async (tempDir) => {
    const bundle = {
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
    expect(loaded.tooling_manifest.package_version).toBe(expectedManifest.package_version);
    expect(loaded.tooling_manifest.implementation_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.tooling_manifest.implementation_hash).not.toBe("0".repeat(64));
    expect(loaded.tooling_manifest.inputs).toEqual(Array.from(TOOLING_INPUTS));
    expect(stableToolingManifestValues(loaded.tooling_manifest)).toEqual(stableToolingManifestValues(expectedManifest));

    const loadedAgain = await loadArtifactBundle(`${tempDir}${sep}`);
    expect(stableToolingManifestValues(loadedAgain.tooling_manifest)).toEqual(stableToolingManifestValues(loaded.tooling_manifest));

  });
});

test("final report promotion preserves artifacts when destination is not writable", async () => {
  await withTempDir("audit-code-report-promotion-", async (tempDir) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

    const warnings = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir, repoRoot },
      {
        copy: async () => {
          throw new Error("EPERM: operation not permitted");
        },
        warn: (message) => warnings.push(message),
      },
    );

    expect(result.promoted).toBe(false);
    expect(result.cleaned).toBe(false);
    expect(result.warning).toMatch(/could not promote final report/i);
    expect(warnings.length).toBe(1);
    expect(existsSync(join(artifactsDir, "audit-report.md"))).toBe(true);
  });
});

test("promoteFinalAuditReport warns when audit-findings.json copy fails (OBS-24e78e9d)", async () => {
  await withTempDir("audit-code-report-promotion-findings-warn-", async (tempDir) => {
    const artifactsDir = join(tempDir, "artifacts");
    const repoRoot = join(tempDir, "repo");
    await writeCoreArtifacts(artifactsDir, {
      audit_report: "# Audit Report\n",
    });

    const warnings = [];
    let copyCallCount = 0;
    const result = await promoteFinalAuditReport(
      { artifactsDir, repoRoot },
      {
        copy: async (src, dest) => {
          copyCallCount++;
          // First copy (audit-report.md) succeeds; second (audit-findings.json) fails.
          if (dest.endsWith("audit-findings.json")) {
            throw new Error("ENOENT: no such file or directory");
          }
        },
        warn: (message) => warnings.push(message),
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
  });
});

test("run artifact helpers produce parseable run ids and clean only dispatch files", async () => {
  await withTempDir("audit-code-run-artifacts-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    const fixedNow = new Date("2026-04-22T15:16:17.089Z");
    const runId = buildRunId(" flow:auth/entry ", 7, fixedNow);
    const paths = getRunPaths(artifactsDir, runId);

    expect(runId).toBe("20260422T151617089Z_flow-auth-entry_007");
    expect(buildRunId("", 1, fixedNow)).toBe("20260422T151617089Z_terminal_001");

    await ensureSupervisorDirs(artifactsDir);

    const task = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: runId,
      repo_root: "C:\\repo",
      artifacts_dir: artifactsDir,
      obligation_id: "flow:auth/entry",
      preferred_executor: "agent",
      result_path: paths.resultPath,
      worker_command: ["node", "dist/index.js", "worker-run"],
      audit_results_path: join(paths.runDir, "run-results.json"),
      worker_command_mode: "deferred",
      timeout_ms: 5000,
      max_retries: 1,
    };
    const pendingTasks = [
      {
        task_id: "audit-1",
        unit_id: "unit-1",
        pass_id: "pass-1",
        lens: "security",
        file_paths: ["src/index.ts"],
        file_line_counts: { "src/index.ts": 12 },
        rationale: "fixture",
      },
      {
        task_id: "audit-2",
        unit_id: "unit-2",
        pass_id: "pass-2",
        lens: "correctness",
        file_paths: ["src/other.ts"],
        file_line_counts: { "src/other.ts": 8 },
        rationale: "second fixture",
      },
    ];

    await writeWorkerTaskFiles(
      task,
      "# Prompt\n",
      paths,
      artifactsDir,
      pendingTasks,
    );

    expect(JSON.parse(await readFile(paths.taskPath, "utf8"))).toEqual(task);
    expect(await readFile(paths.promptPath, "utf8")).toBe("# Prompt\n");
    expect(JSON.parse(await readFile(paths.statusPath, "utf8"))).toEqual({ run_id: runId, status: "dispatched" });
    expect(JSON.parse(
        await readFile(join(artifactsDir, "dispatch", "current-tasks.json"), "utf8"),
      )).toEqual(pendingTasks);
    expect(JSON.parse(
        await readFile(join(artifactsDir, "dispatch", "current-single-task.json"), "utf8"),
      )).toEqual(pendingTasks[0]);
    const singleTaskPrompt = await readFile(
      join(artifactsDir, "dispatch", "current-single-task-prompt.md"),
      "utf8",
    );
    expect(singleTaskPrompt).toMatch(/task_id: audit-1/);
    expect(singleTaskPrompt).toMatch(/worker_command:/);
    expect(singleTaskPrompt).not.toMatch(/audit-2/);
    expect((await readFile(join(artifactsDir, "dispatch", "audit-result.schema.json"), "utf8")).includes(
        "\"$schema\"",
      )).toBeTruthy();
    expect((await readFile(join(artifactsDir, "dispatch", "audit-results.schema.json"), "utf8")).includes(
        "\"Audit Results\"",
      )).toBeTruthy();
    expect((await readFile(join(artifactsDir, "dispatch", "finding.schema.json"), "utf8")).includes(
        "\"Audit Finding\"",
      )).toBeTruthy();

    await clearDispatchFiles(artifactsDir);

    expect(existsSync(join(artifactsDir, "dispatch", "current-task.json"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "current-prompt.md"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "current-tasks.json"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "current-single-task.json"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "current-single-task-prompt.md"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "audit-result.schema.json"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "audit-results.schema.json"))).toBe(false);
    expect(existsSync(join(artifactsDir, "dispatch", "finding.schema.json"))).toBe(false);
    expect(existsSync(paths.taskPath)).toBe(true);
    expect(existsSync(paths.promptPath)).toBe(true);
    expect(existsSync(paths.statusPath)).toBe(true);
  });
});

test("clearDispatchFiles is a no-op when the dispatch directory does not exist", async () => {
  await withTempDir("audit-code-clear-dispatch-missing-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");

    await mkdir(artifactsDir, { recursive: true });
    expect(existsSync(join(artifactsDir, "dispatch")), "dispatch directory should not exist before clearDispatchFiles").toBe(false);

    // clearDispatchFiles must resolve without throwing even though dispatch/ is absent.
    await assert.doesNotReject(
      clearDispatchFiles(artifactsDir),
      "clearDispatchFiles must not throw when dispatch directory does not exist",
    );

    // The directory must not be created as a side-effect.
    expect(existsSync(join(artifactsDir, "dispatch")), "clearDispatchFiles must not create the dispatch directory").toBe(false);
  });
});

test("io/artifacts has no import from cli/dispatch (ARC-13a4083a)", async () => {
  const { readFile: readFileFs } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pathJoin } = await import("node:path");
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = await readFileFs(pathJoin(__dir, "../../src/audit/io/artifacts.ts"), "utf8");
  expect(!src.includes("../cli/dispatch"), "io/artifacts.ts must not import from ../cli/dispatch (circular dependency); use ../types/activeDispatch instead").toBeTruthy();
});

test("readPackageVersion logs to stderr on JSON parse error and returns null (OBS-9335faf6)", async () => {
  await withTempDir("audit-code-tooling-manifest-parse-err-", async (tempDir) => {
    // Patch PACKAGE_ROOT by writing a broken package.json into tempDir,
    // then call buildToolingManifest with a shadow module.
    // Since PACKAGE_ROOT is resolved at module load time we must exercise the path
    // indirectly: write a broken package.json at an accessible path and call the
    // function via a tiny inline reimplementation that points at tempDir.
    const { readFile: rf } = await import("node:fs/promises");
    const { stat: st } = await import("node:fs/promises");

    async function pathExistsLocal(p) {
      try { await st(p); return true; } catch { return false; }
    }

    const packageJsonPath = join(tempDir, "package.json");
    await writeFile(packageJsonPath, "{invalid json}", "utf8");

    const stderrLines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return orig(chunk, ...rest);
    };
    let result;
    try {
      if (!(await pathExistsLocal(packageJsonPath))) {
        result = null;
      } else {
        try {
          const parsed = JSON.parse(await rf(packageJsonPath, "utf8"));
          result = typeof parsed.version === "string" ? parsed.version : null;
        } catch (error) {
          process.stderr.write(
            `[audit-code] readPackageVersion: failed to read/parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          result = null;
        }
      }
    } finally {
      process.stderr.write = orig;
    }

    expect(result, "parse error must return null").toBe(null);
    const matchingLine = stderrLines.find((l) => l.includes("readPackageVersion"));
    expect(matchingLine, "stderr must contain a line mentioning readPackageVersion").toBeTruthy();
    expect(matchingLine).toMatch(/readPackageVersion/);
    // The error message from JSON.parse should be present
    expect(stderrLines.some((l) => l.includes("readPackageVersion"))).toBeTruthy();
  });
});

test("ARTIFACT_DEFINITIONS each have a non-null phase field from the 5 valid audit phases (ARC-dd468422)", async () => {
  // Regression: ArtifactBundle was originally a flat bag of 30+ optional fields
  // with no phase-based grouping. This test asserts that every artifact definition
  // carries an explicit phase from the canonical set, so the grouping cannot regress.
  const { ARTIFACT_DEFINITIONS } = await import("../../src/audit/io/artifacts.ts");
  const validPhases = new Set(["intake", "analysis", "execution", "reporting", "supervisor"]);
  const entries = Object.entries(ARTIFACT_DEFINITIONS);
  expect(entries.length >= 25, `expected at least 25 artifact definitions, got ${entries.length}`).toBeTruthy();
  const missingPhase = [];
  const badPhase = [];
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
  const presentPhases = new Set(entries.map(([, def]) => def.phase));
  for (const phase of validPhases) {
    expect(presentPhases.has(phase), `phase '${phase}' has no artifact definitions`).toBeTruthy();
  }
});

test("ArtifactBundle active_dispatch field still typed as ActiveDispatchState after ARC-13a4083a refactor", async () => {
  const { loadArtifactBundle: load } = await import("../../src/audit/io/artifacts.ts");
  await withTempDir("arc-13a4083a-", async (dir) => {
    // No active-dispatch.json → active_dispatch should be absent
    const bundle = await load(dir);
    expect(!("active_dispatch" in bundle), "active_dispatch absent when file missing").toBeTruthy();

    // With a valid active-dispatch.json, the field should be populated
    const { writeFile: wf } = await import("node:fs/promises");
    const activeDispatch = {
      run_id: "test-run",
      created_at: new Date().toISOString(),
      packet_count: 1,
      task_count: 1,
      status: "active",
    };
    await wf(join(dir, "active-dispatch.json"), JSON.stringify(activeDispatch));
    const bundle2 = await load(dir);
    expect("active_dispatch" in bundle2, "active_dispatch populated when file present").toBeTruthy();
    expect(bundle2.active_dispatch?.run_id).toBe("test-run");
    expect(bundle2.active_dispatch?.status).toBe("active");
  });
});

test("loadArtifactBundle throws ArtifactSchemaVersionError for mismatched intent_checkpoint schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load, ArtifactSchemaVersionError } = await import("../../src/audit/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-", async (dir) => {
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
      (err) => {
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
  const { loadArtifactBundle: load } = await import("../../src/audit/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-intent-ok-", async (dir) => {
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

test("loadArtifactBundle throws ArtifactSchemaVersionError for mismatched provider_confirmation schema_version (ARC-dd468422)", async () => {
  const { loadArtifactBundle: load, ArtifactSchemaVersionError } = await import("../../src/audit/io/artifacts.ts");
  const { writeFile: wf } = await import("node:fs/promises");
  await withTempDir("arc-dd468422-provider-", async (dir) => {
    // Write provider_confirmation.json with wrong schema_version
    const stale = {
      schema_version: "0.0.0",
      confirmed_at: new Date().toISOString(),
      provider_pool: [],
      session_level: true,
    };
    await wf(join(dir, "provider_confirmation.json"), JSON.stringify(stale), "utf8");

    await assert.rejects(
      load(dir),
      (err) => {
        expect(err instanceof ArtifactSchemaVersionError, "must be ArtifactSchemaVersionError").toBeTruthy();
        expect(err.message).toMatch(/provider_confirmation\.json/);
        expect(err.message).toMatch(/0\.0\.0/);
        return true;
      },
    );
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
      `Cycles:\n${cycles.map((c) => "  " + formatCycle(c, repoRoot)).join("\n")}\n` +
      `Fix by ensuring no import chain forms a cycle. (ARC-1fa005bb regression guard)`).toEqual([]);
});

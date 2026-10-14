import { test, expect } from "vitest";
import * as acquisitionEngine from "../../src/shared/analyzers/acquisitionEngine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type {
  BinaryFetcher,
  BinaryCommandRunner,
} from "../../src/shared/analyzers/binaryAcquisition.js";

// Slice D — production wiring of the external-analyzer acquisition engine.
// Covers the hermeticity gate (disabled ⇒ empty marker, nothing spawned) and the
// enabled path with an injected fetch + command runner (gitleaks via a fake
// PATH-resolved binary), asserting the marker + the upserted findings.

const { runExternalAnalyzerAcquisitionExecutor } = await import(
  "../../src/audit/orchestrator/acquisitionExecutor.js"
);

function bundleAfterIntake(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
  };
}

test("disabled (no option) ⇒ hermetic empty marker, nothing spawned, results untouched", async () => {
  let spawned = false;
  const run: BinaryCommandRunner = async () => {
    spawned = true;
    return { status: 0, stdout: "", stderr: "", argv: [], duration_ms: 1 };
  };
  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    "/repo",
    { run },
  );
  expect(spawned, "no subprocess may spawn when disabled").toBe(false);
  expect(result.artifacts_written).toEqual([
    "external_analyzer_acquisition.json",
  ]);
  const marker = result.updated.external_analyzer_acquisition!;
  expect(marker.enabled).toBe(false);
  expect(marker.tool_statuses).toEqual([]);
  expect(result.updated.external_analyzer_results).toBe(undefined);
});

test("enabled but no root ⇒ empty marker (defence-in-depth)", async () => {
  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    undefined,
    { enabled: true },
  );
  expect(result.updated.external_analyzer_acquisition!.enabled).toBe(false);
  expect(result.artifacts_written).toEqual([
    "external_analyzer_acquisition.json",
  ]);
});

test("enabled ⇒ gitleaks (PATH-resolved) findings upserted + marker records status", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "executor-binary-cache-"));
  try {
    // gitleaks writes a JSON report file, not stdout. The engine reads
    // candidate.reportFile() — so the fake runner must create that file. We
    // intercept the report path from the spawn argv (`--report-path <path>`).
    const { writeFileSync } = await import("node:fs");
    const gitleaksReport = JSON.stringify([
      {
        RuleID: "generic-api-key",
        File: "src/a.ts",
        StartLine: 7,
        EndLine: 7,
        Description: "Generic API key",
        Fingerprint: "fp-1",
        Secret: "SHOULD-NOT-LEAK",
      },
    ]);

    const run: BinaryCommandRunner = async (argv) => {
      // PATH probe for gitleaks (`gitleaks version`) succeeds so resolveBinary
      // returns the on-PATH binary and never downloads.
      if (argv.includes("version") && argv[0] === "/fixture/gitleaks") {
        return { status: 0, stdout: "8.21.2", stderr: "", argv, duration_ms: 1 };
      }
      // npx/pipx probes (semgrep/eslint) — report unavailable so they degrade.
      if (argv.includes("--version")) {
        return {
          status: 1,
          stdout: "",
          stderr: "not found",
          argv,
          duration_ms: 1,
          error: new Error("ENOENT"),
        };
      }
      // The gitleaks tool spawn: write the report file it was told to.
      const reportIdx = argv.indexOf("--report-path");
      if (reportIdx >= 0) {
        writeFileSync(argv[reportIdx + 1], gitleaksReport, "utf8");
      }
      return { status: 0, stdout: "", stderr: "", argv, duration_ms: 1 };
    };

    // Fetcher must never be called (gitleaks resolves on PATH); fail loudly if it is.
    const fetchAdapter: BinaryFetcher = async () => {
      throw new Error("fetch must not run when the binary resolves on PATH");
    };

    const result = await runExternalAnalyzerAcquisitionExecutor(
      bundleAfterIntake(),
      process.cwd(),
      { enabled: true, run, fetch: fetchAdapter, cacheDir, resolveExecutable: name => name === "gitleaks" ? "/fixture/gitleaks" : null },
    );

    const marker = result.updated.external_analyzer_acquisition!;
    expect(marker.enabled).toBe(true);
    const { EXTERNAL_ANALYZER_CANDIDATES } = await import("audit-tools/shared");
    expect(marker.tool_statuses.map(status => status.tool)).toEqual(EXTERNAL_ANALYZER_CANDIDATES.map(candidate => candidate.id));
    const gitleaksStatus = marker.tool_statuses.find((s) => s.tool === "gitleaks");
    expect(gitleaksStatus, "marker must carry a gitleaks status").toBeTruthy();
    expect(gitleaksStatus!.status).toBe("findings");

    // Findings upserted into external_analyzer_results, raw secret dropped.
    expect(result.artifacts_written.includes("external_analyzer_results.json")).toBeTruthy();
    const gitleaksResults = result.updated.external_analyzer_results!.find(
      (r) => r.tool === "gitleaks",
    );
    expect(gitleaksResults, "external_analyzer_results must contain gitleaks").toBeTruthy();
    expect(gitleaksResults!.results.length).toBe(1);
    const finding = gitleaksResults!.results[0];
    expect(finding.path).toBe("src/a.ts");
    expect(finding.category).toBe("security");
    expect(!JSON.stringify(finding).includes("SHOULD-NOT-LEAK"), "raw secret value must never be carried into the artifact").toBeTruthy();
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

// ── CP-NODE-1(d): the SCOPED consent grant has a production producer.
//
// The residual read "the bare-string consent token is retired only additively;
// the scoped grant has no production producer until the caller-side node lands".
// The caller-side node landed in the fold (`handleAnalyzerConsentBranch` builds
// `{ value, tools }` from the ids the operator actually answered), and it reaches
// the spawn chokepoint through this production executor. Pinned END TO END here,
// because "a producer exists" and "the produced scope survives to admission" are
// different claims: the grant must still be per-tool at the moment it matters,
// and only the real dispatch path proves that.
test("a scoped grant admits exactly the tool it names, through the production executor", async () => {
  const { EXTERNAL_ANALYZER_CANDIDATES } = await import("audit-tools/shared");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync, writeFileSync } = await import("node:fs");

  const root = await mkdtemp(join(tmpdir(), "grant-scope-"));
  try {
    // A Node repo, so the npx candidates are applicable and the grant is what
    // decides — not ecosystem detection.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });

    const spawnedArgs: string[][] = [];
    const run: BinaryCommandRunner = async (argv) => {
      spawnedArgs.push(argv);
      return {
        status: 1,
        stdout: "",
        stderr: "probe unavailable",
        argv,
        duration_ms: 1,
        error: new Error("ENOENT"),
      };
    };

    const grantedId = "eslint";
    const result = await runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), root, {
      enabled: true,
      run,
      fetch: async () => null,
      resolveExecutable: () => null,
      cacheDir: join(root, "cache"),
      // The shape `handleAnalyzerConsentBranch` produces from the operator's answers.
      consentToken: { value: "run-scoped-token", tools: [grantedId] },
    });

    const statuses = result.updated.external_analyzer_acquisition!.tool_statuses;
    const granted = statuses.find((s) => s.tool === grantedId);
    expect(granted, "the granted candidate must still be reported").toBeDefined();
    expect(
      granted?.error,
      "a candidate the operator GRANTED must not be refused at the spawn chokepoint",
    ).not.toBe("consent not recorded for this analyzer (not yet decided; no consent token for this run)");

    // Every OTHER consent-gated candidate is still owed its own offer: the grant
    // names one tool and must not widen into a run-wide admission.
    const ungranted = EXTERNAL_ANALYZER_CANDIDATES.filter(
      (c) => !c.defaultRun && c.id !== grantedId && c.detect(root),
    ).map((c) => c.id);
    expect(ungranted.length).toBeGreaterThan(0);
    for (const id of ungranted) {
      const status = statuses.find((s) => s.tool === id);
      expect(
        status?.error,
        `candidate '${id}' was never granted — a scoped grant must not admit it`,
      ).toContain("consent");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired executor reports exactly one ordered status per candidate without I/O", async () => {
  const { EXTERNAL_ANALYZER_CANDIDATES } = await import("audit-tools/shared");
  let operations = 0;
  const result = await runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), process.cwd(), {
    enabled: true, deadline: { at: 0 },
    run: async argv => { operations++; return { status: 0, stdout: "", stderr: "", argv, duration_ms: 0 }; },
    fetch: async () => { operations++; return null; },
    resolveExecutable: () => { operations++; return null; },
  });
  const statuses = result.updated.external_analyzer_acquisition!.tool_statuses;
  expect(operations).toBe(0);
  expect(statuses.map(status => status.tool)).toEqual(EXTERNAL_ANALYZER_CANDIDATES.map(candidate => candidate.id));
  expect(statuses.every(status => status.status === "skipped" || status.status === "not_resolved")).toBe(true);
  expect(statuses.find(status => status.tool === "gitleaks")?.error).toContain("deadline_exceeded");
});

test("resolution failures keep their single producer and supply-chain classification", async () => {
  const shared = await import("audit-tools/shared");
  const { vi } = await import("vitest");
  const failures = shared.EXTERNAL_ANALYZER_CANDIDATES.filter(candidate => candidate.runner === "binary")
    .map((candidate, index) => ({ tool: candidate.id, resolved: false,
      status: (index === 0 ? "checksum_mismatch" : index === 1 ? "extract_failed" : "not_resolved") as "checksum_mismatch" | "extract_failed" | "not_resolved",
      error: "specific resolution failure" }));
  const resolver = vi.spyOn(acquisitionEngine, "resolveBinaryCandidates").mockResolvedValue({ resolvedBinaries: {}, unresolvedStatuses: failures });
  try {
    const result = await runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), process.cwd(), {
      enabled: true,
      run: async argv => ({ status: 1, stdout: "", stderr: "unavailable", argv, duration_ms: 0 }),
      fetch: async () => { throw new Error("no download permitted"); },
    });
    const statuses = result.updated.external_analyzer_acquisition!.tool_statuses;
    expect(statuses.map(status => status.tool)).toEqual(shared.EXTERNAL_ANALYZER_CANDIDATES.map(candidate => candidate.id));
    for (const failure of failures) expect(statuses.filter(status => status.tool === failure.tool)).toEqual([failure]);
  } finally { resolver.mockRestore(); }
});

test("status assembly rejects duplicate producers rather than silently deduplicating", async () => {
  const { vi } = await import("vitest");
  const failure = { tool: "gitleaks", resolved: false, status: "not_resolved" as const };
  const resolver = vi.spyOn(acquisitionEngine, "resolveBinaryCandidates").mockResolvedValue({ resolvedBinaries: {}, unresolvedStatuses: [failure, failure] });
  try {
    await expect(runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), process.cwd(), {
      enabled: true, deadline: { at: 0 },
    })).rejects.toThrow("duplicate analyzer status producer");
  } finally { resolver.mockRestore(); }
});

test("executor rejects missing binary statuses instead of silently omitting registry entries", async () => {
  const { vi } = await import("vitest");
  const resolver = vi.spyOn(acquisitionEngine, "resolveBinaryCandidates").mockResolvedValue({ resolvedBinaries: {}, unresolvedStatuses: [] });
  try {
    await expect(runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), process.cwd(), {
      enabled: true, deadline: { at: 0 },
    })).rejects.toThrow("missing analyzer status producer");
  } finally { resolver.mockRestore(); }
});

test("resolution and execution share the identical absolute deadline", async () => {
  const { vi } = await import("vitest");
  let time = 100;
  const now = vi.spyOn(Date, "now").mockImplementation(() => time);
  const deadline = { at: 200 };
  let spawns = 0;
  const resolver = vi.spyOn(acquisitionEngine, "resolveBinaryCandidates").mockImplementation(async (candidates, _root, options) => {
    expect(options?.deadline).toBe(deadline);
    time = 200;
    return {
      resolvedBinaries: { gitleaks: "/fixture/gitleaks" },
      unresolvedStatuses: candidates.filter(candidate => candidate.runner === "binary" && candidate.id !== "gitleaks")
        .map(candidate => ({ tool: candidate.id, resolved: false, status: "not_resolved" as const })),
    };
  });
  try {
    const result = await runExternalAnalyzerAcquisitionExecutor(bundleAfterIntake(), process.cwd(), {
      enabled: true, deadline,
      run: async argv => { spawns++; return { status: 0, stdout: "", stderr: "", argv, duration_ms: 0 }; },
    });
    expect(spawns).toBe(0);
    const statuses = result.updated.external_analyzer_acquisition!.tool_statuses;
    expect(statuses.filter(status => status.tool === "gitleaks")).toEqual([
      { tool: "gitleaks", resolved: false, status: "not_resolved", error: "deadline_exceeded: acquisition budget exhausted" },
    ]);
  } finally { resolver.mockRestore(); now.mockRestore(); }
});

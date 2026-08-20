// Acceptance coverage for the dispatch/ script family (CP-NODE-21,
// dispatch-scripts-test-reach). Before this suite, dispatch/** had zero test
// coverage and merge-results.mjs's four labelled invariants (INV-01
// array-payload expansion, fail-closed manifest, no-destructive-truncation,
// INV-03 non-zero partial-merge exit) were asserted only in comments —
// TST-094b5d9e / TST-094b5d9e-2 / TST-094b5d9e-3 / TST-1cb89b90. The scripts
// were restructured (this run, same work item) into importable cores plus
// byte-compatible CLI shims specifically so this suite could exist.
//
// UNIMPORTABLE-SINCE-467b1e8f regression: merge-results.mjs imported
// PACKET_SCHEMA_FILENAMES from dist/audit/io/runArtifacts.js, but that export
// (and its sole producer) was deleted in 467b1e8f ("retire the execution
// substrate: zero adapters, host-owned execution"), orphaning the import.
// ESM throws SyntaxError on a missing named export, so the whole module was
// unimportable — a defect that zero test coverage let ship silently.
//
// CAUGHT ONLY BY A REAL NODE SUBPROCESS, NOT BY VITEST'S OWN IMPORT: verified
// empirically re-deriving this red-green pass — vitest's Vite/esbuild
// transform resolves an UNUSED missing named export to `undefined` and does
// NOT throw, so a plain `import { mergeResults } from "../../dispatch/
// merge-results.mjs"` at the top of this file stays green even with the
// orphaned import reinstated (only the totally unrelated `mergeResults`
// export's own presence is what that kind of check can pin). Node's real
// ESM loader is strict about every named binding regardless of use, so the
// only test that actually reproduces the production failure mode spawns a
// real `node` subprocess and does the import there — below.
import { describe, test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import { mergeResults } from "../../dispatch/merge-results.mjs";
import { resolveArtifactsDir } from "../../dispatch/artifacts-dir.mjs";
import { validateResult } from "../../dispatch/validate.mjs";
import { validateOneResult, resolveTaskContext } from "../../dispatch/validate-result.mjs";
import {
  normalizeCoveragePath,
  validateAuditResults,
} from "../../src/audit/validation/auditResults.js";
import type { AuditTask } from "../../src/audit/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const MERGE_RESULTS_SCRIPT = join(REPO_ROOT, "dispatch", "merge-results.mjs");

// ── Fixture builders ────────────────────────────────────────────────────────
// A schema-valid AuditTask / AuditResult pair (required fields per
// schemas/audit_result.schema.json: task_id, unit_id, pass_id, lens,
// file_coverage [non-empty, path+total_lines], findings, plus
// reviewed_clean:true for a zero-findings result; validateResultIdentityFields
// (src/audit/validation/auditResults.ts) cross-checks unit_id/pass_id/lens
// against the matching task and iterates task.file_paths, which must be an
// array).
function fixtureTask(taskId: string) {
  return {
    task_id: taskId,
    unit_id: "U1",
    pass_id: "P1",
    lens: "correctness",
    file_paths: ["src/x.ts"],
    file_line_counts: { "src/x.ts": 10 },
  };
}
function fixtureResult(taskId: string) {
  return {
    task_id: taskId,
    unit_id: "U1",
    pass_id: "P1",
    lens: "correctness",
    file_coverage: [{ path: "src/x.ts", total_lines: 10 }],
    findings: [],
    reviewed_clean: true,
  };
}

async function seedRun(
  root: string,
  { runId = "R1", tasks, taskResults }: { runId?: string; tasks: unknown[]; taskResults?: Record<string, unknown> },
) {
  const artifactsDir = join(root, ".audit-tools", "audit");
  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  await mkdir(taskResultsDir, { recursive: true });
  await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify(tasks));
  for (const [filename, content] of Object.entries(taskResults ?? {})) {
    await writeFile(join(taskResultsDir, filename), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { artifactsDir, runDir, taskResultsDir };
}

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dispatch-validate-"));
}

// ── UNIMPORTABLE-SINCE-467b1e8f regression ─────────────────────────────────

describe("dispatch/merge-results.mjs is importable (467b1e8f orphaned-import regression)", () => {
  test("the module's own exports are present and callable (vitest-transformed import)", () => {
    // Necessary but NOT sufficient for the 467b1e8f class: this only pins
    // that mergeResults itself is exported, which an orphaned import of an
    // UNRELATED, unused symbol elsewhere in the file does not affect under
    // vitest's transform (see the native-subprocess test below for the
    // assertion that actually reproduces the production failure).
    expect(typeof mergeResults, "mergeResults must be an exported function").toBe("function");
  });

  test("importing merge-results.mjs never calls process.exit or prints CLI usage text (T-007 fix)", () => {
    // Before the CP-NODE-21 split, argv parsing and process.exit(1) ran at
    // module load time (dispatch/merge-results.mjs:7-11 pre-split), so
    // *importing* the module for a test executed the CLI's own "no --run-id"
    // usage branch. If that regressed, this process would already have
    // exited before this line ran.
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a real Node subprocess (native ESM, not vitest's transform) imports the module without a SyntaxError", () => {
    const moduleUrl = pathToFileURL(MERGE_RESULTS_SCRIPT).href;
    const proc = spawnSyncHidden(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(moduleUrl)}).then((m) => { ` +
          `if (typeof m.mergeResults !== "function") { console.error("mergeResults not exported"); process.exit(1); } ` +
          `});`,
      ],
      { encoding: "utf8" },
    );
    expect(proc.status, `native ESM import must succeed with no export missing: ${proc.stderr}`).toBe(0);
  });

  // RED-GREEN (inversion, verified against this repo's tree; see the amended
  // commit message for the transcript): reintroducing
  // `import { PACKET_SCHEMA_FILENAMES } from "../dist/audit/io/runArtifacts.js";`
  // into dispatch/merge-results.mjs (the import alone, unused, exactly as the
  // 467b1e8f-orphaned defect left it) leaves the first two tests above GREEN
  // — vitest's transform tolerates the missing binding since nothing reads
  // it — but turns the native-subprocess test RED with the real
  // `SyntaxError: The requested module '../dist/audit/io/runArtifacts.js'
  // does not provide an export named 'PACKET_SCHEMA_FILENAMES'`, and turns
  // both INV-03 CLI-spawn tests below RED too (their child process crashes
  // on the same SyntaxError before it can run at all). That three-test
  // spread is this suite's actual coverage of the T-007 defect class; a
  // plain in-process import assertion alone does not close it.
});

// ── INV-01: array-payload expansion ─────────────────────────────────────────

describe("mergeResults: INV-01 array-payload expansion", () => {
  test("a top-level AuditResult[] array is expanded into independently-judged candidates", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A"), fixtureTask("T-UNKNOWN-NEVER")],
        taskResults: {
          "pair.json": JSON.stringify([fixtureResult("T-A"), fixtureResult("T-FOREIGN")]),
        },
      });
      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;
      expect(result.passing.some((r: any) => r.task_id === "T-A"), "T-A from the array payload must pass").toBe(true);
      const foreignFailing = result.failing.find((f: any) => f.task_id === "T-FOREIGN");
      expect(foreignFailing, "T-FOREIGN from the array payload must be independently rejected").toBeTruthy();
      expect(foreignFailing.errors.some((e: string) => e.includes("Unknown task_id"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RED-GREEN (inversion): reverting `Array.isArray(parsed) ? parsed :
  // [parsed]` to always `[parsed]` makes this test fail — T-A no longer
  // passes, because the whole two-element array is instead treated as one
  // invalid object with no task_id. See the amended commit message for the
  // transcript.
});

// ── Fail-closed manifest ─────────────────────────────────────────────────────

describe("mergeResults: fail-closed unreadable manifest", () => {
  test("an unreadable pending-audit-tasks.json aborts BEFORE any write", async () => {
    const root = await freshRoot();
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const runDir = join(artifactsDir, "runs", "R1");
      await mkdir(join(runDir, "task-results"), { recursive: true });
      await writeFile(join(runDir, "pending-audit-tasks.json"), "{not valid json");

      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;

      expect(result.ok, "an unreadable manifest must report ok:false").toBe(false);
      expect(existsSync(join(runDir, "run-results.json")), "run-results.json must not be written").toBe(false);
      expect(existsSync(join(runDir, "failed-tasks.json")), "failed-tasks.json must not be written").toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RED-GREEN (inversion): reverting the catch block to swallow the parse
  // error and fall through to `tasks = []` makes this test fail — merge
  // proceeds with a fabricated empty manifest instead of aborting. See the
  // amended commit message for the transcript.
});

// ── No destructive truncation ────────────────────────────────────────────────

describe("mergeResults: no destructive truncation on a blocked re-run", () => {
  test("a zero-passing merge leaves a pre-existing run-results.json byte-identical", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir, runDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A")],
        taskResults: {}, // nothing on disk -> T-A is a missing-result failure, zero passing
      });
      const priorContent = JSON.stringify([{ task_id: "T-PRIOR", stale: true }], null, 2);
      await writeFile(join(runDir, "run-results.json"), priorContent);

      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;

      expect(result.passing.length, "this fixture must produce zero passing results").toBe(0);
      const after = await readFile(join(runDir, "run-results.json"), "utf8");
      expect(after, "a zero-passing merge must not overwrite/truncate a prior run-results.json").toBe(priorContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RED-GREEN (inversion): removing the `if (passing.length > 0)` guard
  // around the run-results.json write makes this test fail — the prior
  // content is unconditionally overwritten with `[]`. See the amended commit
  // message for the transcript.
});

// ── INV-03: non-zero exit on partial merge (real CLI spawn) ────────────────

describe("mergeResults: INV-03 non-zero exit on partial merge", () => {
  test("the core distinguishes passing from failing results (CLI exit code checked below)", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A"), fixtureTask("T-B")],
        taskResults: { "a.json": fixtureResult("T-A") }, // T-B has no result -> failing
      });
      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;
      expect(result.failing.length, "a missing result for T-B must be recorded as a failing entry").toBeGreaterThan(0);
      expect(result.passing.length, "T-A must still be accepted").toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the real CLI (node dispatch/merge-results.mjs) exits non-zero on a partial merge, with byte-compatible output", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A"), fixtureTask("T-B")],
        taskResults: { "a.json": fixtureResult("T-A") }, // T-B has no result -> partial merge
      });
      const proc = spawnSyncHidden(
        process.execPath,
        [MERGE_RESULTS_SCRIPT, "--run-id", "R1", "--artifacts-dir", artifactsDir],
        { encoding: "utf8" },
      );
      expect(proc.status, "a partial merge must exit non-zero").toBe(1);
      expect(proc.stderr).toContain("task(s) failed validation and were excluded");
      expect(proc.stderr).toContain("T-B: Missing audit result for assigned task.");
      expect(proc.stdout).toContain('"event":"merge_summary"');
      expect(proc.stdout).toMatch(/✓ 1\/2 tasks valid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the real CLI exits 0 on a clean merge (no failures)", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A")],
        taskResults: { "a.json": fixtureResult("T-A") },
      });
      const proc = spawnSyncHidden(
        process.execPath,
        [MERGE_RESULTS_SCRIPT, "--run-id", "R1", "--artifacts-dir", artifactsDir],
        { encoding: "utf8" },
      );
      expect(proc.status, "a clean merge must exit 0").toBe(0);
      expect(proc.stdout).toMatch(/✓ 1\/1 tasks valid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RED-GREEN (inversion): changing `process.exit(failing.length > 0 ? 1 :
  // 0)` to `process.exit(0)` makes the partial-merge CLI-spawn test above
  // fail — the real process now exits 0 against the identical fixture. See
  // the amended commit message for the transcript.
});

// ── Duplicate / unknown task_id / invalid JSON (fail-1..fail-4 coverage) ──

describe("mergeResults: acceptance rejection branches", () => {
  test("a duplicate task_id is rejected; the first on-disk result (by sorted filename) wins", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A")],
        taskResults: { "a1.json": fixtureResult("T-A"), "a2.json": fixtureResult("T-A") },
      });
      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;
      const dupFail = result.failing.find((f: any) => f.errors.some((e: string) => e.includes("Duplicate audit result")));
      expect(dupFail, "the second on-disk result for the same task_id must be rejected").toBeTruthy();
      expect(result.passing.length, "exactly one result must be accepted").toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown task_id is rejected and never merged into run-results.json", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A")],
        taskResults: { "foreign.json": fixtureResult("T-FOREIGN") },
      });
      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;
      const foreignFail = result.failing.find((f: any) => f.task_id === "T-FOREIGN");
      expect(foreignFail, "a foreign task_id must be rejected").toBeTruthy();
      expect(foreignFail.errors.some((e: string) => e.includes("Unknown task_id"))).toBe(true);
      expect(result.passing.length, "nothing must be accepted").toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unparseable task-results file is recorded as a failing entry keyed by filename", async () => {
    const root = await freshRoot();
    try {
      const { artifactsDir } = await seedRun(root, {
        tasks: [fixtureTask("T-A")],
        taskResults: { "broken.json": "{not json" },
      });
      const result = mergeResults({ artifactsDir, runId: "R1" }) as any;
      const brokenFail = result.failing.find((f: any) => f.task_id === "broken.json");
      expect(brokenFail, "an unparseable file must be recorded as a failing entry keyed by filename").toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── dispatch/validate.mjs, dispatch/artifacts-dir.mjs (already-importable) ──
// Both were already plain exported functions with no top-level side effects
// (needed no refactor); these pin their existing documented behavior.

describe("dispatch/validate.mjs: fail-closed no-task-context gate", () => {
  test("validateResult(resultObj, null) hard-fails without touching validateAuditResults", () => {
    const { valid, errors } = validateResult({ task_id: "X" }, null);
    expect(valid).toBe(false);
    expect(errors.some((e: string) => e.includes("fail-closed"))).toBe(true);
  });
});

describe("dispatch/artifacts-dir.mjs: resolveArtifactsDir", () => {
  test("resolves the documented default and honors --artifacts-dir override", async () => {
    const dflt = resolveArtifactsDir([]);
    expect(dflt.includes(".audit-tools")).toBe(true);

    const root = await freshRoot();
    try {
      const override = resolveArtifactsDir(["--artifacts-dir", join(root, "custom-dir")]);
      expect(override.endsWith("custom-dir")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── dispatch/validate-result.mjs: importable task-lookup seam ─────────────

describe("dispatch/validate-result.mjs: resolveTaskContext / validateOneResult", () => {
  test("resolveTaskContext resolves the real task from a readable manifest, no warning", async () => {
    const root = await freshRoot();
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const runDir = join(artifactsDir, "runs", "R1");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify([fixtureTask("T-A")]));

      const { task, warning } = await resolveTaskContext({ artifactsDir, runId: "R1", taskId: "T-A" });
      expect(warning).toBeUndefined();
      expect((task as any)?.task_id).toBe("T-A");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable manifest degrades to task:null plus a warning, never silently valid", async () => {
    const root = await freshRoot();
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const runDir = join(artifactsDir, "runs", "R1");
      await mkdir(join(runDir, "task-results"), { recursive: true });
      await writeFile(join(runDir, "task-results", "T-A.json"), JSON.stringify(fixtureResult("T-A")));
      await writeFile(join(runDir, "pending-audit-tasks.json"), "{not valid json");

      const result = await validateOneResult({ artifactsDir, runId: "R1", taskId: "T-A" });
      expect(result.ok, "the result file exists and parses; ok must be true").toBe(true);
      expect(result.warning).toContain("Could not read pending-audit-tasks.json");
      expect(result.valid, "task:null must hit validateResult's fail-closed branch, never report valid").toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("File not found is reported for a missing task-results file", async () => {
    const root = await freshRoot();
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const result = await validateOneResult({ artifactsDir, runId: "R1", taskId: "NOPE" });
      expect(result.ok).toBe(false);
      expect(result.fatal?.message).toContain("File not found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── INV-ACP-VALIDATE-RESULTS-SIGNATURE-PIN (audit-coverage-path-keyspace) ───
//
// dispatch/validate.mjs consumes validateAuditResults through the BUILT
// dist/audit/validation/auditResults.js as the sole authority for per-result
// validity, and merge-results routes accept/reject off that verdict. Two
// properties therefore have to be pinned at this module's own phase, in source,
// or a key-space change here silently changes what merge-results accepts:
//
//   1. the raw-vs-normalized path regime is INVISIBLE to the caller — a raw and
//      an already-normalized declared path for the same file yield an identical
//      verdict AND an identical reported line-count divergence; and
//   2. the exported SIGNATURE the script binds to — parameter arity 3
//      (results, tasks, options) and the returned verdict shape (an
//      AuditResultIssue[] whose entries carry `severity` / `path` / `message`,
//      the three fields validate.mjs reduces into `{ valid, errors }`).
describe("validateAuditResults: the signature and path regime dispatch/validate.mjs binds to", () => {
  const declaredResult = (totalLines: number) => [
    {
      task_id: "T-pin",
      unit_id: "U1",
      pass_id: "P1",
      lens: "correctness",
      file_coverage: [{ path: "src/x.ts", total_lines: totalLines }],
      findings: [
        {
          id: "f-pin",
          title: "T",
          category: "correctness",
          severity: "low",
          confidence: "high",
          lens: "correctness",
          summary: "S",
          affected_files: [{ path: "src/x.ts", line_start: 2, line_end: 6 }],
          evidence: ["e"],
        },
      ],
    },
  ];
  // The SAME underlying file, declared on the task in two surface forms.
  const taskWithPaths = (filePaths: string[]): AuditTask => ({
    task_id: "T-pin",
    unit_id: "U1",
    pass_id: "P1",
    lens: "correctness",
    file_paths: filePaths,
    file_line_counts: { "src/x.ts": 10 },
    rationale: "fixture",
  });
  const RAW_TASK = taskWithPaths([String.raw`src\x.ts`]);
  const NORM_TASK = taskWithPaths(["src/x.ts"]);
  // Exactly the reduction dispatch/validate.mjs performs over the return value.
  const verdictOf = (issues: ReturnType<typeof validateAuditResults>) => {
    const errors = issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`);
    return { valid: errors.length === 0, errors };
  };

  test("a raw and an already-normalized declared path give an IDENTICAL accept verdict", () => {
    const lineIndex = { "src/x.ts": 10 };
    const raw = validateAuditResults(declaredResult(10), [RAW_TASK], { lineIndex });
    const norm = validateAuditResults(declaredResult(10), [NORM_TASK], { lineIndex });

    expect(verdictOf(norm).valid, "the normalized control must accept").toBe(true);
    expect(
      verdictOf(raw),
      `raw and normalized task paths must produce the same verdict; raw was ${JSON.stringify(verdictOf(raw))}`,
    ).toEqual(verdictOf(norm));
    expect(raw, "the full issue list must be identical, warnings included").toEqual(norm);
  });

  test("a raw and an already-normalized declared path report an IDENTICAL line-count divergence", () => {
    // 40 declared vs 10 measured: past both the absolute floor and the ratio, so
    // the CE-009 gate is a hard reject in BOTH regimes or in neither.
    const lineIndex = { "src/x.ts": 10 };
    const raw = validateAuditResults(declaredResult(40), [RAW_TASK], { lineIndex });
    const norm = validateAuditResults(declaredResult(40), [NORM_TASK], { lineIndex });

    const divergence = (issues: ReturnType<typeof validateAuditResults>) =>
      issues.filter((i) => i.field === "file_coverage[0].total_lines");
    expect(divergence(norm).length, "the normalized control must report the divergence").toBe(1);
    expect(divergence(norm)[0].severity, "40 vs 10 is a significant divergence (CE-009 hard reject)").toBe("error");
    expect(
      divergence(raw),
      "the divergence report must not depend on the task path's surface form",
    ).toEqual(divergence(norm));
    expect(verdictOf(raw)).toEqual(verdictOf(norm));
    expect(raw, "the full issue list must be identical, warnings included").toEqual(norm);
  });

  test("normalizeCoveragePath is the one key-space function, and it is idempotent", () => {
    for (const raw of [String.raw`src\x.ts`, "./src/x.ts", String.raw`.\src\x.ts`, "src/./x.ts"]) {
      expect(normalizeCoveragePath(raw), `'${raw}' must land in the one key space`).toBe("src/x.ts");
      expect(
        normalizeCoveragePath(normalizeCoveragePath(raw)),
        "normalization must be idempotent — re-normalizing a key cannot move it",
      ).toBe("src/x.ts");
    }
  });

  test("the exported signature dispatch/validate.mjs binds to is unchanged", () => {
    // Arity: validate.mjs calls validateAuditResults(results, tasks, options).
    // `Function.length` counts only the parameters before the first defaulted
    // one, so the two REQUIRED positions are pinned by `.length`...
    expect(
      validateAuditResults.length,
      "validateAuditResults must take (results, tasks) as its required positions",
    ).toBe(2);
    // ...and the optional third position is pinned FUNCTIONALLY: dropping it
    // must lose the line-count check, so a caller that passes it and one that
    // does not cannot get the same verdict.
    const withOptions = validateAuditResults(declaredResult(40), [NORM_TASK], {
      lineIndex: NORM_TASK.file_line_counts ?? {},
    });
    const withoutOptions = validateAuditResults(declaredResult(40), [NORM_TASK]);
    expect(
      withOptions.some((i) => i.field === "file_coverage[0].total_lines"),
      "the third (options) parameter must still carry lineIndex into the line-count check",
    ).toBe(true);
    expect(
      withoutOptions.some((i) => i.field === "file_coverage[0].total_lines"),
      "with no lineIndex there is no expectation to diverge from",
    ).toBe(false);

    const issues = withOptions;
    // Verdict shape: an ARRAY of issues, each carrying the three fields the
    // script reduces over. A shape change here is a silent merge-results break.
    expect(Array.isArray(issues), "the verdict must be an array of issues").toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.severity, "each issue must carry a string severity").toBe("string");
      expect(["error", "warning"]).toContain(issue.severity);
      expect(typeof issue.path, "each issue must carry a string path (validate.mjs prints it)").toBe("string");
      expect(typeof issue.message, "each issue must carry a string message").toBe("string");
    }
    // And the reduction validate.mjs performs still produces its documented shape.
    const verdict = verdictOf(issues);
    expect(typeof verdict.valid).toBe("boolean");
    expect(Array.isArray(verdict.errors)).toBe(true);
    expect(verdict.errors.every((e) => typeof e === "string")).toBe(true);
  });
});

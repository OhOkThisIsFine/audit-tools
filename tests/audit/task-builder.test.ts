import { test, expect } from "vitest";
import type { CoverageFileRecord, CoverageMatrix } from "../../src/audit/types.js";
import type { CriticalFlowManifest } from "audit-tools/shared";
import { autoCompleteTrivialCoverage } from "../../src/audit/orchestrator/trivialAudit.js";
import { UNMEASURED_LINE_COUNT } from "../../src/audit/cli/lineIndex.js";

const { buildChunkedAuditTasks } = await import("../../src/audit/orchestrator/taskBuilder.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CoverageMatrix file entry that is pending (not excluded,
 * no completed lenses).
 */
function pendingFile(path: string, lenses: string[] = ["correctness"]): CoverageFileRecord {
  return {
    path,
    classification_status: "classified",
    audit_status: "pending",
    required_lenses: lenses,
    completed_lenses: [],
    unit_ids: ["unit-1"],
  };
}

function makeCoverage(files: CoverageFileRecord[]): CoverageMatrix {
  return { files };
}

// ---------------------------------------------------------------------------
// DEFAULT_MAX_TASK_FILES = 0 (disabled)
// ---------------------------------------------------------------------------

test("DEFAULT_MAX_TASK_FILES is 0: 20-file unit produces a single task (not split by count)", () => {
  const files = Array.from({ length: 20 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  // Give each file 10 lines so they are not trivial (isTrivialAuditPath skips 0-line files)
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 10]));
  // 20 files × 10 lines = 200 lines total, well under max_task_lines=3000, so no line-budget split
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const corrTasks = tasks.filter((t) => t.lens === "correctness");
  expect(corrTasks.length, "should produce exactly 1 task for 20 small-line files").toBe(1);
  expect(corrTasks[0].file_paths.length).toBe(20);
});

test("DEFAULT_MAX_TASK_FILES=0 does not split; explicit max_task_files=5 does split", () => {
  const files = Array.from({ length: 10 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 10]));

  // Default: no file-count split
  const defaultTasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const defaultCorr = defaultTasks.filter((t) => t.lens === "correctness");
  expect(defaultCorr.length, "default: 10 files → 1 task").toBe(1);

  // Explicit cap: split by 5
  const cappedTasks = buildChunkedAuditTasks(coverage, lineIndex, { max_task_files: 5 });
  const cappedCorr = cappedTasks.filter((t) => t.lens === "correctness");
  expect(cappedCorr.length >= 2, "capped: 10 files / 5 → at least 2 tasks").toBeTruthy();
});

test("buildChunkedAuditTasks still splits when max_task_lines is exceeded", () => {
  // 5 files each 1000 lines; default max_task_lines = 3000 → should split into 2 tasks
  const files = Array.from({ length: 5 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 1000]));
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const corrTasks = tasks.filter((t) => t.lens === "correctness");
  // 5000 total lines, 3000 budget → must produce > 1 task
  expect(corrTasks.length > 1, `line-budget split should produce >1 task; got ${corrTasks.length}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// intent_priority_boost elevates task priority by one tier
// ---------------------------------------------------------------------------

test("intent_priority_boost: low lens (architecture) → medium when boosted", () => {
  const files = [pendingFile("src/a.ts", ["architecture"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/a.ts": 100 };

  const unboosted = buildChunkedAuditTasks(coverage, lineIndex, {});
  const archUnboosted = unboosted.filter((t) => t.lens === "architecture");
  expect(archUnboosted.length > 0, "should have architecture task").toBeTruthy();
  expect(archUnboosted[0].priority, "architecture without boost should be low").toBe("low");

  const boosted = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["architecture"] });
  const archBoosted = boosted.filter((t) => t.lens === "architecture");
  expect(archBoosted.length > 0, "should have architecture task after boost").toBeTruthy();
  expect(archBoosted[0].priority, "architecture boosted should become medium").toBe("medium");
});

test("intent_priority_boost: medium lens (security) → high when boosted", () => {
  const files = [pendingFile("src/auth.ts", ["security"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/auth.ts": 100 };

  const unboosted = buildChunkedAuditTasks(coverage, lineIndex, {});
  const secUnboosted = unboosted.filter((t) => t.lens === "security");
  expect(secUnboosted.length > 0, "should have security task").toBeTruthy();
  // security without external signal → medium
  expect(secUnboosted[0].priority, "security without signal should be medium").toBe("medium");

  const boosted = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["security"] });
  const secBoosted = boosted.filter((t) => t.lens === "security");
  expect(secBoosted.length > 0, "should have security task after boost").toBeTruthy();
  expect(secBoosted[0].priority, "security boosted from medium → high").toBe("high");
});

test("intent_priority_boost: high lens stays high (no promotion above high)", () => {
  // security with external analyzer signal → already high; boosting should keep it high
  const files = [pendingFile("src/auth.ts", ["security"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/auth.ts": 100 };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {
    intent_priority_boost: ["security"],
    external_analyzer_results: [{
      tool: "semgrep",
      results: [{
        id: "r1",
        path: "src/auth.ts",
        category: "security",
        summary: "SQL injection",
        severity: "high",
      }],
    }],
  });
  const secTasks = tasks.filter((t) => t.lens === "security");
  expect(secTasks.length > 0, "should have security task").toBeTruthy();
  expect(secTasks[0].priority, "already high should stay high").toBe("high");
});

test("intent_priority_boost: unrelated lens not in boost list is unaffected", () => {
  const files = [
    pendingFile("src/a.ts", ["architecture"]),
    pendingFile("src/b.ts", ["security"]),
  ];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/a.ts": 100, "src/b.ts": 100 };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["security"] });
  const archTask = tasks.find((t) => t.lens === "architecture");
  expect(archTask, "architecture task should exist").toBeTruthy();
  expect(archTask!.priority, "architecture should remain low when not in boost list").toBe("low");
});

// ---------------------------------------------------------------------------
// OBL-audit-coverage-path-keyspace-inv-2 / fail-2 / fail-3 — an UNMEASURED line
// count is not a zero line count, exercised on the REAL pipeline path
// ---------------------------------------------------------------------------

test("an UNMEASURED file survives the real autoComplete-then-build sequence and earns a tagged task", () => {
  // THE DECISION SITE IS UPSTREAM. planningExecutors runs
  // autoCompleteTrivialCoverage BEFORE buildChunkedAuditTasks, and that pass
  // used its own `lineIndex[path] ?? 0` to mark an unmeasured file
  // `audit_status: "excluded"`. Any leniency in buildPendingByLens alone is
  // therefore UNREACHABLE — its own excluded-guard skips the file first. This
  // test replicates the real sequence on ONE matrix so a fix that only touches
  // the task builder cannot pass it.
  //
  // "Unmeasured" arrives in TWO shapes, and both are covered because they fail
  // DIFFERENTLY under the old code. The reachable one is the SENTINEL —
  // buildLineIndex emits an entry for every manifest path and writes
  // UNMEASURED_LINE_COUNT when the read fails — which a `?? 0` does NOT catch
  // (NaN is not nullish), so only an unmeasured-aware predicate saves it. The
  // rarer ABSENT key is precisely what `?? 0` turns into a zero, so it is the
  // shape that makes each removed coercion load-bearing.
  // Distinct unit_ids on the two unmeasured files on purpose: the lead tag is
  // applied per emitted task, so grouping them into ONE task would let either
  // file's tag satisfy the other's assertion and hide a fix that only handles
  // one of the two shapes.
  const coverage = makeCoverage([
    { ...pendingFile("src/unmeasured-sentinel.ts", ["correctness"]), unit_ids: ["unit-sentinel"] },
    { ...pendingFile("src/unmeasured-absent.ts", ["correctness"]), unit_ids: ["unit-absent"] },
    pendingFile("src/genuinely-empty.ts", ["correctness"]),
    pendingFile(".gitignore", ["correctness"]),
  ]);
  const lineIndex = {
    "src/unmeasured-sentinel.ts": UNMEASURED_LINE_COUNT,
    // "src/unmeasured-absent.ts" — deliberately no key at all.
    "src/genuinely-empty.ts": 0,
    ".gitignore": UNMEASURED_LINE_COUNT,
  };

  const skipped = autoCompleteTrivialCoverage(coverage, lineIndex);

  for (const path of ["src/unmeasured-sentinel.ts", "src/unmeasured-absent.ts"]) {
    expect(
      skipped.includes(path),
      `'${path}' must NOT be excluded from coverage — nobody measured it, which is not the same as it being empty`,
    ).toBe(false);
  }
  expect(
    skipped.includes("src/genuinely-empty.ts"),
    "a MEASURED zero-line file is genuinely trivial and must still be excluded",
  ).toBe(true);
  expect(
    skipped.includes(".gitignore"),
    "an unmeasured DOTFILE is still trivial by NAME — withholding the size rules must not withhold the path rules",
  ).toBe(true);

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});

  for (const path of ["src/unmeasured-sentinel.ts", "src/unmeasured-absent.ts"]) {
    const covering = tasks.filter((t) => t.file_paths.includes(path));
    expect(
      covering.length,
      `'${path}' must reach a real task — never a silent, permanent coverage hole`,
    ).toBeGreaterThan(0);
    expect(
      covering.every((t) => (t.tags ?? []).includes("unmeasured_line_count")),
      `'${path}' must carry the explicit unmeasured lead tag; got tags ${JSON.stringify(covering.map((t) => t.tags))}`,
    ).toBe(true);
  }
  expect(
    tasks.some((t) => t.file_paths.includes("src/genuinely-empty.ts")),
    "a measured zero-line file stays excluded",
  ).toBe(false);
  expect(
    tasks.some((t) => t.file_paths.includes(".gitignore")),
    "an unmeasured dotfile stays excluded",
  ).toBe(false);
});

test("an unmeasured file does not poison the line budget or masquerade as a tiny test", () => {
  // The sentinel is NaN. Letting it into the budget total makes every
  // `cost > budget` comparison false, so the greedy chunker silently stops
  // splitting; treating it as 0 in the tiny-test check would batch a file whose
  // size nobody knows into the tiny-test unit. Neither may happen.
  const coverage = makeCoverage([
    pendingFile("tests/unmeasured-sentinel.test.ts", ["tests"]),
    pendingFile("tests/unmeasured-absent.test.ts", ["tests"]),
    pendingFile("tests/small.test.ts", ["tests"]),
  ]);
  const lineIndex = {
    "tests/unmeasured-sentinel.test.ts": UNMEASURED_LINE_COUNT,
    // "tests/unmeasured-absent.test.ts" — deliberately no key at all.
    "tests/small.test.ts": 10,
  };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});

  const smallTask = tasks.find((t) => t.file_paths.includes("tests/small.test.ts"));
  expect(smallTask, "the measured tiny test file must still get a task").toBeTruthy();
  expect(
    smallTask!.unit_id,
    "a MEASURED tiny test file is batched into the tiny-test unit",
  ).toBe("tests-tiny-files");

  for (const path of [
    "tests/unmeasured-sentinel.test.ts",
    "tests/unmeasured-absent.test.ts",
  ]) {
    const task = tasks.find((t) => t.file_paths.includes(path));
    expect(task, `'${path}' must still get a task`).toBeTruthy();
    expect(
      task!.unit_id,
      `'${path}' is not known-small and must not be batched as a tiny test`,
    ).not.toBe("tests-tiny-files");
  }
});

// ---------------------------------------------------------------------------
// OBL-audit-coverage-path-keyspace-inv-4 — ONE KEY SPACE is satisfied at the
// VALIDATION join, not by re-keying copies here.
//
// There is deliberately NO test asserting that buildChunkedAuditTasks
// normalizes coverage / line-index / flow paths, because it deliberately does
// NOT. Those three descend from the same posix-normal repo manifest and are one
// key space at the source; re-keying copies of them here would leave the
// PERSISTED matrix, the persisted line index and result ingestion
// (applyFileCoverage) on the original strings — a second key space with no live
// route to close. The one genuinely foreign path surface (a worker-supplied
// string copied into a followup task's file_paths) enters at validation, and
// the normalization that closes it is pinned there:
// tests/audit/validation-remediation.test.ts and
// tests/audit/dispatch-validate.test.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OBL-audit-coverage-path-keyspace-inv-4 — the flow-claim contract cutover
// ---------------------------------------------------------------------------

test("flow-claimed paths are excluded from the remainder pass via the RETURNED claim contract, not by-reference mutation", () => {
  // claimFlowReviewBlocks no longer writes back into the caller's `assigned`
  // set or `pendingByLens` map (both are ReadonlySet/ReadonlyMap parameters);
  // buildChunkedAuditTasks must consume `result.assigned` / `result.pending`.
  // Reading the pre-claim arguments instead re-emits every flow-claimed path as
  // a remainder task — an observable DOUBLE CLAIM of the same lens:path.
  const coverage = makeCoverage([
    pendingFile("src/claimed.ts", ["security"]),
    pendingFile("src/unclaimed.ts", ["security"]),
  ]);
  const lineIndex = { "src/claimed.ts": 80, "src/unclaimed.ts": 80 };
  const criticalFlows: CriticalFlowManifest = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/claimed.ts"],
        entrypoints: ["src/claimed.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, { critical_flows: criticalFlows });

  const claimedTasks = tasks.filter(
    (t) => t.lens === "security" && t.file_paths.includes("src/claimed.ts"),
  );
  expect(
    claimedTasks.length,
    `src/claimed.ts must be reviewed under 'security' exactly once; got ${JSON.stringify(claimedTasks.map((t) => t.task_id))}`,
  ).toBe(1);
  expect(
    (claimedTasks[0].tags ?? []).includes("critical_flow"),
    "the single claim must be the critical-flow block",
  ).toBe(true);

  // MISSING-CLAIM half: the unclaimed sibling must still reach a remainder task.
  const unclaimedTasks = tasks.filter(
    (t) => t.lens === "security" && t.file_paths.includes("src/unclaimed.ts"),
  );
  expect(
    unclaimedTasks.length,
    "a path no flow claimed must still be emitted by the remainder pass",
  ).toBe(1);
  expect(
    (unclaimedTasks[0].tags ?? []).includes("critical_flow"),
    "the remainder task must not be tagged as a flow claim",
  ).toBe(false);
});

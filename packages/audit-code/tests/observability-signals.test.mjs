import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const { checkFileIntegrity } = await import("../src/orchestrator/fileIntegrity.ts");
const { normalizeGenericExternalResults } = await import(
  "../src/adapters/normalizeExternal.ts"
);
const { runCommand } = await import("../src/orchestrator/runtimeCommand.ts");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function manifest(files) {
  return {
    repository: { name: "t" },
    generated_at: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      language: "ts",
      size_bytes: 1,
      hash: f.hash,
    })),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-code-obs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Silence (and capture) process.stderr.write for a single async body. */
async function withCapturedStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return await fn(lines);
  } finally {
    process.stderr.write = original;
  }
}

// ── checkFileIntegrity: I/O-error vs missing classification (OBS-005) ────────

test("checkFileIntegrity reports an unreadable-but-present file via io_errors, not missing", async () => {
  await withTempDir(async (dir) => {
    // A directory at the manifest path exists on disk (existsSync is true) but
    // readFile throws a non-ENOENT error (EISDIR/EPERM); it must land in
    // io_errors, NOT missing_files.
    const rel = "as-a-dir";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    assert.deepEqual(result.io_errors, [rel]);
    assert.deepEqual(result.missing_files, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity reports an absent file as missing, not io_errors", async () => {
  await withTempDir(async (dir) => {
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: "does-not-exist.ts", hash: "deadbeef" }]),
    );
    assert.deepEqual(result.missing_files, ["does-not-exist.ts"]);
    assert.deepEqual(result.io_errors, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity is_clean is false whenever io_errors is non-empty", async () => {
  await withTempDir(async (dir) => {
    const rel = "dir-path";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    assert.ok(result.io_errors.length > 0);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity reports a content change in changed_files, not missing/io_errors", async () => {
  await withTempDir(async (dir) => {
    const rel = "changed.ts";
    await writeFile(join(dir, rel), "modified", "utf8");
    // hash recorded at manifest time differs from current content
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: rel, hash: sha256("original") }]),
    );
    assert.deepEqual(result.changed_files, [rel]);
    assert.deepEqual(result.missing_files, []);
    assert.deepEqual(result.io_errors, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity is_clean when current content matches the manifest hash", async () => {
  await withTempDir(async (dir) => {
    const rel = "stable.ts";
    await writeFile(join(dir, rel), "v1", "utf8");
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: rel, hash: sha256("v1") }]),
    );
    assert.equal(result.is_clean, true);
  });
});

// ── normalizeGenericExternalResults: dropped-item signal (OBS-003) ───────────

test("normalizeGenericExternalResults drops items missing path/summary and logs the count", async () => {
  const lines = [];
  const result = await withCapturedStderr(async (captured) => {
    const out = normalizeGenericExternalResults("semgrep", [
      { path: "a.ts", summary: "finding A" },
      { path: "b.ts" }, // missing summary -> dropped
      { summary: "no path" }, // missing path -> dropped
      { path: "c.ts", summary: "finding C" },
    ]);
    lines.push(...captured);
    return out;
  });
  // Existing behavior preserved: only the two valid items survive.
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    result.results.map((r) => r.path),
    ["a.ts", "c.ts"],
  );
  // Structured drop log emitted with the correct count.
  const dropLine = lines.find((l) => l.includes("normalizeExternal: dropped"));
  assert.ok(dropLine, "expected a dropped-item stderr line");
  assert.match(dropLine, /dropped 2\/4 semgrep finding\(s\) missing path or summary/);
});

test("normalizeGenericExternalResults emits no drop log when nothing is dropped", async () => {
  const lines = [];
  await withCapturedStderr(async (captured) => {
    normalizeGenericExternalResults("eslint", [
      { path: "a.ts", summary: "A" },
      { path: "b.ts", summary: "B" },
    ]);
    lines.push(...captured);
  });
  assert.equal(
    lines.some((l) => l.includes("normalizeExternal: dropped")),
    false,
  );
});

// ── buildLineIndex / buildLineIndexForPaths: warn on unreadable file (OBS-2cc9cf82) ──

const { buildLineIndex, buildLineIndexForPaths } = await import(
  "../src/cli/lineIndex.ts"
);

test("buildLineIndex warns on unreadable file and returns 0 for that entry", async () => {
  await withTempDir(async (dir) => {
    const validFile = "valid.ts";
    await writeFile(join(dir, validFile), "line1\nline2\nline3\n", "utf8");

    const manifest = {
      repository: { name: "t" },
      generated_at: new Date().toISOString(),
      files: [
        { path: validFile, language: "ts", size_bytes: 18, hash: "abc" },
        { path: "does-not-exist.ts", language: "ts", size_bytes: 0, hash: "000" },
      ],
    };

    let result;
    const stderrLines = [];
    await withCapturedStderr(async (lines) => {
      result = await buildLineIndex(dir, manifest);
      stderrLines.push(...lines);
    });

    // Non-existent file falls back to 0 line count.
    assert.equal(result["does-not-exist.ts"], 0);
    // Valid file still has the correct count.
    assert.ok(result[validFile] > 0, "valid file should have a positive line count");
    // A stderr diagnostic was emitted containing the failing path and an error message.
    const warnLine = stderrLines.find((l) => l.includes("does-not-exist.ts"));
    assert.ok(warnLine, "expected a stderr diagnostic for the unreadable file");
    assert.match(warnLine, /\[lineIndex\]/);
  });
});

test("buildLineIndexForPaths warns on unreadable file and returns 0 for that entry", async () => {
  await withTempDir(async (dir) => {
    const validFile = "module.ts";
    await writeFile(join(dir, validFile), "a\nb\n", "utf8");

    let result;
    const stderrLines = [];
    await withCapturedStderr(async (lines) => {
      result = await buildLineIndexForPaths(dir, [validFile, "ghost.ts"]);
      stderrLines.push(...lines);
    });

    // Non-existent path falls back to 0.
    assert.equal(result["ghost.ts"], 0);
    // Valid path has a correct count.
    assert.ok(result[validFile] > 0, "valid file should have a positive line count");
    // A stderr diagnostic was emitted containing the failing path.
    const warnLine = stderrLines.find((l) => l.includes("ghost.ts"));
    assert.ok(warnLine, "expected a stderr diagnostic for the unreadable path");
    assert.match(warnLine, /\[lineIndex\]/);
  });
});

// ── runCommand error event: accumulated output in evidence (OBS-99c970ca) ─────

test("runCommand error event with no prior output returns empty evidence", async () => {
  // Spawn a command that cannot exist on any platform; the OS fires an error
  // event immediately (ENOENT), with no stdout/stderr having arrived yet.
  const result = await runCommand(
    ["__audit_code_nonexistent_command_xyz__"],
    process.cwd(),
  );
  assert.equal(result.status, "inconclusive", "status is inconclusive on spawn error");
  assert.match(result.summary, /Failed to execute/, "summary says 'Failed to execute'");
  assert.match(
    result.summary,
    /__audit_code_nonexistent_command_xyz__/,
    "summary includes the failing command",
  );
  assert.deepEqual(result.evidence, [], "evidence is empty when no output was captured");
});

test("runCommand error event summary includes the OS error message", async () => {
  const result = await runCommand(["__audit_code_nonexistent_42__"], process.cwd());
  assert.equal(result.status, "inconclusive");
  assert.ok(result.summary.length > 0, "summary is non-empty");
  assert.ok(
    result.summary.includes("__audit_code_nonexistent_42__"),
    "summary embeds the command name",
  );
});

// ── ExecutorRunResult structured observability fields (OBS-d202e206) ──────────
// These are runtime-shape checks: verify the optional fields are accepted by
// constructing plain objects and checking they satisfy the expected structure.

test("ExecutorRunResult accepts log_entries with all severity levels", async () => {
  /** @type {import("../src/orchestrator/executorResult.ts").LogEntry[]} */
  const entries = [
    { severity: "debug", message: "debug msg", timestamp_ms: 1 },
    { severity: "info", message: "info msg", timestamp_ms: 2 },
    { severity: "warn", message: "warn msg", timestamp_ms: 3 },
    { severity: "error", message: "error msg", timestamp_ms: 4, context: { task_id: "t1", run_id: "r1" } },
  ];
  for (const e of entries) {
    assert.ok(typeof e.severity === "string", "severity is a string");
    assert.ok(typeof e.message === "string", "message is a string");
    assert.ok(typeof e.timestamp_ms === "number", "timestamp_ms is a number");
  }
  // LogEntry with a context object satisfies the type.
  const withCtx = entries[3];
  assert.ok(withCtx.context !== undefined, "context is present");
  assert.equal(withCtx.context.task_id, "t1");
});

test("ExecutorRunResult accepts optional step_duration_ms and degraded fields", async () => {
  // A minimal valid result omitting optional fields.
  const minimal = { updated: {}, artifacts_written: [], progress_summary: "ok" };
  assert.ok(minimal.step_duration_ms === undefined, "step_duration_ms is optional");
  assert.ok(minimal.degraded === undefined, "degraded is optional");

  // With the new fields populated.
  const full = { ...minimal, step_duration_ms: 0, degraded: false };
  assert.equal(full.step_duration_ms, 0);
  assert.equal(full.degraded, false);

  // degraded: true is valid.
  const partial = { ...minimal, degraded: true };
  assert.equal(partial.degraded, true);
});

// ── runRuntimeValidationExecutor: deduplication counters in progress_summary (OBS-24ba5c5e) ──

const { runRuntimeValidationExecutor } = await import(
  "../src/orchestrator/ingestionExecutors.ts"
);

/**
 * Build a minimal ArtifactBundle with runtime_validation_tasks for counter tests.
 * Tasks are given `command` fields so the deduplication path is exercised.
 */
function makeRvBundle(tasks) {
  return {
    runtime_validation_tasks: { tasks },
    runtime_validation_report: undefined,
    audit_results: [],
    audit_tasks: undefined,
    coverage_matrix: undefined,
    critical_flows: undefined,
    flow_coverage: undefined,
    unit_manifest: undefined,
    repo_manifest: undefined,
    graph_bundle: undefined,
    external_analyzer_results: undefined,
    audit_plan_metrics: undefined,
    requeue_tasks: undefined,
    audit_report: undefined,
    file_disposition: undefined,
    surface_manifest: undefined,
  };
}

function makeRvTask(id, command) {
  return {
    id,
    kind: "unit-risk-check",
    target_paths: [`src/${id}.ts`],
    reason: "test",
    priority: "low",
    command,
  };
}

test("runRuntimeValidationExecutor progress_summary includes unique-command and deduplication-hit counts", async () => {
  await withTempDir(async (dir) => {
    // Two tasks share the same command; one task has a unique command.
    const sharedCommand = ["node", "--version"];
    const uniqueCommand = ["node", "-e", "process.exit(0)"];
    const bundle = makeRvBundle([
      makeRvTask("t1", sharedCommand),
      makeRvTask("t2", sharedCommand), // same signature → dedup hit
      makeRvTask("t3", uniqueCommand),
    ]);

    const result = await runRuntimeValidationExecutor(bundle, dir);

    // 3 total tasks, 2 unique command signatures (sharedCommand + uniqueCommand), 1 dedup hit.
    assert.match(
      result.progress_summary,
      /3 task\(s\)/,
      "summary mentions total task count",
    );
    assert.match(
      result.progress_summary,
      /2 unique command\(s\) run/,
      "summary mentions uniqueCommandsRun = 2",
    );
    assert.match(
      result.progress_summary,
      /1 served from deduplication cache/,
      "summary mentions deduplicatedHits = 1",
    );
  });
});

test("runRuntimeValidationExecutor: all distinct commands → deduplicatedHits is 0", async () => {
  await withTempDir(async (dir) => {
    const bundle = makeRvBundle([
      makeRvTask("t1", ["node", "--version"]),
      makeRvTask("t2", ["node", "-e", "process.exit(0)"]),
    ]);

    const result = await runRuntimeValidationExecutor(bundle, dir);

    assert.match(
      result.progress_summary,
      /2 unique command\(s\) run/,
      "both commands are unique",
    );
    assert.match(
      result.progress_summary,
      /0 served from deduplication cache/,
      "no dedup hits",
    );
  });
});

test("runRuntimeValidationExecutor: all tasks share one command → uniqueCommandsRun is 1", async () => {
  await withTempDir(async (dir) => {
    const sharedCommand = ["node", "--version"];
    const bundle = makeRvBundle([
      makeRvTask("t1", sharedCommand),
      makeRvTask("t2", sharedCommand),
      makeRvTask("t3", sharedCommand),
    ]);

    const result = await runRuntimeValidationExecutor(bundle, dir);

    assert.match(
      result.progress_summary,
      /3 task\(s\)/,
      "summary mentions total task count",
    );
    assert.match(
      result.progress_summary,
      /1 unique command\(s\) run/,
      "only 1 unique command",
    );
    assert.match(
      result.progress_summary,
      /2 served from deduplication cache/,
      "task count minus 1 are dedup hits",
    );
  });
});

// ── OBS-159522c2: packet-planning debug traces ────────────────────────────────

const { unionFindFromGroups } = await import(
  "../src/orchestrator/reviewPacketGraph.ts"
);
const { buildReviewPackets: buildReviewPacketsForObs } = await import(
  "../src/orchestrator/reviewPackets.ts"
);

function makeObsTask(task_id, unit_id, file_paths, lens = "correctness", overrides = {}) {
  return {
    task_id,
    unit_id,
    pass_id: `pass:${lens}`,
    lens,
    file_paths,
    rationale: "test",
    priority: "medium",
    ...overrides,
  };
}

test("unionFindFromGroups emits shared-file merge trace when AUDIT_CODE_VERBOSE is set", async () => {
  const prevVerbose = process.env.AUDIT_CODE_VERBOSE;
  process.env.AUDIT_CODE_VERBOSE = "1";
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    // Two groups that share a file — shared-file pass must union them.
    const groups = new Map([
      ["g1", [makeObsTask("t1", "u1", ["src/shared.ts", "src/a.ts"])]],
      ["g2", [makeObsTask("t2", "u2", ["src/shared.ts", "src/b.ts"])]],
    ]);
    unionFindFromGroups(groups, []);
    const mergeLines = stderrLines.filter((l) =>
      l.includes("[audit-code:packet-planning]") && l.includes("shared-file merge"),
    );
    assert.ok(mergeLines.length > 0, "expected at least one shared-file merge trace line");
    assert.ok(
      mergeLines.some((l) => l.includes("g1") || l.includes("g2")),
      "merge trace should mention the merged group keys",
    );
  } finally {
    process.stderr.write = origWrite;
    if (prevVerbose === undefined) {
      delete process.env.AUDIT_CODE_VERBOSE;
    } else {
      process.env.AUDIT_CODE_VERBOSE = prevVerbose;
    }
  }
});

test("unionFindFromGroups emits edge-driven merge trace when AUDIT_CODE_VERBOSE is set", async () => {
  const prevVerbose = process.env.AUDIT_CODE_VERBOSE;
  process.env.AUDIT_CODE_VERBOSE = "1";
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    // Two groups with disjoint files connected by a graph edge.
    const groups = new Map([
      ["g1", [makeObsTask("t1", "u1", ["src/a.ts"])]],
      ["g2", [makeObsTask("t2", "u2", ["src/b.ts"])]],
    ]);
    const edge = { from: "src/a.ts", to: "src/b.ts", kind: "import", confidence: 0.9 };
    unionFindFromGroups(groups, [edge]);
    const edgeLines = stderrLines.filter((l) =>
      l.includes("[audit-code:packet-planning]") && l.includes("edge-driven merge"),
    );
    assert.ok(edgeLines.length > 0, "expected at least one edge-driven merge trace line");
  } finally {
    process.stderr.write = origWrite;
    if (prevVerbose === undefined) {
      delete process.env.AUDIT_CODE_VERBOSE;
    } else {
      process.env.AUDIT_CODE_VERBOSE = prevVerbose;
    }
  }
});

test("unionFindFromGroups emits no stderr when AUDIT_CODE_VERBOSE is unset", async () => {
  const prevVerbose = process.env.AUDIT_CODE_VERBOSE;
  delete process.env.AUDIT_CODE_VERBOSE;
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    const groups = new Map([
      ["g1", [makeObsTask("t1", "u1", ["src/shared.ts", "src/a.ts"])]],
      ["g2", [makeObsTask("t2", "u2", ["src/shared.ts", "src/b.ts"])]],
    ]);
    unionFindFromGroups(groups, []);
    const planningLines = stderrLines.filter((l) =>
      l.includes("[audit-code:packet-planning]"),
    );
    assert.equal(planningLines.length, 0, "no packet-planning traces without AUDIT_CODE_VERBOSE");
  } finally {
    process.stderr.write = origWrite;
    if (prevVerbose === undefined) {
      delete process.env.AUDIT_CODE_VERBOSE;
    } else {
      process.env.AUDIT_CODE_VERBOSE = prevVerbose;
    }
  }
});

test("chunkPacketTasks emits token-budget split trace when AUDIT_CODE_VERBOSE is set", async () => {
  const prevVerbose = process.env.AUDIT_CODE_VERBOSE;
  process.env.AUDIT_CODE_VERBOSE = "1";
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    // Two tasks that share the SAME multi-file signature so they land in one
    // packet group (packetGroupingKey = unit_id + file signature). Each lists
    // two files (length > 1) so neither trips the isolated-large-file path;
    // accumulating the second task pushes the candidate over the token budget,
    // firing the token-budget split branch. targetPacketTokens=1 guarantees the
    // overflow on the second task.
    const tasks = [
      makeObsTask("t1", "u1", ["src/a.ts", "src/b.ts"], "correctness", {
        file_line_counts: { "src/a.ts": 100, "src/b.ts": 100 },
      }),
      makeObsTask("t2", "u1", ["src/a.ts", "src/b.ts"], "security", {
        file_line_counts: { "src/a.ts": 100, "src/b.ts": 100 },
      }),
    ];
    buildReviewPacketsForObs(tasks, { targetPacketTokens: 1 });
    const splitLines = stderrLines.filter((l) =>
      l.includes("[audit-code:packet-planning]") && l.includes("token-budget split"),
    );
    assert.ok(splitLines.length > 0, "expected at least one token-budget split trace");
    assert.ok(
      splitLines.some((l) => l.includes("targetPacketTokens=1")),
      "split trace should include targetPacketTokens",
    );
  } finally {
    process.stderr.write = origWrite;
    if (prevVerbose === undefined) {
      delete process.env.AUDIT_CODE_VERBOSE;
    } else {
      process.env.AUDIT_CODE_VERBOSE = prevVerbose;
    }
  }
});

test("chunkPacketTasks emits no stderr when AUDIT_CODE_VERBOSE is unset", async () => {
  const prevVerbose = process.env.AUDIT_CODE_VERBOSE;
  delete process.env.AUDIT_CODE_VERBOSE;
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    const tasks = [
      makeObsTask("t1", "u1", ["src/a.ts"], "correctness", {
        file_line_counts: { "src/a.ts": 100 },
      }),
      makeObsTask("t2", "u1", ["src/b.ts"], "security", {
        file_line_counts: { "src/b.ts": 100 },
      }),
    ];
    buildReviewPacketsForObs(tasks, { targetPacketTokens: 1 });
    const planningLines = stderrLines.filter((l) =>
      l.includes("[audit-code:packet-planning]"),
    );
    assert.equal(planningLines.length, 0, "no packet-planning traces without AUDIT_CODE_VERBOSE");
  } finally {
    process.stderr.write = origWrite;
    if (prevVerbose === undefined) {
      delete process.env.AUDIT_CODE_VERBOSE;
    } else {
      process.env.AUDIT_CODE_VERBOSE = prevVerbose;
    }
  }
});

// ── OBS-91b2317c: structured stderr for lensVerification truncation events ────

const { buildLensVerificationTasks } = await import(
  "../src/orchestrator/selectiveDeepening/lensVerification.ts"
);
const { MAX_LENS_VERIFICATION_FILES, MAX_LENS_VERIFICATION_RESULT_SUMMARIES } = await import(
  "../src/orchestrator/selectiveDeepening/shared.ts"
);

/**
 * Build a minimal AuditResult for use in lensVerification tests.
 */
function makeLvResult(taskId, lens, filePaths, overrides = {}) {
  return {
    task_id: taskId,
    unit_id: `unit:${taskId}`,
    pass_id: `pass:${lens}`,
    lens,
    findings: [],
    file_coverage: filePaths.map((p) => ({ path: p, total_lines: 10 })),
    requires_followup: true,
    ...overrides,
  };
}

/**
 * Build a minimal AuditTask for use in lensVerification tests.
 */
function makeLvTask(taskId, lens, filePaths, overrides = {}) {
  return {
    task_id: taskId,
    unit_id: `unit:${taskId}`,
    pass_id: `pass:${lens}`,
    lens,
    file_paths: filePaths,
    rationale: "test",
    priority: "high",
    tags: ["critical_flow"],
    status: "complete",
    ...overrides,
  };
}

test("selectLensVerificationFiles emits structured stderr when file list is truncated", async () => {
  // Build enough distinct results/tasks to exceed MAX_LENS_VERIFICATION_FILES.
  // Each result covers one unique file — with MAX+1 files, truncation fires.
  const fileCount = MAX_LENS_VERIFICATION_FILES + 1;
  const lens = "security";
  const results = [];
  const tasks = [];
  for (let i = 0; i < fileCount; i++) {
    const id = `task-${i}`;
    const file = `src/file${i}.ts`;
    results.push(makeLvResult(id, lens, [file]));
    tasks.push(makeLvTask(id, lens, [file]));
  }

  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    buildLensVerificationTasks({ existingTasks: tasks, results });
  } finally {
    process.stderr.write = origWrite;
  }

  const truncLines = stderrLines.filter((l) => {
    try {
      const obj = JSON.parse(l.trim());
      return obj.event === "truncated_verification_file_list";
    } catch { return false; }
  });
  assert.equal(truncLines.length, 1, "expected exactly one truncated_verification_file_list line");
  const parsed = JSON.parse(truncLines[0].trim());
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.source, "audit-code:selectiveDeepening");
  assert.equal(parsed.lens, lens);
  assert.equal(parsed.kept, MAX_LENS_VERIFICATION_FILES);
  assert.equal(parsed.total, fileCount);
  assert.ok(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp");
});

test("buildLensVerificationTask emits structured stderr when result-summary list is truncated", async () => {
  // Build enough results to exceed MAX_LENS_VERIFICATION_RESULT_SUMMARIES.
  // Each result shares the same single file so file-list truncation does NOT fire.
  const sourceCount = MAX_LENS_VERIFICATION_RESULT_SUMMARIES + 1;
  const lens = "security";
  const sharedFile = "src/shared.ts";
  const results = [];
  const tasks = [];
  for (let i = 0; i < sourceCount; i++) {
    const id = `src-task-${i}`;
    results.push(makeLvResult(id, lens, [sharedFile]));
    tasks.push(makeLvTask(id, lens, [sharedFile]));
  }

  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    buildLensVerificationTasks({ existingTasks: tasks, results });
  } finally {
    process.stderr.write = origWrite;
  }

  const truncLines = stderrLines.filter((l) => {
    try {
      const obj = JSON.parse(l.trim());
      return obj.event === "truncated_result_summary_list";
    } catch { return false; }
  });
  assert.equal(truncLines.length, 1, "expected exactly one truncated_result_summary_list line");
  const parsed = JSON.parse(truncLines[0].trim());
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.source, "audit-code:selectiveDeepening");
  assert.equal(parsed.lens, lens);
  assert.equal(parsed.kept, MAX_LENS_VERIFICATION_RESULT_SUMMARIES);
  assert.equal(parsed.total, sourceCount);
  assert.ok(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp");
});

test("No truncation stderr is emitted when counts are within limits", async () => {
  // Use counts well within both limits.
  const lens = "security";
  const results = [];
  const tasks = [];
  for (let i = 0; i < 2; i++) {
    const id = `small-task-${i}`;
    const file = `src/small${i}.ts`;
    results.push(makeLvResult(id, lens, [file]));
    tasks.push(makeLvTask(id, lens, [file]));
  }

  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    buildLensVerificationTasks({ existingTasks: tasks, results });
  } finally {
    process.stderr.write = origWrite;
  }

  const truncLines = stderrLines.filter((l) => {
    try {
      const obj = JSON.parse(l.trim());
      return (
        obj.event === "truncated_verification_file_list" ||
        obj.event === "truncated_result_summary_list"
      );
    } catch { return false; }
  });
  assert.equal(truncLines.length, 0, "no truncation stderr when within limits");
});

// FND-OBS-c8d43100/48c05a13/6e84f23c/99e3a861/bf5c7331 tests: audit-dispatch-observability.test.mjs

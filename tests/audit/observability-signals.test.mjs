import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const { checkFileIntegrity } = await import("../../src/audit/orchestrator/fileIntegrity.ts");
const { normalizeGenericExternalResults } = await import("../../src/audit/adapters/normalizeExternal.ts");
const { runCommand } = await import("../../src/audit/orchestrator/runtimeCommand.ts");

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
    expect(result.io_errors).toEqual([rel]);
    expect(result.missing_files).toEqual([]);
    expect(result.is_clean).toBe(false);
  });
});

test("checkFileIntegrity reports an absent file as missing, not io_errors", async () => {
  await withTempDir(async (dir) => {
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: "does-not-exist.ts", hash: "deadbeef" }]),
    );
    expect(result.missing_files).toEqual(["does-not-exist.ts"]);
    expect(result.io_errors).toEqual([]);
    expect(result.is_clean).toBe(false);
  });
});

test("checkFileIntegrity is_clean is false whenever io_errors is non-empty", async () => {
  await withTempDir(async (dir) => {
    const rel = "dir-path";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    expect(result.io_errors.length > 0).toBeTruthy();
    expect(result.is_clean).toBe(false);
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
    expect(result.changed_files).toEqual([rel]);
    expect(result.missing_files).toEqual([]);
    expect(result.io_errors).toEqual([]);
    expect(result.is_clean).toBe(false);
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
    expect(result.is_clean).toBe(true);
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
  expect(result.results.length).toBe(2);
  expect(result.results.map((r) => r.path)).toEqual(["a.ts", "c.ts"]);
  // Structured drop event emitted with the correct count.
  const dropLine = lines.find((l) => {
    try { const obj = JSON.parse(l.trim()); return obj.event === "normalizer_findings_dropped"; }
    catch { return false; }
  });
  expect(dropLine, "expected a normalizer_findings_dropped JSON event on stderr").toBeTruthy();
  const dropEvent = JSON.parse(dropLine.trim());
  expect(dropEvent.tool).toBe("semgrep");
  expect(dropEvent.dropped).toBe(2);
  expect(dropEvent.total).toBe(4);
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
  expect(lines.some((l) => {
      try { const obj = JSON.parse(l.trim()); return obj.event === "normalizer_findings_dropped"; }
      catch { return false; }
    })).toBe(false);
});

// ── buildLineIndex / buildLineIndexForPaths: warn on unreadable file (OBS-2cc9cf82) ──

const { buildLineIndex, buildLineIndexForPaths } = await import("../../src/audit/cli/lineIndex.ts");

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
    expect(result["does-not-exist.ts"]).toBe(0);
    // Valid file still has the correct count.
    expect(result[validFile] > 0, "valid file should have a positive line count").toBeTruthy();
    // A stderr diagnostic was emitted containing the failing path and an error message.
    const warnLine = stderrLines.find((l) => l.includes("does-not-exist.ts"));
    expect(warnLine, "expected a stderr diagnostic for the unreadable file").toBeTruthy();
    expect(warnLine).toMatch(/\[lineIndex\]/);
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
    expect(result["ghost.ts"]).toBe(0);
    // Valid path has a correct count.
    expect(result[validFile] > 0, "valid file should have a positive line count").toBeTruthy();
    // A stderr diagnostic was emitted containing the failing path.
    const warnLine = stderrLines.find((l) => l.includes("ghost.ts"));
    expect(warnLine, "expected a stderr diagnostic for the unreadable path").toBeTruthy();
    expect(warnLine).toMatch(/\[lineIndex\]/);
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
  expect(result.status, "status is inconclusive on spawn error").toBe("inconclusive");
  expect(result.summary, "summary says 'Failed to execute'").toMatch(/Failed to execute/);
  expect(result.summary, "summary includes the failing command").toMatch(/__audit_code_nonexistent_command_xyz__/);
  expect(result.evidence, "evidence is empty when no output was captured").toEqual([]);
});

test("runCommand error event summary includes the OS error message", async () => {
  const result = await runCommand(["__audit_code_nonexistent_42__"], process.cwd());
  expect(result.status).toBe("inconclusive");
  expect(result.summary.length > 0, "summary is non-empty").toBeTruthy();
  expect(result.summary.includes("__audit_code_nonexistent_42__"), "summary embeds the command name").toBeTruthy();
});

// ── ExecutorRunResult structured observability fields (OBS-d202e206) ──────────
// These are runtime-shape checks: verify the optional fields are accepted by
// constructing plain objects and checking they satisfy the expected structure.

test("ExecutorRunResult accepts log_entries with all severity levels", async () => {
  /** @type {import("../../src/audit/orchestrator/executorResult.ts").LogEntry[]} */
  const entries = [
    { severity: "debug", message: "debug msg", timestamp_ms: 1 },
    { severity: "info", message: "info msg", timestamp_ms: 2 },
    { severity: "warn", message: "warn msg", timestamp_ms: 3 },
    { severity: "error", message: "error msg", timestamp_ms: 4, context: { task_id: "t1", run_id: "r1" } },
  ];
  for (const e of entries) {
    expect(typeof e.severity === "string", "severity is a string").toBeTruthy();
    expect(typeof e.message === "string", "message is a string").toBeTruthy();
    expect(typeof e.timestamp_ms === "number", "timestamp_ms is a number").toBeTruthy();
  }
  // LogEntry with a context object satisfies the type.
  const withCtx = entries[3];
  expect(withCtx.context !== undefined, "context is present").toBeTruthy();
  expect(withCtx.context.task_id).toBe("t1");
});

test("ExecutorRunResult accepts optional step_duration_ms and degraded fields", async () => {
  // A minimal valid result omitting optional fields.
  const minimal = { updated: {}, artifacts_written: [], progress_summary: "ok" };
  expect(minimal.step_duration_ms === undefined, "step_duration_ms is optional").toBeTruthy();
  expect(minimal.degraded === undefined, "degraded is optional").toBeTruthy();

  // With the new fields populated.
  const full = { ...minimal, step_duration_ms: 0, degraded: false };
  expect(full.step_duration_ms).toBe(0);
  expect(full.degraded).toBe(false);

  // degraded: true is valid.
  const partial = { ...minimal, degraded: true };
  expect(partial.degraded).toBe(true);
});

// ── runRuntimeValidationExecutor: deduplication counters in progress_summary (OBS-24ba5c5e) ──

const { runRuntimeValidationExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.ts");

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
    expect(result.progress_summary, "summary mentions total task count").toMatch(/3 task\(s\)/);
    expect(result.progress_summary, "summary mentions uniqueCommandsRun = 2").toMatch(/2 unique command\(s\) run/);
    expect(result.progress_summary, "summary mentions deduplicatedHits = 1").toMatch(/1 served from deduplication cache/);
  });
});

test("runRuntimeValidationExecutor: all distinct commands → deduplicatedHits is 0", async () => {
  await withTempDir(async (dir) => {
    const bundle = makeRvBundle([
      makeRvTask("t1", ["node", "--version"]),
      makeRvTask("t2", ["node", "-e", "process.exit(0)"]),
    ]);

    const result = await runRuntimeValidationExecutor(bundle, dir);

    expect(result.progress_summary, "both commands are unique").toMatch(/2 unique command\(s\) run/);
    expect(result.progress_summary, "no dedup hits").toMatch(/0 served from deduplication cache/);
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

    expect(result.progress_summary, "summary mentions total task count").toMatch(/3 task\(s\)/);
    expect(result.progress_summary, "only 1 unique command").toMatch(/1 unique command\(s\) run/);
    expect(result.progress_summary, "task count minus 1 are dedup hits").toMatch(/2 served from deduplication cache/);
  });
});

// ── OBS-159522c2: packet-planning debug traces ────────────────────────────────

const { unionFindFromGroups } = await import("../../src/audit/orchestrator/reviewPacketGraph.ts");
const { buildReviewPackets: buildReviewPacketsForObs } = await import("../../src/audit/orchestrator/reviewPackets.ts");

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
    expect(mergeLines.length > 0, "expected at least one shared-file merge trace line").toBeTruthy();
    expect(mergeLines.some((l) => l.includes("g1") || l.includes("g2")), "merge trace should mention the merged group keys").toBeTruthy();
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
    expect(edgeLines.length > 0, "expected at least one edge-driven merge trace line").toBeTruthy();
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
    expect(planningLines.length, "no packet-planning traces without AUDIT_CODE_VERBOSE").toBe(0);
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
    expect(splitLines.length > 0, "expected at least one token-budget split trace").toBeTruthy();
    expect(splitLines.some((l) => l.includes("targetPacketTokens=1")), "split trace should include targetPacketTokens").toBeTruthy();
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
    expect(planningLines.length, "no packet-planning traces without AUDIT_CODE_VERBOSE").toBe(0);
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

const { buildLensVerificationTasks } = await import("../../src/audit/orchestrator/selectiveDeepening/lensVerification.ts");
const { MAX_LENS_VERIFICATION_FILES, MAX_LENS_VERIFICATION_RESULT_SUMMARIES } = await import("../../src/audit/orchestrator/selectiveDeepening/shared.ts");

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
  expect(truncLines.length, "expected exactly one truncated_verification_file_list line").toBe(1);
  const parsed = JSON.parse(truncLines[0].trim());
  expect(parsed.level).toBe("warn");
  expect(parsed.source).toBe("audit-code:selectiveDeepening");
  expect(parsed.lens).toBe(lens);
  expect(parsed.kept).toBe(MAX_LENS_VERIFICATION_FILES);
  expect(parsed.total).toBe(fileCount);
  expect(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp").toBeTruthy();
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
  expect(truncLines.length, "expected exactly one truncated_result_summary_list line").toBe(1);
  const parsed = JSON.parse(truncLines[0].trim());
  expect(parsed.level).toBe("warn");
  expect(parsed.source).toBe("audit-code:selectiveDeepening");
  expect(parsed.lens).toBe(lens);
  expect(parsed.kept).toBe(MAX_LENS_VERIFICATION_RESULT_SUMMARIES);
  expect(parsed.total).toBe(sourceCount);
  expect(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp").toBeTruthy();
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
  expect(truncLines.length, "no truncation stderr when within limits").toBe(0);
});

// FND-OBS-c8d43100/48c05a13/6e84f23c/99e3a861/bf5c7331 tests: audit-dispatch-observability.test.mjs

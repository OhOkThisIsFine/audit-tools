import test from "node:test";
import assert from "node:assert/strict";

const {
  formatValidationIssues,
  prefixValidationIssues,
  requireKeys,
} = await import("audit-tools/shared/validation/basic");
const { validateArtifactBundle } = await import("../../src/audit/validation/artifacts.ts");
const {
  formatAuditResultIssues,
  validateAuditResults,
} = await import("../../src/audit/validation/auditResults.ts");
const {
  validateConfiguredProviderEnvironment,
  validateSessionConfig,
} = await import("../../src/audit/validation/sessionConfig.ts");

test("requireKeys rejects non-object payloads and shared validation formatting stays stable", () => {
  const issues = requireKeys(["not", "an", "object"], "repo_manifest", [
    "files",
  ]);
  const prefixed = prefixValidationIssues("session_config", [
    {
      path: "claude_code.command",
      message: "command must be a bare executable name or direct executable path.",
      severity: "error",
    },
  ]);

  assert.deepEqual(issues, [
    {
      path: "repo_manifest",
      message: "Expected an object, got array.",
      severity: "error",
    },
  ]);
  assert.equal(
    formatValidationIssues(issues),
    "  [error] repo_manifest: Expected an object, got array.",
  );
  assert.deepEqual(prefixed, [
    {
      path: "session_config.claude_code.command",
      message: "command must be a bare executable name or direct executable path.",
      severity: "error",
    },
  ]);
});

test("validateArtifactBundle reports malformed bundle sections and unit invariants together", () => {
  const issues = validateArtifactBundle({
    repo_manifest: [],
    unit_manifest: {
      units: [
        {
          unit_id: "unit-auth",
          files: [],
          required_lenses: [],
        },
      ],
    },
  });

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "repo_manifest" &&
        /expected an object, got array/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "unit_manifest:unit-auth" &&
        /unit has no files/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "unit_manifest:unit-auth" &&
        /unit has no required lenses/i.test(issue.message),
    ),
  );
});

test("validateArtifactBundle treats vcs_ignore aggregate prefixes as disposition coverage", () => {
  const bundle = {
    repo_manifest: {
      files: [
        { path: "src/app.ts" },
        { path: "node_modules/dep/index.js" },
        { path: "node_modules/dep/lib/util.js" },
        { path: "orphan/missing.ts" },
      ],
    },
    file_disposition: {
      files: [{ path: "src/app.ts", status: "included" }],
      vcs_ignore: {
        applied: true,
        ignored_count: 2,
        aggregates: [
          { prefix: "node_modules", count: 2, reason: "vcs_ignored" },
        ],
      },
    },
  };

  const issues = validateArtifactBundle(bundle);
  const missing = issues.filter((issue) =>
    /missing disposition entry/i.test(issue.message),
  );
  // Paths under an aggregate prefix are accounted for; genuinely uncovered
  // paths are still flagged.
  assert.deepEqual(
    missing.map((issue) => issue.message),
    ["Missing disposition entry for orphan/missing.ts"],
  );
});

test("validateArtifactBundle rejects invalid audit task line ranges", () => {
  const baseTask = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    rationale: "Review auth.",
  };

  assert.deepEqual(
    validateArtifactBundle({
      audit_tasks: [
        {
          ...baseTask,
          line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 1 }],
        },
        {
          ...baseTask,
          task_id: "task-2",
          line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 4 }],
        },
      ],
    }),
    [],
  );

  const issues = validateArtifactBundle({
    audit_tasks: [
      {
        ...baseTask,
        line_ranges: [{ path: "src/api/auth.ts", start: 8, end: 4 }],
      },
    ],
  });

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "audit_tasks:task-1.line_ranges:0" &&
        /end must be greater than or equal to start/i.test(issue.message),
    ),
  );
});

test("validateAuditResults exposes a shared path alias for empty evidence failures", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Whitespace evidence",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Evidence only contains whitespace.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: ["   "],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
  );

  const evidenceIssue = issues.find(
    (issue) => issue.field === "findings[0].evidence",
  );
  assert.ok(evidenceIssue);
  assert.equal(evidenceIssue.path, "findings[0].evidence");
  assert.match(evidenceIssue.message, /empty strings/i);
  assert.match(
    formatAuditResultIssues([evidenceIssue]),
    /\[error\] task-1 \/ findings\[0\]\.evidence:/i,
  );
});

test("validateAuditResults accepts file_coverage paths with backslashes or ./ prefix", () => {
  const tasks = [
    {
      task_id: "task-norm",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/utils/helpers.ts", "src/index.ts"],
      file_line_counts: { "src/utils/helpers.ts": 50, "src/index.ts": 20 },
      rationale: "fixture",
    },
  ];

  // Backslash paths
  const issuesBackslash = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src\\utils\\helpers.ts", total_lines: 50 },
          { path: "src\\index.ts", total_lines: 20 },
        ],
        findings: [],
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const backslashErrors = issuesBackslash.filter((i) => i.severity === "error");
  assert.equal(backslashErrors.length, 0, `unexpected errors: ${JSON.stringify(backslashErrors)}`);

  // ./ prefix paths
  const issuesDotSlash = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "./src/utils/helpers.ts", total_lines: 50 },
          { path: "./src/index.ts", total_lines: 20 },
        ],
        findings: [],
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const dotSlashErrors = issuesDotSlash.filter((i) => i.severity === "error");
  assert.equal(dotSlashErrors.length, 0, `unexpected errors: ${JSON.stringify(dotSlashErrors)}`);

  // Mixed: backslash + ./ prefix
  const issuesMixed = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: ".\\src\\utils\\helpers.ts", total_lines: 50 },
          { path: "./src/index.ts", total_lines: 20 },
        ],
        findings: [],
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const mixedErrors = issuesMixed.filter((i) => i.severity === "error");
  assert.equal(mixedErrors.length, 0, `unexpected errors: ${JSON.stringify(mixedErrors)}`);
});

test("validateAuditResults rejects a backslash path that normalizes to an unrecognized file", () => {
  const tasks = [
    {
      task_id: "task-norm-typo",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/utils/helpers.ts"],
      file_line_counts: { "src/utils/helpers.ts": 50 },
      rationale: "fixture",
    },
  ];

  // 'src\\utils\\helper.ts' normalizes to 'src/utils/helper.ts' — note missing trailing 's'
  // The task only has 'src/utils/helpers.ts', so after normalization the path is not found
  const issues = validateAuditResults(
    [
      {
        task_id: "task-norm-typo",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src\\utils\\helper.ts", total_lines: 50 },
        ],
        findings: [],
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50 } },
  );

  const errorIssues = issues.filter((i) => i.severity === "error");
  assert.ok(
    errorIssues.length >= 1,
    `expected at least one error issue, got: ${JSON.stringify(errorIssues)}`,
  );
  const pathIssue = errorIssues.find(
    (i) => i.field === "file_coverage[0].path",
  );
  assert.ok(
    pathIssue,
    `expected an error issue with field 'file_coverage[0].path', got: ${JSON.stringify(errorIssues)}`,
  );
  assert.match(pathIssue.message, /not listed in the task file_paths/i);
});

test("validateAuditResults detects duplicates across normalized paths", () => {
  const tasks = [
    {
      task_id: "task-dup",
      unit_id: "unit-1",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 10 },
      rationale: "fixture",
    },
  ];
  const issues = validateAuditResults(
    [
      {
        task_id: "task-dup",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [
          { path: "src/foo.ts", total_lines: 10 },
          { path: "src\\foo.ts", total_lines: 10 },
        ],
        findings: [],
      },
    ],
    tasks,
  );
  const dupIssue = issues.find((i) => /duplicated/i.test(i.message));
  assert.ok(dupIssue, "should detect normalized duplicate");
});

test("validateAuditResults accepts affected_files path with backslashes when file_coverage declares forward-slash equivalent", () => {
  const tasks = [
    {
      task_id: "task-af-norm",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 20 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/foo.ts", total_lines: 20 }],
        findings: [
          {
            id: "f-1",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "src\\foo.ts", line_start: 1, line_end: 5 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/foo.ts": 20 } },
  );

  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files/.test(i.field ?? ""),
  );
  assert.equal(pathErrors.length, 0, `unexpected affected_files errors: ${JSON.stringify(pathErrors)}`);
});

test("validateAuditResults accepts affected_files path with leading ./ prefix when file_coverage declares stripped equivalent", () => {
  const tasks = [
    {
      task_id: "task-af-dot",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/bar.ts"],
      file_line_counts: { "src/bar.ts": 15 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-dot",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/bar.ts", total_lines: 15 }],
        findings: [
          {
            id: "f-2",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "./src/bar.ts", line_start: 1 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/bar.ts": 15 } },
  );

  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files/.test(i.field ?? ""),
  );
  assert.equal(pathErrors.length, 0, `unexpected affected_files errors: ${JSON.stringify(pathErrors)}`);
});

test("validateAuditResults produces a WARNING (not error) for affected_files path not in file_coverage (INV-09 strip-and-warn)", () => {
  // INV-09: out-of-scope affected_files must not hard-reject the entire result.
  // The validation now emits a warning so the in-scope findings are retained.
  const tasks = [
    {
      task_id: "task-af-miss",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 10 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-miss",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/foo.ts", total_lines: 10 }],
        findings: [
          {
            id: "f-3",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "src/other.ts", line_start: 1 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/foo.ts": 10 } },
  );

  // Must be a warning, NOT an error (strip-and-warn, not hard reject).
  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files\[0\]\.path/.test(i.field ?? ""),
  );
  assert.equal(pathErrors.length, 0, `out-of-scope affected_files must not produce a hard error, got: ${JSON.stringify(pathErrors)}`);

  const pathWarnings = issues.filter(
    (i) => i.severity === "warning" && /affected_files\[0\]\.path/.test(i.field ?? ""),
  );
  assert.equal(pathWarnings.length, 1, `expected exactly one affected_files path warning, got: ${JSON.stringify(pathWarnings)}`);
  assert.match(
    pathWarnings[0].message,
    /out-of-scope/i,
    "warning message must mention out-of-scope",
  );
  assert.match(
    pathWarnings[0].message,
    /src\/foo\.ts/,
    "warning should surface the task's allowed files",
  );
});

test("validateSessionConfig rejects compound command strings and environment validation avoids probing them", async () => {
  let pathLookups = 0;
  let commandLookups = 0;

  const configIssues = validateSessionConfig({
    provider: "claude-code",
    claude_code: {
      command: "node ./bin/claude.js",
    },
  });
  const environmentIssues = await validateConfiguredProviderEnvironment(
    {
      provider: "claude-code",
      claude_code: {
        command: "node ./bin/claude.js",
      },
    },
    {
      commandExists: () => {
        commandLookups++;
        return Promise.resolve(true);
      },
      pathExists: () => {
        pathLookups++;
        return true;
      },
    },
  );

  assert.ok(
    configIssues.some(
      (issue) =>
        issue.path === "claude_code.command" &&
        /bare executable name or direct executable path/i.test(issue.message),
    ),
  );
  assert.ok(
    environmentIssues.some(
      (issue) =>
        issue.path === "claude_code.command" &&
        /put cli flags in extra_args/i.test(issue.message),
    ),
  );
  assert.equal(commandLookups, 0);
  assert.equal(pathLookups, 0);
});

test("validateSessionConfig accepts boolean host dispatch capability", () => {
  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      host_can_dispatch_subagents: true,
    }),
    [],
  );

  const issues = validateSessionConfig({
    host_can_dispatch_subagents: "true",
  });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "host_can_dispatch_subagents" &&
        /must be a boolean/i.test(issue.message),
    ),
  );
});

test("validateSessionConfig validates the analyzers map of resolution settings", () => {
  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      analyzers: { typescript: "ephemeral", python: "skip" },
    }),
    [],
  );

  const badSetting = validateSessionConfig({ analyzers: { typescript: "yes" } });
  assert.ok(
    badSetting.some(
      (issue) =>
        issue.path === "analyzers.typescript" &&
        /repo, ephemeral, permanent, skip, auto/.test(issue.message),
    ),
  );

  const badShape = validateSessionConfig({ analyzers: ["typescript"] });
  assert.ok(
    badShape.some(
      (issue) =>
        issue.path === "analyzers" && /must be a JSON object/i.test(issue.message),
    ),
  );
});

test("validateArtifactBundle reports orphaned runtime_validation_report results", () => {
  // Case 1: one known task + one orphan result → exactly one issue for the orphan
  const issues1 = validateArtifactBundle({
    runtime_validation_tasks: {
      tasks: [{ id: "rvt-1", target_paths: ["src/foo.ts"] }],
    },
    runtime_validation_report: {
      results: [
        { task_id: "rvt-1" },
        { task_id: "rvt-unknown" },
      ],
    },
  });
  const orphanIssues1 = issues1.filter(
    (issue) => issue.path === "runtime_validation_report:rvt-unknown",
  );
  assert.equal(orphanIssues1.length, 1);
  assert.match(orphanIssues1[0].message, /unknown task/i);
  // Known task produces no orphan issue
  assert.ok(
    !issues1.some((issue) => issue.path === "runtime_validation_report:rvt-1"),
  );

  // Case 2: report present but no runtime_validation_tasks → every result is an orphan
  const issues2 = validateArtifactBundle({
    runtime_validation_report: {
      results: [
        { task_id: "rvt-a" },
        { task_id: "rvt-b" },
      ],
    },
  });
  assert.ok(
    issues2.some(
      (issue) =>
        issue.path === "runtime_validation_report:rvt-a" &&
        /unknown task/i.test(issue.message),
    ),
  );
  assert.ok(
    issues2.some(
      (issue) =>
        issue.path === "runtime_validation_report:rvt-b" &&
        /unknown task/i.test(issue.message),
    ),
  );

  // Case 3: well-formed bundle — all results reference known task ids → no runtime_validation_report issues
  const issues3 = validateArtifactBundle({
    runtime_validation_tasks: {
      tasks: [
        { id: "rvt-1", target_paths: ["src/foo.ts"] },
        { id: "rvt-2", target_paths: ["src/bar.ts"] },
      ],
    },
    runtime_validation_report: {
      results: [
        { task_id: "rvt-1" },
        { task_id: "rvt-2" },
      ],
    },
  });
  assert.ok(
    !issues3.some((issue) =>
      issue.path.startsWith("runtime_validation_report:"),
    ),
  );
});

test("validateAuditResults logs a summary to stderr when issues are found", () => {
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };
  try {
    // Result missing required fields — produces at least one error issue
    const issues = validateAuditResults(
      [
        {
          task_id: "task-log",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          // file_coverage missing intentionally
          findings: [],
        },
      ],
      [
        {
          task_id: "task-log",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "fixture",
        },
      ],
    );
    assert.ok(issues.length > 0, "expected at least one validation issue");
    const logLine = stderrLines.find((l) =>
      /\[audit-results validation\]/.test(l),
    );
    assert.ok(logLine, `expected a stderr log line; got: ${JSON.stringify(stderrLines)}`);
    assert.match(logLine, /\[audit-results validation\] \d+ error\(s\), \d+ warning\(s\) across \d+ result\(s\)/);

    // Clean run — no stderr log
    stderrLines.length = 0;
    const cleanIssues = validateAuditResults([], []);
    assert.deepEqual(cleanIssues, []);
    assert.ok(
      !stderrLines.some((l) => /\[audit-results validation\]/.test(l)),
      "expected no stderr log on clean run",
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("validateArtifactBundle logs a summary to stderr when issues are found", () => {
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };
  try {
    // repo_manifest as array triggers a validation issue
    const issues = validateArtifactBundle({ repo_manifest: [] });
    assert.ok(issues.length > 0, "expected at least one validation issue");
    const logLine = stderrLines.find((l) =>
      /\[artifact-bundle validation\]/.test(l),
    );
    assert.ok(logLine, `expected a stderr log line; got: ${JSON.stringify(stderrLines)}`);
    assert.match(logLine, /\[artifact-bundle validation\] \d+ issue\(s\)/);

    // Clean run — no stderr log
    stderrLines.length = 0;
    const cleanIssues = validateArtifactBundle({});
    assert.deepEqual(cleanIssues, []);
    assert.ok(
      !stderrLines.some((l) => /\[artifact-bundle validation\]/.test(l)),
      "expected no stderr log on clean run",
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("validateSessionConfig validates the dispatch sub-object fields", () => {
  // Valid dispatch object — no issues
  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      dispatch: { confirm_threshold: 2, max_packets: 10 },
    }),
    [],
  );

  // dispatch is an array (non-object) — issue on path 'dispatch'
  const issuesArray = validateSessionConfig({ dispatch: ["not-an-object"] });
  assert.ok(
    issuesArray.some(
      (issue) =>
        issue.path === "dispatch" &&
        /must be a JSON object/i.test(issue.message),
    ),
  );

  // dispatch.confirm_threshold is -1 (negative integer) — issue on path 'dispatch.confirm_threshold'
  const issuesThresholdNeg = validateSessionConfig({ dispatch: { confirm_threshold: -1 } });
  assert.ok(
    issuesThresholdNeg.some(
      (issue) =>
        issue.path === "dispatch.confirm_threshold" &&
        /must be a non-negative integer/i.test(issue.message),
    ),
  );

  // dispatch.confirm_threshold is 1.5 (non-integer) — issue on path 'dispatch.confirm_threshold'
  const issuesThresholdFloat = validateSessionConfig({ dispatch: { confirm_threshold: 1.5 } });
  assert.ok(
    issuesThresholdFloat.some(
      (issue) =>
        issue.path === "dispatch.confirm_threshold" &&
        /must be a non-negative integer/i.test(issue.message),
    ),
  );

  // dispatch.max_packets is -1 (negative integer) — issue on path 'dispatch.max_packets'
  const issuesMaxPacketsNeg = validateSessionConfig({ dispatch: { max_packets: -1 } });
  assert.ok(
    issuesMaxPacketsNeg.some(
      (issue) =>
        issue.path === "dispatch.max_packets" &&
        /must be a non-negative integer/i.test(issue.message),
    ),
  );

  // dispatch.max_packets is 'all' (non-integer) — issue on path 'dispatch.max_packets'
  const issuesMaxPacketsStr = validateSessionConfig({ dispatch: { max_packets: "all" } });
  assert.ok(
    issuesMaxPacketsStr.some(
      (issue) =>
        issue.path === "dispatch.max_packets" &&
        /must be a non-negative integer/i.test(issue.message),
    ),
  );
});

test("validateConfiguredProviderEnvironment checks explicit executable paths without PATH probing", async () => {
  let pathLookups = 0;
  let commandLookups = 0;

  const issues = await validateConfiguredProviderEnvironment(
    {
      provider: "opencode",
      opencode: {
        command: "C:\\Program Files\\OpenCode\\opencode.exe",
      },
    },
    {
      commandExists: () => {
        commandLookups++;
        return Promise.resolve(false);
      },
      pathExists: (commandPath) => {
        pathLookups++;
        return (
          commandPath === "C:\\Program Files\\OpenCode\\opencode.exe"
        );
      },
    },
  );

  assert.deepEqual(issues, []);
  assert.equal(commandLookups, 0);
  assert.equal(pathLookups, 1);
});

// ── INV-09: out-of-scope affected_files is a warning, not a hard error ────────

test("INV-09: affected_files path outside file_coverage is a warning (not an error)", () => {
  const result = {
    task_id: "t-scope",
    unit_id: "unit-scope",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/auth.ts", total_lines: 50 }],
    findings: [
      {
        id: "SEC-001",
        title: "Out of scope reference",
        category: "cross-boundary-reference",
        severity: "high",
        confidence: "medium",
        lens: "security",
        summary: "This finding cites a file outside the packet.",
        affected_files: [{ path: "src/other.ts" }], // out-of-scope
        evidence: ["src/other.ts:10 - see line 10"],
      },
    ],
  };
  const task = {
    task_id: "t-scope",
    unit_id: "unit-scope",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/auth.ts"],
    file_line_counts: { "src/auth.ts": 50 },
    rationale: "test",
    priority: "medium",
  };

  const issues = validateAuditResults([result], [task], { lineIndex: { "src/auth.ts": 50 } });
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  assert.equal(errors.length, 0, "out-of-scope affected_files must not be a hard error");
  assert.equal(warnings.length, 1, "out-of-scope affected_files must emit a warning");
  assert.match(warnings[0].message, /out-of-scope/i, "warning message must mention out-of-scope");
});

test("INV-09: in-scope findings in the same result are retained when one affected_files entry is out-of-scope", () => {
  const result = {
    task_id: "t-mixed",
    unit_id: "unit-mixed",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/core.ts", total_lines: 30 }],
    findings: [
      {
        id: "COR-001",
        title: "In-scope finding",
        category: "null-dereference",
        severity: "medium",
        confidence: "high",
        lens: "correctness",
        summary: "An in-scope finding.",
        affected_files: [{ path: "src/core.ts", line_start: 5, line_end: 10 }],
        evidence: ["src/core.ts:5 - dereference"],
      },
    ],
  };
  const task = {
    task_id: "t-mixed",
    unit_id: "unit-mixed",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: ["src/core.ts"],
    file_line_counts: { "src/core.ts": 30 },
    rationale: "test",
    priority: "medium",
  };

  const issues = validateAuditResults([result], [task], { lineIndex: { "src/core.ts": 30 } });
  // A clean result with only in-scope entries should produce no errors or warnings.
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0, "in-scope finding with valid span must produce no errors");
});

// ── FND-REL-6f9f6681: commandExists must handle hangs/timeouts gracefully ─────

test("FND-REL-6f9f6681: validateConfiguredProviderEnvironment reports not-found when PATH probe returns false (timeout result)", async () => {
  // The internal commandExists adds a 5 s timeout to execFileAsync so a stalled
  // PATH probe (NFS home dir, broken PATH, slow DNS) is killed and returns false
  // rather than hanging forever.  The injected stub here simulates what the
  // production code produces after an ETIMEDOUT: false (command not found).
  const issues = await validateConfiguredProviderEnvironment(
    { provider: "claude-code", claude_code: { command: "claude" } },
    {
      commandExists: () => Promise.resolve(false),
    },
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "claude_code.command" &&
        /not found on path/i.test(issue.message),
    ),
    `expected a 'not found on PATH' issue; got: ${JSON.stringify(issues)}`,
  );
});

test("FND-REL-6f9f6681: validateConfiguredProviderEnvironment reports not-found for opencode when PATH probe returns false", async () => {
  // Regression guard: same path-probe timeout scenario for opencode provider.
  const issues = await validateConfiguredProviderEnvironment(
    { provider: "opencode", opencode: { command: "opencode" } },
    {
      commandExists: () => Promise.resolve(false),
    },
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "opencode.command" &&
        /not found on path/i.test(issue.message),
    ),
    `expected a 'not found on PATH' issue when commandExists returns false; got: ${JSON.stringify(issues)}`,
  );
});

// ── TST-6f9f6681: codex branch of validateConfiguredProviderEnvironment ────────

test("TST-6f9f6681: validateConfiguredProviderEnvironment reports not-found for codex when PATH probe returns false", async () => {
  const issues = await validateConfiguredProviderEnvironment(
    { provider: "codex", codex: { command: "codex" } },
    {
      commandExists: () => Promise.resolve(false),
    },
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "codex.command" &&
        /not found on path/i.test(issue.message),
    ),
    `expected a 'not found on PATH' issue for codex when commandExists returns false; got: ${JSON.stringify(issues)}`,
  );
});

test("TST-6f9f6681: validateConfiguredProviderEnvironment accepts codex when PATH probe returns true", async () => {
  const issues = await validateConfiguredProviderEnvironment(
    { provider: "codex", codex: { command: "codex" } },
    {
      commandExists: () => Promise.resolve(true),
    },
  );

  const codexIssues = issues.filter((issue) => issue.path === "codex.command");
  assert.equal(
    codexIssues.length,
    0,
    `expected no codex.command issues when codex is found on PATH; got: ${JSON.stringify(codexIssues)}`,
  );
});

test("TST-6f9f6681: validateConfiguredProviderEnvironment rejects compound codex command and skips PATH probe", async () => {
  let commandLookups = 0;
  const issues = await validateConfiguredProviderEnvironment(
    { provider: "codex", codex: { command: "node /path/to/codex.js" } },
    {
      commandExists: () => {
        commandLookups++;
        return Promise.resolve(true);
      },
    },
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "codex.command" &&
        /put cli flags in extra_args/i.test(issue.message),
    ),
    `expected a compound-command issue for codex; got: ${JSON.stringify(issues)}`,
  );
  assert.equal(commandLookups, 0, "PATH probe must not run for compound commands");
});

test("TST-6f9f6681: validateConfiguredProviderEnvironment accepts codex explicit executable path when it exists", async () => {
  const issues = await validateConfiguredProviderEnvironment(
    {
      provider: "codex",
      codex: { command: "/usr/local/bin/codex" },
    },
    {
      commandExists: () => Promise.resolve(false),
      pathExists: (commandPath) => commandPath === "/usr/local/bin/codex",
    },
  );

  const codexIssues = issues.filter((issue) => issue.path === "codex.command");
  assert.equal(
    codexIssues.length,
    0,
    `expected no codex.command issues when absolute path exists; got: ${JSON.stringify(codexIssues)}`,
  );
});

// ── TST-6f9f6681-2: synthesis and routing_tiers sections of validateSessionConfig ────

test("TST-6f9f6681-2: validateSessionConfig accepts synthesis object with narrative boolean", () => {
  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      synthesis: { narrative: true },
    }),
    [],
    "synthesis.narrative: true should produce no issues",
  );

  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      synthesis: { narrative: false },
    }),
    [],
    "synthesis.narrative: false should produce no issues",
  );
});

test("TST-6f9f6681-2: validateSessionConfig rejects synthesis as array", () => {
  const issues = validateSessionConfig({ synthesis: ["narrative"] });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "synthesis" &&
        /must be a json object/i.test(issue.message),
    ),
    `expected a synthesis-must-be-object issue; got: ${JSON.stringify(issues)}`,
  );
});

test("TST-6f9f6681-2: validateSessionConfig rejects synthesis.narrative as non-boolean", () => {
  const issues = validateSessionConfig({ synthesis: { narrative: "yes" } });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "synthesis.narrative" &&
        /must be a boolean/i.test(issue.message),
    ),
    `expected a synthesis.narrative type error; got: ${JSON.stringify(issues)}`,
  );
});

test("TST-6f9f6681-2: validateSessionConfig accepts dispatch.routing_tiers with valid deep_at and standard_at", () => {
  assert.deepEqual(
    validateSessionConfig({
      provider: "local-subprocess",
      dispatch: { routing_tiers: { deep_at: 0.8, standard_at: 0.4 } },
    }),
    [],
    "routing_tiers with deep_at >= standard_at should produce no issues",
  );
});

test("TST-6f9f6681-2: validateSessionConfig rejects dispatch.routing_tiers as array", () => {
  const issues = validateSessionConfig({
    dispatch: { routing_tiers: ["deep_at"] },
  });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "dispatch.routing_tiers" &&
        /must be a json object/i.test(issue.message),
    ),
    `expected dispatch.routing_tiers-must-be-object issue; got: ${JSON.stringify(issues)}`,
  );
});

test("TST-6f9f6681-2: validateSessionConfig rejects dispatch.routing_tiers.deep_at out of range", () => {
  const issues = validateSessionConfig({
    dispatch: { routing_tiers: { deep_at: 1.5, standard_at: 0.5 } },
  });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "dispatch.routing_tiers.deep_at" &&
        /\[0, 1\]/.test(issue.message),
    ),
    `expected deep_at range error; got: ${JSON.stringify(issues)}`,
  );
});

test("TST-6f9f6681-2: validateSessionConfig rejects routing_tiers where deep_at < standard_at", () => {
  const issues = validateSessionConfig({
    dispatch: { routing_tiers: { deep_at: 0.3, standard_at: 0.7 } },
  });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "dispatch.routing_tiers" &&
        /deep_at must be >= standard_at/i.test(issue.message),
    ),
    `expected deep_at < standard_at ordering error; got: ${JSON.stringify(issues)}`,
  );
});

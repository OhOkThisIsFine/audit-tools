import test from "node:test";
import assert from "node:assert/strict";

const {
  formatValidationIssues,
  prefixValidationIssues,
  requireKeys,
} = await import("@audit-tools/shared/validation/basic");
const { validateArtifactBundle } = await import(
  "../src/validation/artifacts.ts"
);
const {
  formatAuditResultIssues,
  validateAuditResults,
} = await import("../src/validation/auditResults.ts");
const {
  validateConfiguredProviderEnvironment,
  validateSessionConfig,
} = await import("../src/validation/sessionConfig.ts");

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

test("validateAuditResults still produces an error for affected_files path genuinely not in file_coverage", () => {
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

  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files\[0\]\.path/.test(i.field ?? ""),
  );
  assert.equal(pathErrors.length, 1, `expected exactly one affected_files path error, got: ${JSON.stringify(pathErrors)}`);
  assert.match(
    pathErrors[0].message,
    /assigned files are: src\/foo\.ts/,
    "error should surface the task's allowed files",
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

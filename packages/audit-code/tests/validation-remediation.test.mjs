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

test("validateArtifactBundle rejects review packets missing listed file line counts", () => {
  const packet = {
    packet_id: "packet-1",
    task_ids: ["task-1"],
    unit_ids: ["unit-1"],
    pass_ids: ["pass:security"],
    lenses: ["security"],
    file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
    file_line_counts: { "src/api/auth.ts": 12 },
    total_lines: 12,
    priority: "high",
    quality: {
      cohesion_score: 1,
      internal_edge_count: 0,
      boundary_edge_count: 0,
      unexplained_file_count: 0,
    },
    rationale: "Review auth.",
    estimated_tokens: 1000,
  };

  const issues = validateArtifactBundle({ review_packets: [packet] });
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "review_packets:packet-1" &&
        /every listed file must have a corresponding file_line_counts entry/i.test(
          issue.message,
        ) &&
        /src\/lib\/session\.ts/i.test(issue.message),
    ),
  );

  assert.deepEqual(
    validateArtifactBundle({
      review_packets: [
        {
          ...packet,
          file_line_counts: {
            "src/api/auth.ts": 12,
            "src/lib/session.ts": 8,
          },
          total_lines: 20,
        },
      ],
    }),
    [],
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

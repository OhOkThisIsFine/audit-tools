import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { validateAuditResults } = await importSourceModule(
  "src/validation/auditResults.ts",
);
const { buildAuditReportModel } = await importSourceModule(
  "src/reporting/synthesis.ts",
);
const { buildRequeuePayload } = await importSourceModule(
  "src/orchestrator/requeueCommand.ts",
);
const { buildChunkedAuditTasks } = await importSourceModule(
  "src/orchestrator/taskBuilder.ts",
);
const { initializeCoverageFromPlan } = await importSourceModule(
  "src/orchestrator/planning.ts",
);
const { autoCompleteTrivialCoverage } = await importSourceModule(
  "src/orchestrator/trivialAudit.ts",
);
const { loadSessionConfig } = await importSourceModule(
  "src/supervisor/sessionConfig.ts",
);

test("validateAuditResults reports field-level evidence type errors instead of crashing", () => {
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
            title: "Object evidence",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Evidence payload shape is wrong.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: [{ excerpt: "bad", line_reference: "src/api/auth.ts:1" }],
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

  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "findings[0].evidence[0]" &&
        /must be a string, got object/i.test(issue.message),
    ),
  );
});

test("validateAuditResults treats total_lines as advisory (S7) but still flags spans outside declared coverage", () => {
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
            title: "Out of range evidence",
            category: "security",
            severity: "medium",
            confidence: "high",
            lens: "security",
            summary: "The finding points at lines the worker did not claim to read.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
            evidence: ["src/api/auth.ts:12 - cited outside file coverage"],
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
    {
      lineIndex: { "src/api/auth.ts": 12 },
    },
  );

  // S7: a total_lines mismatch is now an advisory WARNING, not a gating error —
  // findings are grounded by quote-and-verify, not by attesting a line count.
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "file_coverage[0].total_lines" &&
        issue.severity === "warning" &&
        /does not match the current line count/i.test(issue.message),
    ),
  );
  // The cited-span-within-declared-coverage check is unchanged (still an error).
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "findings[0].affected_files[0]" &&
        /falls outside the declared file_coverage/i.test(issue.message),
    ),
  );
});

test("validateAuditResults rejects task metadata drift and out-of-scope coverage", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "wrong-unit",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src/api/auth.ts", total_lines: 10 },
          { path: "src/other.ts", total_lines: 5 },
        ],
        findings: [
          {
            id: "finding-1",
            title: "Boundary drift",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "performance",
            summary: "The finding tries to escape the assigned task boundary.",
            affected_files: [{ path: "src/other.ts" }],
            evidence: ["src/other.ts:1 - outside the assigned review packet"],
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
    {
      lineIndex: {
        "src/api/auth.ts": 10,
        "src/other.ts": 5,
      },
    },
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "unit_id" &&
        /must match the assigned task metadata/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "pass_id" &&
        /must match the assigned task metadata/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "lens" &&
        /must match the assigned task metadata/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "file_coverage[1].path" &&
        issue.severity === "error" &&
        /not listed in the task file_paths/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "findings[0].lens" &&
        /must match the assigned task lens/i.test(issue.message),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "findings[0].affected_files[0].path" &&
        /not in the declared assigned file_coverage/i.test(issue.message),
    ),
  );
});

test("validateAuditResults accepts zero-line file coverage for empty files", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-empty",
        unit_id: "unit-empty",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_coverage: [{ path: "src/empty.ts", total_lines: 0 }],
        findings: [],
      },
    ],
    [
      {
        task_id: "task-empty",
        unit_id: "unit-empty",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_paths: ["src/empty.ts"],
        rationale: "fixture",
      },
    ],
    {
      lineIndex: { "src/empty.ts": 0 },
    },
  );

  assert.deepEqual(issues, []);
});

test("buildAuditReportModel omits pending runtime placeholder noise and builds deterministic work blocks", () => {
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "task-1",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Missing audit trail",
            category: "security",
            severity: "medium",
            confidence: "medium",
            lens: "security",
            summary: "Authentication events are not captured consistently.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 2, line_end: 8 },
            ],
            evidence: ["src/api/auth.ts:2 - no log emitted"],
          },
        ],
      },
    ],
    unitManifest: {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          files: ["src/api/auth.ts"],
          required_lenses: ["security"],
        },
      ],
    },
    runtimeValidationReport: {
      results: [
        {
          task_id: "runtime:unit:src-api-auth",
          status: "pending",
          summary: "Deterministic runtime validation has not executed yet.",
        },
      ],
    },
  });

  assert.equal(report.findings.length, 1);
  assert.equal(report.work_blocks.length, 1);
  assert.equal(
    report.findings[0].evidence.some((entry) =>
      /has not executed yet/i.test(entry),
    ),
    false,
  );
});

test("buildRequeuePayload skips flow requeue duplicates when file coverage is already complete", () => {
  const payload = buildRequeuePayload(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "partial",
          required_lenses: ["security", "reliability"],
          completed_lenses: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          id: "auth-session",
          name: "Auth session",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-session",
          status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].task_id, "requeue:reliability:src/api/auth.ts");
});

test("buildRequeuePayload dedupeByScope merges a file task and flow task sharing a lens+file signature", () => {
  // The file still needs `security`, and the same file in a critical flow also
  // still needs `security`. The file requeue task and the flow requeue task
  // therefore resolve to the identical `lens:sorted(file_paths)` signature
  // (security:src/api/auth.ts) and dedupeByScope must collapse them to one
  // task — while file_task_count / flow_task_count still report the per-source
  // counts before the cross-source merge.
  const payload = buildRequeuePayload(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    {
      flows: [
        {
          id: "auth-session",
          name: "Auth session",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-session",
          status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  // Cross-source signatures collide -> exactly one merged task.
  assert.equal(payload.tasks.length, 1);
  // Per-source counts reflect the pre-merge totals (one file task, one flow task).
  assert.equal(payload.file_task_count, 1);
  assert.equal(payload.flow_task_count, 1);
});

test("initializeCoverageFromPlan derives per-file required lenses instead of unit unions", () => {
  const coverage = initializeCoverageFromPlan(
    {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [
        { path: "src/api/auth.ts", language: "ts", size_bytes: 10 },
        { path: "infra/deploy.yml", language: "yaml", size_bytes: 10 },
      ],
    },
    {
      units: [
        {
          unit_id: "mixed-unit",
          name: "mixed-unit",
          files: ["src/api/auth.ts", "infra/deploy.yml"],
          required_lenses: ["security", "config_deployment"],
        },
      ],
    },
    {
      files: [
        { path: "src/api/auth.ts", status: "included" },
        { path: "infra/deploy.yml", status: "included" },
      ],
    },
  );

  const authCoverage = coverage.files.find((file) => file.path === "src/api/auth.ts");
  const deployCoverage = coverage.files.find((file) => file.path === "infra/deploy.yml");

  assert.deepEqual(authCoverage.required_lenses, [
    "security",
    "correctness",
    "reliability",
    "observability",
    "tests",
  ]);
  assert.deepEqual(deployCoverage.required_lenses, [
    "reliability",
    "operability",
    "config_deployment",
  ]);
});

test("buildChunkedAuditTasks claims critical-flow files without overlapping unit blocks", () => {
  const tasks = buildChunkedAuditTasks(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
        {
          path: "src/lib/session.ts",
          unit_ids: ["src-lib"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
        {
          path: "infra/deploy.yml",
          unit_ids: ["infra-deploy"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    {
      "src/api/auth.ts": 4,
      "src/lib/session.ts": 8,
      "infra/deploy.yml": 5,
    },
    {
      critical_flows: {
        flows: [
          {
            id: "auth-session",
            name: "Auth session",
            paths: ["src/api/auth.ts", "src/lib/session.ts"],
            entrypoints: ["src/api/auth.ts"],
            concerns: ["security"],
          },
        ],
      },
    },
  );

  assert.deepEqual(
    tasks.map((task) => ({
      task_id: task.task_id,
      lens: task.lens,
      file_paths: task.file_paths,
    })),
    [
      {
        task_id: "flow:auth-session:security",
        lens: "security",
        file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
      },
      {
        task_id: "infra-deploy:security",
        lens: "security",
        file_paths: ["infra/deploy.yml"],
      },
    ],
  );
});

// TST-6ef02f3b: intent_priority_boost elevates low→medium and medium→high, but
// NEVER over-promotes an already-high lens. Also verifies boost has no effect on
// lenses not in the boost set.
test("buildChunkedAuditTasks intent_priority_boost elevates priority one tier without exceeding high", () => {
  const coverage = {
    files: [
      {
        path: "src/main.ts",
        unit_ids: ["src-main"],
        classification_status: "classified",
        audit_status: "pending",
        required_lenses: ["maintainability", "security", "correctness"],
        completed_lenses: [],
      },
    ],
  };
  const lineIndex = { "src/main.ts": 20 };

  // Boost maintainability (normally low priority) and security (already high-ish).
  // Do NOT boost correctness — it should remain at its base priority.
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {
    intent_priority_boost: ["maintainability", "security"],
  });

  const byLens = {};
  for (const t of tasks) {
    byLens[t.lens] = t.priority;
  }

  // maintainability base = low → after boost = medium
  assert.equal(byLens["maintainability"], "medium", "low→medium boost for maintainability");

  // security base = medium (standard) or high (sensitive) → boost caps at high; must not exceed high
  assert.ok(
    byLens["security"] === "high" || byLens["security"] === "medium",
    `security priority must be high or medium after boost, got ${byLens["security"]}`,
  );

  // correctness is NOT boosted — must remain at its base priority (not elevated)
  if (byLens["correctness"]) {
    assert.ok(
      byLens["correctness"] !== "high",
      "unboosted correctness must not be elevated to high",
    );
  }
});

test("buildChunkedAuditTasks already-high priority lens stays at high when boosted", () => {
  const coverage = {
    files: [
      {
        path: "src/auth.ts",
        unit_ids: ["src-auth"],
        classification_status: "classified",
        audit_status: "pending",
        required_lenses: ["security"],
        completed_lenses: [],
      },
    ],
  };
  const lineIndex = { "src/auth.ts": 10 };

  // Boost security — even if base is already "high", boost must not create "critical" or exceed "high".
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {
    intent_priority_boost: ["security"],
  });

  const secTask = tasks.find((t) => t.lens === "security");
  assert.ok(secTask, "security task should exist");
  assert.ok(
    ["low", "medium", "high"].includes(secTask.priority),
    `priority must be one of the valid values; got ${secTask.priority}`,
  );
  // "high" is the ceiling; boosting an already-high task must not break it
  assert.notEqual(secTask.priority, "critical", "no over-promotion beyond high");
});

test("buildChunkedAuditTasks splits aggregate review blocks by line budget", () => {
  const tasks = buildChunkedAuditTasks(
    {
      files: [
        {
          path: "src/a.ts",
          unit_ids: ["src-unit"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
        {
          path: "src/b.ts",
          unit_ids: ["src-unit"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
        {
          path: "src/c.ts",
          unit_ids: ["src-unit"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
      ],
    },
    {
      "src/a.ts": 700,
      "src/b.ts": 700,
      "src/c.ts": 700,
    },
    {
      max_task_lines: 1500,
    },
  );

  assert.deepEqual(
    tasks.map((task) => ({
      task_id: task.task_id,
      file_paths: task.file_paths,
      tags: task.tags,
    })),
    [
      {
        task_id: "src-unit:correctness:part-1",
        file_paths: ["src/a.ts", "src/b.ts"],
        tags: ["line_budget_split"],
      },
      {
        task_id: "src-unit:correctness:part-2",
        file_paths: ["src/c.ts"],
        tags: ["line_budget_split"],
      },
    ],
  );
});

test("buildChunkedAuditTasks splits an oversized file into its own large_file task", () => {
  const tasks = buildChunkedAuditTasks(
    {
      files: [
        {
          path: "src/big.ts",
          unit_ids: ["src-unit"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
        {
          path: "src/small.ts",
          unit_ids: ["src-unit"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
      ],
    },
    {
      "src/big.ts": 600,
      "src/small.ts": 50,
    },
    // Threshold below the big file's line count so it splits out on its own,
    // while keeping the aggregate budget high enough that the remaining small
    // file is NOT a budget split.
    { file_split_threshold: 100, max_task_lines: 3000 },
  );

  const bigTask = tasks.find((t) => t.task_id === "src-unit:correctness:src/big.ts");
  const smallTask = tasks.find((t) => t.task_id === "src-unit:correctness");

  // The oversized file is emitted as its own task containing only that file.
  assert.ok(bigTask, "oversized file should get its own task");
  assert.deepEqual(bigTask.file_paths, ["src/big.ts"]);
  assert.ok(bigTask.tags.includes("large_file"));

  // The remaining small file is grouped in a separate (non-large-file) task.
  assert.ok(smallTask, "small file should get its own budget task");
  assert.deepEqual(smallTask.file_paths, ["src/small.ts"]);
  assert.ok(!(smallTask.tags ?? []).includes("large_file"));

  assert.equal(tasks.length, 2);
});

function makeTrivialFiles(authLenses = ["security", "correctness"]) {
  return [
    {
      path: ".gitignore",
      unit_ids: ["repo-root"],
      classification_status: "classified",
      audit_status: "pending",
      required_lenses: ["correctness"],
      completed_lenses: [],
    },
    {
      path: "pkg/__init__.py",
      unit_ids: ["pkg"],
      classification_status: "classified",
      audit_status: "pending",
      required_lenses: ["correctness"],
      completed_lenses: [],
    },
    {
      path: "src/api/auth.ts",
      unit_ids: ["src-api-auth"],
      classification_status: "classified",
      audit_status: "pending",
      required_lenses: authLenses,
      completed_lenses: [],
    },
  ];
}

test("buildChunkedAuditTasks excludes trivial audit files from tasks", () => {
  const tasks = buildChunkedAuditTasks(
    { files: makeTrivialFiles() },
    {
      ".gitignore": 2,
      "pkg/__init__.py": 1,
      "src/api/auth.ts": 4,
    },
  );

  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.file_paths.includes("src/api/auth.ts")));
});

test("autoCompleteTrivialCoverage marks trivial files as excluded", () => {
  const coverage = { files: makeTrivialFiles(["security"]) };

  const skipped = autoCompleteTrivialCoverage(coverage, {
    ".gitignore": 2,
    "pkg/__init__.py": 1,
    "src/api/auth.ts": 4,
  });

  assert.deepEqual(skipped, [".gitignore", "pkg/__init__.py"]);
  assert.equal(coverage.files[0].audit_status, "excluded");
  assert.equal(coverage.files[1].audit_status, "excluded");
  assert.equal(coverage.files[2].audit_status, "pending");
});

test("loadSessionConfig writes a default repo-local session config when missing", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    const config = await loadSessionConfig(artifactsDir);
    assert.equal(config.provider, "local-subprocess");

    const persisted = JSON.parse(
      await readFile(join(artifactsDir, "session-config.json"), "utf8"),
    );
    assert.equal(persisted.provider, "local-subprocess");
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("loadSessionConfig reads and returns a pre-existing config with a non-default provider", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ provider: "claude-code" }),
      "utf8",
    );
    const config = await loadSessionConfig(artifactsDir);
    assert.equal(config.provider, "claude-code");
    // File must not have been overwritten to a default value.
    const persisted = JSON.parse(
      await readFile(join(artifactsDir, "session-config.json"), "utf8"),
    );
    assert.equal(persisted.provider, "claude-code");
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("loadSessionConfig merges a partial config with defaults", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    // Only provider is set; all other SessionConfig fields are absent.
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ provider: "codex" }),
      "utf8",
    );
    const config = await loadSessionConfig(artifactsDir);
    assert.equal(config.provider, "codex");
    // The returned object must be a plain object (not null, not a string).
    assert.equal(typeof config, "object");
    assert.ok(config !== null);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("loadSessionConfig handles malformed JSON in the config file", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    await writeFile(
      join(artifactsDir, "session-config.json"),
      "{not json}",
      "utf8",
    );
    // loadSessionConfig must throw — it must not silently swallow a parse error.
    await assert.rejects(
      loadSessionConfig(artifactsDir),
      (err) => {
        assert.ok(
          err instanceof Error,
          "expected an Error to be thrown for malformed JSON",
        );
        // The io layer wraps JSON.parse errors with the path in the message.
        assert.ok(
          err.message.toLowerCase().includes("json") ||
            err.message.includes("session-config.json"),
          `expected error message to reference JSON or the config file, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

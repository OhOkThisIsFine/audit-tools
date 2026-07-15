import { test, expect } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const {
  buildAuditPlanMetrics,
  buildReviewPackets,
  orderTasksForPacketReview,
} = await import("../../src/audit/orchestrator/reviewPackets.ts");
const { buildChunkedAuditTasks } = await import("../../src/audit/orchestrator/taskBuilder.ts");
const { runCli } = await import("../../src/audit/cli.ts");

function makeTask(task_id, lens, overrides = {}) {
  return {
    task_id,
    unit_id: "src-auth",
    pass_id: `pass:${lens}`,
    lens,
    file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
    file_line_counts: {
      "src/api/auth.ts": 40,
      "src/lib/session.ts": 30,
    },
    rationale: `Review auth under ${lens}.`,
    priority: "medium",
    ...overrides,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-code-packets-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("review packets group related lenses without changing task identity", () => {
  const tasks = [
    makeTask("src-auth:security", "security", { priority: "high" }),
    makeTask("src-auth:correctness", "correctness"),
    makeTask("src-auth:reliability", "reliability"),
  ];

  const packets = buildReviewPackets(tasks);
  const metrics = buildAuditPlanMetrics(tasks, {
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-auth:security",
    "src-auth:correctness",
    "src-auth:reliability",
  ]);
  expect(packets[0].lenses).toEqual([
    "security",
    "correctness",
    "reliability",
  ]);
  expect(packets[0].total_lines).toBe(70);
  expect(metrics.task_count).toBe(3);
  expect(metrics.packet_count).toBe(1);
  expect(metrics.estimated_agent_reduction).toBe(2);
  expect(metrics.repeated_line_reference_count).toBe(140);
  expect(metrics.packet_quality.weakly_explained_packet_count).toBe(1);
  expect(metrics.packet_quality.weakly_explained_gap_counts).toEqual({
    missing_internal_edges: 1,
    unexplained_files: 0,
    partial_cohesion: 0,
  });
  expect(metrics.packet_quality.weakly_explained_file_extension_counts).toEqual({
      ".ts": 2,
    });
  expect(metrics.packet_quality.weakly_explained_packet_ids).toEqual([
    packets[0].packet_id,
  ]);
  expect(metrics.packet_quality.weakly_explained_packet_samples).toEqual([
    {
      packet_id: packets[0].packet_id,
      primary_gap: "missing_internal_edges",
      file_count: 2,
      sample_file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
      cohesion_score: 0,
      internal_edge_count: 0,
      boundary_edge_count: 0,
      unexplained_file_count: 2,
    },
  ]);
});

test("packet ordering keeps related tasks adjacent for provider batches", () => {
  const ordered = orderTasksForPacketReview([
    makeTask("src-auth:tests", "tests"),
    makeTask("src-other:correctness", "correctness", {
      unit_id: "src-other",
      file_paths: ["src/other.ts"],
      file_line_counts: { "src/other.ts": 10 },
    }),
    makeTask("src-auth:security", "security", { priority: "high" }),
  ]);

  expect(ordered.map((task) => task.task_id)).toEqual(["src-auth:security", "src-auth:tests", "src-other:correctness"]);
});

test("review packets merge graph-connected task groups within packet budgets", () => {
  const tasks = [
    makeTask("src-auth:security", "security", {
      unit_id: "src-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-session:correctness", "correctness", {
      unit_id: "src-session",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
    }),
  ];

  const graphBundle = {
    graphs: {
      imports: [
        {
          from: "src/api/auth.ts",
          to: "src/lib/session.ts",
          kind: "esm",
        },
      ],
    },
  };
  const packets = buildReviewPackets(tasks, { graphBundle });
  const metrics = buildAuditPlanMetrics(tasks, {
    graphBundle,
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-auth:security",
    "src-session:correctness",
  ]);
  expect(packets[0].file_paths).toEqual([
    "src/api/auth.ts",
    "src/lib/session.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "src/api/auth.ts",
      to: "src/lib/session.ts",
      kind: "esm",
      confidence: 0.8,
    },
  ]);
  expect(packets[0].quality).toEqual({
    cohesion_score: 1,
    internal_edge_count: 1,
    boundary_edge_count: 0,
    unexplained_file_count: 0,
  });
  expect(metrics.packet_quality.merge_edge_kind_counts).toEqual({ esm: 1 });
  expect(metrics.packet_quality.boundary_edge_kind_counts).toEqual({});
  expect(metrics.packet_quality.weakly_explained_packet_count).toBe(0);
  expect(metrics.packet_quality.weakly_explained_gap_counts).toEqual({
    missing_internal_edges: 0,
    unexplained_files: 0,
    partial_cohesion: 0,
  });
  expect(metrics.packet_quality.weakly_explained_file_extension_counts).toEqual({});
  expect(metrics.packet_quality.weakly_explained_packet_samples).toEqual([]);
});

test("review packets co-pack source and test tasks linked by graph evidence", () => {
  const tasks = [
    makeTask("src-auth:security", "security", {
      unit_id: "src-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-auth-test:tests", "tests", {
      unit_id: "src-auth-test",
      file_paths: ["src/api/auth.test.ts"],
      file_line_counts: { "src/api/auth.test.ts": 24 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        references: [
          {
            from: "src/api/auth.test.ts",
            to: "src/api/auth.ts",
            kind: "test-source-link",
            confidence: 0.88,
            reason: "Test path naming maps to source path 'src/api/auth.ts'.",
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-auth:security",
    "src-auth-test:tests",
  ]);
  expect(packets[0].file_paths).toEqual([
    "src/api/auth.test.ts",
    "src/api/auth.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "src/api/auth.test.ts",
      to: "src/api/auth.ts",
      kind: "test-source-link",
      confidence: 0.88,
      reason: "Test path naming maps to source path 'src/api/auth.ts'.",
    },
  ]);
  expect(packets[0].quality.cohesion_score).toBe(1);
});

test("review packets co-pack route files with imported handlers and expose entrypoints", () => {
  const tasks = [
    makeTask("src-route:correctness", "correctness", {
      unit_id: "src-route",
      file_paths: ["src/routes/auth.ts"],
      file_line_counts: { "src/routes/auth.ts": 28 },
      priority: "medium",
    }),
    makeTask("src-handler:security", "security", {
      unit_id: "src-handler",
      file_paths: ["src/handlers/auth.ts"],
      file_line_counts: { "src/handlers/auth.ts": 42 },
      priority: "high",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        calls: [
          {
            from: "src/routes/auth.ts",
            to: "src/handlers/auth.ts",
            kind: "route-handler-link",
            confidence: 0.92,
            reason:
              "Route POST '/login' passes handler 'login' from '../handlers/auth'.",
          },
        ],
        routes: [
          {
            path: "/login",
            handler: "src/handlers/auth.ts",
            method: "POST",
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-handler:security",
    "src-route:correctness",
  ]);
  expect(packets[0].entrypoints).toEqual([
    "POST /login -> src/handlers/auth.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "src/routes/auth.ts",
      to: "src/handlers/auth.ts",
      kind: "route-handler-link",
      confidence: 0.92,
      reason:
        "Route POST '/login' passes handler 'login' from '../handlers/auth'.",
    },
  ]);
});

test("review packets bridge entrypoint flow paths through boundary-only files", () => {
  const tasks = [
    makeTask("src-route:correctness", "correctness", {
      unit_id: "src-route",
      file_paths: ["src/routes/auth.ts"],
      file_line_counts: { "src/routes/auth.ts": 28 },
      priority: "high",
    }),
    makeTask("src-session-repo:data", "data_integrity", {
      unit_id: "src-session-repo",
      file_paths: ["src/data/sessionRepo.ts"],
      file_line_counts: { "src/data/sessionRepo.ts": 36 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        imports: [
          {
            from: "src/handlers/auth.ts",
            to: "src/data/sessionRepo.ts",
            kind: "esm",
            confidence: 0.95,
            reason: "Resolved esm specifier '../data/sessionRepo'.",
          },
        ],
        calls: [
          {
            from: "src/routes/auth.ts",
            to: "src/handlers/auth.ts",
            kind: "route-handler-link",
            confidence: 0.92,
            reason:
              "Route POST '/login' passes handler 'login' from '../handlers/auth'.",
          },
        ],
        routes: [
          {
            path: "/login",
            handler: "src/handlers/auth.ts",
            method: "POST",
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-route:correctness",
    "src-session-repo:data",
  ]);
  expect(packets[0].file_paths).toEqual([
    "src/data/sessionRepo.ts",
    "src/routes/auth.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "src/routes/auth.ts",
      to: "src/data/sessionRepo.ts",
      kind: "entrypoint-flow-link",
      confidence: 0.92,
      reason:
        "Entrypoint flow from 'src/routes/auth.ts' reaches 'src/data/sessionRepo.ts' via src/handlers/auth.ts.",
    },
  ]);
  expect(packets[0].boundary_files).toEqual(["src/handlers/auth.ts"]);
  expect(packets[0].quality).toEqual({
    cohesion_score: 1,
    internal_edge_count: 1,
    boundary_edge_count: 2,
    unexplained_file_count: 0,
  });
});

test("entrypoint flow bridges do not traverse high fan shared files", () => {
  const routeTask = makeTask("src-route:correctness", "correctness", {
    unit_id: "src-route",
    file_paths: ["src/routes/auth.ts"],
    file_line_counts: { "src/routes/auth.ts": 28 },
    priority: "high",
  });
  const leafTask = makeTask("src-leaf:security", "security", {
    unit_id: "src-leaf",
    file_paths: ["src/features/leaf.ts"],
    file_line_counts: { "src/features/leaf.ts": 24 },
    priority: "medium",
  });
  const fanOutEdges = Array.from({ length: 13 }, (_, index) => ({
    from: "src/shared/router.ts",
    to: `src/features/feature-${index}.ts`,
    kind: "esm",
    confidence: 0.95,
  }));

  const packets = buildReviewPackets([routeTask, leafTask], {
    graphBundle: {
      graphs: {
        imports: [
          {
            from: "src/shared/router.ts",
            to: "src/features/leaf.ts",
            kind: "esm",
            confidence: 0.95,
          },
          ...fanOutEdges,
        ],
        calls: [
          {
            from: "src/routes/auth.ts",
            to: "src/shared/router.ts",
            kind: "route-handler-link",
            confidence: 0.92,
          },
        ],
        routes: [
          {
            path: "/login",
            handler: "src/shared/router.ts",
            method: "POST",
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(2);
  expect(packets.every(
      (packet) =>
        packet.key_edges?.some((edge) => edge.kind === "entrypoint-flow-link") !==
        true,
    )).toBeTruthy();
});

test("review packets cluster bounded subsystem tasks without graph evidence", () => {
  const tasks = [
    makeTask("src-billing-invoice:security", "security", {
      unit_id: "src-billing-invoice",
      file_paths: ["src/features/billing/invoice.ts"],
      file_line_counts: { "src/features/billing/invoice.ts": 42 },
      priority: "high",
    }),
    makeTask("src-billing-discounts:correctness", "correctness", {
      unit_id: "src-billing-discounts",
      file_paths: ["src/features/billing/discounts.ts"],
      file_line_counts: { "src/features/billing/discounts.ts": 36 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks);

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "src-billing-invoice:security",
    "src-billing-discounts:correctness",
  ]);
  expect(packets[0].file_paths).toEqual([
    "src/features/billing/discounts.ts",
    "src/features/billing/invoice.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "src/features/billing/discounts.ts",
      to: "src/features/billing/invoice.ts",
      kind: "subsystem-cluster-link",
      confidence: 0.7,
      reason:
        "Bounded subsystem cluster 'src/features/billing' groups 2 file(s) without stronger graph evidence.",
    },
  ]);
  expect(packets[0].quality).toEqual({
    cohesion_score: 1,
    internal_edge_count: 1,
    boundary_edge_count: 0,
    unexplained_file_count: 0,
  });
});

test("review packets cluster bounded package-owned tasks across subdirectories", () => {
  const tasks = [
    makeTask("pkg-auth-api:security", "security", {
      unit_id: "pkg-auth-api",
      file_paths: ["packages/auth/src/api/login.ts"],
      file_line_counts: { "packages/auth/src/api/login.ts": 44 },
      priority: "high",
    }),
    makeTask("pkg-auth-session:correctness", "correctness", {
      unit_id: "pkg-auth-session",
      file_paths: ["packages/auth/src/lib/session.ts"],
      file_line_counts: { "packages/auth/src/lib/session.ts": 38 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        references: [
          {
            from: "packages/auth/package.json",
            to: "packages/auth/src/index.ts",
            kind: "package-entrypoint-link",
            confidence: 0.9,
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(1);
  expect(packets[0].task_ids).toEqual([
    "pkg-auth-api:security",
    "pkg-auth-session:correctness",
  ]);
  expect(packets[0].file_paths).toEqual([
    "packages/auth/src/api/login.ts",
    "packages/auth/src/lib/session.ts",
  ]);
  expect(packets[0].key_edges).toEqual([
    {
      from: "packages/auth/src/api/login.ts",
      to: "packages/auth/src/lib/session.ts",
      kind: "package-ownership-link",
      confidence: 0.68,
      reason:
        "Package ownership root 'packages/auth' groups 2 file(s) across bounded package subdirectories.",
    },
  ]);
  expect(packets[0].quality).toEqual({
    cohesion_score: 1,
    internal_edge_count: 1,
    boundary_edge_count: 0,
    unexplained_file_count: 0,
  });
});

function assertOwnershipRootCase({
  taskPrefix,
  apiPath,
  storePath,
  referenceEdges,
  expectedTaskIds,
  expectedKeyEdge,
  assertMetrics = false,
}) {
  const tasks = [
    makeTask(`${taskPrefix}-api:security`, "security", {
      unit_id: `${taskPrefix}-api`,
      file_paths: [apiPath],
      file_line_counts: { [apiPath]: 44 },
      priority: "high",
    }),
    makeTask(`${taskPrefix}-store:correctness`, "correctness", {
      unit_id: `${taskPrefix}-store`,
      file_paths: [storePath],
      file_line_counts: { [storePath]: 36 },
      priority: "medium",
    }),
  ];
  const graphBundle = { graphs: { references: referenceEdges } };
  const packets = buildReviewPackets(tasks, { graphBundle });

  // Verify: two tasks are clustered through the ownership root
  expect(packets.length, "Expected single packet from ownership clustering").toBe(1);
  expect(packets[0].task_ids, "Task IDs should match expected").toEqual(expectedTaskIds);

  // Verify: key_edges entry includes ecosystem-specific edge kind and reason wording
  expect(packets[0].key_edges, "Key edges should match expected edge with ecosystem-specific kind and reason").toEqual([expectedKeyEdge]);

  if (assertMetrics) {
    const metrics = buildAuditPlanMetrics(tasks, {
      graphBundle,
      generatedAt: new Date("2026-04-22T00:00:00Z"),
    });

    // Verify: case produces expected edge kind in metrics
    expect(metrics.packet_quality.merge_edge_kind_counts, "Metrics should reflect the ecosystem-specific edge kind").toEqual({
      [expectedKeyEdge.kind]: 1,
    });
  }
}

const projectConfigOwnershipReason =
  "Module ownership root 'packages/auth' from project configuration groups 2 file(s) across bounded subdirectories.";

const ownershipRootCases = [
  {
    name: "workspace package links seed package ownership clustering",
    taskPrefix: "pkg-auth",
    apiPath: "packages/auth/src/api/login.ts",
    storePath: "packages/auth/src/store/users.ts",
    referenceEdges: [
      {
        from: "package.json",
        to: "packages/auth/package.json",
        kind: "workspace-package-link",
        confidence: 0.86,
      },
    ],
    expectedTaskIds: ["pkg-auth-api:security", "pkg-auth-store:correctness"],
    expectedKeyEdge: {
      from: "packages/auth/src/api/login.ts",
      to: "packages/auth/src/store/users.ts",
      kind: "package-ownership-link",
      confidence: 0.68,
      reason:
        "Package ownership root 'packages/auth' groups 2 file(s) across bounded package subdirectories.",
    },
  },
  {
    name: "typescript project references seed module ownership clustering",
    taskPrefix: "pkg-auth",
    apiPath: "packages/auth/src/api/login.ts",
    storePath: "packages/auth/src/store/users.ts",
    referenceEdges: [
      {
        from: "tsconfig.json",
        to: "packages/auth/tsconfig.json",
        kind: "typescript-project-reference-link",
        confidence: 0.87,
      },
    ],
    expectedTaskIds: ["pkg-auth-api:security", "pkg-auth-store:correctness"],
    expectedKeyEdge: {
      from: "packages/auth/src/api/login.ts",
      to: "packages/auth/src/store/users.ts",
      kind: "module-ownership-link",
      confidence: 0.66,
      reason: projectConfigOwnershipReason,
    },
  },
  {
    name: "go workspace module links seed module ownership clustering",
    taskPrefix: "go-auth",
    apiPath: "packages/auth/api/login.go",
    storePath: "packages/auth/store/users.go",
    referenceEdges: [
      {
        from: "go.work",
        to: "packages/auth/go.mod",
        kind: "go-workspace-module-link",
        confidence: 0.87,
      },
    ],
    expectedTaskIds: ["go-auth-api:security", "go-auth-store:correctness"],
    expectedKeyEdge: {
      from: "packages/auth/api/login.go",
      to: "packages/auth/store/users.go",
      kind: "module-ownership-link",
      confidence: 0.66,
      reason: projectConfigOwnershipReason,
    },
  },
  {
    name: "cargo workspace member links seed module ownership clustering",
    taskPrefix: "rust-auth",
    apiPath: "packages/auth/src/api.rs",
    storePath: "packages/auth/src/store.rs",
    referenceEdges: [
      {
        from: "Cargo.toml",
        to: "packages/auth/Cargo.toml",
        kind: "cargo-workspace-member-link",
        confidence: 0.87,
      },
    ],
    expectedTaskIds: ["rust-auth-api:security", "rust-auth-store:correctness"],
    expectedKeyEdge: {
      from: "packages/auth/src/api.rs",
      to: "packages/auth/src/store.rs",
      kind: "module-ownership-link",
      confidence: 0.66,
      reason: projectConfigOwnershipReason,
    },
  },
  {
    name: "maven module links seed module ownership clustering",
    taskPrefix: "java-auth",
    apiPath: "packages/auth/api/src/main/java/AuthController.java",
    storePath: "packages/auth/store/src/main/java/UserRepository.java",
    referenceEdges: [
      {
        from: "pom.xml",
        to: "packages/auth/pom.xml",
        kind: "maven-module-link",
        confidence: 0.87,
      },
    ],
    expectedTaskIds: ["java-auth-api:security", "java-auth-store:correctness"],
    expectedKeyEdge: {
      from: "packages/auth/api/src/main/java/AuthController.java",
      to: "packages/auth/store/src/main/java/UserRepository.java",
      kind: "module-ownership-link",
      confidence: 0.66,
      reason: projectConfigOwnershipReason,
    },
  },
  {
    name: "analyzer ownership root links seed module ownership clustering",
    taskPrefix: "py-billing",
    apiPath: "src/billing/api.py",
    storePath: "src/billing/store.py",
    referenceEdges: [
      {
        from: "src/billing",
        to: "src/billing/api.py",
        kind: "analyzer-ownership-root-link",
        confidence: 0.84,
        reason: "pyright reports python-package ownership root 'src/billing'.",
      },
      {
        from: "src/billing",
        to: "src/billing/store.py",
        kind: "analyzer-ownership-root-link",
        confidence: 0.84,
        reason: "pyright reports python-package ownership root 'src/billing'.",
      },
    ],
    expectedTaskIds: ["py-billing-api:security", "py-billing-store:correctness"],
    expectedKeyEdge: {
      from: "src/billing/api.py",
      to: "src/billing/store.py",
      kind: "module-ownership-link",
      confidence: 0.66,
      reason:
        "Module ownership root 'src/billing' from analyzer ownership hint groups 2 file(s) across bounded subdirectories.",
    },
    assertMetrics: true,
  },
];

// Table-driven test cases for ownership root clustering
// Each ecosystem case supplies its own path inputs, edge kind metadata, and expected reason text
// Case names identify the ecosystem so regressions are reported distinctly
for (const ownershipRootCase of ownershipRootCases) {
  test(`ownership root clustering: ${ownershipRootCase.name}`, () => {
    assertOwnershipRootCase(ownershipRootCase);
  });
}

test("module ownership clustering ignores repository root tsconfig files", () => {
  const tasks = [
    makeTask("src-api-auth:security", "security", {
      unit_id: "src-api-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-lib-session:correctness", "correctness", {
      unit_id: "src-lib-session",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 32 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        references: [
          {
            from: "tsconfig.json",
            to: "src/index.ts",
            kind: "typescript-project-reference-link",
            confidence: 0.87,
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(2);
  expect(packets.every(
      (packet) =>
        packet.key_edges?.some((edge) => edge.kind === "module-ownership-link") !==
        true,
    )).toBeTruthy();
});

test("package ownership clustering ignores repository root package manifests", () => {
  const tasks = [
    makeTask("src-api-auth:security", "security", {
      unit_id: "src-api-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-lib-session:correctness", "correctness", {
      unit_id: "src-lib-session",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 32 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        references: [
          {
            from: "package.json",
            to: "src/index.ts",
            kind: "package-entrypoint-link",
            confidence: 0.9,
          },
        ],
      },
    },
  });

  expect(packets.length).toBe(2);
  expect(packets.every(
      (packet) =>
        packet.key_edges?.some((edge) => edge.kind === "package-ownership-link") !==
        true,
    )).toBeTruthy();
});

test("subsystem clustering ignores broad source directories", () => {
  const tasks = [
    makeTask("src-api-auth:security", "security", {
      unit_id: "src-api-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-api-users:correctness", "correctness", {
      unit_id: "src-api-users",
      file_paths: ["src/api/users.ts"],
      file_line_counts: { "src/api/users.ts": 32 },
      priority: "medium",
    }),
  ];

  const packets = buildReviewPackets(tasks);

  expect(packets.length).toBe(2);
  expect(packets.every(
      (packet) =>
        packet.key_edges?.some((edge) => edge.kind === "subsystem-cluster-link") !==
        true,
    )).toBeTruthy();
});

test("weak graph edges remain boundary context instead of forcing packet expansion", () => {
  const tasks = [
    makeTask("src-auth:security", "security", {
      unit_id: "src-auth",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      priority: "high",
    }),
    makeTask("src-session:correctness", "correctness", {
      unit_id: "src-session",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
    }),
  ];

  const graphBundle = {
    graphs: {
      imports: [
        {
          from: "src/api/auth.ts",
          to: "src/lib/session.ts",
          kind: "heuristic-auth-session-link",
          confidence: 0.55,
          reason: "Name-based auth/session proximity.",
        },
      ],
    },
  };
  const packets = buildReviewPackets(tasks, { graphBundle });
  const metrics = buildAuditPlanMetrics(tasks, {
    graphBundle,
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });

  expect(packets.length).toBe(2);
  const authPacket = packets.find((packet) =>
    packet.file_paths.includes("src/api/auth.ts"),
  );
  const sessionPacket = packets.find((packet) =>
    packet.file_paths.includes("src/lib/session.ts"),
  );
  expect(authPacket).toBeTruthy();
  expect(sessionPacket).toBeTruthy();
  expect(authPacket.key_edges).toBe(undefined);
  expect(authPacket.boundary_files).toEqual(["src/lib/session.ts"]);
  expect(sessionPacket.boundary_files).toEqual(["src/api/auth.ts"]);
  expect(metrics.packet_quality.boundary_crossing_count).toBe(2);
  expect(metrics.packet_quality.merge_edge_kind_counts).toEqual({});
  expect(metrics.packet_quality.boundary_edge_kind_counts).toEqual({
    "heuristic-auth-session-link": 1,
  });
  expect(metrics.packet_quality.average_cohesion_score).toBe(1);
  expect(metrics.packet_quality.weakly_explained_packet_count).toBe(0);
});

test("high fan-in graph edges do not collapse shared files into every packet", () => {
  const sharedTask = makeTask("src-shared:correctness", "correctness", {
    unit_id: "src-shared",
    file_paths: ["src/shared/util.ts"],
    file_line_counts: { "src/shared/util.ts": 20 },
  });
  const featureTasks = Array.from({ length: 13 }, (_, index) =>
    makeTask(`src-feature-${index}:correctness`, "correctness", {
      unit_id: `src-feature-${index}`,
      file_paths: [`src/features/feature-${index}.ts`],
      file_line_counts: { [`src/features/feature-${index}.ts`]: 20 },
    }),
  );
  const graphBundle = {
    graphs: {
      imports: featureTasks.map((task) => ({
        from: task.file_paths[0],
        to: "src/shared/util.ts",
        kind: "esm",
        confidence: 0.95,
      })),
    },
  };

  const tasks = [sharedTask, ...featureTasks];
  const packets = buildReviewPackets(tasks, { graphBundle });
  const metrics = buildAuditPlanMetrics(tasks, {
    graphBundle,
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });

  expect(packets.length).toBe(tasks.length);
  expect(metrics.packet_quality.high_fan_in_file_count).toBe(1);
  expect(metrics.packet_quality.largest_unexplained_packet_files).toBe(0);
});

test("directory-proximity merge combines small packets sharing a deep directory", () => {
  // Three tasks in src/services/payments/ (depth 3) — should merge into one packet.
  // One task in src/utils/ (depth 2) — should stay separate (depth < 3).
  const tasks = [
    makeTask("payments-validate:security", "security", {
      unit_id: "payments-validate",
      file_paths: ["src/services/payments/validate.ts"],
      file_line_counts: { "src/services/payments/validate.ts": 30 },
    }),
    makeTask("payments-charge:security", "security", {
      unit_id: "payments-charge",
      file_paths: ["src/services/payments/charge.ts"],
      file_line_counts: { "src/services/payments/charge.ts": 25 },
    }),
    makeTask("payments-refund:security", "security", {
      unit_id: "payments-refund",
      file_paths: ["src/services/payments/refund.ts"],
      file_line_counts: { "src/services/payments/refund.ts": 20 },
    }),
    makeTask("utils-format:security", "security", {
      unit_id: "utils-format",
      file_paths: ["src/utils/format.ts"],
      file_line_counts: { "src/utils/format.ts": 15 },
    }),
  ];

  const packets = buildReviewPackets(tasks);

  // The three payments tasks share src/services/payments (depth 3) → merged.
  // The utils task stays alone (src/utils is depth 2 < minDepth 3).
  expect(packets.length, `expected 2 packets, got ${packets.length}`).toBe(2);
  const paymentsPacket = packets.find((p) =>
    p.file_paths.includes("src/services/payments/validate.ts"),
  );
  expect(paymentsPacket, "should have a payments packet").toBeTruthy();
  expect(paymentsPacket.file_paths.includes("src/services/payments/charge.ts"), "payments packet should include charge.ts").toBeTruthy();
  expect(paymentsPacket.file_paths.includes("src/services/payments/refund.ts"), "payments packet should include refund.ts").toBeTruthy();
  const utilsPacket = packets.find((p) =>
    p.file_paths.includes("src/utils/format.ts"),
  );
  expect(utilsPacket, "should have a utils packet").toBeTruthy();
  expect(!utilsPacket.file_paths.includes("src/services/payments/validate.ts"), "utils packet should not include payments files").toBeTruthy();
});

test("tiny test files batch across unit boundaries per lens", () => {
  const tasks = buildChunkedAuditTasks(
    {
      files: [
        {
          path: "tests/a.test.mjs",
          unit_ids: ["tests-a"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["tests", "maintainability"],
          completed_lenses: [],
        },
        {
          path: "tests/b.test.mjs",
          unit_ids: ["tests-b"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["tests", "maintainability"],
          completed_lenses: [],
        },
      ],
    },
    {
      "tests/a.test.mjs": 20,
      "tests/b.test.mjs": 30,
    },
    {
      tiny_test_file_lines: 50,
    },
  );

  expect(tasks.map((task) => ({
      task_id: task.task_id,
      unit_id: task.unit_id,
      lens: task.lens,
      file_paths: task.file_paths,
    }))).toEqual([
      {
        task_id: "tests-tiny-files:maintainability",
        unit_id: "tests-tiny-files",
        lens: "maintainability",
        file_paths: ["tests/a.test.mjs", "tests/b.test.mjs"],
      },
      {
        task_id: "tests-tiny-files:tests",
        unit_id: "tests-tiny-files",
        lens: "tests",
        file_paths: ["tests/a.test.mjs", "tests/b.test.mjs"],
      },
    ]);
});

test("prepare-dispatch writes one packet prompt for multiple task outputs", async () => {
  await withTempDir(async (artifactsDir) => {
    const runId = "run-1";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify(
        [
          makeTask("src-auth:security", "security"),
          makeTask("src-auth:correctness", "correctness"),
        ],
        null,
        2,
      ),
    );

    const captured = await captureConsole(() =>
      runCli([
        process.execPath,
        join(repoRoot, "dist", "audit", "cli.js"),
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
      ]),
    );

    const summary = JSON.parse(captured.stdout);
    expect(summary.run_id).toBe(runId);
    expect(summary.packet_count).toBe(1);
    expect(summary.task_count).toBe(2);
    expect(summary.warning_count).toBe(0);
    expect(summary.dispatch_warnings_path).toBe(null);
    expect(summary.dispatch_plan_path).toBe(join(runDir, "dispatch-plan.json"));

    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    expect(plan.length).toBe(1);
    expect(summary.largest_packet.packet_id).toBe(plan[0].packet_id);
    expect(summary.largest_packet.total_lines).toBe(70);
    expect(summary.largest_packet.estimated_tokens > 0).toBe(true);
    expect(Object.keys(plan[0]).sort()).toEqual([
      "access",
      "complexity",
      "description",
      "file_paths",
      "model_hint",
      "packet_id",
      "prompt_path",
      "result_path",
    ]);
    expect(plan[0].complexity).toEqual({
      priority: "medium",
      task_count: 2,
      file_count: 2,
      total_lines: 70,
      estimated_tokens: 1180,
      lenses: ["security", "correctness"],
      tags: [],
      large_file_mode: false,
    });
    // Tasks here carry no frozen risk_estimate, so the rebuilt affinity graph
    // reports routing_risk 0 and the standard-floor escalators set the tier.
    expect(plan[0].model_hint).toEqual({
      tier: "standard",
      reasons: ["routing_risk:0.00", "sensitive_lens", "medium_priority"],
    });
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    expect(resultMap.entries.map((entry) => entry.task_id).sort()).toEqual(["src-auth:correctness", "src-auth:security"]);
    expect(new Set(resultMap.entries.map((entry) => entry.result_path)).size).toBe(2);

    const prompt = await readFile(plan[0].prompt_path, "utf8");
    expect(prompt).toMatch(/## Packet graph context/);
    expect(prompt).toMatch(/Quality: cohesion=/);
    expect(prompt).toMatch(/emit exactly one result per listed task/i);
    expect(prompt).toMatch(/Do not use shell search commands/i);
    expect(prompt).toMatch(/src-auth:security/);
    expect(prompt).toMatch(/src-auth:correctness/);
    // result_path is embedded and the worker is told to WRITE it (no submit-packet
    // command, no inline-only emission). This is the data-loss fix: the generated
    // worker prompt must write its results, matching the rolling-dispatch step prompt.
    expect(prompt).toMatch(/result_path:/);
    expect(prompt).toMatch(/WRITE that array[\s\S]*to your result_path/i);
    expect(prompt).not.toMatch(/Do not write files/i);
    expect(prompt).not.toMatch(/emit it INLINE/i);
    expect(prompt).not.toMatch(/submit-packet/);
    // quoted_text grounding is required in the generated prompt.
    expect(prompt).toMatch(/quoted_text/);
    // Case-insensitive match: old prompt had lowercase "reply", new has "Reply"
    expect(prompt).toMatch(new RegExp(`reply exactly: valid: ${plan[0].packet_id}, findings=<total finding count>`, "i"));
  });
});

test("prepare-dispatch marks tiny low-risk packets for small model routing", async () => {
  await withTempDir(async (artifactsDir) => {
    const runId = "run-small";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify(
        [
          makeTask("docs-readme:maintainability", "maintainability", {
            unit_id: "docs-readme",
            file_paths: ["README.md"],
            file_line_counts: { "README.md": 12 },
            priority: "low",
          }),
        ],
        null,
        2,
      ),
    );

    await captureConsole(() =>
      runCli([
        process.execPath,
        join(repoRoot, "dist", "audit", "cli.js"),
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
      ]),
    );

    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    expect(plan[0].complexity.priority).toBe("low");
    expect(plan[0].complexity.total_lines).toBe(12);
    expect(plan[0].model_hint).toEqual({
      tier: "small",
      reasons: ["routing_risk:0.00"],
    });
  });
});

test("prepare-dispatch keeps colliding sanitized task ids on distinct result paths", async () => {
  await withTempDir(async (artifactsDir) => {
    const runId = "run-collision";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify(
        [
          makeTask("src/auth:security", "security"),
          makeTask("src:auth/security", "correctness"),
        ],
        null,
        2,
      ),
    );

    await captureConsole(() =>
      runCli([
        process.execPath,
        join(repoRoot, "dist", "audit", "cli.js"),
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
      ]),
    );

    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    expect(resultMap.entries.length).toBe(2);
    expect(new Set(resultMap.entries.map((entry) => entry.result_path)).size).toBe(2);
  });
});

test("large single-file packets stay isolated and get mechanical anchors", async () => {
  const largePath = "src/large.ts";
  const largeLineCount = 8500;
  const largeTask = makeTask("src-large:security", "security", {
    unit_id: "src-large",
    pass_id: "pass:security",
    file_paths: [largePath],
    file_line_counts: { [largePath]: largeLineCount },
    rationale: "Review the large auth file under security.",
    priority: "high",
  });
  const packets = buildReviewPackets([
    largeTask,
    makeTask("src-large:correctness", "correctness", {
      ...largeTask,
      task_id: "src-large:correctness",
      lens: "correctness",
      pass_id: "pass:correctness",
    }),
  ]);

  expect(packets.length).toBe(2);
  expect(packets.every((packet) => packet.file_paths.length === 1)).toBeTruthy();
  expect(packets.every((packet) => packet.task_ids.length === 1)).toBeTruthy();

  await withTempDir(async (artifactsDir) => {
    const runId = "run-large";
    const repoDir = join(artifactsDir, "repo");
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    const content = [
      "import { verifyToken } from './session';",
      "export async function authenticate(token: string) {",
      "  const password = token.trim();",
      "  return verifyToken(password);",
      "}",
      ...Array.from({ length: largeLineCount - 5 }, (_, index) => `// filler ${index + 1}`),
    ].join("\n");
    await writeFile(join(repoDir, largePath), content, "utf8");
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repo_root: repoDir }, null, 2),
      "utf8",
    );
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify([largeTask], null, 2),
      "utf8",
    );

    const captured = await captureConsole(() =>
      runCli([
        process.execPath,
        join(repoRoot, "dist", "audit", "cli.js"),
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
      ]),
    );

    const summary = JSON.parse(captured.stdout);
    expect(summary.warning_count).toBe(0);
    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    expect(plan[0].description).toMatch(/isolated large-file mode/i);
    expect(plan[0].complexity.large_file_mode).toBe(true);
    expect(plan[0].model_hint.tier).toBe("deep");
    expect(plan[0].model_hint.reasons.includes("isolated_large_file")).toBeTruthy();
    const taskResultFiles = await readdir(join(runDir, "task-results"));
    const anchorFile = taskResultFiles.find((name) => name.endsWith(".anchors.json"));
    expect(anchorFile).toBeTruthy();
    const anchors = JSON.parse(
      await readFile(join(runDir, "task-results", anchorFile), "utf8"),
    );
    expect(anchors.review_mode).toBe("isolated_large_file");
    expect(anchors.anchors.some(
        (anchor) => anchor.kind === "symbol" && anchor.name === "authenticate",
      )).toBeTruthy();
    expect(anchors.anchors.some(
        (anchor) => anchor.kind === "keyword" && anchor.name.toLowerCase() === "password",
      )).toBeTruthy();
    const prompt = await readFile(plan[0].prompt_path, "utf8");
    expect(prompt).toMatch(/Large File Review Mode/);
    expect(prompt).toMatch(/Anchor file:/);
    expect(prompt).toMatch(/authenticate/);
  });
});

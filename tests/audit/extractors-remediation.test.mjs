import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { bucketFile } = await importSourceModule("src/extractors/bucketing.ts");
const {
  buildFileDisposition,
  isAuditExcludedStatus,
} = await importSourceModule("src/extractors/disposition.ts");
const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");
const { buildRepoManifest } = await importSourceModule("src/extractors/fileInventory.ts");
const { buildCriticalFlowManifest } = await importSourceModule("src/extractors/flows.ts");
const { buildUnitManifest } = await importSourceModule("src/orchestrator/unitBuilder.ts");
const {
  EXTRACTOR_HEURISTIC_NOTE,
  isAsyncTaskPath,
  isAuditArtifactPath,
  isBackgroundSurfacePath,
  isBillingPath,
  isConcurrencyPath,
  isDataLayerPath,
  isDeploymentConfigPath,
  isGeneratedPath,
  isIdentityPath,
  isInterfacePath,
  isNetworkSurfacePath,
  isScriptPath,
  isSecuritySensitivePath,
  isSurfacePath,
  isTestPath,
  normalizeExtractorPath,
} = await importSourceModule("src/extractors/pathPatterns.ts");
const { buildSurfaceManifest } = await importSourceModule("src/extractors/surfaces.ts");
const { loadIgnoreFile } = await importSourceModule("src/extractors/ignore.ts");
const { buildRiskRegister } = await importSourceModule("src/extractors/risk.ts");
const { buildRepoManifestFromFs } = await importSourceModule("src/extractors/fsIntake.ts");

const { withTempDir } = await import("./helpers/withTempDir.mjs");

function makeRepoManifest(paths) {
  return buildRepoManifest(
    "fixture-repo",
    paths.map((path, index) => ({
      path,
      size_bytes: index + 1,
    })),
  );
}

function getDispositionItem(disposition, path) {
  return disposition.files.find((item) => item.path === path);
}

function assertPredicateCases(name, predicate, positives, negatives) {
  for (const path of positives) {
    expect(predicate(normalizeExtractorPath(path)), `${name} should match ${path}`).toBe(true);
  }
  for (const path of negatives) {
    expect(predicate(normalizeExtractorPath(path)), `${name} should not match ${path}`).toBe(false);
  }
}

test("loadIgnoreFile returns trimmed non-comment patterns and tolerates missing files", async () => {
  await withTempDir("audit-code-ignore-", async (root) => {
    expect(await loadIgnoreFile(root)).toEqual([]);

    await writeFile(
      join(root, ".auditorignore"),
      ["", "  # comment", " src/generated ", "logs/*.txt", "   "].join("\n"),
      "utf8",
    );

    expect(await loadIgnoreFile(root)).toEqual([
      "src/generated",
      "logs/*.txt",
    ]);
  });
});

test("buildRiskRegister derives deterministic risk signals from units, flows, and analyzer hits", () => {
  const register = buildRiskRegister(
    {
      units: [
        {
          unit_id: "auth-cache",
          name: "auth-cache",
          files: ["src/auth/cacheWriter.ts"],
          required_lenses: ["security", "data_integrity", "tests"],
          risk_score: 6,
        },
        {
          unit_id: "docs",
          name: "docs",
          files: ["README.md"],
          required_lenses: ["correctness"],
          risk_score: 0,
        },
      ],
    },
    {
      flows: [
        {
          id: "auth-flow",
          name: "Auth Flow",
          paths: ["src/auth/cacheWriter.ts"],
          entrypoints: ["src/auth/cacheWriter.ts"],
          concerns: ["security"],
        },
      ],
    },
    [
      {
        tool: "eslint",
        results: [
          {
            id: "eslint-1",
            category: "correctness",
            severity: "error",
            path: "src/auth/cacheWriter.ts",
            summary: "fixture",
          },
        ],
      },
    ],
  );

  const auth = register.items.find((item) => item.unit_id === "auth-cache");
  expect(auth.signals).toEqual([
    "high_bucket_density",
    "security_relevant",
    "writes_or_persistence",
    "path_level_stateful_behavior",
    "critical_flow_member",
    "external_analyzer_signal",
  ]);
  expect(auth.risk_score).toBe(9);
  expect(register.items.map((item) => item.unit_id)).toEqual(["auth-cache", "docs"]);
});

test("buildRiskRegister folds whole-graph signals: cycle + hub raise score, deletion candidate is informational", () => {
  const unitManifest = {
    units: [
      { unit_id: "cyc", name: "cyc", files: ["src/cyc.ts"], required_lenses: [], risk_score: 0 },
      { unit_id: "hub", name: "hub", files: ["src/hub.ts"], required_lenses: [], risk_score: 0 },
      { unit_id: "dead", name: "dead", files: ["src/dead.ts"], required_lenses: [], risk_score: 0 },
      { unit_id: "plain", name: "plain", files: ["src/plain.ts"], required_lenses: [], risk_score: 0 },
    ],
  };
  const graphSignals = {
    cycles: [["src/cyc.ts"]],
    fanIn: new Map(),
    fanOut: new Map(),
    nodesInCycles: new Set(["src/cyc.ts"]),
    hubs: new Set(["src/hub.ts"]),
    hubThreshold: 8,
    deletionCandidates: new Set(["src/dead.ts"]),
    connected: new Set(["src/cyc.ts", "src/hub.ts"]),
  };

  const register = buildRiskRegister(unitManifest, undefined, undefined, graphSignals);
  const byId = Object.fromEntries(register.items.map((i) => [i.unit_id, i]));

  expect(byId.cyc.signals).toEqual(["member_of_cycle"]);
  expect(byId.cyc.risk_score, "cycle membership adds 1").toBe(1);
  expect(byId.hub.signals).toEqual(["is_hub"]);
  expect(byId.hub.risk_score, "hub status adds 1").toBe(1);
  // deletion_candidate is advisory: signal present, score unchanged.
  expect(byId.dead.signals).toEqual(["deletion_candidate"]);
  expect(byId.dead.risk_score, "deletion candidate does not inflate score").toBe(0);
  expect(byId.plain.signals).toEqual([]);
});

test("buildRiskRegister omits graph signals entirely when none are supplied (back-compat)", () => {
  const unitManifest = {
    units: [{ unit_id: "u", name: "u", files: ["src/u.ts"], required_lenses: [], risk_score: 0 }],
  };
  const register = buildRiskRegister(unitManifest);
  expect(register.items[0].signals).toEqual([]);
});

test("buildRepoManifestFromFs traverses recursively, ignores configured paths, and hashes bounded files", async () => {
  await withTempDir("audit-code-fs-intake-", async (root) => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "src", "nested", "app.ts"), "small\n", "utf8");
    await writeFile(join(root, "src", "large.ts"), "0123456789", "utf8");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
    await writeFile(join(root, "ignored", "skip.ts"), "x", "utf8");
    try {
      await symlink(
        join(root, "src", "nested", "app.ts"),
        join(root, "src", "app-link.ts"),
      );
    } catch {
      // Symlink creation may be unavailable on some Windows runners.
    }

    const manifest = await buildRepoManifestFromFs({
      root,
      ignore: ["ignored"],
      hash_files: true,
      max_file_size_bytes: 6,
    });

    expect(manifest.files.map((file) => file.path).sort()).toEqual(["src/large.ts", "src/nested/app.ts"]);
    const small = manifest.files.find((file) => file.path === "src/nested/app.ts");
    const large = manifest.files.find((file) => file.path === "src/large.ts");
    expect(small.hash).toBe(createHash("sha256").update("small\n").digest("hex"));
    expect(large.size_bytes).toBe(10);
    expect(large.hash).toBe(undefined);
  });
});

test("bucketFile handles Windows-style separators, case-insensitivity, and overlapping heuristics", () => {
  const assignment = bucketFile("C:\\repo\\SRC\\Api\\test_worker.TS");
  const vendor = bucketFile("C:\\repo\\node_modules\\left-pad\\index.js");

  expect(assignment.buckets).toEqual([
    "tests",
    "interface",
    "concurrency_state",
  ]);
  expect(assignment.rationale).toEqual([
    "path suggests tests",
    "path suggests interface code",
    "path suggests concurrency or stateful behavior",
  ]);

  expect(vendor.buckets).toEqual(["generated_vendor"]);
  expect(vendor.rationale).toEqual([
    "node_modules or .git excluded by convention",
  ]);
});

test("isTestPath matches test tokens without substring false positives", () => {
  const positives = [
    "tests/helpers/auth.ts",
    "src/__tests__/auth.ts",
    "src/api/auth.test.ts",
    "src/api/auth.spec.ts",
    "src/api/test_worker.ts",
  ];
  const negatives = [
    "src/contest/runner.ts",
    "src/latest.ts",
    "src/specification/parser.ts",
    "src/api/protest-handler.ts",
  ];

  for (const path of positives) {
    expect(isTestPath(normalizeExtractorPath(path)), path).toBe(true);
  }
  for (const path of negatives) {
    expect(isTestPath(normalizeExtractorPath(path)), path).toBe(false);
  }
});

test("isInterfacePath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "interface",
    isInterfacePath,
    [
      "src/api/auth.ts",
      "src/routes/AuthHandler.ts",
      "src/controllers/user-controller.ts",
    ],
    [
      "src/routerless.ts",
      "src/controllerish/module.ts",
      "src/handlerish.ts",
    ],
  );
});

test("isDataLayerPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "data layer",
    isDataLayerPath,
    [
      "src/models/user.ts",
      "db/migrations/add-users.ts",
      "src/UserSchema.ts",
    ],
    [
      "src/remodel/view.ts",
      "src/schemaish/parser.ts",
      "src/migrationist.ts",
    ],
  );
});

test("isSecuritySensitivePath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "security",
    isSecuritySensitivePath,
    [
      "src/authService.ts",
      "src/session/tokenStore.ts",
      "src/password-reset.ts",
    ],
    [
      "src/author.ts",
      "src/tokenizer.ts",
      "src/permissionless.ts",
    ],
  );
});

test("isConcurrencyPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "concurrency",
    isConcurrencyPath,
    [
      "src/queueWorker.ts",
      "src/workers/emailJob.ts",
      "src/retry-policy.ts",
    ],
    [
      "src/locksmith.ts",
      "src/cachet.ts",
      "src/workerish.ts",
    ],
  );
});

test("isScriptPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "script",
    isScriptPath,
    ["scripts/release.ts", "src/buildScript.ts"],
    ["src/typescript/parser.ts", "src/scriptorium.ts"],
  );
});

test("isDeploymentConfigPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "deployment",
    isDeploymentConfigPath,
    [".github/workflows/ci.yml", "infra/k8s/deploy.ts", "docker-compose.yml"],
    ["src/redeploy.ts", "src/workflower.ts"],
  );
});

test("isGeneratedPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "generated",
    isGeneratedPath,
    [
      "src/generated/client.ts",
      "src/generatedClient.ts",
      "vendor/left-pad/index.js",
      "third_party/zlib/index.c",
    ],
    [
      "src/regenerated/client.ts",
      "src/vendorized.ts",
      "src/autogenerator.ts",
    ],
  );
});

test("isSurfacePath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "surface",
    isSurfacePath,
    [
      "src/api/auth.ts",
      "src/BackgroundWorker.ts",
      "src/commands/deploy.ts",
      "src/cli.ts",
    ],
    [
      "src/jobber.ts",
      "src/commander.ts",
      "src/controllerish.ts",
    ],
  );
});

test("isBackgroundSurfacePath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "background surface",
    isBackgroundSurfacePath,
    ["src/EmailJob.ts", "src/workers/email.ts"],
    ["src/jobber.ts", "src/workflow.ts"],
  );
});

test("isNetworkSurfacePath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "network surface",
    isNetworkSurfacePath,
    ["src/routes/auth.ts", "src/api/auth.ts", "src/UserController.ts"],
    ["src/routerless.ts", "src/controllerish.ts"],
  );
});

test("isBillingPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "billing",
    isBillingPath,
    ["src/billing/invoice.ts", "src/paymentLedger.ts"],
    ["src/ledgerdemain.ts", "src/subscriptionless.ts"],
  );
});

test("isIdentityPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "identity",
    isIdentityPath,
    ["src/users/profile.ts", "src/auth/session.ts"],
    ["src/userland/parser.ts", "src/author.ts"],
  );
});

test("isAsyncTaskPath matches keyword tokens without substring false positives", () => {
  assertPredicateCases(
    "async task",
    isAsyncTaskPath,
    ["src/tasks/sendEmail.ts", "src/retryTask.ts", "src/queueWorker.ts"],
    ["src/taskmaster.ts", "src/cachet.ts"],
  );
});

test("buildRepoManifest infers languages from normalized extensions and leaves extensionless files unknown", () => {
  const manifest = buildRepoManifest("fixture-repo", [
    { path: "SRC\\App.TSX", size_bytes: 10 },
    { path: "scripts\\build.MJS", size_bytes: 11 },
    { path: "types\\shared.MTS", size_bytes: 12 },
    { path: "README", size_bytes: 13 },
  ]);

  expect(manifest.files.map((file) => file.language)).toEqual(["tsx", "javascript", "typescript", "unknown"]);
});

test("buildFileDisposition stays stable for Windows-style absolute paths and overlapping matches", () => {
  const repoManifest = makeRepoManifest([
    "C:\\repo\\Docs\\Runbook.MD",
    "C:\\repo\\DIST\\bundle.js",
    "C:\\repo\\vendor\\left-pad\\index.js",
    "C:\\repo\\logs\\STDOUT.LOG",
    "C:\\repo\\docs\\package-lock.json",
    "C:\\repo\\archive.TAR.GZ",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  expect(getDispositionItem(disposition, "C:\\repo\\Docs\\Runbook.MD")?.status).toBe("doc_only");
  expect(getDispositionItem(disposition, "C:\\repo\\DIST\\bundle.js")?.status).toBe("generated");
  expect(getDispositionItem(disposition, "C:\\repo\\vendor\\left-pad\\index.js")?.status).toBe("vendor");
  expect(getDispositionItem(disposition, "C:\\repo\\logs\\STDOUT.LOG")?.status).toBe("generated");

  const lockfile = getDispositionItem(
    disposition,
    "C:\\repo\\docs\\package-lock.json",
  );
  expect(lockfile?.status).toBe("generated");
  expect(lockfile?.reason ?? "").toMatch(/lockfile/i);
  expect(getDispositionItem(disposition, "C:\\repo\\archive.TAR.GZ")?.status).toBe("binary");
});

test("buildFileDisposition excludes generated install and test artifacts before they reach planning", () => {
  const repoManifest = makeRepoManifest([
    ".audit-tools/audit/dispatch/current-task.json",
    ".audit-tools/audit/dispatch/audit-result.schema.json",
    ".audit-code/install/run-mcp-server.mjs",
    ".audit-code/install/manifest.json",
    ".audit-code/install/claude-desktop/bundle/server/index.js",
    ".audit-code/install/claude-desktop/auditor-lambda.dxt",
    ".audit-code/install/GETTING-STARTED.md",
    "tests/.test-plan-artifacts/remediation_plan.json",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  expect(getDispositionItem(disposition, ".audit-tools/audit/dispatch/current-task.json")?.status).toBe("generated");
  expect(getDispositionItem(
      disposition,
      ".audit-tools/audit/dispatch/audit-result.schema.json",
    )?.status).toBe("generated");
  expect(getDispositionItem(disposition, ".audit-code/install/run-mcp-server.mjs")?.status).toBe("generated");
  expect(getDispositionItem(disposition, ".audit-code/install/manifest.json")?.status).toBe("generated");
  expect(getDispositionItem(
      disposition,
      ".audit-code/install/claude-desktop/bundle/server/index.js",
    )?.status).toBe("generated");
  expect(getDispositionItem(
      disposition,
      ".audit-code/install/claude-desktop/auditor-lambda.dxt",
    )?.status).toBe("generated");
  expect(getDispositionItem(disposition, ".audit-code/install/GETTING-STARTED.md")?.status).toBe("doc_only");
  expect(getDispositionItem(
      disposition,
      "tests/.test-plan-artifacts/remediation_plan.json",
    )?.status).toBe("generated");
});

test("buildFileDisposition excludes bundled .tmp artifacts (e.g. .tmp/cache)", () => {
  const repoManifest = makeRepoManifest([
    ".tmp/cache/index.js",
    ".tmp/cache/package.json",
    "src/index.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  expect(getDispositionItem(disposition, ".tmp/cache/index.js")?.status).toBe("excluded");
  expect(getDispositionItem(disposition, ".tmp/cache/package.json")?.status).toBe("excluded");
  // Real source outside .tmp is still included.
  expect(getDispositionItem(disposition, "src/index.ts")?.status).toBe("included");
});

test("buildFileDisposition excludes archives, package caches, nested .audit-artifacts, and pipeline output contracts", () => {
  const repoManifest = makeRepoManifest([
    "packages/remediate-code/remediator-lambda-0.3.5.tgz",
    "release/payload.tar",
    "release/archive.tar.gz",
    "packages/audit-code/.audit-artifacts/runs/x/task-results/a.json",
    "packages/remediate-code/smoke/tmp/run-1/npm-cache/_cacache/content-v2/sha512/aa/bb/cc",
    "audit/audit-findings.json",
    "audit/audit-report.md",
    "src/index.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  expect(getDispositionItem(disposition, "packages/remediate-code/remediator-lambda-0.3.5.tgz")?.status).toBe("binary");
  expect(getDispositionItem(disposition, "release/payload.tar")?.status).toBe("binary");
  expect(getDispositionItem(disposition, "release/archive.tar.gz")?.status).toBe("binary");
  expect(getDispositionItem(disposition, "packages/audit-code/.audit-artifacts/runs/x/task-results/a.json")?.status).toBe("generated");
  expect(getDispositionItem(
      disposition,
      "packages/remediate-code/smoke/tmp/run-1/npm-cache/_cacache/content-v2/sha512/aa/bb/cc",
    )?.status).toBe("excluded");
  expect(getDispositionItem(disposition, "audit/audit-findings.json")?.status).toBe("generated");
  // The matching markdown render stays doc_only via isDocPath.
  expect(getDispositionItem(disposition, "audit/audit-report.md")?.status).toBe("doc_only");
  // Real source is still audited.
  expect(getDispositionItem(disposition, "src/index.ts")?.status).toBe("included");
  // Every non-source artifact above is kept out of audit scope.
  for (const p of [
    "packages/remediate-code/remediator-lambda-0.3.5.tgz",
    "packages/audit-code/.audit-artifacts/runs/x/task-results/a.json",
    "packages/remediate-code/smoke/tmp/run-1/npm-cache/_cacache/content-v2/sha512/aa/bb/cc",
    "audit/audit-findings.json",
  ]) {
    expect(isAuditExcludedStatus(getDispositionItem(disposition, p)?.status), `${p} should be excluded from audit scope`).toBeTruthy();
  }
});

test("buildFileDisposition excludes extension binary and source map artifacts", () => {
  const repoManifest = makeRepoManifest([
    "service/main.js",
    "download_worker/codec.wasm",
    "download_worker/libav-6.5.7.wasm.mjs",
    "content/panel.js.map",
    "bitmaps/logo-128.png",
    "content/sidebar.html",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  expect(getDispositionItem(disposition, "service/main.js")?.status).toBe("included");
  expect(getDispositionItem(disposition, "content/sidebar.html")?.status).toBe("included");
  expect(getDispositionItem(disposition, "download_worker/codec.wasm")?.status).toBe("binary");
  expect(getDispositionItem(disposition, "download_worker/libav-6.5.7.wasm.mjs")?.status).toBe("generated");
  expect(getDispositionItem(disposition, "content/panel.js.map")?.status).toBe("generated");
  expect(getDispositionItem(disposition, "bitmaps/logo-128.png")?.status).toBe("binary");
});

test("buildSurfaceManifest excludes generated files and preserves the documented heuristic note", () => {
  const repoManifest = makeRepoManifest([
    "src\\API\\route.ts",
    "workers\\EmailJob.ts",
    "dist\\generated-cli.js",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const manifest = buildSurfaceManifest(repoManifest, disposition);

  expect(manifest.surfaces).toEqual([
    {
      id: "surface:src\\API\\route.ts",
      kind: "interface",
      entrypoint: "src\\API\\route.ts",
      exposure: "network",
      methods: ["GET", "POST"],
      notes: [EXTRACTOR_HEURISTIC_NOTE],
    },
    {
      id: "surface:workers\\EmailJob.ts",
      kind: "background",
      entrypoint: "workers\\EmailJob.ts",
      exposure: "local",
      methods: undefined,
      notes: [EXTRACTOR_HEURISTIC_NOTE],
    },
  ]);
  expect(disposition.files
      .filter((item) => isAuditExcludedStatus(item.status))
      .map((item) => item.path)
      .includes("dist\\generated-cli.js")).toBe(true);
});

test("buildCriticalFlowManifest links normalized related paths and dedupes duplicate surface entries", () => {
  const repoManifest = makeRepoManifest([
    "src\\API\\auth.ts",
    "src\\lib\\session.ts",
    "src\\models\\invoice.ts",
    "schemas\\audit_result.schema.json",
    "tests\\helpers\\jsonSchemaAssert.mjs",
    "tests\\schema-contracts.test.mjs",
    "examples\\session-config\\claude-code-model.json",
    "src\\workers\\queueJob.ts",
    "src\\workers\\retryTask.ts",
    "infra\\deploy.yml",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const surfaceManifest = {
    surfaces: [
      {
        id: "surface:auth-a",
        kind: "interface",
        entrypoint: "src\\API\\auth.ts",
      },
      {
        id: "surface:auth-b",
        kind: "interface",
        entrypoint: "src\\API\\auth.ts",
      },
      {
        id: "surface:queue",
        kind: "background",
        entrypoint: "src\\workers\\queueJob.ts",
      },
    ],
  };

  const flowManifest = buildCriticalFlowManifest(
    repoManifest,
    surfaceManifest,
    disposition,
  );
  const authFlows = flowManifest.flows.filter(
    (flow) => flow.entrypoints[0] === "src\\API\\auth.ts",
  );
  const queueFlow = flowManifest.flows.find(
    (flow) => flow.entrypoints[0] === "src\\workers\\queueJob.ts",
  );

  expect(authFlows.length).toBe(1);
  expect(authFlows[0].paths.includes("src\\lib\\session.ts")).toBeTruthy();
  expect(authFlows[0].concerns.includes("security")).toBeTruthy();
  expect(authFlows[0].concerns.includes("correctness")).toBeTruthy();
  expect(authFlows[0].notes).toEqual([EXTRACTOR_HEURISTIC_NOTE]);

  expect(queueFlow).toBeTruthy();
  expect(queueFlow.paths.includes("src\\workers\\retryTask.ts")).toBeTruthy();
  expect(queueFlow.concerns.includes("reliability")).toBeTruthy();
  expect(flowManifest.flows.some(
      (flow) => flow.entrypoints[0] === "src\\models\\invoice.ts",
    )).toBeTruthy();
  expect(flowManifest.flows.some(
      (flow) => flow.entrypoints[0] === "schemas\\audit_result.schema.json",
    )).toBe(false);
  expect(flowManifest.flows.some(
      (flow) => flow.entrypoints[0] === "tests\\helpers\\jsonSchemaAssert.mjs",
    )).toBe(false);
  expect(flowManifest.flows.some(
      (flow) => flow.entrypoints[0] === "tests\\schema-contracts.test.mjs",
    )).toBe(false);
  expect(flowManifest.flows.some(
      (flow) => flow.entrypoints[0] === "examples\\session-config\\claude-code-model.json",
    )).toBe(false);
  expect(flowManifest.fallback_required).toBe(false);
});

// Shared fixture for the three Chrome-extension tests below.
function makeChromeExtensionFixture() {
  const repoManifest = makeRepoManifest([
    "manifest.json",
    "service/main.js",
    "content/content-script.js",
    "content/sidebar.html",
    "content/panel.js",
    "content/sidebar.css",
    "download_worker/main.js",
    "bitmaps/logo-128.png",
  ]);
  const fileContents = {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      permissions: ["tabs", "downloads", "scripting"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "service/main.js" },
      content_scripts: [
        {
          matches: ["<all_urls>"],
          js: ["content/content-script.js"],
          css: ["content/sidebar.css"],
        },
      ],
      side_panel: { default_path: "/content/sidebar.html" },
      web_accessible_resources: [
        { resources: ["download_worker/main.js", "bitmaps/logo-128.png"] },
      ],
    }),
    "content/sidebar.html": [
      "<!doctype html>",
      "<script type=\"module\" src=\"panel.js\"></script>",
      "<link rel=\"stylesheet\" href=\"sidebar.css\">",
    ].join("\n"),
  };
  return { repoManifest, fileContents };
}

test("buildGraphBundle understands Chrome extension manifests and HTML resources", () => {
  const { repoManifest, fileContents } = makeChromeExtensionFixture();
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, { fileContents });

  const references = graph.graphs.references.map((edge) => [
    edge.from,
    edge.to,
    edge.kind,
  ]);
  expect(references.some(
      ([from, to, kind]) =>
        from === "manifest.json" &&
        to === "service/main.js" &&
        kind === "chrome-extension-background-link",
    )).toBeTruthy();
  expect(references.some(
      ([from, to, kind]) =>
        from === "manifest.json" &&
        to === "content/content-script.js" &&
        kind === "chrome-extension-content-script-link",
    )).toBeTruthy();
  expect(references.some(
      ([from, to, kind]) =>
        from === "manifest.json" &&
        to === "content/sidebar.html" &&
        kind === "chrome-extension-ui-page-link",
    )).toBeTruthy();
  expect(references.some(
      ([from, to, kind]) =>
        from === "content/sidebar.html" &&
        to === "content/panel.js" &&
        kind === "html-resource-link",
    )).toBeTruthy();
  expect(references.some(([, to]) => to === "bitmaps/logo-128.png")).toBe(false);
});

test("buildSurfaceManifest understands Chrome extension manifests and HTML resources", () => {
  const { repoManifest, fileContents } = makeChromeExtensionFixture();
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, { fileContents });

  const surfaces = buildSurfaceManifest(repoManifest, disposition, {
    graphBundle: graph,
  }).surfaces;
  expect(surfaces.map((surface) => [
      surface.kind,
      surface.entrypoint,
      surface.exposure,
    ])).toEqual([
      ["background", "download_worker/main.js", "local"],
      ["interface", "content/content-script.js", "network"],
      ["interface", "content/sidebar.html", "local"],
      ["background", "service/main.js", "local"],
    ]);
});

test("buildUnitManifest understands Chrome extension manifests", () => {
  const { repoManifest } = makeChromeExtensionFixture();
  const disposition = buildFileDisposition(repoManifest);

  const unitManifest = buildUnitManifest(repoManifest, disposition);
  const serviceUnit = unitManifest.units.find((unit) =>
    unit.files.includes("service/main.js"),
  );
  expect(serviceUnit?.kind).toBe("extension_background");
  expect(serviceUnit?.required_lenses.includes("security")).toBeTruthy();
});

test("buildGraphBundle resolves code imports and literal path references", () => {
  const repoManifest = makeRepoManifest([
    "src/api/auth.ts",
    "src/lib/session.ts",
    "schemas/audit_result.schema.json",
    "src/config/load.ts",
    "node_modules/vendor/index.js",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/api/auth.ts": [
        "import { createSession } from '../lib/session';",
        "const schema = 'schemas/audit_result.schema.json';",
      ].join("\n"),
      "src/config/load.ts":
        "const localSessionPath = '../lib/session.ts';\n",
      "node_modules/vendor/index.js":
        "import { createSession } from '../../src/lib/session';\n",
    },
  });

  const importEdge = graph.graphs.imports.find(
    (edge) =>
      edge.from === "src/api/auth.ts" &&
      edge.to === "src/lib/session.ts" &&
      edge.kind === "esm",
  );
  expect(importEdge).toBeTruthy();
  expect(importEdge.direction).toBe("directed");
  expect(importEdge.confidence).toBe(0.95);
  expect(importEdge.reason).toMatch(/Resolved esm specifier/);

  const repoReferenceEdge = graph.graphs.references.find(
    (edge) =>
      edge.from === "src/api/auth.ts" &&
      edge.to === "schemas/audit_result.schema.json" &&
      edge.kind === "repo-path-reference",
  );
  expect(repoReferenceEdge).toBeTruthy();
  expect(repoReferenceEdge.direction).toBe("directed");
  expect(repoReferenceEdge.confidence).toBe(0.72);
  expect(repoReferenceEdge.reason).toMatch(/repository path string literal/);

  const relativeReferenceEdge = graph.graphs.references.find(
    (edge) =>
      edge.from === "src/config/load.ts" &&
      edge.to === "src/lib/session.ts" &&
      edge.kind === "relative-string-reference",
  );
  expect(relativeReferenceEdge).toBeTruthy();
  expect(relativeReferenceEdge.direction).toBe("directed");
  expect(relativeReferenceEdge.confidence).toBe(0.82);
  expect(relativeReferenceEdge.reason).toMatch(/relative string literal/);
  expect(graph.graphs.imports.some((edge) => edge.from === "node_modules/vendor/index.js")).toBe(false);
  expect(graph.graphs.references.some(
      (edge) =>
        edge.from === "src/api/auth.ts" &&
        edge.to === "src/lib/session.ts" &&
        edge.kind === "relative-string-reference",
    )).toBe(false);
});

test("buildGraphBundle maps TypeScript runtime js specifiers to source files", () => {
  const repoManifest = makeRepoManifest([
    "src/index.ts",
    "src/state/store.ts",
    "src/types/workerSession.ts",
    "src/mcp/server.mts",
    "src/legacy/loader.cts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/index.ts": [
        "import { StateStore } from './state/store.js';",
        "import type { WorkerTask } from './types/workerSession.js';",
        "export { runMcp } from './mcp/server.mjs';",
        "const legacy = await import('./legacy/loader.cjs');",
      ].join("\n"),
    },
  });

  for (const [to, kind] of [
    ["src/state/store.ts", "esm"],
    ["src/types/workerSession.ts", "esm"],
    ["src/mcp/server.mts", "re-export"],
    ["src/legacy/loader.cts", "dynamic-import"],
  ]) {
    const edge = graph.graphs.imports.find(
      (candidate) =>
        candidate.from === "src/index.ts" &&
        candidate.to === to &&
        candidate.kind === kind,
    );
    expect(edge, `expected ${kind} edge to ${to}`).toBeTruthy();
    expect(edge.confidence).toBe(0.95);
    expect(edge.reason).toMatch(/Resolved/);
  }

  expect(graph.graphs.references.some((edge) => edge.from === "src/index.ts")).toBe(false);
});

test("buildGraphBundle resolves Python imports to local modules and packages", () => {
  const repoManifest = makeRepoManifest([
    "src/app/__init__.py",
    "src/app/api.py",
    "src/app/db/session.py",
    "src/app/handlers.py",
    "src/app/models.py",
    "src/app/services/auth.py",
    "services/billing/app/__init__.py",
    "services/billing/app/invoices.py",
    "services/billing/app/reports/__init__.py",
    "services/billing/app/reports/daily.py",
    "services/billing/app/store.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/app/api.py": [
        "import app.services.auth as auth_service",
        "from .db import session",
        "from .models import User",
        "from app import handlers",
      ].join("\n"),
      "services/billing/app/invoices.py": [
        "from app import store",
        "from .reports import (",
        "  daily as daily_report,",
        ")",
      ].join("\n"),
    },
  });

  const pythonImportEdges = graph.graphs.imports.filter((edge) =>
    ["python-import", "python-from-import"].includes(edge.kind),
  );
  expect(pythonImportEdges.map((edge) => [edge.from, edge.to, edge.kind])).toEqual([
      [
        "services/billing/app/invoices.py",
        "services/billing/app/reports/daily.py",
        "python-from-import",
      ],
      [
        "services/billing/app/invoices.py",
        "services/billing/app/store.py",
        "python-from-import",
      ],
      ["src/app/api.py", "src/app/db/session.py", "python-from-import"],
      ["src/app/api.py", "src/app/handlers.py", "python-from-import"],
      ["src/app/api.py", "src/app/models.py", "python-from-import"],
      ["src/app/api.py", "src/app/services/auth.py", "python-import"],
    ]);
  expect(pythonImportEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.95 &&
        /Resolved Python import specifier/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle links deterministic test files to their source files", () => {
  const repoManifest = makeRepoManifest([
    "src/api/auth.ts",
    "src/api/auth.test.ts",
    "src/lib/session.ts",
    "src/lib/__tests__/session.spec.ts",
    "src/workers/queueJob.ts",
    "tests/workers/queueJob.test.ts",
    "tests/helpers/testHarness.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition);
  const testSourceEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "test-source-link",
  );

  expect(testSourceEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["src/api/auth.test.ts", "src/api/auth.ts"],
      ["src/lib/__tests__/session.spec.ts", "src/lib/session.ts"],
      ["tests/workers/queueJob.test.ts", "src/workers/queueJob.ts"],
    ]);
  expect(testSourceEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.88 &&
        /Test path naming maps to source path/.test(edge.reason ?? ""),
    )).toBeTruthy();
  expect(testSourceEdges.some((edge) => edge.from === "tests/helpers/testHarness.ts")).toBe(false);
});

test("buildGraphBundle links pytest-style test files to Python source files", () => {
  const repoManifest = makeRepoManifest([
    "src/app/api.py",
    "src/app/models.py",
    "src/app/services/auth.py",
    "src/app/services/auth_test.py",
    "src/app/tests/test_models.py",
    "tests/app/test_api.py",
    "tests/helpers/test_harness.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition);
  const testSourceEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "test-source-link",
  );

  expect(testSourceEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["src/app/services/auth_test.py", "src/app/services/auth.py"],
      ["src/app/tests/test_models.py", "src/app/models.py"],
      ["tests/app/test_api.py", "src/app/api.py"],
    ]);
  expect(testSourceEdges.some(
      (edge) => edge.from === "tests/helpers/test_harness.py",
    )).toBe(false);
});

test("buildGraphBundle imports analyzer ownership roots as graph references", () => {
  const repoManifest = makeRepoManifest([
    "services/billing/api/invoices.py",
    "services/billing/store/invoices.py",
    "services/legacy/old.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    externalAnalyzerResults: [{
      tool: "pyright",
      ownership_roots: [
        {
          root: "services/billing/",
          paths: [
            "services/billing/api/invoices.py",
            "services/billing/store/invoices.py",
            "services/legacy/old.py",
            "services/billing/missing.py",
          ],
          kind: "python-package",
          confidence: 0.91,
          reason: "Python package root contains these modules.",
        },
      ],
      results: [],
    }],
  });

  const ownershipEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "analyzer-ownership-root-link",
  );
  expect(ownershipEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["services/billing", "services/billing/api/invoices.py"],
      ["services/billing", "services/billing/store/invoices.py"],
    ]);
  expect(ownershipEdges.every(
      (edge) =>
        edge.direction === "undirected" &&
        edge.confidence === 0.91 &&
        edge.reason === "Python package root contains these modules.",
    )).toBeTruthy();
});

test("buildGraphBundle extracts package entrypoints and route handler relationships", () => {
  const repoManifest = makeRepoManifest([
    "package.json",
    "scripts/release-and-publish.mjs",
    "scripts/run-mcp-server.mjs",
    "scripts/smoke-linked-audit-code.mjs",
    "src/cli.ts",
    "src/routes/auth.ts",
    "src/handlers/auth.ts",
    "src/app/api/health/route.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "package.json": JSON.stringify({
        bin: {
          fixture: "./src/cli.ts",
        },
        exports: {
          "./auth": "./src/handlers/auth.ts",
        },
        scripts: {
          "release:patch": "node scripts/release-and-publish.mjs patch --bump-only",
          "smoke:linked": "node ./scripts/smoke-linked-audit-code.mjs",
        },
      }),
      "src/routes/auth.ts": [
        "import { loginHandler as login } from '../handlers/auth';",
        "router.post('/login', login);",
      ].join("\n"),
      "src/app/api/health/route.ts": [
        "export async function GET() {",
        "  return Response.json({ ok: true });",
        "}",
      ].join("\n"),
    },
  });

  const packageEntrypointEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "package-entrypoint-link",
  );
  expect(packageEntrypointEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["package.json", "src/cli.ts"],
      ["package.json", "src/handlers/auth.ts"],
    ]);
  expect(packageEntrypointEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.9 &&
        /Package manifest field/.test(edge.reason ?? ""),
    )).toBeTruthy();

  const packageScriptEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "package-script-link",
  );
  expect(packageScriptEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["package.json", "scripts/release-and-publish.mjs"],
      ["package.json", "scripts/smoke-linked-audit-code.mjs"],
    ]);
  expect(packageScriptEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.88 &&
        /Package script/.test(edge.reason ?? ""),
    )).toBeTruthy();

  const packageScriptSuiteEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "package-script-suite-link",
  );
  expect(packageScriptSuiteEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["scripts/release-and-publish.mjs", "scripts/run-mcp-server.mjs"],
      ["scripts/run-mcp-server.mjs", "scripts/smoke-linked-audit-code.mjs"],
    ]);
  expect(packageScriptSuiteEdges.every(
      (edge) =>
        edge.direction === "undirected" &&
        edge.confidence === 0.78 &&
        /Package script suite 'scripts'/.test(edge.reason ?? ""),
    )).toBeTruthy();

  const routeHandlerEdge = graph.graphs.calls.find(
    (edge) =>
      edge.from === "src/routes/auth.ts" &&
      edge.to === "src/handlers/auth.ts" &&
      edge.kind === "route-handler-link",
  );
  expect(routeHandlerEdge).toBeTruthy();
  expect(routeHandlerEdge.direction).toBe("directed");
  expect(routeHandlerEdge.confidence).toBe(0.92);
  expect(routeHandlerEdge.reason).toMatch(/Route POST '\/login'/);

  expect(graph.graphs.routes.filter((route) =>
      ["src/handlers/auth.ts", "src/app/api/health/route.ts"].includes(
        route.handler,
      ),
    )).toEqual([
      {
        path: "/api/health",
        handler: "src/app/api/health/route.ts",
        method: "GET",
      },
      {
        path: "/login",
        handler: "src/handlers/auth.ts",
        method: "POST",
      },
    ]);
});

test("buildGraphBundle extracts JSON Schema refs and bounded suite links", () => {
  const repoManifest = makeRepoManifest([
    "schemas/finding.schema.json",
    "schemas/remediation_block.schema.json",
    "schemas/remediation_plan.schema.json",
    ".github/workflows/ci.yml",
    ".github/workflows/publish-package.yml",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "schemas/remediation_plan.schema.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "remediation_plan.schema.json",
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: { $ref: "finding.schema.json" },
          },
          blocks: {
            type: "array",
            items: { $ref: "./remediation_block.schema.json#/definitions/block" },
          },
        },
      }),
    },
  });

  const schemaRefs = graph.graphs.references.filter(
    (edge) => edge.kind === "json-schema-ref",
  );
  expect(schemaRefs.map((edge) => [edge.from, edge.to])).toEqual([
      [
        "schemas/remediation_plan.schema.json",
        "schemas/finding.schema.json",
      ],
      [
        "schemas/remediation_plan.schema.json",
        "schemas/remediation_block.schema.json",
      ],
    ]);
  expect(schemaRefs.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.93 &&
        /JSON Schema \$ref/.test(edge.reason ?? ""),
    )).toBeTruthy();

  const schemaSuiteEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "schema-suite-link",
  );
  expect(schemaSuiteEdges.map((edge) => [edge.from, edge.to])).toEqual([
      [
        "schemas/finding.schema.json",
        "schemas/remediation_block.schema.json",
      ],
      [
        "schemas/remediation_block.schema.json",
        "schemas/remediation_plan.schema.json",
      ],
    ]);
  expect(schemaSuiteEdges.every(
      (edge) =>
        edge.direction === "undirected" &&
        edge.confidence === 0.78 &&
        /JSON Schema suite 'schemas'/.test(edge.reason ?? ""),
    )).toBeTruthy();

  expect(graph.graphs.references
      .filter((edge) => edge.kind === "github-workflow-suite-link")
      .map((edge) => [edge.from, edge.to, edge.direction, edge.confidence])).toEqual([
      [
        ".github/workflows/ci.yml",
        ".github/workflows/publish-package.yml",
        "undirected",
        0.78,
      ],
    ]);
});

test("buildGraphBundle links schema contract tests to exact schema files", () => {
  const repoManifest = makeRepoManifest([
    "schemas/finding.schema.json",
    "schemas/remediation_plan.schema.json",
    "tests/schema-contracts.test.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "tests/schema-contracts.test.ts": [
        "const SCHEMA_DIR = join(__dirname, '..', 'schemas');",
        "const EXPECTED_SCHEMAS = [",
        "  'finding.schema.json',",
        "  'remediation_plan.schema.json',",
        "];",
      ].join("\n"),
    },
  });

  const schemaTestEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "schema-contract-test-link",
  );
  expect(schemaTestEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["tests/schema-contracts.test.ts", "schemas/finding.schema.json"],
      ["tests/schema-contracts.test.ts", "schemas/remediation_plan.schema.json"],
    ]);
  expect(schemaTestEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.86 &&
        /Schema contract test references/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle links bounded TypeScript type contract suites", () => {
  const repoManifest = makeRepoManifest([
    "src/types/auditState.ts",
    "src/types/runLedger.ts",
    "src/types/sessionConfig.ts",
    "src/runtime/runLedger.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/types/auditState.ts": "export interface AuditState { status: string; }",
      "src/types/runLedger.ts": "export type RunStatus = 'pending' | 'done';",
      "src/types/sessionConfig.ts": "export const PROVIDERS = ['auto'] as const;",
      "src/runtime/runLedger.ts": "export function writeRunLedger() {}",
    },
  });

  const typeSuiteEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "typescript-type-suite-link",
  );
  expect(typeSuiteEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["src/types/auditState.ts", "src/types/runLedger.ts"],
      ["src/types/runLedger.ts", "src/types/sessionConfig.ts"],
    ]);
  expect(typeSuiteEdges.every(
      (edge) =>
        edge.direction === "undirected" &&
        edge.confidence === 0.78 &&
        /TypeScript type contract suite 'src\/types'/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle extracts workspace package manifest links", () => {
  const repoManifest = makeRepoManifest([
    "package.json",
    "packages/auth/package.json",
    "packages/auth/src/index.ts",
    "packages/billing/package.json",
    "packages/billing/src/index.ts",
    "tools/migration/package.json",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "package.json": JSON.stringify({
        workspaces: ["packages/*", "!packages/billing"],
      }),
    },
  });

  const workspaceEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "workspace-package-link",
  );
  expect(workspaceEdges.map((edge) => [edge.from, edge.to])).toEqual([["package.json", "packages/auth/package.json"]]);
  expect(workspaceEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.86 &&
        /Workspace pattern 'packages\/\*' includes package manifest/.test(
          edge.reason ?? "",
        ),
    )).toBeTruthy();
});

test("buildGraphBundle extracts pnpm workspace package manifest links", () => {
  const repoManifest = makeRepoManifest([
    "pnpm-workspace.yaml",
    "packages/auth/package.json",
    "packages/auth/src/index.ts",
    "packages/billing/package.json",
    "packages/billing/src/index.ts",
    "tools/migration/package.json",
    "tools/migration/src/index.ts",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "pnpm-workspace.yaml": [
        "packages:",
        "  - 'packages/*'",
        "  - '!packages/billing'",
        "  - tools/* # include internal tooling packages",
        "catalog:",
        "  typescript: ^5.9.2",
      ].join("\n"),
    },
  });

  const workspaceEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "workspace-package-link",
  );
  expect(workspaceEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["pnpm-workspace.yaml", "packages/auth/package.json"],
      ["pnpm-workspace.yaml", "tools/migration/package.json"],
    ]);
  expect(workspaceEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.86 &&
        /Workspace pattern/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle extracts TypeScript project reference links", () => {
  const repoManifest = makeRepoManifest([
    "tsconfig.json",
    "packages/auth/tsconfig.json",
    "packages/auth/src/index.ts",
    "packages/billing/tsconfig.build.json",
    "packages/billing/src/index.ts",
    "packages/legacy/tsconfig.json",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "tsconfig.json": [
        "{",
        "  // project references are JSONC in real tsconfig files",
        "  \"references\": [",
        "    { \"path\": \"./packages/auth\" },",
        "    { \"path\": \"packages/billing/tsconfig.build.json\" },",
        "    { \"path\": \"https://example.invalid/project\" },",
        "  ],",
        "}",
      ].join("\n"),
    },
  });

  const projectEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "typescript-project-reference-link",
  );
  expect(projectEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["tsconfig.json", "packages/auth/tsconfig.json"],
      ["tsconfig.json", "packages/billing/tsconfig.build.json"],
    ]);
  expect(projectEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.87 &&
        /TypeScript project reference/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle extracts Go workspace module links", () => {
  const repoManifest = makeRepoManifest([
    "go.work",
    "services/auth/go.mod",
    "services/auth/main.go",
    "services/billing/go.mod",
    "services/billing/main.go",
    "tools/migration/go.mod",
    "tools/migration/main.go",
    "legacy/go.mod",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "go.work": [
        "go 1.22",
        "use (",
        "  ./services/auth",
        "  \"./services/billing\" // quoted module path",
        ")",
        "use ./tools/migration",
        "replace example.com/legacy => ./legacy",
      ].join("\n"),
    },
  });

  const moduleEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "go-workspace-module-link",
  );
  expect(moduleEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["go.work", "services/auth/go.mod"],
      ["go.work", "services/billing/go.mod"],
      ["go.work", "tools/migration/go.mod"],
    ]);
  expect(moduleEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.87 &&
        /Go workspace use directive/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle extracts Cargo workspace member links", () => {
  const repoManifest = makeRepoManifest([
    "Cargo.toml",
    "crates/auth/Cargo.toml",
    "crates/auth/src/lib.rs",
    "crates/billing/Cargo.toml",
    "crates/billing/src/lib.rs",
    "tools/xtask/Cargo.toml",
    "tools/xtask/src/main.rs",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "Cargo.toml": [
        "[workspace]",
        "members = [",
        "  'crates/*',",
        "  \"tools/*\", # include internal tooling crates",
        "]",
        "exclude = [\"crates/billing\"]",
        "",
        "[workspace.package]",
        "edition = \"2021\"",
      ].join("\n"),
    },
  });

  const memberEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "cargo-workspace-member-link",
  );
  expect(memberEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["Cargo.toml", "crates/auth/Cargo.toml"],
      ["Cargo.toml", "tools/xtask/Cargo.toml"],
    ]);
  expect(memberEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.87 &&
        /Cargo workspace pattern/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle extracts Maven reactor module links", () => {
  const repoManifest = makeRepoManifest([
    "pom.xml",
    "services/auth/pom.xml",
    "services/auth/src/main/java/AuthController.java",
    "services/billing/pom.xml",
    "services/billing/src/main/java/BillingController.java",
    "tools/migration/pom.xml",
    "tools/migration/src/main/java/MigrationTool.java",
    "legacy/pom.xml",
  ]);
  const disposition = buildFileDisposition(repoManifest);

  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "pom.xml": [
        "<project>",
        "  <modules>",
        "    <module>services/auth</module>",
        "    <module>services/billing/pom.xml</module>",
        "    <!-- ignored: <module>legacy</module> -->",
        "    <module>tools/migration</module>",
        "  </modules>",
        "</project>",
      ].join("\n"),
    },
  });

  const moduleEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "maven-module-link",
  );
  expect(moduleEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["pom.xml", "services/auth/pom.xml"],
      ["pom.xml", "services/billing/pom.xml"],
      ["pom.xml", "tools/migration/pom.xml"],
    ]);
  expect(moduleEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.87 &&
        /Maven module/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle links pytest conftest to Python files in its scope directory", () => {
  const repoManifest = makeRepoManifest([
    "src/module.py",
    "tests/conftest.py",
    "tests/test_module.py",
    "tests/test_other.py",
    "tests/utils/helpers.py",
    "tests/integration/conftest.py",
    "tests/integration/test_pipeline.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {});

  const conftestEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "conftest-link",
  );

  expect(conftestEdges.map((edge) => [edge.from, edge.to]).sort()).toEqual([
      ["tests/conftest.py", "tests/integration/test_pipeline.py"],
      ["tests/conftest.py", "tests/test_module.py"],
      ["tests/conftest.py", "tests/test_other.py"],
      ["tests/conftest.py", "tests/utils/helpers.py"],
      ["tests/integration/conftest.py", "tests/integration/test_pipeline.py"],
    ].sort());
  expect(conftestEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.85 &&
        /Pytest conftest/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle links pyproject.toml testpaths to conftest in test directory", () => {
  const repoManifest = makeRepoManifest([
    "pyproject.toml",
    "src/module.py",
    "tests/conftest.py",
    "tests/test_module.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "pyproject.toml": [
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        'addopts = "-v"',
      ].join("\n"),
    },
  });

  const testpathEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "pyproject-testpaths-link",
  );
  expect(testpathEdges.map((edge) => [edge.from, edge.to])).toEqual([["pyproject.toml", "tests/conftest.py"]]);
  expect(testpathEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.85 &&
        /pyproject\.toml testpaths/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle emits yaml-path-reference-link edges for YAML files referencing config files by path", () => {
  const repoManifest = makeRepoManifest([
    "configs/benchmark.yaml",
    "configs/templates/cifar10_base.yaml",
    "configs/templates/sst2_base.yaml",
    "src/train.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "configs/benchmark.yaml": [
        "defaults:",
        '  script: "src/train.py"',
        "domains:",
        "  image:",
        '    config_template: "configs/templates/cifar10_base.yaml"',
        "  nlp:",
        '    config_template: "configs/templates/sst2_base.yaml"',
      ].join("\n"),
    },
  });

  const yamlEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "yaml-path-reference-link",
  );
  expect(yamlEdges.map((edge) => [edge.from, edge.to]).sort()).toEqual([
      ["configs/benchmark.yaml", "configs/templates/cifar10_base.yaml"],
      ["configs/benchmark.yaml", "configs/templates/sst2_base.yaml"],
    ].sort());
  expect(yamlEdges.every(
      (edge) =>
        edge.direction === "directed" &&
        edge.confidence === 0.8 &&
        /YAML file references path/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle links Python files in test utility directories with python-test-util-suite-link", () => {
  const repoManifest = makeRepoManifest([
    "tests/utils/assertions.py",
    "tests/utils/mocks.py",
    "tests/utils/test_data.py",
    "tests/test_module.py",
    "src/utils/helpers.py",
    "src/utils/config.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {});

  const utilEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "python-test-util-suite-link",
  );

  expect(utilEdges.map((edge) => [edge.from, edge.to]).sort(), "links files in tests/utils/ but not src/utils/").toEqual([
      ["tests/utils/assertions.py", "tests/utils/mocks.py"],
      ["tests/utils/mocks.py", "tests/utils/test_data.py"],
    ].sort());
  expect(utilEdges.every(
      (edge) =>
        edge.direction === "undirected" &&
        edge.confidence === 0.72 &&
        /Python test utility/.test(edge.reason ?? ""),
    )).toBeTruthy();
});

test("buildGraphBundle python-test-util-suite-link matches helpers/ and support/ in test directories", () => {
  const repoManifest = makeRepoManifest([
    "tests/helpers/fixtures.py",
    "tests/helpers/builders.py",
    "spec/support/matchers.py",
    "spec/support/factories.py",
    "src/helpers/utils.py",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {});

  const utilEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "python-test-util-suite-link",
  );

  const edgePairs = utilEdges.map((edge) => [edge.from, edge.to]).sort();
  expect(edgePairs.some(([f, t]) => f === "tests/helpers/fixtures.py" && t === "tests/helpers/builders.py") ||
    edgePairs.some(([f, t]) => f === "tests/helpers/builders.py" && t === "tests/helpers/fixtures.py"), "links files in tests/helpers/").toBeTruthy();
  expect(edgePairs.some(([f, t]) => f === "spec/support/matchers.py" && t === "spec/support/factories.py") ||
    edgePairs.some(([f, t]) => f === "spec/support/factories.py" && t === "spec/support/matchers.py"), "links files in spec/support/").toBeTruthy();
  expect(utilEdges.filter((e) => e.from === "src/helpers/utils.py" || e.to === "src/helpers/utils.py").length, "does not link files in src/helpers/").toBe(0);
});

test("buildGraphBundle python-test-util-suite-link skips conftest.py and non-.py files", () => {
  const repoManifest = makeRepoManifest([
    "tests/utils/conftest.py",
    "tests/utils/helpers.py",
    "tests/utils/README.md",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {});

  const utilEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "python-test-util-suite-link",
  );

  expect(utilEdges.length, "single non-conftest .py file does not form a suite").toBe(0);
});

test("buildGraphBundle yaml-path-reference-link does not match non-config paths or absolute URLs", () => {
  const repoManifest = makeRepoManifest([
    "ci/pipeline.yaml",
    "ci/helpers.yaml",
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "ci/pipeline.yaml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        '    uses: https://github.com/org/repo/.github/workflows/test.yaml@main',
        '    runs-on: "ubuntu-latest"',
        '    timeout-minutes: 30',
      ].join("\n"),
    },
  });

  const yamlEdges = graph.graphs.references.filter(
    (edge) => edge.kind === "yaml-path-reference-link",
  );
  expect(yamlEdges.length, "absolute URLs should not produce edges").toBe(0);
});

test("isAuditArtifactPath matches only the exact segment", () => {
  const positives = [
    ".audit-tools/audit/file.json",
    "project/.audit-tools/audit/runs/x.json",
    ".audit-tools/remediation/state.json",
    "src/.audit-tools/anything.json",
  ];
  const negatives = [
    ".audit-toolset/file.json",
    "my-audit-tools/file.json",
    "src/main.ts",
  ];

  for (const path of positives) {
    expect(isAuditArtifactPath(normalizeExtractorPath(path)), path).toBe(true);
  }
  for (const path of negatives) {
    expect(isAuditArtifactPath(normalizeExtractorPath(path)), path).toBe(false);
  }
});

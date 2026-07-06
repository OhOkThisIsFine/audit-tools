import { test, expect } from "vitest";
import { execFileSyncHidden as execFileSync, spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  computeAuditScope,
  applyScopeToCoverage,
  resolveAuditScope,
  fullAuditScope,
} = await import("../../src/audit/orchestrator/scope.ts");

const {
  buildFileDisposition,
  VCS_IGNORED_REASON,
  VCS_IGNORED_PER_FILE_LIMIT,
  VCS_IGNORED_MAX_SHARE,
} = await import("../../src/audit/extractors/disposition.ts");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// Build a graph_bundle whose import edges all share one confidence so hop-decay
// is easy to reason about. Edges are bidirectional during scope expansion.
function bundleWithEdges(edges) {
  return {
    graphs: {
      imports: edges.map((e) => ({
        from: e.from,
        to: e.to,
        kind: "ts-import",
        direction: "directed",
        confidence: e.confidence,
      })),
      calls: [],
      references: [],
      routes: [],
    },
  };
}

function coverage(paths, { status = "pending", lenses = ["correctness"] } = {}) {
  return {
    files: paths.map((path) => ({
      path,
      unit_ids: ["u"],
      classification_status: "classified",
      audit_status: status,
      required_lenses: [...lenses],
      completed_lenses: status === "complete" ? [...lenses] : [],
    })),
  };
}

test("computeAuditScope: deterministic — same inputs (any changed order) → identical scope", () => {
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const graphBundle = bundleWithEdges([
    { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
    { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
    { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
  ]);
  const first = computeAuditScope({
    since: "HEAD~1",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle,
  });
  const second = computeAuditScope({
    since: "HEAD~1",
    changed: ["src/a.ts"],
    includedFiles: [...included].reverse(),
    graphBundle,
  });
  expect(first).toEqual(second);
  expect(first.mode).toBe("delta");
  expect(first.since).toBe("HEAD~1");
});

test("computeAuditScope: one changed file pulls in only its direct neighbours", () => {
  // 0.6 edges: one hop (0.6) clears the 0.5 frontier floor, two hops (0.36) do not.
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
      { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
    ]),
  });
  expect(scope.seed_files).toEqual(["src/a.ts"]);
  expect(scope.expanded_files).toEqual(["src/b.ts", "src/e.ts"]);
  // src/c.ts is two hops away and must stay out of scope.
  expect(!scope.expanded_files.includes("src/c.ts")).toBeTruthy();
});

test("applyScopeToCoverage: in-scope files re-queue, the rest inherit prior complete", () => {
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
      { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
    ]),
  });
  const fresh = coverage(included, { status: "pending" });
  const prior = coverage(included, { status: "complete" });
  const result = applyScopeToCoverage(fresh, scope, prior);
  const byPath = new Map(result.files.map((f) => [f.path, f]));

  // Seed + direct neighbours re-queue (pending, nothing completed yet).
  for (const inScope of ["src/a.ts", "src/b.ts", "src/e.ts"]) {
    expect(byPath.get(inScope).audit_status).toBe("pending");
    expect(byPath.get(inScope).completed_lenses).toEqual([]);
  }
  // Out-of-scope file with a prior complete record inherits that completion.
  expect(byPath.get("src/c.ts").audit_status).toBe("complete");
  expect(byPath.get("src/c.ts").completed_lenses).toEqual(["correctness"]);
});

test("applyScopeToCoverage: out-of-scope file with no prior is excluded this run", () => {
  const scope = {
    mode: "delta",
    since: "main",
    seed_files: ["src/a.ts"],
    expanded_files: [],
    budget: { max_files: 200 },
  };
  const fresh = coverage(["src/a.ts", "src/z.ts"], { status: "pending" });
  const result = applyScopeToCoverage(fresh, scope /* no prior */);
  const z = result.files.find((f) => f.path === "src/z.ts");
  expect(z.audit_status).toBe("excluded");
  expect(z.classification_status).toBe("out_of_scope_delta");
  expect(z.required_lenses).toEqual([]);
});

test("applyScopeToCoverage: full scope is a no-op", () => {
  const fresh = coverage(["src/a.ts", "src/b.ts"], { status: "pending" });
  const result = applyScopeToCoverage(fresh, fullAuditScope());
  expect(result.files.every((f) => f.audit_status === "pending")).toBe(true);
});

test("applyScopeToCoverage: deterministic exclusions are left untouched", () => {
  const scope = {
    mode: "delta",
    since: "main",
    seed_files: ["src/a.ts"],
    expanded_files: [],
    budget: { max_files: 200 },
  };
  const fresh = coverage(["src/a.ts", "vendor/lib.js"], { status: "pending" });
  fresh.files.find((f) => f.path === "vendor/lib.js").audit_status = "excluded";
  const result = applyScopeToCoverage(fresh, scope);
  const vendor = result.files.find((f) => f.path === "vendor/lib.js");
  expect(vendor.audit_status).toBe("excluded");
  // Not re-tagged as out_of_scope_delta — it was already a deterministic exclusion.
  expect(vendor.classification_status).not.toBe("out_of_scope_delta");
});

test("computeAuditScope: high fan-in/out hubs are skipped to prevent scope blow-up", () => {
  // seed -> hub, hub -> f0..f14 (15 fan-out > HIGH_FAN_DEGREE_THRESHOLD of 12).
  const fanFiles = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`);
  const edges = [{ from: "src/seed.ts", to: "src/hub.ts", confidence: 0.9 }];
  for (const f of fanFiles) {
    edges.push({ from: "src/hub.ts", to: f, confidence: 0.9 });
  }
  const included = ["src/seed.ts", "src/hub.ts", ...fanFiles];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/seed.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges(edges),
  });
  // The hub is never traversed into, so neither it nor its 15 dependents enter scope.
  expect(scope.seed_files).toEqual(["src/seed.ts"]);
  expect(scope.expanded_files).toEqual([]);
});

test("computeAuditScope: expansion stops at the file budget and records a note", () => {
  // A long 0.9-edge chain that would expand far if unbounded.
  const chain = Array.from({ length: 10 }, (_, i) => `src/n${i}.ts`);
  const edges = [];
  for (let i = 0; i < chain.length - 1; i++) {
    edges.push({ from: chain[i], to: chain[i + 1], confidence: 0.9 });
  }
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/n0.ts"],
    includedFiles: chain,
    graphBundle: bundleWithEdges(edges),
    budget: { max_files: 3 },
  });
  expect(scope.seed_files.length + scope.expanded_files.length <= 3).toBe(true);
  expect(scope.dropped_note ?? "").toMatch(/budget/);
});

test("computeAuditScope: changed files outside the auditable set drop out", () => {
  const scope = computeAuditScope({
    since: "main",
    changed: ["README.md", "docs/guide.md"],
    includedFiles: ["src/a.ts"],
    graphBundle: bundleWithEdges([]),
  });
  expect(scope.seed_files).toEqual([]);
  expect(scope.expanded_files).toEqual([]);
  expect(scope.dropped_note ?? "").toMatch(/No auditable files changed/);
});

test("computeAuditScope: two-hop expansion succeeds when accumulated confidence stays above the floor", () => {
  // 0.8 edges: one hop (0.8) > 0.5, two hops (0.64) > 0.5, three hops (0.512) > 0.5,
  // four hops (0.41) < 0.5 — so src/e.ts (four hops) must be excluded.
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.8 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.8 },
      { from: "src/c.ts", to: "src/d.ts", confidence: 0.8 },
      { from: "src/d.ts", to: "src/e.ts", confidence: 0.8 },
    ]),
  });
  expect(scope.mode).toBe("delta");
  expect(scope.seed_files).toEqual(["src/a.ts"]);
  // One hop (0.8) clears 0.5 floor.
  expect(scope.expanded_files.includes("src/b.ts"), "src/b.ts should be in expanded_files (1 hop, 0.8)").toBeTruthy();
  // Two hops (0.64) still clears 0.5 floor — the key assertion.
  expect(scope.expanded_files.includes("src/c.ts"), "src/c.ts should be in expanded_files (2 hops, 0.64)").toBeTruthy();
  // Three hops (0.512) clears 0.5 floor.
  expect(scope.expanded_files.includes("src/d.ts"), "src/d.ts should be in expanded_files (3 hops, 0.512)").toBeTruthy();
  // Four hops (0.41) drops below 0.5 floor — BFS stops here.
  expect(!scope.expanded_files.includes("src/e.ts"), "src/e.ts should NOT be in expanded_files (4 hops, 0.41 < 0.5)").toBeTruthy();
});

test("resolveAuditScope: no --since → full audit", () => {
  const scope = resolveAuditScope({ root: ".", bundle: {} });
  expect(scope.mode).toBe("full");
  expect(scope.since).toBe(null);
  expect(scope.dropped_note).toBe(undefined);
});

test("resolveAuditScope: --since with no root falls back to full with a note", () => {
  const scope = resolveAuditScope({ since: "HEAD~1", bundle: {} });
  expect(scope.mode).toBe("full");
  expect(scope.dropped_note ?? "").toMatch(/full audit/);
});

test("resolveAuditScope: real git repo — changed file + graph neighbour, mistyped ref → full", async (t) => {
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), "audit-scope-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
  } catch {
    t.skip("git is not available");
    return;
  }
  try {
    await writeFile(join(root, "a.ts"), "import './b';\nexport const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    await writeFile(join(root, "c.ts"), "export const c = 3;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // Modify one file in the working tree (uncommitted).
    await writeFile(join(root, "a.ts"), "import './b';\nexport const a = 99;\n");

    const bundle = {
      repo_manifest: {
        files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      },
      file_disposition: {
        files: [
          { path: "a.ts", status: "source" },
          { path: "b.ts", status: "source" },
          { path: "c.ts", status: "source" },
        ],
      },
      graph_bundle: {
        graphs: {
          imports: [
            {
              from: "a.ts",
              to: "b.ts",
              kind: "ts-import",
              direction: "directed",
              confidence: 0.9,
            },
          ],
          calls: [],
          references: [],
          routes: [],
        },
      },
    };

    const scope = resolveAuditScope({ root, since: "HEAD", bundle });
    expect(scope.mode).toBe("delta");
    expect(scope.seed_files).toEqual(["a.ts"]);
    expect(scope.expanded_files).toEqual(["b.ts"]);

    // A mistyped ref must not silently audit nothing — fall back to full.
    const fallback = resolveAuditScope({
      root,
      since: "definitely-not-a-ref",
      bundle,
    });
    expect(fallback.mode).toBe("full");
    expect(fallback.dropped_note ?? "").toMatch(/could not be resolved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gitignore-aware disposition (batched `git check-ignore --stdin`)
// ---------------------------------------------------------------------------

function manifest(paths) {
  return { files: paths.map((path) => ({ path })) };
}

function countingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return spawnSync(command, args, options);
  };
  return { calls, spawn };
}

async function makeGitRoot(t, gitignoreContent) {
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), "audit-disposition-"));
    git(root, "init", "-q");
  } catch {
    if (root) await rm(root, { recursive: true, force: true });
    t.skip("git is not available");
    return undefined;
  }
  if (gitignoreContent !== undefined) {
    await writeFile(join(root, ".gitignore"), gitignoreContent);
  }
  return root;
}

test("disposition: batched check-ignore classifies ignored files as vcs_ignored (single spawn, slash-normalized)", async (t) => {
  const root = await makeGitRoot(t, "alpha/\n");
  if (!root) return;
  try {
    const { calls, spawn } = countingSpawn();
    // alpha\b.ts uses Windows backslash separators on purpose: normalization
    // to forward slashes must happen before the batch reaches git, and the
    // ignored-set lookup must still match the original manifest entry.
    const disposition = buildFileDisposition(
      manifest(["alpha/a.ts", "alpha\\b.ts", "src/keep.ts"]),
      { root, spawn },
    );

    // Exactly one batched spawn with --stdin, never per-file.
    expect(calls.length).toBe(1);
    expect(calls[0].command).toBe("git");
    expect(calls[0].args.includes("check-ignore")).toBeTruthy();
    expect(calls[0].args.includes("--stdin")).toBeTruthy();
    // Input batch is forward-slash normalized.
    expect(calls[0].options.input.includes("alpha/b.ts")).toBeTruthy();
    expect(!calls[0].options.input.includes("\\")).toBeTruthy();

    const byPath = new Map(disposition.files.map((f) => [f.path, f]));
    for (const ignored of ["alpha/a.ts", "alpha\\b.ts"]) {
      expect(byPath.get(ignored).status).toBe("excluded");
      expect(byPath.get(ignored).reason).toBe(VCS_IGNORED_REASON);
    }
    expect(byPath.get("src/keep.ts").status).toBe("included");
    expect(disposition.vcs_ignore.applied).toBe(true);
    expect(disposition.vcs_ignore.ignored_count).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: check-ignore exit 1 (nothing ignored) is success; targeted exclusions unchanged", async (t) => {
  const root = await makeGitRoot(t, "does-not-match-anything/\n");
  if (!root) return;
  try {
    const disposition = buildFileDisposition(
      manifest(["src/a.ts", "dist/bundle.js"]),
      { root },
    );
    const byPath = new Map(disposition.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts").status).toBe("included");
    // Existing targeted exclusion still applies unchanged.
    expect(byPath.get("dist/bundle.js").status).toBe("generated");
    expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
    expect(disposition.vcs_ignore.applied).toBe(true);
    expect(disposition.vcs_ignore.ignored_count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: git absent (spawn ENOENT) falls back cleanly to targeted exclusions", () => {
  const enoentSpawn = () => ({
    error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  });
  // Must not throw.
  const disposition = buildFileDisposition(
    manifest(["src/a.ts", "dist/bundle.js"]),
    { root: tmpdir(), spawn: enoentSpawn },
  );
  const byPath = new Map(disposition.files.map((f) => [f.path, f]));
  expect(byPath.get("src/a.ts").status).toBe("included");
  expect(byPath.get("dist/bundle.js").status).toBe("generated");
  expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
  expect(disposition.vcs_ignore.applied).toBe(false);
  expect(disposition.vcs_ignore.skipped_reason).toMatch(/skipped/);
  expect(disposition.vcs_ignore.skipped_reason).toMatch(/ENOENT/);
});

test("disposition: not a git work tree (exit 128) falls back cleanly and records why", async (t) => {
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), "audit-disposition-nogit-"));
    // Confirm git exists but the directory is not a work tree.
    const probe = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: "x\0",
      encoding: "utf8",
    });
    if (probe.error) {
      t.skip("git is not available");
      return;
    }
    if (probe.status === 0 || probe.status === 1) {
      t.skip("temp dir is unexpectedly inside a git work tree");
      return;
    }

    const disposition = buildFileDisposition(
      manifest(["src/a.ts", "dist/bundle.js"]),
      { root },
    );
    const byPath = new Map(disposition.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts").status).toBe("included");
    expect(byPath.get("dist/bundle.js").status).toBe("generated");
    expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
    expect(disposition.vcs_ignore.applied).toBe(false);
    expect(disposition.vcs_ignore.skipped_reason).toMatch(/skipped/);
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("disposition: at or below VCS_IGNORED_PER_FILE_LIMIT emits per-file records, no aggregates", async (t) => {
  const root = await makeGitRoot(t, "alpha/\n");
  if (!root) return;
  try {
    const ignored = Array.from({ length: 5 }, (_, i) => `alpha/f${i}.ts`);
    const disposition = buildFileDisposition(
      manifest([...ignored, "src/keep.ts"]),
      { root },
    );
    for (const path of ignored) {
      const item = disposition.files.find((f) => f.path === path);
      expect(item.status).toBe("excluded");
      expect(item.reason).toBe(VCS_IGNORED_REASON);
    }
    expect(disposition.vcs_ignore.applied).toBe(true);
    expect(disposition.vcs_ignore.aggregates).toBe(undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: exactly VCS_IGNORED_PER_FILE_LIMIT ignored files is the per-file boundary (no aggregates)", async (t) => {
  const root = await makeGitRoot(t, "alpha/\n");
  if (!root) return;
  try {
    // Exactly at the named threshold ("at or below"): per-file records must
    // still be emitted; aggregation only kicks in strictly above the limit.
    const ignoredTotal = VCS_IGNORED_PER_FILE_LIMIT;
    // Enough included files to keep the ignored share under the guard.
    const includedCount =
      Math.ceil(ignoredTotal / VCS_IGNORED_MAX_SHARE) - ignoredTotal + 5;
    const paths = [
      ...Array.from({ length: ignoredTotal }, (_, i) => `alpha/f${i}.ts`),
      ...Array.from({ length: includedCount }, (_, i) => `src/s${i}.ts`),
    ];

    const disposition = buildFileDisposition(manifest(paths), { root });

    expect(disposition.vcs_ignore.applied).toBe(true);
    expect(disposition.vcs_ignore.ignored_count).toBe(ignoredTotal);
    expect(disposition.vcs_ignore.aggregates).toBe(undefined);
    const perFile = disposition.files.filter(
      (f) => f.reason === VCS_IGNORED_REASON,
    );
    expect(perFile.length).toBe(ignoredTotal);
    expect(perFile.every((f) => f.status === "excluded")).toBe(true);
    // Non-ignored candidates all remain present and included.
    expect(disposition.files.filter((f) => f.status === "included").length).toBe(includedCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: above VCS_IGNORED_PER_FILE_LIMIT aggregates by directory prefix; counts sum to total ignored", async (t) => {
  const root = await makeGitRoot(t, "alpha/\nbeta/\n");
  if (!root) return;
  try {
    const alphaCount = Math.ceil(VCS_IGNORED_PER_FILE_LIMIT * 0.75);
    const betaCount = VCS_IGNORED_PER_FILE_LIMIT - alphaCount + 51;
    const ignoredTotal = alphaCount + betaCount;
    expect(ignoredTotal > VCS_IGNORED_PER_FILE_LIMIT).toBeTruthy();

    // Enough included files to keep the ignored share under the guard.
    const includedCount =
      Math.ceil(ignoredTotal / VCS_IGNORED_MAX_SHARE) - ignoredTotal + 5;
    const paths = [
      ...Array.from({ length: alphaCount }, (_, i) => `alpha/f${i}.ts`),
      ...Array.from({ length: betaCount }, (_, i) => `beta/g${i}.ts`),
      ...Array.from({ length: includedCount }, (_, i) => `src/s${i}.ts`),
    ];

    const disposition = buildFileDisposition(manifest(paths), { root });

    // Bounded: no unbounded per-file vcs_ignored records.
    expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
    expect(disposition.files.length).toBe(includedCount);
    expect(disposition.vcs_ignore.applied).toBe(true);

    const aggregates = disposition.vcs_ignore.aggregates;
    expect(aggregates).toEqual([
      { prefix: "alpha", count: alphaCount, reason: VCS_IGNORED_REASON },
      { prefix: "beta", count: betaCount, reason: VCS_IGNORED_REASON },
    ]);
    const sum = aggregates.reduce((acc, a) => acc + a.count, 0);
    expect(sum).toBe(ignoredTotal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: root-ignored guard skips the rule and records root_ignored", async (t) => {
  const root = await makeGitRoot(t, "*\n");
  if (!root) return;
  try {
    const disposition = buildFileDisposition(
      manifest(["src/a.ts", "src/b.ts", "lib/c.ts"]),
      { root },
    );
    expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
    expect(disposition.files.length).toBe(3);
    expect(disposition.vcs_ignore.applied).toBe(false);
    expect(disposition.vcs_ignore.guard_branch).toBe("root_ignored");
    expect(disposition.vcs_ignore.skipped_reason).toMatch(/skipped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposition: share guard skips the rule and records share_exceeded", async (t) => {
  const root = await makeGitRoot(t, "alpha/\n");
  if (!root) return;
  try {
    // 19 of 20 candidates ignored → share 0.95 > VCS_IGNORED_MAX_SHARE (0.9),
    // but not every candidate, so the share branch (not root_ignored) fires.
    const paths = [
      ...Array.from({ length: 19 }, (_, i) => `alpha/f${i}.ts`),
      "src/keep.ts",
    ];
    const disposition = buildFileDisposition(manifest(paths), { root });
    expect(disposition.files.some((f) => f.reason === VCS_IGNORED_REASON)).toBe(false);
    expect(disposition.files.length).toBe(20);
    expect(disposition.vcs_ignore.applied).toBe(false);
    expect(disposition.vcs_ignore.guard_branch).toBe("share_exceeded");
    expect(disposition.vcs_ignore.skipped_reason).toMatch(/skipped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Invariant tests for the audit-extractors module.
 * Locks the contract guarantees established by the N-audit-extractors-inv
 * remediation block (INV-audit-extractors-01 through INV-audit-extractors-10).
 *
 * These are deterministic, in-process tests — no LLM calls.
 */
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { importSourceModule } from "./helpers/sourceImport.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";
import type { Finding } from "../../src/audit/types.js";
import type { GraphEdge } from "audit-tools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = tests/audit; PACKAGE_ROOT = repo root (single package)
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const EXTRACTOR_SRC = join(PACKAGE_ROOT, "src", "audit", "extractors");

// ── INV-audit-extractors-01: graphManifestEdges is a pure barrel ─────────────
// The index.ts must only re-export and must not import from graph.ts.
// Each language analyzer must be independently importable.

test("INV-01: graphManifestEdges/index.ts contains no imports from graph.ts", () => {
  const indexSrc = readFileSync(
    join(EXTRACTOR_SRC, "graphManifestEdges", "index.ts"),
    "utf8",
  );
  expect(!indexSrc.includes("from \"../graph.js\"") &&
    !indexSrc.includes("from \"../graph\"") &&
    !indexSrc.includes("from './graph'") &&
    !indexSrc.includes("from \"./graph\""), "graphManifestEdges/index.ts must not import from graph.ts").toBeTruthy();
  // Must not contain any `import` statements (only re-exports).
  expect(!indexSrc.includes("\nimport ") && !indexSrc.startsWith("import "), "graphManifestEdges/index.ts must not have any import statements — pure re-export barrel only").toBeTruthy();
});

test("INV-01: each graphManifestEdges language analyzer imports independently (no graph.ts cycle)", () => {
  const analyzerFiles = [
    join(EXTRACTOR_SRC, "graphManifestEdges", "packageJson.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "cargo.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "typescript.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "go.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "maven.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "pyproject.ts"),
    join(EXTRACTOR_SRC, "graphManifestEdges", "yamlPaths.ts"),
  ];
  for (const filePath of analyzerFiles) {
    const src = readFileSync(filePath, "utf8");
    expect(!src.includes("from \"../graph.js\"") && !src.includes("from \"../graph\""), `${filePath} must not import from graph.ts (would create a cycle)`).toBeTruthy();
  }
});

// ── INV-audit-extractors-02: graph edges conform to shared language-neutral contract ─
// Every edge emitted by an analyzer must have the required fields: from, to, kind.
// Confidence and direction must be within the shared contract's allowed types.

test("INV-02: extractors emit edges that conform to shared GraphEdge shape", async () => {
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");
  const { buildFileDisposition } = await importSourceModule("src/extractors/disposition.ts");
  const { buildRepoManifest } = await importSourceModule("src/extractors/fileInventory.ts");

  const repoManifest = buildRepoManifest("fixture", [
    { path: "src/api/auth.ts", size_bytes: 100 },
    { path: "src/lib/session.ts", size_bytes: 100 },
    { path: "schemas/finding.schema.json", size_bytes: 100 },
    { path: "schemas/result.schema.json", size_bytes: 100 },
    { path: "package.json", size_bytes: 100 },
    { path: "src/cli.ts", size_bytes: 100 },
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/api/auth.ts": "import { createSession } from '../lib/session.ts';\n",
      "schemas/finding.schema.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "./result.schema.json",
      }),
      "package.json": JSON.stringify({
        bin: { fixture: "./src/cli.ts" },
      }),
    },
  });

  const VALID_DIRECTIONS = new Set(["directed", "undirected", undefined]);
  const allEdgeLists = [
    graph.graphs.imports,
    graph.graphs.calls,
    graph.graphs.references,
    graph.graphs.heuristics,
  ];

  let total = 0;
  for (const edges of allEdgeLists) {
    for (const edge of edges) {
      total++;
      expect(typeof edge.from, `edge.from must be string, got ${typeof edge.from}`).toBe("string");
      expect(edge.from.length > 0, "edge.from must be non-empty").toBeTruthy();
      expect(typeof edge.to, `edge.to must be string, got ${typeof edge.to}`).toBe("string");
      expect(edge.to.length > 0, "edge.to must be non-empty").toBeTruthy();
      expect(typeof edge.kind, `edge.kind must be string`).toBe("string");
      expect(edge.kind.length > 0, "edge.kind must be non-empty").toBeTruthy();
      if (edge.confidence !== undefined) {
        expect(typeof edge.confidence === "number" && edge.confidence >= 0 && edge.confidence <= 1, `edge.confidence must be a number in [0,1], got ${edge.confidence}`).toBeTruthy();
      }
      expect(VALID_DIRECTIONS.has(edge.direction), `edge.direction must be 'directed', 'undirected', or undefined, got '${edge.direction}'`).toBeTruthy();
    }
  }
  expect(total > 0, "should have emitted at least one edge").toBeTruthy();
});

// ── INV-audit-extractors-03: cycle detection uses per-DFS-path bookkeeping ──
// A cycle reachable ONLY via an already-visited node must NOT be missed.
// Diamond graph: A→X (non-cycle path), B→X→C→X (cycle via shared X).
// With a shared visited set, after DFS from A visits X (no cycle), B's path to
// X is skipped and the cycle X→C→X is missed.

test("INV-03: detectCycles finds cycle reachable only through already-visited shared node", async () => {
  const { buildDesignAssessment } = await importSourceModule("src/extractors/designAssessment.ts");

  // Graph: A→X (leaf from A), B→X, X→C, C→X (cycle X↔C).
  // If DFS starts at A, visits X (no cycle since C→X doesn't exist from A's path alone).
  // Then from B, if X is "visited" and we skip it, we miss the X→C→X cycle.
  // The fixed code uses per-DFS-root visited sets, so B's DFS re-enters X and finds the cycle.
  const result = buildDesignAssessment({
    unitManifest: { units: [] },
    graphBundle: {
      graphs: {
        imports: [
          { from: "A.ts", to: "X.ts", kind: "esm" },
          { from: "B.ts", to: "X.ts", kind: "esm" },
          { from: "X.ts", to: "C.ts", kind: "esm" },
          { from: "C.ts", to: "X.ts", kind: "esm" },
        ],
        calls: [],
        references: [],
        heuristics: [],
        routes: [],
      },
    },
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  });

  const cycleFinding = result.findings.find(
    (finding: Finding) => finding.category === "dependency_cycle",
  );
  expect(cycleFinding, "must detect the X↔C cycle reachable via the shared X node").toBeTruthy();
  expect(cycleFinding.affected_files.some((f: { path: string }) => f.path === "X.ts") ||
    cycleFinding.affected_files.some((f: { path: string }) => f.path === "C.ts"), "cycle finding must include X.ts or C.ts").toBeTruthy();
});

test("INV-03: detectCycles finds direct 2-node cycle (basic regression)", async () => {
  const { buildDesignAssessment } = await importSourceModule("src/extractors/designAssessment.ts");

  const result = buildDesignAssessment({
    unitManifest: { units: [] },
    graphBundle: {
      graphs: {
        imports: [
          { from: "a.ts", to: "b.ts", kind: "esm" },
          { from: "b.ts", to: "a.ts", kind: "esm" },
        ],
        calls: [],
        references: [],
        heuristics: [],
        routes: [],
      },
    },
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  });

  const cycleFinding = result.findings.find(
    (finding: Finding) => finding.category === "dependency_cycle",
  );
  expect(cycleFinding, "must detect the a↔b cycle").toBeTruthy();
});

// ── INV-audit-extractors-04: regex-based extraction is linear-time-safe ──────
// A deeply-nested Angular route object must not catastrophically backtrack.

test("INV-04: Angular route ANGULAR_ROUTE_OBJECT_PATTERN does not hang on deeply nested input", async () => {
  const { extractFrameworkRouteEvidence } = await importSourceModule(
    "src/extractors/graphRoutes.ts",
  );

  // Construct a deeply nested Angular-style routes object that exercises the
  // ANGULAR_ROUTE_OBJECT_PATTERN without triggering catastrophic backtracking.
  const nestedRoutes = Array.from({ length: 200 }, (_, i) =>
    `  { path: 'segment${i}', component: Component${i}, data: { title: 'Page ${i}', nested: { deep: true, value: ${i} } } }`,
  ).join(",\n");
  const content = [
    "import { RouterModule, Routes } from '@angular/router';",
    "const routes: Routes = [",
    nestedRoutes,
    "];",
  ].join("\n");

  const start = Date.now();
  const result = extractFrameworkRouteEvidence("src/app-routing.module.ts", content, new Map());
  const elapsed = Date.now() - start;

  expect(elapsed < 2000, `Angular route extraction must complete in <2000ms, took ${elapsed}ms (possible catastrophic backtracking)`).toBeTruthy();
  // Should extract routes from the nested content.
  expect(Array.isArray(result.routes), "must return routes array").toBeTruthy();
});

// ── INV-audit-extractors-05: loadIgnoreFile honors gitignore-style glob semantics ─
// The .auditorignore file SHOULD be treated as gitignore (via the git check-ignore
// integration). The loadIgnoreFile function itself reads the raw lines (for use with
// fsIntake's shouldIgnore heuristic), while the disposition layer applies real VCS
// semantics via git check-ignore. We verify:
// (a) loadIgnoreFile returns patterns for use by the disposition layer
// (b) VCS-backed disposition correctly excludes negation/wildcard patterns via git

test("INV-05: loadIgnoreFile returns patterns including wildcard and negation lines unchanged", async () => {
  const { loadIgnoreFile } = await importSourceModule("src/extractors/ignore.ts");

  await withTempDir("audit-code-inv05-", async (root) => {
    await writeFile(
      join(root, ".auditorignore"),
      [
        "# comment",
        "dist/",
        "*.log",
        "!important.log",
        "secrets/",
        "",
      ].join("\n"),
      "utf8",
    );

    const patterns = await loadIgnoreFile(root);
    expect(patterns).toEqual(["dist/", "*.log", "!important.log", "secrets/"]);
  });
});

test("INV-05: loadIgnoreFile tolerates a missing .auditorignore file", async () => {
  const { loadIgnoreFile } = await importSourceModule("src/extractors/ignore.ts");

  await withTempDir("audit-code-inv05b-", async (root) => {
    const patterns = await loadIgnoreFile(root);
    expect(patterns).toEqual([]);
  });
});

// ── INV-audit-extractors-06: disposition VCS-ignore guard branches are covered ─
// Both 'root_ignored' and 'share_exceeded' must be explicitly surfaced in the
// disposition's vcs_ignore summary, not silently applied.

test("INV-06: buildFileDisposition surfaces root_ignored guard branch", async () => {
  const { buildFileDisposition } = await importSourceModule("src/extractors/disposition.ts");
  const { buildRepoManifest } = await importSourceModule("src/extractors/fileInventory.ts");

  const repoManifest = buildRepoManifest("fixture", [
    { path: "src/a.ts", size_bytes: 10 },
    { path: "src/b.ts", size_bytes: 10 },
  ]);

  // Fake spawn: reports ALL files as ignored (root_ignored guard fires).
  const fakeSpawn = (_cmd: string, _args: string[], opts: { input: string }) => ({
    status: 0,
    stdout: opts.input.replace(/\0/g, "\0"),
    stderr: "",
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  });

  const result = buildFileDisposition(repoManifest, {
    root: "/fake/root",
    spawn: fakeSpawn,
  });

  expect(result.vcs_ignore?.applied, "root_ignored guard must set applied=false").toBe(false);
  expect(result.vcs_ignore?.guard_branch, "guard_branch must be 'root_ignored'").toBe("root_ignored");
  expect(result.vcs_ignore?.skipped_reason?.includes("root itself is ignored"), "skipped_reason must mention the root being ignored").toBeTruthy();
});

test("INV-06: buildFileDisposition surfaces share_exceeded guard branch", async () => {
  const { buildFileDisposition, VCS_IGNORED_MAX_SHARE } = await importSourceModule(
    "src/extractors/disposition.ts",
  );
  const { buildRepoManifest } = await importSourceModule("src/extractors/fileInventory.ts");

  // Create enough files so that ignoring all BUT one exceeds the share threshold.
  const filePaths = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
  const repoManifest = buildRepoManifest(
    "fixture",
    filePaths.map((path) => ({ path, size_bytes: 10 })),
  );

  // Fake spawn: ignores all but the last file → share = 19/20 = 0.95 > VCS_IGNORED_MAX_SHARE
  const ignoredPaths = filePaths.slice(0, -1).map((p) => p.replace(/\\/g, "/"));
  const fakeSpawn = (_cmd: string, _args: string[], _opts: unknown) => ({
    status: 0,
    stdout: ignoredPaths.join("\0") + "\0",
    stderr: "",
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  });

  const result = buildFileDisposition(repoManifest, {
    root: "/fake/root",
    spawn: fakeSpawn,
  });

  expect(result.vcs_ignore?.applied, "share_exceeded guard must set applied=false").toBe(false);
  expect(result.vcs_ignore?.guard_branch, "guard_branch must be 'share_exceeded'").toBe("share_exceeded");
  expect(result.vcs_ignore?.skipped_reason?.includes("exceeds VCS_IGNORED_MAX_SHARE"), "skipped_reason must mention the exceeded share").toBeTruthy();
  expect(typeof VCS_IGNORED_MAX_SHARE === "number" && VCS_IGNORED_MAX_SHARE > 0 && VCS_IGNORED_MAX_SHARE < 1, "VCS_IGNORED_MAX_SHARE must be exported and be a fraction in (0,1)").toBeTruthy();
});

// ── INV-audit-extractors-07: TypeScript analyzer uses async file IO ───────────
// The TypeScript analyzer source must not use readFileSync on a per-file hot path.
// The only allowed readFile in an async context must be async (readFile, not readFileSync).

test("INV-07: typescript analyzer source does not import readFileSync", () => {
  const src = readFileSync(
    join(EXTRACTOR_SRC, "analyzers", "typescript.ts"),
    "utf8",
  );
  expect(!src.includes("readFileSync"), "typescript analyzer must not use readFileSync; use async readFile instead").toBeTruthy();
  expect(src.includes("readFile"), "typescript analyzer must import readFile (async)").toBeTruthy();
});

// ── INV-audit-extractors-08: oversized file handling in fsIntake ─────────────
// An oversized file must still appear in the manifest (with its size_bytes),
// but without a hash — not silently dropped or left half-present.

test("INV-08: buildRepoManifestFromFs includes oversized files without a hash", async () => {
  const { buildRepoManifestFromFs } = await importSourceModule("src/extractors/fsIntake.ts");

  await withTempDir("audit-code-inv08-", async (root) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "small.ts"), "const x = 1;\n", "utf8");
    await writeFile(join(root, "src", "huge.ts"), "x".repeat(200), "utf8");

    const manifest = await buildRepoManifestFromFs({
      root,
      hash_files: true,
      max_file_size_bytes: 100,
    });

    const small = manifest.files.find((f: { path: string }) => f.path === "src/small.ts");
    const huge = manifest.files.find((f: { path: string }) => f.path === "src/huge.ts");

    expect(small, "small file must appear in manifest").toBeTruthy();
    expect(typeof small.hash, "small file must have a hash").toBe("string");

    expect(huge, "oversized file must appear in manifest (not silently dropped)").toBeTruthy();
    expect(huge.hash, "oversized file must NOT have a hash").toBe(undefined);
    expect(huge.size_bytes > 100, "oversized file must have its actual size_bytes recorded").toBeTruthy();
  });
});

// ── INV-audit-extractors-09: heuristicAuthSession edges scope to related nodes ─
// The auth↔session heuristic must only link auth-named files to session-named files,
// not emit edges for every name-matching file in the entire repository.

test("INV-09: heuristicAuthSession edges connect only auth-named to session-named files", async () => {
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");
  const { buildFileDisposition } = await importSourceModule("src/extractors/disposition.ts");
  const { buildRepoManifest } = await importSourceModule("src/extractors/fileInventory.ts");

  const repoManifest = buildRepoManifest("fixture", [
    { path: "src/auth/service.ts", size_bytes: 10 },     // auth file
    { path: "src/session/store.ts", size_bytes: 10 },    // session file (should be linked)
    { path: "src/billing/invoice.ts", size_bytes: 10 },  // unrelated (must NOT be linked)
    { path: "src/user/profile.ts", size_bytes: 10 },     // unrelated (must NOT be linked)
    { path: "src/auth/session.ts", size_bytes: 10 },     // contains both "auth" and "session" in path
  ]);
  const disposition = buildFileDisposition(repoManifest);
  const graph = buildGraphBundle(repoManifest, disposition);

  const authSessionEdges = graph.graphs.heuristics.filter(
    (e: GraphEdge) => e.kind === "heuristic-auth-session-link",
  );

  // Edges must only go from auth-named files to session-named files.
  for (const edge of authSessionEdges) {
    const fromLower = edge.from.toLowerCase();
    const toLower = edge.to.toLowerCase();
    expect(fromLower.includes("auth"), `heuristic-auth-session-link 'from' must include 'auth', got: ${edge.from}`).toBeTruthy();
    expect(toLower.includes("session"), `heuristic-auth-session-link 'to' must include 'session', got: ${edge.to}`).toBeTruthy();
  }

  // Must NOT link auth files to unrelated billing or profile files.
  const linkedTargets = new Set(authSessionEdges.map((e: GraphEdge) => e.to));
  expect(!linkedTargets.has("src/billing/invoice.ts"), "heuristicAuthSession must NOT link to unrelated billing files").toBeTruthy();
  expect(!linkedTargets.has("src/user/profile.ts"), "heuristicAuthSession must NOT link to unrelated user profile files").toBeTruthy();
});

// ── INV-audit-extractors-10: parse errors emit a structured diagnostic ────────
// graphSuites, fsIntake, and graphRoutes must emit a stderr diagnostic on parse
// errors — not vanish silently.

test("INV-10: graphSuites JSON parse error emits a stderr diagnostic", async () => {
  const { extractJsonSchemaReferenceEdges } = await importSourceModule(
    "src/extractors/graphSuites.ts",
  );

  const stderrLines: string[] = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (...args: [chunk: string | Uint8Array, ...rest: unknown[]]): boolean => {
    stderrLines.push(String(args[0]));
    return Reflect.apply(origWrite, process.stderr, args);
  };
  try {
    const result = extractJsonSchemaReferenceEdges(
      "schemas/broken.schema.json",
      "not valid json {{{",
      new Map(),
    );
    expect(result, "must return empty array on parse error").toEqual([]);
  } finally {
    process.stderr.write = origWrite;
  }

  const hasLog = stderrLines.some(
    (line) => line.includes("graphSuites") && line.includes("JSON parse error"),
  );
  expect(hasLog, "must emit a structured stderr diagnostic on JSON parse error").toBeTruthy();
});

test("INV-10: fsIntake emits warn diagnostic for unreadable directory", async () => {
  // fsIntake already emits console.warn for readdir errors.
  // Verify the diagnostic message format by inspecting source.
  const src = readFileSync(join(EXTRACTOR_SRC, "fsIntake.ts"), "utf8");
  expect(src.includes("console.warn") && src.includes("skipping unreadable"), "fsIntake must have console.warn for unreadable directory/file errors").toBeTruthy();
});

test("INV-10: fsIntake emits warn diagnostic for oversized files", async () => {
  const { buildRepoManifestFromFs } = await importSourceModule("src/extractors/fsIntake.ts");

  await withTempDir("audit-code-inv10-", async (root) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "huge.ts"), "x".repeat(200), "utf8");

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => {
      warnMessages.push(args.join(" "));
    };
    try {
      await buildRepoManifestFromFs({
        root,
        hash_files: true,
        max_file_size_bytes: 100,
      });
    } finally {
      console.warn = origWarn;
    }

    const hasSkipLog = warnMessages.some(
      (msg) => msg.includes("[fsIntake]") && msg.includes("oversized"),
    );
    expect(hasSkipLog, "fsIntake must emit a warn diagnostic for oversized files").toBeTruthy();
  });
});

// ── ARC-27aceb61: regex-based import extraction — capability boundary regression ─
//
// Finding ARC-27aceb61 notes that graph.ts uses IMPORT_PATTERNS (regex over raw
// text) to build the dependency graph rather than the TypeScript compiler API.
// The regex approach is an explicit architectural trade-off: it is language-neutral
// (works across TS, JS, Python, Go) and deterministic, but has known limits.
//
// This block records the capability boundary as a regression assertion so that:
//   (a) future callers know what the regex layer guarantees, and
//   (b) any migration to the TS compiler API has a concrete behavioral baseline.
//
// Known capabilities: ESM static imports, re-exports, string-literal dynamic
//   imports `import('./foo')`, CJS require.
// Known limitations: dynamic imports with template literals `import(\`./\${x}\`)`
//   are silently missed (cannot be statically resolved by any regex approach).
//
// The module contract (finalized_module_contracts.json) already documents:
//   "import resolution is heuristic/regex today — ARC-27aceb61."

test("ARC-27aceb61: buildGraphBundle extracts ESM static import edges", async () => {
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");

  const repoManifest = {
    files: [
      { path: "src/a.ts", language: "typescript", size_bytes: 50, excluded: false },
      { path: "src/b.ts", language: "typescript", size_bytes: 50, excluded: false },
    ],
  };
  const fileContents = {
    "src/a.ts": `import { foo } from "./b.js";\nexport const x = 1;`,
    "src/b.ts": `export const foo = 2;`,
  };

  const bundle = buildGraphBundle(repoManifest, undefined, { fileContents });
  const importEdges = bundle.graphs.imports;

  const edge = importEdges.find((e: GraphEdge) => e.from === "src/a.ts" && e.to === "src/b.ts");
  expect(edge !== undefined, "buildGraphBundle must extract an ESM import edge from src/a.ts → src/b.ts").toBeTruthy();
  expect(edge.kind, "import edge must have kind 'esm'").toBe("esm");
  expect(typeof edge.confidence === "number" && edge.confidence > 0, "import edge must have positive confidence").toBeTruthy();
});

test("ARC-27aceb61: buildGraphBundle extracts re-export edges", async () => {
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");

  const repoManifest = {
    files: [
      { path: "src/index.ts", language: "typescript", size_bytes: 60, excluded: false },
      { path: "src/utils.ts", language: "typescript", size_bytes: 40, excluded: false },
    ],
  };
  const fileContents = {
    "src/index.ts": `export { helper } from "./utils.js";`,
    "src/utils.ts": `export const helper = () => {};`,
  };

  const bundle = buildGraphBundle(repoManifest, undefined, { fileContents });
  const importEdges = bundle.graphs.imports;

  const edge = importEdges.find(
    (e: GraphEdge) => e.from === "src/index.ts" && e.to === "src/utils.ts",
  );
  expect(edge !== undefined, "buildGraphBundle must extract a re-export edge from src/index.ts → src/utils.ts").toBeTruthy();
  expect(edge.kind, "re-export edge must have kind 're-export'").toBe("re-export");
});

test("ARC-27aceb61: buildGraphBundle extracts string-literal dynamic import edges", async () => {
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");

  const repoManifest = {
    files: [
      { path: "src/loader.ts", language: "typescript", size_bytes: 80, excluded: false },
      { path: "src/module.ts", language: "typescript", size_bytes: 40, excluded: false },
    ],
  };
  const fileContents = {
    "src/loader.ts": `const mod = await import("./module.js");`,
    "src/module.ts": `export const value = 42;`,
  };

  const bundle = buildGraphBundle(repoManifest, undefined, { fileContents });
  const importEdges = bundle.graphs.imports;

  const edge = importEdges.find(
    (e: GraphEdge) => e.from === "src/loader.ts" && e.to === "src/module.ts",
  );
  expect(edge !== undefined, "buildGraphBundle must extract a dynamic-import edge for string-literal specifier").toBeTruthy();
  expect(edge.kind, "dynamic import edge must have kind 'dynamic-import'").toBe("dynamic-import");
});

test("ARC-27aceb61: buildGraphBundle does NOT extract template-literal dynamic import edges (known regex limitation)", async () => {
  // This test documents the known limitation of the regex approach.
  // Template-literal dynamic imports (`import(\`./\${segment}\`)`) cannot be
  // statically resolved by regex. The TypeScript compiler API could resolve these
  // when the template expression is a union of string literals, but the regex
  // approach silently misses them. This is the trade-off recorded in ARC-27aceb61.
  const { buildGraphBundle } = await importSourceModule("src/extractors/graph.ts");

  const repoManifest = {
    files: [
      { path: "src/dynamic.ts", language: "typescript", size_bytes: 100, excluded: false },
      { path: "src/feature.ts", language: "typescript", size_bytes: 40, excluded: false },
    ],
  };
  const segment = "feature";
  // Template literal: import(`./\${segment}.js`) — not a string literal
  const fileContents = {
    "src/dynamic.ts": `const seg = "${segment}";\nconst mod = await import(\`./\${seg}.js\`);`,
    "src/feature.ts": `export const x = 1;`,
  };

  const bundle = buildGraphBundle(repoManifest, undefined, { fileContents });
  const importEdges = bundle.graphs.imports;

  const edge = importEdges.find(
    (e: GraphEdge) => e.from === "src/dynamic.ts" && e.to === "src/feature.ts",
  );
  // EXPECTED: the regex approach does NOT detect this edge. This is the documented
  // limitation. If this assertion ever fails, it means the extractor was upgraded
  // to handle template literals (e.g. via TS compiler API) — update accordingly.
  expect(edge, "buildGraphBundle must NOT extract a template-literal dynamic import (known regex limitation — ARC-27aceb61)").toBe(undefined);
});

// ── COR-743d2837 / COR-11e067ab: the deterministic-extraction failure surface ──
//
// The eslint runner, the tsc runner, and the fs-backed graph build all degrade
// rather than throw. These tests pin WHICH degradation each produces, because the
// status a run lands on is the only thing a caller can read.

const ORCHESTRATOR_SRC = join(PACKAGE_ROOT, "src", "audit", "orchestrator");

const {
  eslintCommandArgs,
  resolveEslintConfigState,
  runSyntaxResolutionExecutor,
}: typeof import("../../src/audit/orchestrator/syntaxResolutionExecutor.js") =
  await import("../../src/audit/orchestrator/syntaxResolutionExecutor.js");

const JS_BUNDLE = {
  file_disposition: { files: [{ path: "src/app.js", status: "included" as const }] },
};

/** A repo-local fake eslint: emits one finding, or fails the way ESLint 9 fails on `--ext`. */
async function writeFakeEslint(root: string, version: string): Promise<void> {
  const eslintDir = join(root, "node_modules", "eslint");
  await mkdir(join(eslintDir, "bin"), { recursive: true });
  await writeFile(join(eslintDir, "package.json"), JSON.stringify({ name: "eslint", version }));
  await writeFile(
    join(eslintDir, "bin", "eslint.js"),
    [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "const argv = process.argv.slice(2);",
      "writeFileSync(path.join(process.cwd(), 'eslint-argv.json'), JSON.stringify(argv));",
      // ESLint 9+ rejects --ext outright: nothing but an error on stderr.
      "if (argv.includes('--ext')) {",
      "  process.stderr.write(\"Invalid option '--ext'\\n\");",
      "  process.exit(2);",
      "}",
      "process.stdout.write(JSON.stringify([{",
      "  filePath: path.join(process.cwd(), 'src', 'app.js'),",
      "  messages: [{ severity: 2, line: 1, message: 'fixture lint error', ruleId: 'fixture/rule' }]",
      "}]));",
      "",
    ].join("\n"),
  );
}

async function writeJsFixture(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.js"), "console.log('fixture');\n");
}

function eslintStatus(result: {
  updated: { external_analyzer_results?: Array<{ tool_statuses?: unknown[] }> };
}): { tool: string; status: string; error?: string; output_snippet?: string } {
  const statuses = (result.updated.external_analyzer_results?.[0]?.tool_statuses ??
    []) as Array<{ tool: string; status: string; error?: string; output_snippet?: string }>;
  return statuses.find((status) => status.tool === "eslint")!;
}

// inv-3: the eslint flag surface must match the INSTALLED major.
test("inv-3: eslint is invoked WITHOUT --ext under a flat-config eslint, so the run parses", async () => {
  await withTempDir("audit-code-eslint-ext-", async (root) => {
    await writeJsFixture(root);
    await writeFakeEslint(root, "9.24.0");
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");

    const result = runSyntaxResolutionExecutor(JS_BUNDLE, root);
    const status = eslintStatus(result);

    const argv = JSON.parse(readFileSync(join(root, "eslint-argv.json"), "utf8")) as string[];
    expect(
      argv.includes("--ext"),
      `--ext must not be passed to a flat-config eslint; got ${JSON.stringify(argv)}`,
    ).toBe(false);
    expect(status.status, "the run must parse, not land on parse_error").toBe("findings");
    expect(result.updated.external_analyzer_results![0].results.length).toBe(1);
  });
});

test("inv-3: eslintCommandArgs carries --ext only for a pre-flat-config major", () => {
  expect(eslintCommandArgs(9).includes("--ext"), "ESLint 9 removed --ext").toBe(false);
  expect(eslintCommandArgs(10).includes("--ext")).toBe(false);
  expect(eslintCommandArgs(undefined).includes("--ext"), "unknown major is treated as modern").toBe(false);
  expect(eslintCommandArgs(8).includes("--ext"), "ESLint 8 still needs --ext to reach .ts").toBe(true);
  expect(eslintCommandArgs(9)).toEqual([".", "--format", "json"]);
});

// inv-4: config discovery is era-aware — a config nothing reads is not a config.
test("inv-4: a legacy-only .eslintrc under a flat-config eslint is a REASONED skip, not a silent zero-findings run", async () => {
  await withTempDir("audit-code-eslint-legacy-", async (root) => {
    await writeJsFixture(root);
    await writeFakeEslint(root, "9.24.0");
    await writeFile(join(root, ".eslintrc.json"), JSON.stringify({ rules: {} }));

    const state = resolveEslintConfigState(root);
    expect(state.runnable, "eslint 9 does not read .eslintrc*").toBe(false);
    expect(
      state.skip_reason !== undefined && state.skip_reason.length > 0,
      "the skip must say why",
    ).toBeTruthy();

    const result = runSyntaxResolutionExecutor(JS_BUNDLE, root);
    const status = eslintStatus(result);
    expect(status.status, "never 'success' — the tool did not run").toBe("skipped");
    expect(status.error, "the record distinguishes this from 'no config at all'").toMatch(/legacy/i);
    expect(existsSync(join(root, "eslint-argv.json")), "eslint must not be spawned at all").toBe(false);
  });
});

test("inv-4: the same legacy config IS runnable under an eslint major that still reads it", async () => {
  await withTempDir("audit-code-eslint-legacy8-", async (root) => {
    await writeJsFixture(root);
    await writeFakeEslint(root, "8.57.0");
    await writeFile(join(root, ".eslintrc.json"), JSON.stringify({ rules: {} }));

    const state = resolveEslintConfigState(root);
    expect(state.runnable, "eslint 8 reads .eslintrc*").toBe(true);
    expect(state.major).toBe(8);

    // And a flat config is runnable whatever the major is.
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");
    expect(resolveEslintConfigState(root).runnable).toBe(true);
  });
});

test("inv-4: no configuration at all is a skip with its OWN reason", async () => {
  await withTempDir("audit-code-eslint-noconfig-", async (root) => {
    await writeJsFixture(root);
    await writeFakeEslint(root, "9.24.0");

    const state = resolveEslintConfigState(root);
    expect(state.runnable).toBe(false);
    expect(state.skip_reason).toMatch(/no eslint configuration/i);
    expect(eslintStatus(runSyntaxResolutionExecutor(JS_BUNDLE, root)).status).toBe("skipped");
  });
});

// inv-7: the diagnostic count is derived from the ONE exported status
// classification, so every member of the union is accounted for — including the
// members a hand-copied list omitted.
test("inv-7: a tool that never ran counts as an analyzer diagnostic (classification-derived)", async () => {
  await withTempDir("audit-code-diagnostic-count-", async (root) => {
    await writeJsFixture(root);
    await writeFakeEslint(root, "9.24.0");

    // No config → 'skipped' → classification 'not_run' → no coverage was produced.
    const result = runSyntaxResolutionExecutor(JS_BUNDLE, root);
    expect(eslintStatus(result).status).toBe("skipped");
    expect(
      result.progress_summary,
      "a tool that never ran must not read as a clean scan",
    ).toMatch(/1 analyzer diagnostic/);
  });
});

test("inv-7: syntaxResolutionExecutor keeps no private copy of the status vocabulary", () => {
  const src = readFileSync(join(ORCHESTRATOR_SRC, "syntaxResolutionExecutor.ts"), "utf8");
  expect(
    src.includes("EXTERNAL_ANALYZER_STATUS_CLASSIFICATION"),
    "the shared exhaustive classification must be the consumed vocabulary",
  ).toBeTruthy();
  const members = [
    "skipped",
    "success",
    "findings",
    "not_resolved",
    "spawn_error",
    "parse_error",
    "failed",
    "checksum_mismatch",
  ];
  for (const member of members) {
    expect(
      new RegExp(`\\[\\s*"${member}"\\s*,`).test(src),
      `a status-string ARRAY starting with "${member}" is a second copy of the union`,
    ).toBe(false);
  }
});

// F5: "did this run produce trustworthy coverage?" is ONE member-level question
// with ONE home, not a comparison re-typed at each consumer.
test("inv-7: the non-clean coverage question is single-sourced and exhaustive", async () => {
  const { isNonCleanAnalyzerCoverage, EXTERNAL_ANALYZER_STATUS_CLASSIFICATION } = await import(
    "../../src/shared/analyzers/types.js"
  );

  expect(isNonCleanAnalyzerCoverage("clean")).toBe(false);
  expect(isNonCleanAnalyzerCoverage("findings")).toBe(false);
  expect(isNonCleanAnalyzerCoverage("degraded")).toBe(true);
  expect(isNonCleanAnalyzerCoverage("not_run")).toBe(true);

  // Every status member resolves through the same helper — no member is left to
  // a consumer's own judgement.
  expect(isNonCleanAnalyzerCoverage(EXTERNAL_ANALYZER_STATUS_CLASSIFICATION.checksum_mismatch)).toBe(true);
  expect(isNonCleanAnalyzerCoverage(EXTERNAL_ANALYZER_STATUS_CLASSIFICATION.skipped)).toBe(true);
  expect(isNonCleanAnalyzerCoverage(EXTERNAL_ANALYZER_STATUS_CLASSIFICATION.success)).toBe(false);

  // …and neither consumer keeps its own copy of the comparison.
  const consumer = readFileSync(join(ORCHESTRATOR_SRC, "syntaxResolutionExecutor.ts"), "utf8");
  const owner = readFileSync(
    join(PACKAGE_ROOT, "src", "shared", "analyzers", "types.ts"),
    "utf8",
  );
  // Assert about CODE, not prose — a doc comment may quote the comparison it
  // replaced without being a second copy of it.
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const [label, source] of [["consumer", consumer], ["owner", owner]] as const) {
    const code = stripComments(source);
    expect(
      /===\s*"degraded"/.test(code) || /===\s*"not_run"/.test(code),
      `${label} must ask isNonCleanAnalyzerCoverage, not re-type the coverage comparison`,
    ).toBe(false);
  }
});

// fail-2: command resolution failure is a status, never a throw.
test("fail-2: an unresolvable tool yields not_resolved with zero results, and the run still completes", async () => {
  await withTempDir("audit-code-tsc-unresolved-", async (root) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(join(root, "tsconfig.json"), "{}\n");

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = runSyntaxResolutionExecutor(
        { file_disposition: { files: [{ path: "src/app.ts", status: "included" }] } },
        root,
      );
      const tsc = (result.updated.external_analyzer_results![0].tool_statuses ?? []).find(
        (status) => status.tool === "tsc",
      )!;
      expect(tsc.status).toBe("not_resolved");
      expect(tsc.resolved).toBe(false);
      expect(result.updated.external_analyzer_results![0].results).toEqual([]);
      expect(typeof result.progress_summary, "the run completes and still reports").toBe("string");
      expect(result.progress_summary).toMatch(/analyzer diagnostic/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// fail-3: unparsable output degrades to parse_error — and NOTHING in the status
// distinguishes a malformed payload from a rejected-flag run. Pinned as the
// documented gap: only `output_snippet` carries the difference.
test("fail-3: malformed output and a rejected-flag run are both parse_error, told apart only by the snippet", async () => {
  const runWithFakeEslintOutput = async (
    label: string,
    body: string,
  ): Promise<{ status: string; output_snippet?: string }> =>
    withTempDir(`audit-code-eslint-${label}-`, async (root) => {
      await writeJsFixture(root);
      await writeFakeEslint(root, "9.24.0");
      await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");
      await writeFile(join(root, "node_modules", "eslint", "bin", "eslint.js"), body);
      return eslintStatus(runSyntaxResolutionExecutor(JS_BUNDLE, root));
    });

  const malformed = await runWithFakeEslintOutput(
    "malformed",
    "process.stdout.write('not json from eslint');\n",
  );
  const rejectedFlag = await runWithFakeEslintOutput(
    "flagreject",
    'process.stderr.write("Invalid option \'--ext\'\\n");\nprocess.exit(2);\n',
  );

  expect(malformed.status).toBe("parse_error");
  expect(rejectedFlag.status, "a flag rejection is indistinguishable at the status field").toBe(
    "parse_error",
  );
  expect(malformed.output_snippet).toMatch(/not json from eslint/);
  expect(rejectedFlag.output_snippet, "only the snippet carries the difference").toMatch(
    /Invalid option/,
  );
});

// fail-1: an unreadable file degrades the graph, never the build.
test("fail-1: buildGraphBundleFromFs skips an unreadable file, logs it, and still returns a bundle", async () => {
  const { buildGraphBundleFromFs } = await importSourceModule("src/extractors/graph.ts");

  await withTempDir("audit-code-graph-unreadable-", async (root) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "a.ts"),
      "import { b } from './b';\nexport const a = () => b();\n",
    );
    await writeFile(join(root, "src", "b.ts"), "export const b = () => 1;\n");
    // Present in the manifest, absent from disk — the mid-scan ENOENT case.
    const repoManifest = {
      repository: { name: "unreadable-fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: ["src/a.ts", "src/b.ts", "src/vanished.ts"].map((path) => ({
        path,
        size_bytes: 128,
        language: "typescript",
        excluded: false,
      })),
    };

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (...args: [chunk: string | Uint8Array, ...rest: unknown[]]): boolean => {
      stderrLines.push(String(args[0]));
      return Reflect.apply(origWrite, process.stderr, args);
    };
    let bundle;
    try {
      bundle = await buildGraphBundleFromFs(repoManifest, root, undefined, {});
    } finally {
      process.stderr.write = origWrite;
    }

    const imports = (bundle.graphs.imports ?? []) as GraphEdge[];
    expect(
      imports.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"),
      "the readable files still contribute their edges",
    ).toBeTruthy();
    expect(
      stderrLines.some(
        (line) => line.includes("unreadable file(s)") && line.includes("src/vanished.ts"),
      ),
      `the skip must be observable on stderr; got ${JSON.stringify(stderrLines)}`,
    ).toBeTruthy();
  });
});

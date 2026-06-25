import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  OWNED_TOOL_IDS,
  admitSpawn,
  runSafetyGate,
  runExternalAnalyzer,
  registerExternalAnalyzers,
  runAcquisitionEngine,
  detectNodeEcosystem,
} = await import("../../src/audit/extractors/analyzers/acquisitionEngine.ts");

// F5 inv-8 imports the SAME pre-shipped merge-helper seam pair F6 consumes. The
// top-level await below means a half-shipped state (F5 producers present, seam
// absent) is UNSCHEDULABLE: this import throws before any F5 consumer test runs.
const { mergeAnalyzerGraphContribution } = await import(
  "../../src/audit/extractors/graph.ts"
);
const { mergeAnalyzerRiskSignals } = await import(
  "../../src/audit/extractors/risk.ts"
);

// A fake runner: capability probe (`--version`) succeeds; the real tool spawn
// returns a canned JSON payload one finding + one edge.
function fakeRunner({ probeOk = true, toolStdout = "[]", throwOnTool = false } = {}) {
  return (argv) => {
    if (argv.includes("--version")) {
      return probeOk
        ? { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 }
        : { status: 1, stdout: "", stderr: "not found", argv, duration_ms: 1, error: new Error("ENOENT") };
    }
    if (throwOnTool) throw new Error("spawn blew up");
    return { status: 0, stdout: toolStdout, stderr: "", argv, duration_ms: 1 };
  };
}

function candidate(overrides = {}) {
  return {
    id: "eslint",
    runner: "npx",
    spec: "eslint@9",
    defaultRun: false,
    detect: () => true,
    buildArgv: (prefix, root) => [...prefix, "--format", "json", root],
    parse: (stdout) => JSON.parse(stdout),
    ...overrides,
  };
}

const findingPayload = JSON.stringify([
  { path: "src/a.ts", summary: "no-unused-vars", severity: "warning", rule: "no-unused-vars", from: "src/a.ts", to: "src/b.ts" },
]);

test("admitSpawn: DEFAULT tools run without a consent token", () => {
  const c = candidate({ defaultRun: true });
  assert.equal(admitSpawn(c, "auto", undefined), undefined);
});

test("admitSpawn: non-DEFAULT tool is denied without a consent token (any setting)", () => {
  const c = candidate({ defaultRun: false });
  for (const setting of ["auto", "ephemeral", "permanent"]) {
    assert.ok(
      typeof admitSpawn(c, setting, undefined) === "string",
      `setting=${setting} must be gated on the consent token`,
    );
  }
});

test("admitSpawn: CE-005 — even a permanent pre-installed non-default tool needs the token", () => {
  const c = candidate({ defaultRun: false });
  assert.ok(typeof admitSpawn(c, "permanent", undefined) === "string");
  assert.equal(admitSpawn(c, "permanent", "consent-xyz"), undefined);
});

test("admitSpawn: skip is decisive regardless of token", () => {
  assert.ok(typeof admitSpawn(candidate({ defaultRun: true }), "skip", "tok") === "string");
});

test("registerExternalAnalyzers: own-vs-acquire rejects git-history / secret-scan at registration", () => {
  const accepted = registerExternalAnalyzers([
    candidate({ id: "git-history" }),
    candidate({ id: "secret-scan" }),
    candidate({ id: "eslint" }),
  ]);
  assert.deepEqual(accepted.map((c) => c.id), ["eslint"]);
  assert.ok(OWNED_TOOL_IDS.has("git-history"));
  assert.ok(OWNED_TOOL_IDS.has("secret-scan"));
});

test("runSafetyGate: missing runner degrades (probe fails → ok:false)", () => {
  const gate = runSafetyGate(candidate(), fakeRunner({ probeOk: false }), "/root");
  assert.equal(gate.ok, false);
});

test("runSafetyGate: F5 inv-1 — candidate lacking a pinned version is never executed (degrades)", () => {
  for (const spec of ["", "   ", undefined]) {
    const gate = runSafetyGate(candidate({ spec }), fakeRunner({ probeOk: true }), "/root");
    assert.equal(gate.ok, false, `spec=${JSON.stringify(spec)} must fail the gate`);
    assert.match(gate.reason, /pinned version/);
  }
});

test("runExternalAnalyzer: F5 inv-1 — unpinned candidate yields empty results + a tool_status, never spawns the tool", () => {
  let toolSpawned = false;
  const run = (argv, cwd) => {
    if (!argv.includes("--version")) toolSpawned = true;
    return fakeRunner({ toolStdout: findingPayload })(argv, cwd);
  };
  const out = runExternalAnalyzer(candidate({ defaultRun: true, spec: "" }), "/root", { run });
  assert.equal(toolSpawned, false, "an unpinned tool must never be spawned");
  assert.equal(out.status.status, "not_resolved");
  assert.match(out.status.error, /pinned version/);
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: non-default tool without consent is reported skipped (never silently)", () => {
  const out = runExternalAnalyzer(candidate(), "/root", { run: fakeRunner({ toolStdout: findingPayload }) });
  assert.equal(out.status.status, "skipped");
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: with consent token, runs + normalizes through the adapter seam", () => {
  const out = runExternalAnalyzer(candidate(), "/root", {
    consentToken: "tok",
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  assert.equal(out.status.status, "findings");
  assert.equal(out.results.tool, "eslint");
  assert.equal(out.results.results.length, 1);
  assert.equal(out.results.results[0].path, "src/a.ts");
  // edges normalized through normalizeGenericExternalEdges
  assert.ok(out.results.graph_edges && out.results.graph_edges.length === 1);
  assert.equal(out.results.graph_edges[0].from, "src/a.ts");
});

test("runExternalAnalyzer: default tool runs without a token", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  assert.equal(out.status.status, "findings");
});

test("runExternalAnalyzer: capability-probe failure degrades to empty + not_resolved status", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ probeOk: false }),
  });
  assert.equal(out.status.status, "not_resolved");
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: undetected ecosystem is reported skipped", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true, detect: () => false }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  assert.equal(out.status.status, "skipped");
  assert.match(out.status.error, /ecosystem/);
});

test("runExternalAnalyzer: a thrown spawn degrades to spawn_error, never throws", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ throwOnTool: true }),
  });
  assert.equal(out.status.status, "spawn_error");
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: F5 fail-2 — a non-zero spawn exit (result.error) degrades to spawn_error, never throws", () => {
  const run = (argv, cwd) => {
    if (argv.includes("--version")) return { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 };
    // Tool spawned, exits non-zero with an error attached (process-level failure).
    return { status: 2, stdout: "", stderr: "boom", argv, duration_ms: 1, error: new Error("exited 2") };
  };
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", { run });
  assert.equal(out.status.status, "spawn_error");
  assert.equal(out.status.exit_code, 2);
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: malformed tool output degrades to parse_error, never throws", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: "not json {{{" }),
  });
  assert.equal(out.status.status, "parse_error");
  assert.equal(out.results.results.length, 0);
});

test("runExternalAnalyzer: owned tool is rejected even if it slips past registration", () => {
  const out = runExternalAnalyzer(candidate({ id: "secret-scan", defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  assert.equal(out.status.status, "skipped");
  assert.match(out.status.error, /owned by F6/);
});

test("runAcquisitionEngine: one status per candidate; owned rejected; gating applied", () => {
  const { results, statuses } = runAcquisitionEngine(
    [
      candidate({ id: "eslint", defaultRun: true }),
      candidate({ id: "ruff", defaultRun: false }), // no token → skipped
      candidate({ id: "git-history" }), // owned → rejected at registration
    ],
    "/root",
    { run: fakeRunner({ toolStdout: findingPayload }) },
  );
  // git-history rejected at registration → no status for it
  assert.deepEqual(statuses.map((s) => s.tool).sort(), ["eslint", "ruff"]);
  const eslint = statuses.find((s) => s.tool === "eslint");
  const ruff = statuses.find((s) => s.tool === "ruff");
  assert.equal(eslint.status, "findings");
  assert.equal(ruff.status, "skipped");
  assert.equal(results.length, 1, "only the admitted tool with findings contributes results");
});

test("F5 inv-4: report-skipped-never-silently — exactly one status per in-scope candidate across absent/consent-denied/parse-error paths", () => {
  // Three in-scope (non-owned) candidates exercising distinct degrade paths:
  //  - absent runner    → not_resolved (capability probe fails)
  //  - consent denied   → skipped (non-default, no consent token)
  //  - parse error      → parse_error (malformed tool stdout)
  // Plus one owned candidate that must NOT contribute a status (rejected at
  // registration — i.e. dropped from the in-scope set, never silently from it).
  //
  // Route by RUNNER: "absent" uses pipx (probe fails); the others use npx (probe
  // ok). buildArgv tags the real spawn with --id so the broken path is selectable.
  const tagged = (id, defaultRun, runner) =>
    candidate({
      id,
      defaultRun,
      runner,
      buildArgv: (prefix, root) => [...prefix, '--id', id, root],
    });
  const scoped = [
    tagged('absent', true, 'pipx'),
    tagged('denied', false, 'npx'),
    tagged('broken', true, 'npx'),
  ];
  const candidates = [...scoped, candidate({ id: 'git-history' })];

  const run = (argv) => {
    if (argv.includes('--version')) {
      // pipx (the "absent" runner) is unavailable on this machine; npx is fine.
      return argv[0] === 'pipx'
        ? { status: 1, stdout: '', stderr: 'not found', argv, duration_ms: 1, error: new Error('ENOENT') }
        : { status: 0, stdout: '1.0.0', stderr: '', argv, duration_ms: 1 };
    }
    const idIdx = argv.indexOf('--id');
    const id = idIdx >= 0 ? argv[idIdx + 1] : '';
    if (id === 'broken') return { status: 0, stdout: 'not json {{{', stderr: '', argv, duration_ms: 1 };
    return { status: 0, stdout: findingPayload, stderr: '', argv, duration_ms: 1 };
  };

  const { statuses } = runAcquisitionEngine(candidates, '/root', { run });

  // inv-4 core: status count == in-scope candidate count (owned tool dropped at
  // registration, NOT silently from the in-scope set).
  assert.equal(statuses.length, scoped.length, 'exactly one status per in-scope candidate');
  assert.deepEqual(statuses.map((s) => s.tool).sort(), ['absent', 'broken', 'denied']);
  assert.equal(statuses.find((s) => s.tool === 'absent').status, 'not_resolved');
  assert.equal(statuses.find((s) => s.tool === 'denied').status, 'skipped');
  assert.equal(statuses.find((s) => s.tool === 'broken').status, 'parse_error');
  // None dropped without a status row.
  assert.ok(statuses.every((s) => typeof s.status === 'string' && s.status.length > 0));
});

// F5 inv-8 (shared single-insertion merge with F6 — land-order-safe): F5's
// analyzer-dataflow edges/signals append ONLY through the shared
// mergeAnalyzerGraphContribution / mergeAnalyzerRiskSignals pair (the pre-shipped
// CCU-analyzer-merge-helper-seam, which lands FIRST). F5 declares a scheduling
// dependency on that seam, so a half-shipped state — the seam absent while F5's
// producers are present — is UNSCHEDULABLE: consuming F5's output is impossible
// without first resolving the seam imports. These tests make that land-order
// mechanical, not host-remembered (additive to the CE-006 runtime test).

test("F5 inv-8: the pre-shipped merge-helper seam pair lands first (statically importable)", () => {
  // If either symbol were unshipped, the top-level `await import(...)` at the
  // head of this file would have thrown before any F5 consumer test could run —
  // so a half-shipped state (F5 present, seam absent) can never be scheduled.
  assert.equal(
    typeof mergeAnalyzerGraphContribution,
    "function",
    "graph-contribution seam must be shipped before F5 consumers run",
  );
  assert.equal(
    typeof mergeAnalyzerRiskSignals,
    "function",
    "risk-signals seam must be shipped before F5 consumers run",
  );
});

test("F5 inv-8: F5 dataflow edges + F6 co-change edges both survive a single-insertion merge, deterministically", () => {
  // F5 produces language-neutral dataflow edges (graph_edges on its
  // ExternalAnalyzerResults); F6 produces git co-change edges. Both re-enter via
  // the same seam. Co-existence: neither erases the other, regardless of land
  // order, and the result is the deterministic uniqueSortedEdges output.
  const f6Edge = {
    from: "a.ts",
    to: "b.ts",
    kind: "git-co-change",
    direction: "undirected",
  };
  const f5Edge = {
    from: "a.ts",
    to: "c.ts",
    kind: "analyzer-dataflow-edge",
    direction: "directed",
    confidence: 0.8,
  };

  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  // F6 then F5.
  const f6First = mergeAnalyzerGraphContribution(
    mergeAnalyzerGraphContribution(bundle, [f6Edge]),
    [f5Edge],
  );
  // F5 then F6 — the seam's deterministic sort makes land order irrelevant.
  const f5First = mergeAnalyzerGraphContribution(
    mergeAnalyzerGraphContribution(bundle, [f5Edge]),
    [f6Edge],
  );

  assert.equal(f6First.graphs.references.length, 2, "both contributions survive");
  assert.ok(
    f6First.graphs.references.some((e) => e.kind === "git-co-change"),
    "F6 edge survives the F5 append",
  );
  assert.ok(
    f6First.graphs.references.some((e) => e.kind === "analyzer-dataflow-edge"),
    "F5 edge survives alongside F6",
  );
  assert.deepEqual(
    f5First.graphs.references,
    f6First.graphs.references,
    "land order does not change the merged result (deterministic single-insertion)",
  );
  assert.deepEqual(bundle.graphs.references, [], "the seam never mutates the input bundle");
});

test("F5 inv-8: an F5 dataflow append through the seam is idempotent (re-applying its own edge is a no-op)", () => {
  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const edge = {
    from: "a.ts",
    to: "c.ts",
    kind: "analyzer-dataflow-edge",
    direction: "directed",
  };
  const once = mergeAnalyzerGraphContribution(bundle, [edge]);
  const twice = mergeAnalyzerGraphContribution(once, [edge]);
  assert.equal(once.graphs.references.length, 1);
  assert.deepEqual(twice.graphs.references, once.graphs.references, "idempotent re-apply");
});

test("F5 inv-8: F5 analyzer risk signals union into the register through the shared seam, leaving F6 signals intact", () => {
  // F5 contributes informational per-unit signals (e.g. an analyzer dataflow
  // hit). They union with whatever F6 already merged; risk_score stays owned by
  // buildRiskRegister.
  const register = {
    items: [
      { unit_id: "u1", risk_score: 4, signals: ["change_hotspot"], notes: [] },
    ],
  };
  const merged = mergeAnalyzerRiskSignals(
    register,
    new Map([["u1", ["analyzer_dataflow_signal"]]]),
  );
  assert.deepEqual(
    merged.items[0].signals,
    ["analyzer_dataflow_signal", "change_hotspot"],
    "F5 signal unions with the existing F6 signal, deduped + sorted",
  );
  assert.equal(merged.items[0].risk_score, 4, "risk_score untouched by the informational seam");
  assert.deepEqual(register.items[0].signals, ["change_hotspot"], "input register not mutated");
});

test("detectNodeEcosystem: deterministic marker-file detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-detect-"));
  try {
    assert.equal(detectNodeEcosystem(root), false);
    await writeFile(join(root, "package.json"), "{}");
    assert.equal(detectNodeEcosystem(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

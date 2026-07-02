import { test, expect } from "vitest";
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
  expect(admitSpawn(c, "auto", undefined)).toBe(undefined);
});

test("admitSpawn: non-DEFAULT tool is denied without a consent token (any setting)", () => {
  const c = candidate({ defaultRun: false });
  for (const setting of ["auto", "ephemeral", "permanent"]) {
    expect(typeof admitSpawn(c, setting, undefined) === "string", `setting=${setting} must be gated on the consent token`).toBeTruthy();
  }
});

test("admitSpawn: CE-005 — even a permanent pre-installed non-default tool needs the token", () => {
  const c = candidate({ defaultRun: false });
  expect(typeof admitSpawn(c, "permanent", undefined) === "string").toBeTruthy();
  expect(admitSpawn(c, "permanent", "consent-xyz")).toBe(undefined);
});

test("admitSpawn: skip is decisive regardless of token", () => {
  expect(typeof admitSpawn(candidate({ defaultRun: true }), "skip", "tok") === "string").toBeTruthy();
});

test("registerExternalAnalyzers: own-vs-acquire rejects git-history at registration", () => {
  const accepted = registerExternalAnalyzers([
    candidate({ id: "git-history" }),
    candidate({ id: "secret-scan" }),
    candidate({ id: "eslint" }),
  ]);
  // Only git-history is OWNED. Secret scanning is ACQUIRED (gitleaks), so a
  // candidate named "secret-scan" is no longer rejected.
  expect(accepted.map((c) => c.id)).toEqual(["secret-scan", "eslint"]);
  expect(OWNED_TOOL_IDS.has("git-history")).toBeTruthy();
  expect(OWNED_TOOL_IDS.has("secret-scan")).toBe(false);
});

test("runSafetyGate: missing runner degrades (probe fails → ok:false)", () => {
  const gate = runSafetyGate(candidate(), fakeRunner({ probeOk: false }), "/root");
  expect(gate.ok).toBe(false);
});

test("runSafetyGate: F5 inv-1 — candidate lacking a pinned version is never executed (degrades)", () => {
  for (const spec of ["", "   ", undefined]) {
    const gate = runSafetyGate(candidate({ spec }), fakeRunner({ probeOk: true }), "/root");
    expect(gate.ok, `spec=${JSON.stringify(spec)} must fail the gate`).toBe(false);
    expect(gate.reason).toMatch(/pinned version/);
  }
});

test("runExternalAnalyzer: F5 inv-1 — unpinned candidate yields empty results + a tool_status, never spawns the tool", () => {
  let toolSpawned = false;
  const run = (argv, cwd) => {
    if (!argv.includes("--version")) toolSpawned = true;
    return fakeRunner({ toolStdout: findingPayload })(argv, cwd);
  };
  const out = runExternalAnalyzer(candidate({ defaultRun: true, spec: "" }), "/root", { run });
  expect(toolSpawned, "an unpinned tool must never be spawned").toBe(false);
  expect(out.status.status).toBe("not_resolved");
  expect(out.status.error).toMatch(/pinned version/);
  expect(out.results.results.length).toBe(0);
});

test("runExternalAnalyzer: non-default tool without consent is reported skipped (never silently)", () => {
  const out = runExternalAnalyzer(candidate(), "/root", { run: fakeRunner({ toolStdout: findingPayload }) });
  expect(out.status.status).toBe("skipped");
  expect(out.results.results.length).toBe(0);
});

test("runExternalAnalyzer: with consent token, runs + normalizes through the adapter seam", () => {
  const out = runExternalAnalyzer(candidate(), "/root", {
    consentToken: "tok",
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  expect(out.status.status).toBe("findings");
  expect(out.results.tool).toBe("eslint");
  expect(out.results.results.length).toBe(1);
  expect(out.results.results[0].path).toBe("src/a.ts");
  // edges normalized through normalizeGenericExternalEdges
  expect(out.results.graph_edges && out.results.graph_edges.length === 1).toBeTruthy();
  expect(out.results.graph_edges[0].from).toBe("src/a.ts");
});

test("runExternalAnalyzer: default tool runs without a token", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  expect(out.status.status).toBe("findings");
});

test("runExternalAnalyzer: capability-probe failure degrades to empty + not_resolved status", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ probeOk: false }),
  });
  expect(out.status.status).toBe("not_resolved");
  expect(out.results.results.length).toBe(0);
});

test("runExternalAnalyzer: undetected ecosystem is reported skipped", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true, detect: () => false }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  expect(out.status.status).toBe("skipped");
  expect(out.status.error).toMatch(/ecosystem/);
});

test("runExternalAnalyzer: a thrown spawn degrades to spawn_error, never throws", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ throwOnTool: true }),
  });
  expect(out.status.status).toBe("spawn_error");
  expect(out.results.results.length).toBe(0);
});

test("runExternalAnalyzer: F5 fail-2 — a non-zero spawn exit (result.error) degrades to spawn_error, never throws", () => {
  const run = (argv, cwd) => {
    if (argv.includes("--version")) return { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 };
    // Tool spawned, exits non-zero with an error attached (process-level failure).
    return { status: 2, stdout: "", stderr: "boom", argv, duration_ms: 1, error: new Error("exited 2") };
  };
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", { run });
  expect(out.status.status).toBe("spawn_error");
  expect(out.status.exit_code).toBe(2);
  expect(out.results.results.length).toBe(0);
});

test("runExternalAnalyzer: malformed tool output degrades to parse_error, never throws", () => {
  const out = runExternalAnalyzer(candidate({ defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: "not json {{{" }),
  });
  expect(out.status.status).toBe("parse_error");
  expect(out.results.results.length).toBe(0);
});

test("F5 fail-3: malformed output degrades graph_edges too — no partial/corrupt edges merged", () => {
  // CP-NODE-68: a parse failure must yield empty results AND no graph_edges, so
  // nothing partial/corrupt can reach the shared merge seam. A candidate whose
  // parse() emits edges on success is fed malformed stdout: the parse throws
  // before any edge is normalized, so graph_edges must be absent/empty.
  const out = runExternalAnalyzer(
    candidate({ defaultRun: true, parse: (stdout) => JSON.parse(stdout) }),
    "/root",
    { run: fakeRunner({ toolStdout: "not json {{{" }) },
  );
  expect(out.status.status).toBe("parse_error");
  expect(out.results.results.length).toBe(0);
  expect(!out.results.graph_edges || out.results.graph_edges.length === 0, "no graph_edges may survive a parse failure (no partial/corrupt edges merged)").toBeTruthy();
});

test("runExternalAnalyzer: owned tool is rejected even if it slips past registration", () => {
  const out = runExternalAnalyzer(candidate({ id: "git-history", defaultRun: true }), "/root", {
    run: fakeRunner({ toolStdout: findingPayload }),
  });
  expect(out.status.status).toBe("skipped");
  expect(out.status.error).toMatch(/owned by F6/);
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
  expect(statuses.map((s) => s.tool).sort()).toEqual(["eslint", "ruff"]);
  const eslint = statuses.find((s) => s.tool === "eslint");
  const ruff = statuses.find((s) => s.tool === "ruff");
  expect(eslint.status).toBe("findings");
  expect(ruff.status).toBe("skipped");
  expect(results.length, "only the admitted tool with findings contributes results").toBe(1);
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
  expect(statuses.length, 'exactly one status per in-scope candidate').toBe(scoped.length);
  expect(statuses.map((s) => s.tool).sort()).toEqual(['absent', 'broken', 'denied']);
  expect(statuses.find((s) => s.tool === 'absent').status).toBe('not_resolved');
  expect(statuses.find((s) => s.tool === 'denied').status).toBe('skipped');
  expect(statuses.find((s) => s.tool === 'broken').status).toBe('parse_error');
  // None dropped without a status row.
  expect(statuses.every((s) => typeof s.status === 'string' && s.status.length > 0)).toBeTruthy();
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
  expect(typeof mergeAnalyzerGraphContribution, "graph-contribution seam must be shipped before F5 consumers run").toBe("function");
  expect(typeof mergeAnalyzerRiskSignals, "risk-signals seam must be shipped before F5 consumers run").toBe("function");
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

  expect(f6First.graphs.references.length, "both contributions survive").toBe(2);
  expect(f6First.graphs.references.some((e) => e.kind === "git-co-change"), "F6 edge survives the F5 append").toBeTruthy();
  expect(f6First.graphs.references.some((e) => e.kind === "analyzer-dataflow-edge"), "F5 edge survives alongside F6").toBeTruthy();
  expect(f5First.graphs.references, "land order does not change the merged result (deterministic single-insertion)").toEqual(f6First.graphs.references);
  expect(bundle.graphs.references, "the seam never mutates the input bundle").toEqual([]);
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
  expect(once.graphs.references.length).toBe(1);
  expect(twice.graphs.references, "idempotent re-apply").toEqual(once.graphs.references);
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
  expect(merged.items[0].signals, "F5 signal unions with the existing F6 signal, deduped + sorted").toEqual(["analyzer_dataflow_signal", "change_hotspot"]);
  expect(merged.items[0].risk_score, "risk_score untouched by the informational seam").toBe(4);
  expect(register.items[0].signals, "input register not mutated").toEqual(["change_hotspot"]);
});

test("F5 inv-5 [CP-NODE-62]: no probed runners => every candidate degrades to skipped/not_resolved, zero edges (runtime-discovered)", () => {
  // inv-5: ecosystem detection + runner selection are RUNTIME-discovered — there
  // is no baked-in language->tool or OS->runner table; the capability probe
  // (`--version`) is the sole authority on what can run on THIS machine. Simulate
  // a machine where NO runner is installed: every `--version` probe fails. Each
  // in-scope (detected, admitted) candidate must then degrade through the
  // run-safety gate to `not_resolved`; a consent-denied candidate degrades to
  // `skipped` — but NOTHING is silently dropped, NO tool is spawned, and ZERO
  // edges/results reach the shared merge seam.
  let toolSpawned = false;
  const noRunnerInstalled = (argv) => {
    if (argv.includes('--version')) {
      // Every runner is absent regardless of which one a candidate selected.
      return { status: 127, stdout: '', stderr: 'command not found', argv, duration_ms: 1, error: new Error('ENOENT') };
    }
    toolSpawned = true; // must never be reached
    return { status: 0, stdout: findingPayload, stderr: '', argv, duration_ms: 1 };
  };

  // Candidates spanning multiple ecosystems/runners — none has a baked-in
  // privilege; all are subject to the same runtime probe.
  const candidates = [
    candidate({ id: 'eslint', runner: 'npx', defaultRun: true, detect: () => true }),
    candidate({ id: 'ruff', runner: 'pipx', defaultRun: true, detect: () => true }),
    candidate({ id: 'clippy', runner: 'cargo', defaultRun: true, detect: () => true }),
    candidate({ id: 'rubocop', runner: 'bundle', defaultRun: false, detect: () => true }), // no token => skipped
  ];

  const { results, statuses } = runAcquisitionEngine(candidates, '/root', { run: noRunnerInstalled });

  expect(toolSpawned, 'no tool may be spawned when no runner probes successfully').toBe(false);
  // One status per in-scope candidate — none silently dropped.
  expect(statuses.length, 'exactly one status per candidate (report-skipped-never-silently)').toBe(candidates.length);
  expect(statuses.map((s) => s.tool).sort()).toEqual(['clippy', 'eslint', 'rubocop', 'ruff']);
  // The three default candidates fail the runtime capability probe => not_resolved.
  for (const id of ['eslint', 'ruff', 'clippy']) {
    const s = statuses.find((x) => x.tool === id);
    expect(s.status, `${id} must degrade to not_resolved when its runner is absent`).toBe('not_resolved');
    expect(s.error).toMatch(/not available/);
  }
  // The non-default candidate without a consent token is skipped before any probe.
  expect(statuses.find((x) => x.tool === 'rubocop').status).toBe('skipped');
  // Zero results AND zero edges reach the merge seam.
  expect(results.length, 'no candidate contributes results when no runner is discovered').toBe(0);
  expect(results.every((r) => !r.graph_edges || r.graph_edges.length === 0), 'no graph_edges survive when no runner is discovered').toBeTruthy();
});

// CP-NODE-1: each newly-registered analyzer is consent-gated end-to-end — with
// detect() forced true and no consent token, the engine must report `skipped`
// and spawn ZERO subprocesses (the consent chokepoint short-circuits the probe).
const { EXTERNAL_ANALYZER_CANDIDATES } = await import(
  "../../src/audit/extractors/analyzers/candidates.ts"
);

for (const id of ["clippy", "rubocop", "hadolint", "actionlint", "type-coverage"]) {
  test(`CP-NODE-1: ${id} is consent-gated — no token => skipped, zero subprocess spawn`, () => {
    const real = EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === id);
    expect(real, `${id} must be registered`).toBeTruthy();
    expect(real.defaultRun, `${id} must be defaultRun:false`).toBe(false);

    const spawned = [];
    const spy = (argv, cwd) => {
      spawned.push(argv);
      return fakeRunner({ toolStdout: "[]" })(argv, cwd);
    };
    // Force detect() true so the ONLY thing withholding the spawn is consent.
    const forced = { ...real, detect: () => true };
    const out = runExternalAnalyzer(forced, "/root", { run: spy, analyzers: {} });
    expect(out.status.status, `${id} without consent => skipped`).toBe("skipped");
    expect(out.status.error).toMatch(/consent token/i);
    expect(spawned.length, `${id} must spawn ZERO subprocesses without consent`).toBe(0);
  });
}

test("detectNodeEcosystem: deterministic marker-file detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-detect-"));
  try {
    expect(detectNodeEcosystem(root)).toBe(false);
    await writeFile(join(root, "package.json"), "{}");
    expect(detectNodeEcosystem(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F5 inv-2 (consent enforced at the subprocess-SPAWN admission chokepoint):
// `admitSpawn` is THE single function every candidate flows through before any
// subprocess can run (`runExternalAnalyzer` calls it before the safety probe and
// the real spawn). It gates EVERY non-DEFAULT tool on the per-run consent token
// regardless of AnalyzerSetting — including the `permanent` setting for a
// pre-installed tool (CE-005) — while DEFAULT tools run UNPROMPTED (no token).
// This boundary test drives the gate end-to-end through the engine with a spy
// runner so the "zero subprocesses on consent_denied" half of the invariant is
// observed mechanically, not just at the pure-function level.
test("F5 inv-2 [CP-NODE-59]: spawn-admission gates every non-DEFAULT tool on consent (incl. permanent); DEFAULT unprompted", () => {
  // Pure-function chokepoint: across ALL settings, a non-DEFAULT tool is denied
  // without a token and admitted with one; DEFAULT is admitted token-free.
  const nonDefault = candidate({ defaultRun: false });
  const dflt = candidate({ defaultRun: true });
  for (const setting of ["auto", "ephemeral", "permanent"]) {
    expect(typeof admitSpawn(nonDefault, setting, undefined), `non-default + setting=${setting} must be consent_denied without a token`).toBe("string");
    expect(admitSpawn(nonDefault, setting, "consent-token"), `non-default + setting=${setting} is admitted once the per-run token is present`).toBe(undefined);
    expect(admitSpawn(dflt, setting, undefined), `DEFAULT + setting=${setting} runs unprompted (no token required)`).toBe(undefined);
  }

  // End-to-end through the engine: a spy runner records every subprocess argv.
  // For a non-DEFAULT tool with NO consent token, the chokepoint must short-
  // circuit BEFORE the capability probe — i.e. ZERO subprocesses — even when the
  // operator set the tool to `permanent` (CE-005: a pre-installed permanent tool
  // still needs the token).
  const spawned = [];
  const spy = (argv, cwd) => {
    spawned.push(argv);
    return fakeRunner({ toolStdout: findingPayload })(argv, cwd);
  };

  const deniedOutcome = runExternalAnalyzer(
    candidate({ id: "eslint", defaultRun: false }),
    "/root",
    {
      run: spy,
      analyzers: { eslint: "permanent" }, // operator pinned it permanent…
      // …but supplied NO consentToken for this run.
    },
  );
  expect(deniedOutcome.status.status, "consent_denied => skipped").toBe("skipped");
  expect(deniedOutcome.status.error).toMatch(/consent token/i);
  expect(deniedOutcome.results.results.length, "no findings on a denied spawn").toBe(0);
  expect(spawned.length, "consent absent => permanent non-default tool spawns ZERO subprocesses (not even the probe)").toBe(0);

  // With the per-run token present, the SAME permanent tool is admitted and the
  // subprocess actually runs (probe + real spawn observed by the spy).
  const admittedOutcome = runExternalAnalyzer(
    candidate({ id: "eslint", defaultRun: false }),
    "/root",
    { run: spy, analyzers: { eslint: "permanent" }, consentToken: "consent-token" },
  );
  expect(admittedOutcome.status.status, "admitted spawn produces findings").toBe("findings");
  expect(spawned.length >= 1, "admitted spawn invokes the runner at least once").toBeTruthy();

  // A DEFAULT tool runs UNPROMPTED — no token, yet the subprocess fires.
  const beforeDefault = spawned.length;
  const defaultOutcome = runExternalAnalyzer(
    candidate({ id: "eslint", defaultRun: true }),
    "/root",
    { run: spy }, // no consentToken, no analyzers setting
  );
  expect(defaultOutcome.status.status, "DEFAULT tool runs without consent").toBe("findings");
  expect(spawned.length > beforeDefault, "DEFAULT spawn invoked the runner unprompted").toBeTruthy();
});

// F5 inv-7 (normalize through the existing adapter seam, unchanged): an acquired
// tool's RAW output must re-enter the SAME ExternalAnalyzerResults contract that
// the wired semgrep/ast-grep/codeql adapters produce — there is no parallel
// shape. runExternalAnalyzer normalizes the acquired tool's raw stdout through
// normalizeGenericExternalResults / normalizeGenericExternalEdges (the adapter
// seam), and the normalized object validates against ExternalAnalyzerResultsSchema
// .strict(). `.strict()` is load-bearing here: it would REJECT any extra/parallel
// field, so a green parse proves the acquired path emits the exact contract shape.
const { ExternalAnalyzerResultsSchema } = await import(
  "../../src/audit/types/externalAnalyzer.ts"
);

test("F5 inv-7 [CP-NODE-64]: acquired output normalizes through the existing adapter seam, validates ExternalAnalyzerResultsSchema.strict()", () => {
  const out = runExternalAnalyzer(candidate(), "/root", {
    consentToken: "tok",
    run: fakeRunner({ toolStdout: findingPayload }),
  });

  // The acquired tool ran and was normalized through the adapter seam.
  expect(out.status.status).toBe("findings");
  expect(out.results.tool).toBe("eslint");
  expect(out.results.results.length).toBe(1);
  expect(out.results.graph_edges && out.results.graph_edges.length === 1).toBeTruthy();

  // Same contract as the wired adapters: the normalized object validates against
  // ExternalAnalyzerResultsSchema.strict() — no parallel shape, no extra fields.
  const parsed = ExternalAnalyzerResultsSchema.strict().safeParse(out.results);
  expect(parsed.success, `acquired-tool output must validate against the shared contract; got ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`).toBeTruthy();

  // A parallel/extra field on the acquired shape would be rejected by .strict() —
  // proving the validation above is actually discriminating the contract.
  const withParallelShape = { ...out.results, parallel_findings: [{ x: 1 }] };
  expect(ExternalAnalyzerResultsSchema.strict().safeParse(withParallelShape).success, ".strict() must reject any parallel/extra shape on the acquired contract").toBe(false);
});

// F5 fail-4 (C-009): a non-DEFAULT tool requested WITHOUT the per-run consent
// token must resolve to a consent_denied outcome — status skipped, resolved=false,
// and ZERO subprocesses spawned — enforced at the spawn-admission chokepoint
// (admitSpawn), not by any downstream caller. This is the negative-path companion
// to F5 inv-2: it asserts the FAIL contract (skipped/denied + no spawn) holds even
// when the candidate's own `detect()` would say the tool is installed, so nothing
// past the chokepoint (probe or real spawn) can leak through.
test("F5 fail-4 [CP-NODE-69]: non-DEFAULT tool without consent => consent_denied, zero subprocess spawn", () => {
  // detect() returns true so a missing-binary path can't masquerade as the reason
  // for skipping; the ONLY thing withholding the spawn is the absent consent token.
  const installedNonDefault = candidate({
    id: "eslint",
    defaultRun: false,
    detect: () => true,
  });

  // Pure chokepoint: denial yields a string (the consent_denied reason), never the
  // `undefined` that means "admitted".
  const reason = admitSpawn(installedNonDefault, "auto", undefined);
  expect(typeof reason, "non-default w/o token must be denied at admitSpawn").toBe("string");

  // End-to-end through the engine with a spy runner: not a single argv may be
  // dispatched — not even the `--version` capability probe.
  const spawned = [];
  const spy = (argv, cwd) => {
    spawned.push(argv);
    return fakeRunner({ toolStdout: findingPayload })(argv, cwd);
  };

  const outcome = runExternalAnalyzer(installedNonDefault, "/root", {
    run: spy,
    // non-default tool requested (auto), but NO consentToken supplied this run.
    analyzers: { eslint: "auto" },
  });

  // consent_denied contract: skipped status, no findings (resolved=false), and the
  // operator-facing reason names the missing consent token.
  expect(outcome.status.status, "consent_denied => status skipped").toBe("skipped");
  expect(outcome.status.error, "denied reason names the consent token").toMatch(/consent token/i);
  expect(outcome.results.results.length, "consent_denied => no findings (resolved=false)").toBe(0);

  // The load-bearing half of C-009: enforcement is at the SPAWN-admission chokepoint,
  // so zero subprocesses ran — the probe never even fired.
  expect(spawned.length, "consent_denied must short-circuit at admitSpawn => ZERO subprocesses (not even the probe)").toBe(0);
});

// F5 fail-7 [CP-NODE-72]: an owned signal (git-history / secret-scan) registered
// as an acquired external tool is REJECTED at registration. The own-vs-acquire
// boundary is enforced mechanically: OWNED_TOOL_IDS can never enter the engine,
// so an owned id cannot be double-run via the acquisition path.
test("F5 fail-7 [CP-NODE-72]: an owned signal (git-history) registered as an acquired tool is rejected at registration", () => {
  // Every OWNED id, plus a legitimate acquirable tool that MUST survive.
  const ownedCandidates = [...OWNED_TOOL_IDS].map((id) => candidate({ id }));
  const acquirable = candidate({ id: "eslint", defaultRun: true });

  const accepted = registerExternalAnalyzers([...ownedCandidates, acquirable]);
  const acceptedIds = new Set(accepted.map((c) => c.id));

  // Not a single owned id is admitted.
  for (const id of OWNED_TOOL_IDS) {
    expect(acceptedIds.has(id), `owned signal "${id}" must be rejected at registration (cannot enter the acquisition engine)`).toBe(false);
  }
  // The boundary drops ONLY owned ids; the genuine acquirable tool survives.
  expect(acceptedIds.has("eslint"), "a legitimate acquirable tool is still accepted").toBe(true);
  expect(accepted.length, "exactly the non-owned candidate survives registration").toBe(1);

  // End-to-end: driving the whole set through the engine never runs an owned id.
  const spawned = [];
  const spy = (argv, cwd) => {
    spawned.push(argv);
    return fakeRunner({ toolStdout: "[]" })(argv, cwd);
  };
  runAcquisitionEngine([...ownedCandidates], "/root", { run: spy, analyzers: {} });
  expect(spawned.length, "no owned candidate is ever spawned through the engine").toBe(0);
});

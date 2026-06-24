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

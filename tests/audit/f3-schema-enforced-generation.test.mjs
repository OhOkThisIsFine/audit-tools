// F3 — schema-enforced worker generation boundary tests (CP-NODE-21).
//
// Covers the F3 ↔ F4 ↔ O3 seam set:
//   - OutputConstraintCapability descriptor discovery is PROVIDER-AGNOSTIC and
//     happens ONCE at provider construction (stamped on the provider contract).
//   - emit-time enforcement of the canonical worker zod schema, degrading via the
//     O3 emit-validate-repair seam on capability `none` or a validation failure.
//   - every repair LLM touch is routed through F4's BrokeredRepairDispatch broker
//     (refused/cooled broker ⟹ no LLM touch).
//   - STRUCTURAL guard: F3's files contain no hardcoded model literal.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const { discoverOutputConstraintCapability, createFreshSessionProvider } =
  await import("../../src/shared/providers/providerFactory.ts");
const { createBrokeredRepairDispatch } = await import(
  "../../src/shared/repair/brokeredDispatch.ts"
);
const { enforceSchemaAtEmit, buildWorkerRepairContract, resolveEmitConstraint } =
  await import("../../src/audit/contracts/schemaEnforcedEmit.ts");
const { WorkerAuditResultsSchema } = await import(
  "../../src/audit/contracts/workerSchemas.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
// Friction capture writes under artifactsDir; isolate it to a temp dir.
const artifactsDir = await mkdtemp(join(tmpdir(), "f3-emit-"));

// A minimal, valid worker AuditResult array against WorkerAuditResultsSchema.
function validWorkerResults() {
  return [
    {
      task_id: "T1",
      unit_id: "U1",
      pass_id: "P1",
      lens: "correctness",
      file_coverage: [{ path: "src/x.ts", total_lines: 10 }],
      findings: [],
    },
  ];
}

const noopDeps = {
  orchestratorName: "audit-code",
  createClaudeCodeProvider: () => ({ name: "claude-code", launch: async () => ({ accepted: true }) }),
  createOpenCodeProvider: () => ({ name: "opencode", launch: async () => ({ accepted: true }) }),
};

const brokerContext = {
  providerName: "local-subprocess",
  sessionConfig: {},
  hostModel: null,
};

test("F3: discovery is provider-agnostic — agentic CLIs degrade to 'none'", () => {
  for (const name of [
    "claude-code",
    "codex",
    "opencode",
    "local-subprocess",
    "subprocess-template",
    "vscode-task",
    "antigravity",
  ]) {
    const cap = discoverOutputConstraintCapability(name, {});
    assert.equal(cap.mode, "none", `${name} should have no API-level output constraint`);
    assert.ok(cap.reason.length > 0, `${name} descriptor carries a reason`);
  }
});

test("F3: openai-compatible discovers structured_output by default, none when disabled", () => {
  const on = discoverOutputConstraintCapability("openai-compatible", {});
  assert.equal(on.mode, "structured_output");
  const off = discoverOutputConstraintCapability("openai-compatible", {
    openai_compatible: { response_format_json: false },
  });
  assert.equal(off.mode, "none");
});

test("F3: descriptor is discovered ONCE and stamped on the constructed provider", () => {
  const provider = createFreshSessionProvider("local-subprocess", {}, noopDeps);
  assert.ok(provider.outputConstraint, "provider carries a discovered descriptor");
  assert.equal(provider.outputConstraint.mode, "none");

  const oai = createFreshSessionProvider(
    "openai-compatible",
    { openai_compatible: { base_url: "https://x/v1", model: "m" } },
    noopDeps,
  );
  assert.equal(oai.outputConstraint.mode, "structured_output");
});

test("F3: resolveEmitConstraint treats an absent descriptor as 'none'", () => {
  assert.equal(resolveEmitConstraint({}).mode, "none");
  assert.equal(
    resolveEmitConstraint({ outputConstraint: { mode: "forced_tool_call", reason: "r" } }).mode,
    "forced_tool_call",
  );
});

test("F3: buildWorkerRepairContract validates a clean payload and reports errors otherwise", () => {
  const contract = buildWorkerRepairContract("audit_results", WorkerAuditResultsSchema);
  assert.equal(contract.validate(validWorkerResults()).errors.length, 0);
  const bad = contract.validate([{ task_id: "T1" }]);
  assert.ok(bad.errors.length > 0, "invalid payload yields validation errors");
  assert.ok(bad.errors.every((e) => e.required), "worker-schema errors gate escalation");
});

test("F3: a clean emit passes through with status 'clean' and no LLM touch", async () => {
  let patcherCalls = 0;
  const result = await enforceSchemaAtEmit({
    contractId: "audit_results",
    schema: WorkerAuditResultsSchema,
    payload: validWorkerResults(),
    provider: { outputConstraint: { mode: "structured_output", reason: "r" } },
    broker: createBrokeredRepairDispatch(),
    brokerContext,
    artifactsDir,
    runId: "run-clean",
    tool: "audit-code",
    patcher: async (p) => {
      patcherCalls += 1;
      return p;
    },
  });
  assert.equal(result.repair.status, "clean");
  assert.equal(patcherCalls, 0, "no LLM patch for a clean payload");
});

test("F3: capability 'none' + invalid payload degrades via O3, patch routed through the broker", async () => {
  let patcherCalls = 0;
  const result = await enforceSchemaAtEmit({
    contractId: "audit_results",
    schema: WorkerAuditResultsSchema,
    payload: [{ task_id: "T1" }], // invalid
    provider: { outputConstraint: { mode: "none", reason: "r" } },
    broker: createBrokeredRepairDispatch(),
    brokerContext,
    artifactsDir,
    runId: "run-degrade",
    tool: "audit-code",
    patcher: async () => {
      patcherCalls += 1;
      return validWorkerResults(); // the LLM fixes it
    },
  });
  assert.equal(patcherCalls, 1, "broker admitted the repair slot → patcher ran once");
  assert.equal(result.repair.status, "patched");
  assert.equal(result.repair.repaired_payload.length, 1);
});

test("F3: a refused broker means no LLM touch — O3 falls to the re-dispatch signal", async () => {
  let patcherCalls = 0;
  // A broker stub that always refuses admission.
  const refusingBroker = {
    broker: () => ({
      admitted: 0,
      admission: "refused_over_budget",
      admittedSlotIds: [],
      estimatedWaveTokens: 0,
      cooldownUntil: null,
      bindingCap: "none",
      capableHost: false,
      schedule: {},
    }),
    awaitNextCompletion: (c) => c,
  };
  const result = await enforceSchemaAtEmit({
    contractId: "audit_results",
    schema: WorkerAuditResultsSchema,
    payload: [{ task_id: "T1" }], // invalid
    provider: { outputConstraint: { mode: "none", reason: "r" } },
    broker: refusingBroker,
    brokerContext,
    artifactsDir,
    runId: "run-refused",
    tool: "audit-code",
    patcher: async () => {
      patcherCalls += 1;
      return validWorkerResults();
    },
  });
  assert.equal(patcherCalls, 0, "refused broker → no LLM touch");
  assert.equal(result.repair.status, "unrepairable");
  assert.ok(result.repair.redispatch, "re-dispatch signal surfaced");
});

test("F3 STRUCTURAL guard: F3 source files contain no hardcoded model literal", async () => {
  // Provider-agnostic invariant: F3's files must NEVER key off a model id.
  const f3Files = [
    "src/shared/providers/types.ts",
    "src/shared/providers/providerFactory.ts",
    "src/audit/contracts/schemaEnforcedEmit.ts",
  ];
  // Well-known model name string literals + the legacy limits table.
  const modelNamePattern =
    /["'`](claude-[0-9]|claude-opus|claude-sonnet|claude-haiku|gpt-4|gpt-3\.5|gpt-oss|gemini-|llama-|mistral-|o[13]-mini|o1-preview)/i;
  const knownLimitsPattern = /KNOWN_MODEL_LIMITS/;

  const violations = [];
  for (const rel of f3Files) {
    const src = await readFile(join(repoRoot, rel), "utf8");
    if (modelNamePattern.test(src)) violations.push(`${rel}: hardcoded model name literal`);
    if (knownLimitsPattern.test(src)) violations.push(`${rel}: references KNOWN_MODEL_LIMITS`);
  }
  assert.equal(
    violations.length,
    0,
    `F3 files must not hardcode model identities. Violations:\n${violations.join("\n")}`,
  );
});

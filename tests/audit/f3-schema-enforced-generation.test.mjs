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
const { WorkerAuditResultsSchema, WORKER_SCHEMA_SOURCES } = await import(
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

test("F3 inv-2: descriptor is output-constraint-scoped only — no concurrency/agent-nesting field (CP-NODE-23)", () => {
  // Read the descriptor through a constructed FreshSessionProvider and assert it
  // carries ONLY output-constraint keys (mode + reason) — F3 is sole owner and the
  // descriptor must never grow an agent-nesting / host-concurrency field.
  const allowedKeys = new Set(["mode", "reason"]);
  const forbiddenKeyPattern = /concurrency|agent.?nest|host.?concurrency|parallel|nesting/i;

  for (const [name, config] of [
    ["local-subprocess", {}],
    ["openai-compatible", { openai_compatible: { base_url: "https://x/v1", model: "m" } }],
  ]) {
    const provider = createFreshSessionProvider(name, config, noopDeps);
    const descriptor = provider.outputConstraint;
    assert.ok(descriptor, `${name} carries a discovered descriptor`);
    const keys = Object.keys(descriptor);
    for (const key of keys) {
      assert.ok(allowedKeys.has(key), `${name} descriptor has unexpected key '${key}' — output-constraint-scoped only`);
      assert.ok(!forbiddenKeyPattern.test(key), `${name} descriptor must not carry a concurrency/agent-nesting key '${key}'`);
    }
  }
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

test("F3 inv-4: an advertised constraint mode + conforming payload validates with zero repair stages", async () => {
  // inv-4: when a backend advertises a constraint mode (json_schema_constrained /
  // forced_tool_call), a conforming payload is enforced at emit and validates with
  // ZERO runEmitValidateRepair stages — only the initial 'validate', never coerce
  // / llm_patch / redispatch — and no LLM touch.
  for (const mode of ["json_schema_constrained", "forced_tool_call"]) {
    let patcherCalls = 0;
    const result = await enforceSchemaAtEmit({
      contractId: "audit_results",
      schema: WorkerAuditResultsSchema,
      payload: validWorkerResults(),
      provider: { outputConstraint: { mode, reason: "advertised" } },
      broker: createBrokeredRepairDispatch(),
      brokerContext,
      artifactsDir,
      runId: `run-inv4-${mode}`,
      tool: "audit-code",
      patcher: async (p) => {
        patcherCalls += 1;
        return p;
      },
    });
    assert.equal(result.mode, mode, `emit reports the advertised mode (${mode})`);
    assert.equal(result.repair.status, "clean", `${mode}: conforming payload is clean`);
    assert.deepEqual(
      result.repair.stages_applied,
      ["validate"],
      `${mode}: zero repair stages — only the initial validate`,
    );
    assert.equal(patcherCalls, 0, `${mode}: no LLM touch on a conforming payload`);
  }
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

test("F3 inv-5 [CP-NODE-26]: capability 'none' degrades through the brokered repair seam", async () => {
  // inv-5: a backend that cannot enforce (capability 'none') OR whose enforced
  // emit fails validation degrades to runEmitValidateRepair, and its stage-2 LLM
  // patch is routed through the SHARED BrokeredRepairDispatch seam — the emit path
  // NEVER spawns a re-dispatch directly. Prove it by passing a broker stub whose
  // `broker()` admission gate is the sole control over whether the patcher runs,
  // and assert the stage-2 result flows back through `awaitNextCompletion`.
  let brokerCalls = 0;
  let awaitCalls = 0;
  let patcherCalls = 0;
  const seamBroker = {
    broker: ({ slots }) => {
      brokerCalls += 1;
      const slotId = slots[0].slotId;
      return {
        admitted: 1,
        admission: "admitted",
        admittedSlotIds: [slotId],
        estimatedWaveTokens: 0,
        cooldownUntil: null,
        bindingCap: "none",
        capableHost: true,
        schedule: {},
      };
    },
    awaitNextCompletion: (completion) => {
      awaitCalls += 1;
      return completion;
    },
  };
  const result = await enforceSchemaAtEmit({
    contractId: "audit_results",
    schema: WorkerAuditResultsSchema,
    payload: [{ task_id: "T1" }], // invalid → must degrade through O3
    provider: { outputConstraint: { mode: "none", reason: "cannot enforce" } },
    broker: seamBroker,
    brokerContext,
    artifactsDir,
    runId: "run-cp-node-26",
    tool: "audit-code",
    patcher: async () => {
      patcherCalls += 1;
      return validWorkerResults(); // the brokered LLM touch fixes it
    },
  });
  // The degrade path went through the SHARED broker, not a direct spawn.
  assert.equal(brokerCalls, 1, "stage-2 patch was gated by the shared broker exactly once");
  assert.equal(awaitCalls, 1, "patched result flowed back through the broker's awaitNextCompletion");
  assert.equal(patcherCalls, 1, "broker admitted the slot → bounded LLM patch ran once");
  assert.equal(result.mode, "none", "emit reports capability 'none'");
  assert.equal(result.repair.status, "patched", "invalid 'none' payload is salvaged via the brokered repair seam");
});

test("F3 inv-3: discovery runs exactly ONCE per constructed provider, ZERO per emit/dispatch", async () => {
  // inv-3: OutputConstraintCapability discovery happens once at provider
  // construction and is then READ at every emit — never re-discovered per
  // dispatch. Instrument both ends:
  //   (a) STRUCTURAL — the emit module must never call the discovery fn, so a
  //       dispatch path can't accidentally recompute it.
  //   (b) RUNTIME — N emits against one constructed provider observe the SAME
  //       stamped descriptor object identity (a re-discovery would mint a new
  //       object), proving zero per-emit discovery.

  // (a) The emit/dispatch source never invokes discovery.
  const emitSrc = await readFile(
    join(repoRoot, "src/audit/contracts/schemaEnforcedEmit.ts"),
    "utf8",
  );
  assert.ok(
    !/discoverOutputConstraintCapability/.test(emitSrc),
    "emit path must READ the stamped descriptor, never re-discover per emit",
  );

  // (b) One construction → one descriptor object reused across many emits.
  const provider = createFreshSessionProvider("local-subprocess", {}, noopDeps);
  const stamped = provider.outputConstraint;
  assert.ok(stamped, "construction stamps a descriptor exactly once");

  for (let i = 0; i < 3; i += 1) {
    const result = await enforceSchemaAtEmit({
      contractId: "audit_results",
      schema: WorkerAuditResultsSchema,
      payload: validWorkerResults(),
      provider, // same constructed provider across every emit
      broker: createBrokeredRepairDispatch(),
      brokerContext,
      artifactsDir,
      runId: `run-inv3-${i}`,
      tool: "audit-code",
      patcher: async (p) => p,
    });
    assert.equal(result.repair.status, "clean");
    // resolveEmitConstraint must hand back the SAME object the constructor stamped.
    assert.strictEqual(
      resolveEmitConstraint(provider),
      stamped,
      "every emit reads the once-discovered descriptor; no re-discovery",
    );
  }
});

test("F3 inv-7: enforced schema + registered RepairContract validator both resolve from workerSchemas.ts — no second schema definition (CP-NODE-28)", async () => {
  // inv-7: the schema enforced at emit AND the schema the registered
  // RepairContract validates against must be the ONE canonical zod source in
  // workerSchemas.ts (WORKER_SCHEMA_SOURCES). There must be no second/parallel
  // definition the two could drift apart on.

  // (a) SINGLE SOURCE — the registry entry's schema is the SAME object identity
  //     as the exported canonical schema (a second definition would be a
  //     different object).
  const registered = WORKER_SCHEMA_SOURCES["audit_results.schema.json"];
  assert.ok(registered, "audit_results schema is registered in WORKER_SCHEMA_SOURCES");
  assert.strictEqual(
    registered.schema,
    WorkerAuditResultsSchema,
    "registry source === canonical exported schema (one definition, not a copy)",
  );

  // (b) The RepairContract validator is built FROM that single source — and a
  //     contract built from the registry entry validates byte-for-byte the same
  //     as one built from the exported schema (they are the same schema).
  const fromExport = buildWorkerRepairContract("audit_results", WorkerAuditResultsSchema);
  const fromRegistry = buildWorkerRepairContract("audit_results", registered.schema);

  // Clean payload: both contract validators AND the raw schema agree (0 errors).
  const clean = validWorkerResults();
  assert.equal(fromExport.validate(clean).errors.length, 0);
  assert.equal(fromRegistry.validate(clean).errors.length, 0);
  assert.equal(WorkerAuditResultsSchema.safeParse(clean).success, true);

  // Invalid payload: both contract validators AND the raw schema agree it fails,
  // proving the enforced schema and the registered validator are one and the same.
  const bad = [{ task_id: "T1" }];
  assert.ok(fromExport.validate(bad).errors.length > 0);
  assert.ok(fromRegistry.validate(bad).errors.length > 0);
  assert.equal(WorkerAuditResultsSchema.safeParse(bad).success, false);
  assert.deepEqual(
    fromRegistry.validate(bad).errors,
    fromExport.validate(bad).errors,
    "registry-sourced and export-sourced validators report identical errors — one schema",
  );
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

test("F3 inv-1 [CP-NODE-22]: structural guard rejects hardcoded model literals in F3 files", async () => {
  // CP-NODE-22 / OBL-f3-schema-enforced-generation-inv-1: capability is discovered
  // at runtime — F3's scoped files must carry NO hardcoded model-id literal and NO
  // per-provider capability constant (CE-003). This guard is STRUCTURAL: it walks
  // the TypeScript AST of each F3 file and inspects only real string-literal /
  // template-head tokens (not comments, not identifiers), so a model id mentioned
  // in a doc comment can't trip it while a literal keyed in code can't slip past.
  const ts = (await import("typescript")).default;

  // The full F3 scope per the finding — incl. both providers/index.ts registries.
  const f3Files = [
    "src/shared/providers/providerFactory.ts",
    "src/shared/providers/types.ts",
    "src/audit/providers/index.ts",
    "src/remediate/providers/index.ts",
  ];

  // A hardcoded model-id literal (vendor-prefixed family names + the legacy table)
  // or a per-provider capability/limits constant.
  const modelIdLiteral =
    /^(claude-[0-9]|claude-(opus|sonnet|haiku)|gpt-4|gpt-3\.5|gpt-oss|gemini-|llama-|mistral-|o[13]-mini|o1-preview)/i;
  const capabilityConstantLiteral = /KNOWN_MODEL_LIMITS|MODEL_(LIMITS|TIERS|CAPABILITIES)/;

  const violations = [];
  for (const rel of f3Files) {
    const src = await readFile(join(repoRoot, rel), "utf8");
    const sourceFile = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      // Real string-literal tokens only — AST-scoped, so comments are excluded.
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (modelIdLiteral.test(node.text)) {
          violations.push(`${rel}: hardcoded model-id literal "${node.text}"`);
        }
      }
      // Per-provider capability constant referenced by identifier name.
      if (ts.isIdentifier(node) && capabilityConstantLiteral.test(node.text)) {
        violations.push(`${rel}: per-provider capability constant '${node.text}'`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  assert.deepEqual(
    violations,
    [],
    `F3 files must discover capability at runtime — no hardcoded model id / capability constant (CE-003). Violations:\n${violations.join("\n")}`,
  );
});

test("F3 inv-6 [CP-NODE-27]: enforcement core has no per-backend branching (parametrized over all providers)", async () => {
  // CP-NODE-27 / OBL-f3-schema-enforced-generation-inv-6: enforcement is
  // provider-agnostic. Identical code paths must run for EVERY resolved provider —
  // a new backend enriches the discovered descriptor, never forks enforcement.
  // Two complementary checks:
  //   (a) RUNTIME — the emit seam, driven across every resolved provider name,
  //       behaves identically given the SAME constraint mode. Provider identity
  //       is invisible to the enforcement core; only the descriptor's `mode`
  //       steers behavior. A conforming payload is `clean` with only the initial
  //       `validate` stage and NO LLM touch — for ALL backends alike.
  //   (b) STRUCTURAL — the enforcement core source (schemaEnforcedEmit.ts) must
  //       contain NO branch keyed on a backend NAME. It may read the descriptor
  //       `mode` only; a `=== "<provider-name>"` / `providerName ===` comparison
  //       would be a per-backend fork.

  // The full set of resolved provider names (mirrors the F3 discovery test set
  // plus the API-driven openai-compatible backend).
  const allProviders = [
    'claude-code',
    'codex',
    'opencode',
    'local-subprocess',
    'subprocess-template',
    'vscode-task',
    'antigravity',
    'openai-compatible',
  ];

  // (a) Runtime: one shared path for every resolved provider. We pin the SAME
  // constraint mode for each so any divergence can ONLY come from a per-backend
  // fork in the enforcement core — there is none, so every result is identical.
  for (const providerName of allProviders) {
    let patcherCalls = 0;
    const result = await enforceSchemaAtEmit({
      contractId: 'audit_results',
      schema: WorkerAuditResultsSchema,
      payload: validWorkerResults(),
      // Provider identity carried for realism, but the enforcement core reads
      // ONLY the descriptor mode — the name must not steer anything.
      provider: {
        name: providerName,
        outputConstraint: { mode: 'structured_output', reason: `descriptor for ${providerName}` },
      },
      broker: createBrokeredRepairDispatch(),
      brokerContext: { ...brokerContext, providerName },
      artifactsDir,
      runId: `run-inv6-${providerName}`,
      tool: 'audit-code',
      patcher: async (p) => {
        patcherCalls += 1;
        return p;
      },
    });
    assert.equal(
      result.mode,
      'structured_output',
      `${providerName}: emit reports the descriptor mode, not the backend name`,
    );
    assert.equal(
      result.repair.status,
      'clean',
      `${providerName}: identical clean path for a conforming payload`,
    );
    assert.deepEqual(
      result.repair.stages_applied,
      ['validate'],
      `${providerName}: one shared validate stage — no backend-specific stages`,
    );
    assert.equal(patcherCalls, 0, `${providerName}: no LLM touch on a conforming payload`);
  }

  // (b) Structural: the enforcement core branches on the descriptor `mode` only,
  // never on a backend name. Walk the AST and reject any comparison whose other
  // operand is a known provider-name string literal, or a comparison against a
  // `providerName` / `provider.name` access.
  const ts = (await import('typescript')).default;
  const emitRel = 'src/audit/contracts/schemaEnforcedEmit.ts';
  const emitSrc = await readFile(join(repoRoot, emitRel), 'utf8');
  const sourceFile = ts.createSourceFile(emitRel, emitSrc, ts.ScriptTarget.Latest, true);

  const providerNameSet = new Set(allProviders);
  const branchViolations = [];

  const isProviderNameLiteral = (node) =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    providerNameSet.has(node.text);

  const isProviderNameAccess = (node) => {
    if (ts.isIdentifier(node)) return /providerName/i.test(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return /^name$/i.test(node.name.text) && /provider/i.test(node.expression.getText(sourceFile));
    }
    return false;
  };

  const visit = (node) => {
    // Equality/switch comparisons that key off a backend name are per-backend forks.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isEq =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (isEq) {
        const sides = [node.left, node.right];
        if (sides.some(isProviderNameLiteral)) {
          branchViolations.push(`${emitRel}: equality branch on a provider-name literal`);
        }
        if (sides.some(isProviderNameAccess) && sides.some(isProviderNameLiteral)) {
          branchViolations.push(`${emitRel}: equality branch comparing provider name to a backend literal`);
        }
      }
    }
    // A `switch (providerName)` is likewise a per-backend fork.
    if (ts.isSwitchStatement(node) && isProviderNameAccess(node.expression)) {
      branchViolations.push(`${emitRel}: switch keyed on a provider name`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.deepEqual(
    branchViolations,
    [],
    `Enforcement core must be provider-agnostic — no branch keyed on a backend name (inv-6). Violations:\n${branchViolations.join('\n')}`,
  );
});

test("F3 fail-1 [CP-NODE-29]: mis-advertised mode + invalid emit => degrade to repair, never accept", async () => {
  // F3 fail-1 / OBL-f3-schema-enforced-generation-fail-1: a backend can ADVERTISE
  // a constraint mode it cannot actually honor (forced_tool_call /
  // json_schema_constrained / structured_output) yet still emit a payload that
  // fails the canonical worker zod schema. The enforcement core must NEVER trust
  // the advertised mode and accept an invalid payload — the zod validate is the
  // sole authority, so a validation failure under ANY mode degrades through the O3
  // emit-validate-repair seam, with its stage-2 LLM patch routed through the SHARED
  // BrokeredRepairDispatch broker (never a direct spawn). The emit reports the
  // advertised mode for the record, but the OUTCOME is a brokered repair, not an
  // accepted invalid payload.
  for (const advertisedMode of [
    "forced_tool_call",
    "json_schema_constrained",
    "structured_output",
  ]) {
    let brokerCalls = 0;
    let awaitCalls = 0;
    let patcherCalls = 0;
    // A seam broker whose admission gate is the SOLE control over the patch, so we
    // can prove the degrade went through the shared broker, not a direct spawn.
    const seamBroker = {
      broker: ({ slots }) => {
        brokerCalls += 1;
        const slotId = slots[0].slotId;
        return {
          admitted: 1,
          admission: "admitted",
          admittedSlotIds: [slotId],
          estimatedWaveTokens: 0,
          cooldownUntil: null,
          bindingCap: "none",
          capableHost: true,
          schedule: {},
        };
      },
      awaitNextCompletion: (completion) => {
        awaitCalls += 1;
        return completion;
      },
    };
    const result = await enforceSchemaAtEmit({
      contractId: "audit_results",
      schema: WorkerAuditResultsSchema,
      // The backend mis-advertised `advertisedMode` but emitted an invalid payload.
      payload: [{ task_id: "T1" }],
      provider: {
        outputConstraint: { mode: advertisedMode, reason: "advertised but not honored" },
      },
      broker: seamBroker,
      brokerContext,
      artifactsDir,
      runId: `run-cp-node-29-${advertisedMode}`,
      tool: "audit-code",
      patcher: async () => {
        patcherCalls += 1;
        return validWorkerResults(); // the brokered LLM touch salvages it
      },
    });
    // The mis-advertised mode is recorded, but the invalid payload was NOT accepted
    // on the strength of the advertised mode — it degraded through the brokered seam.
    assert.equal(
      result.mode,
      advertisedMode,
      `${advertisedMode}: emit records the advertised mode for the audit trail`,
    );
    assert.equal(
      result.repair.status,
      "patched",
      `${advertisedMode}: invalid payload degraded + salvaged via repair — never accepted`,
    );
    assert.notEqual(
      result.repair.status,
      "clean",
      `${advertisedMode}: a mis-advertised mode must NOT short-circuit to clean on an invalid payload`,
    );
    assert.equal(
      brokerCalls,
      1,
      `${advertisedMode}: the degrade patch was gated by the shared broker exactly once`,
    );
    assert.equal(
      awaitCalls,
      1,
      `${advertisedMode}: the patched result flowed back through the broker's awaitNextCompletion`,
    );
    assert.equal(
      patcherCalls,
      1,
      `${advertisedMode}: broker admitted the slot → bounded LLM patch ran once`,
    );
    assert.equal(
      result.repair.repaired_payload.length,
      1,
      `${advertisedMode}: the repaired payload is the salvaged valid worker result`,
    );
  }
});

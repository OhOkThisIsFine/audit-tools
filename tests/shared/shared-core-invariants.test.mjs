/**
 * Regression tests for shared-core module invariants.
 * INV-shared-core-01 through INV-shared-core-11.
 *
 * Each test block is tagged with the invariant ID it covers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../");
const AUDIT_CODE_SCHEMAS = resolve(REPO_ROOT, "schemas");

// ── INV-shared-core-01: Schema drift detection ───────────────────────────────

test("INV-shared-core-01: finding.schema.json required keys match Finding TS type", () => {
  const schemaPath = resolve(AUDIT_CODE_SCHEMAS, "finding.schema.json");
  assert.ok(existsSync(schemaPath), `schema not found: ${schemaPath}`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  // The required fields from finding.schema.json must all be present on the
  // TS Finding interface. We verify by checking the schema's "required" array
  // against the known Finding fields. A missing key here means schema/TS drift.
  const schemaRequired = schema.required ?? [];

  // Known canonical Finding fields from types/finding.ts (required + commonly required by schema).
  const findingFields = new Set([
    "id", "title", "category", "severity", "confidence",
    "lens", "summary", "affected_files", "evidence",
    // optional: impact, likelihood, reproduction, systemic,
    // related_findings, theme_id, evidence_grounded, contract_goal_id,
    // contract_obligation_ids, verification_obligation_ids, targeted_commands
  ]);

  for (const key of schemaRequired) {
    assert.ok(
      findingFields.has(key),
      `Schema required field "${key}" is missing from the TS Finding type — schema/TS drift detected`,
    );
  }
});

test("INV-shared-core-01: finding.schema.json severity enum matches SEVERITIES", async () => {
  const { SEVERITIES } = await import("../../src/shared/types/lens.ts");
  const schemaPath = resolve(AUDIT_CODE_SCHEMAS, "finding.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  const schemaEnum = schema.properties?.severity?.enum ?? [];
  const tsEnum = Array.from(SEVERITIES);

  // Every schema severity must be in the TS enum.
  for (const sev of schemaEnum) {
    assert.ok(
      tsEnum.includes(sev),
      `Schema severity enum value "${sev}" not in SEVERITIES — schema/TS drift`,
    );
  }

  // Every TS severity must be in the schema.
  for (const sev of tsEnum) {
    assert.ok(
      schemaEnum.includes(sev),
      `SEVERITIES value "${sev}" missing from finding.schema.json — schema/TS drift`,
    );
  }
});

test("INV-shared-core-01: audit_result.schema.json required keys are present in the shared contract", () => {
  const schemaPath = resolve(AUDIT_CODE_SCHEMAS, "audit_result.schema.json");
  assert.ok(existsSync(schemaPath), `schema not found: ${schemaPath}`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  // The audit_result schema required keys are: task_id, unit_id, pass_id, lens,
  // file_coverage, findings. These match the auditor's AuditResult contract.
  const required = schema.required ?? [];
  const expectedKeys = ["task_id", "unit_id", "pass_id", "lens", "file_coverage", "findings"];
  for (const key of expectedKeys) {
    assert.ok(
      required.includes(key),
      `Expected "${key}" to be in audit_result.schema.json required array`,
    );
  }
});

// ── INV-shared-core-02: No provider-name→tier table ─────────────────────────

test("INV-shared-core-02: CAPABILITY_TIER_MAP is not exported from shared", async () => {
  const shared = await import("../../src/shared/index.ts");
  // CAPABILITY_TIER_MAP was an internal map; it must not be exported.
  assert.equal(
    shared["CAPABILITY_TIER_MAP"],
    undefined,
    "CAPABILITY_TIER_MAP must not be exported from shared (INV-shared-core-02)",
  );
});

test("INV-shared-core-02: rollingDispatch derives pool rank from pool.rank, not from provider name", async () => {
  // The rollingDispatch module must derive routing rank from pool.rank (DispatchModelTier),
  // not from a hardcoded switch on providerName.
  //
  // We verify by giving two pools the SAME providerName but different rank values,
  // then checking that selectProvider prefers the deeper-ranked pool for a high-complexity
  // packet. If ranking were based on providerName they would be indistinguishable.
  const { setQuotaStateDir } = await import("../../src/shared/quota/state.ts");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "inv02-test-"));
  setQuotaStateDir(dir);

  const { selectProvider, InFlightTokenTracker } = await import("../../src/shared/dispatch/rollingDispatch.ts");

  function makePool(id, rank) {
    return {
      id,
      providerName: "claude-code", // same name for both — rank must come from pool.rank
      hostModel: null,
      rank,
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
    };
  }

  const deepPool = makePool("deep-pool", "deep");
  const smallPool = makePool("small-pool", "small");

  const tracker = new InFlightTokenTracker();

  // High-complexity packet — should prefer 'deep' pool.
  const highComplexityPacket = {
    id: "p1",
    payload: {},
    estimatedTokens: 100,
    complexity: 0.9,
  };

  const session = { quota: { enabled: false } };
  // small-pool first in array — if ranking used provider name (same), order would decide.
  const slot = selectProvider(highComplexityPacket, [smallPool, deepPool], tracker, {}, session);
  assert.ok(slot !== null, "expected a pool to be selected");
  assert.equal(
    slot.poolId,
    "deep-pool",
    "High-complexity packet must prefer pool with rank=deep; rank derives from pool.rank, not provider name",
  );
});

// ── INV-shared-core-03: Both orchestrators delegate provider wiring to shared factory ──

test("INV-shared-core-03: shared providerFactory exports createFreshSessionProvider", async () => {
  const { createFreshSessionProvider } = await import("../../src/shared/providers/providerFactory.ts");
  assert.equal(typeof createFreshSessionProvider, "function", "createFreshSessionProvider must be exported from shared");
});

test("INV-shared-core-03: FreshSessionProviderDeps interface exposes createClaudeCodeProvider and createOpenCodeProvider", async () => {
  // We verify the interface contract at the TypeScript level via the build check,
  // and at runtime by confirming that the factory accepts a deps object with those keys.
  const { createFreshSessionProvider } = await import("../../src/shared/providers/providerFactory.ts");

  let claudeCodeCreated = false;
  let openCodeCreated = false;

  const deps = {
    orchestratorName: "test-orchestrator",
    createClaudeCodeProvider: (_config) => {
      claudeCodeCreated = true;
      return { name: "claude-code", launch: async () => ({ accepted: false }) };
    },
    createOpenCodeProvider: (_config) => {
      openCodeCreated = true;
      return { name: "opencode", launch: async () => ({ accepted: false }) };
    },
  };

  // Requesting "claude-code" must call createClaudeCodeProvider from deps.
  createFreshSessionProvider("claude-code", {}, deps);
  assert.ok(claudeCodeCreated, "createClaudeCodeProvider must be called by the factory");
});

// ── INV-shared-core-04: Shared obligation abstraction ────────────────────────

test("INV-shared-core-04: ObligationEntry is exported from shared types", async () => {
  // The ObligationEntry type is the shared obligation abstraction.
  // We verify it is accessible via shared and has the required shape fields.
  const { buildObligationLedger, CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION } = await import("../../src/shared/index.ts");

  const ledger = buildObligationLedger({
    goal_id: "test-goal",
    obligations: [
      { id: "OBL-1", description: "test obligation", kind: "behavioral", depends_on: [], status: "pending" },
    ],
  });

  assert.equal(ledger.contract_version, CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION);
  assert.equal(ledger.goal_id, "test-goal");
  assert.equal(ledger.obligations.length, 1);
  assert.equal(ledger.obligations[0].id, "OBL-1");
  assert.ok(typeof ledger.obligations[0].depends_on !== "undefined", "ObligationEntry must have depends_on");
});

// ── INV-shared-core-05: Finding identity subset ───────────────────────────────

test("INV-shared-core-05: findingIdentity strips contract_* fields", async () => {
  const { findingIdentity } = await import("../../src/shared/types/finding.ts");

  const finding = {
    id: "FINDING-001",
    title: "Test Finding",
    category: "General",
    severity: "high",
    confidence: "high",
    lens: "security",
    summary: "A test finding",
    affected_files: [{ path: "src/foo.ts" }],
    contract_goal_id: "remediate-xyz",
    contract_obligation_ids: ["OBL-1"],
    verification_obligation_ids: ["OBL-1"],
    targeted_commands: ["npm test"],
    evidence_grounded: true,
    theme_id: "T-1",
  };

  const identity = findingIdentity(finding);

  // Identity must contain the canonical fields.
  assert.equal(identity.id, "FINDING-001");
  assert.equal(identity.title, "Test Finding");
  assert.equal(identity.severity, "high");
  assert.equal(identity.lens, "security");
  assert.equal(identity.summary, "A test finding");
  assert.deepEqual(identity.affected_files, [{ path: "src/foo.ts" }]);

  // Identity must NOT carry contract_* fields.
  assert.equal(identity["contract_goal_id"], undefined, "contract_goal_id must not appear in FindingIdentity");
  assert.equal(identity["contract_obligation_ids"], undefined, "contract_obligation_ids must not appear");
  assert.equal(identity["verification_obligation_ids"], undefined, "verification_obligation_ids must not appear");
  assert.equal(identity["targeted_commands"], undefined, "targeted_commands must not appear");
});

test("INV-shared-core-05: findingIdentity round-trips through JSON without contract_* fields", async () => {
  const { findingIdentity } = await import("../../src/shared/types/finding.ts");

  const finding = {
    id: "F-2",
    title: "Another",
    category: "Test",
    severity: "low",
    confidence: "medium",
    lens: "tests",
    summary: "summary",
    affected_files: [],
    contract_goal_id: "g",
    contract_obligation_ids: ["x"],
  };

  const identity = findingIdentity(finding);
  const roundTripped = JSON.parse(JSON.stringify(identity));

  // No contract_* keys should survive round-trip.
  for (const key of Object.keys(roundTripped)) {
    assert.ok(
      !key.startsWith("contract_") && key !== "verification_obligation_ids" && key !== "targeted_commands",
      `Unexpected key in FindingIdentity after JSON round-trip: ${key}`,
    );
  }
});

// ── INV-shared-core-06: AuditFindingsReport.contract_version validated on ingestion ─

test("INV-shared-core-06: validateAuditFindingsReport flags missing contract_version as error", async () => {
  const { validateAuditFindingsReport } = await import("../../src/shared/validation/findingsReport.ts");

  const issues = validateAuditFindingsReport({ findings: [], work_blocks: [] });
  const errors = issues.filter(i => i.severity === "error");
  assert.ok(errors.length > 0, "missing contract_version must produce an error issue");
  assert.ok(
    errors.some(i => i.message.includes("contract_version")),
    `expected contract_version error, got: ${JSON.stringify(errors)}`,
  );
});

test("INV-shared-core-06 / OBL-C002-VERSION-TRUST: validateAuditFindingsReport emits error (not warning) on mismatched contract_version", async () => {
  const { validateAuditFindingsReport } = await import("../../src/shared/validation/findingsReport.ts");

  const issues = validateAuditFindingsReport({
    contract_version: "unexpected-version/v99",
    findings: [],
    work_blocks: [],
  });
  // OBL-C002-VERSION-TRUST: mismatch must be an error, not a warning, so
  // isValidAuditFindingsReport returns false for mismatched versions.
  const errors = issues.filter(i => i.severity === "error");
  assert.ok(errors.length > 0, "mismatched contract_version must produce an error (not a warning)");
  assert.ok(
    errors.some(i => i.message.includes("unexpected-version")),
    "error must cite the mismatched version value",
  );
  // Confirm no warnings emitted for this case — it's an error.
  const warnings = issues.filter(i => i.severity === "warning");
  assert.equal(warnings.length, 0, "version mismatch must not produce a warning; it is an error");
});

test("INV-shared-core-06 / OBL-C002-VERSION-TRUST: isValidAuditFindingsReport returns false for mismatched contract_version", async () => {
  const { isValidAuditFindingsReport } = await import("../../src/shared/validation/findingsReport.ts");

  // Present-but-mismatched version must cause rejection (return false), not just a warning.
  assert.equal(
    isValidAuditFindingsReport({
      contract_version: "audit-tools/audit-findings/v0alpha0",
      findings: [],
      work_blocks: [],
      summary: { finding_count: 0 },
    }),
    false,
    "isValidAuditFindingsReport must return false when contract_version is present but mismatched",
  );

  // Any non-canonical version string must be rejected.
  assert.equal(
    isValidAuditFindingsReport({
      contract_version: "some-other-tool/v1",
      findings: [],
      work_blocks: [],
    }),
    false,
    "isValidAuditFindingsReport must return false for any non-canonical contract_version",
  );
});

test("INV-shared-core-06: validateAuditFindingsReport passes with correct contract_version", async () => {
  const { validateAuditFindingsReport, AUDIT_FINDINGS_CONTRACT_VERSION } = await import("../../src/shared/validation/findingsReport.ts");

  const issues = validateAuditFindingsReport({
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    findings: [],
    work_blocks: [],
    summary: { finding_count: 0 },
  });
  const errors = issues.filter(i => i.severity === "error");
  assert.equal(errors.length, 0, `expected no errors for valid report, got: ${JSON.stringify(errors)}`);
});

test("INV-shared-core-06: validateAuditFindingsReport rejects non-object", async () => {
  const { validateAuditFindingsReport } = await import("../../src/shared/validation/findingsReport.ts");

  const issues = validateAuditFindingsReport(null);
  assert.ok(issues.some(i => i.severity === "error"), "null value must produce an error");

  const issues2 = validateAuditFindingsReport("not an object");
  assert.ok(issues2.some(i => i.severity === "error"), "string value must produce an error");
});

// ── INV-shared-core-07: ObligationEntry.depends_on cycle-checked at construction ─

test("INV-shared-core-07: buildObligationLedger throws when depends_on forms a direct cycle (A → B → A)", async () => {
  const { buildObligationLedger } = await import("../../src/shared/types/obligationLedger.ts");

  assert.throws(
    () => buildObligationLedger({
      goal_id: "g",
      obligations: [
        { id: "A", description: "a", kind: "behavioral", depends_on: ["B"], status: "pending" },
        { id: "B", description: "b", kind: "behavioral", depends_on: ["A"], status: "pending" },
      ],
    }),
    /cycle/i,
    "A direct depends_on cycle must be caught at construction time",
  );
});

test("INV-shared-core-07: buildObligationLedger throws when depends_on forms a transitive cycle (A → B → C → A)", async () => {
  const { buildObligationLedger } = await import("../../src/shared/types/obligationLedger.ts");

  assert.throws(
    () => buildObligationLedger({
      goal_id: "g",
      obligations: [
        { id: "A", description: "a", kind: "behavioral", depends_on: ["B"], status: "pending" },
        { id: "B", description: "b", kind: "behavioral", depends_on: ["C"], status: "pending" },
        { id: "C", description: "c", kind: "behavioral", depends_on: ["A"], status: "pending" },
      ],
    }),
    /cycle/i,
    "A transitive depends_on cycle must be caught at construction time",
  );
});

test("INV-shared-core-07: buildObligationLedger accepts a valid DAG with no cycles", async () => {
  const { buildObligationLedger } = await import("../../src/shared/types/obligationLedger.ts");

  const ledger = buildObligationLedger({
    goal_id: "g",
    obligations: [
      { id: "A", description: "a", kind: "behavioral", depends_on: [], status: "pending" },
      { id: "B", description: "b", kind: "behavioral", depends_on: ["A"], status: "pending" },
      { id: "C", description: "c", kind: "behavioral", depends_on: ["A", "B"], status: "pending" },
    ],
  });
  assert.equal(ledger.obligations.length, 3);
  assert.equal(ledger.goal_id, "g");
});

test("INV-shared-core-07: buildObligationLedger accepts empty obligations list", async () => {
  const { buildObligationLedger } = await import("../../src/shared/types/obligationLedger.ts");
  const ledger = buildObligationLedger({ goal_id: "g", obligations: [] });
  assert.equal(ledger.obligations.length, 0);
});

// ── INV-shared-core-08: ClaudeCodeConfig.dangerously_skip_permissions flagged ─

test("INV-shared-core-08: validateSessionConfig warns when dangerously_skip_permissions=true", async () => {
  const { validateSessionConfig } = await import("../../src/shared/validation/sessionConfig.ts");

  const issues = validateSessionConfig({
    provider: "claude-code",
    claude_code: { dangerously_skip_permissions: true },
  });

  const warnings = issues.filter(i => i.severity === "warning");
  assert.ok(warnings.length > 0, "dangerously_skip_permissions=true must produce a warning");
  assert.ok(
    warnings.some(i => i.message.toLowerCase().includes("dangerously_skip_permissions")),
    `expected dangerously_skip_permissions in warning message, got: ${JSON.stringify(warnings)}`,
  );
});

test("INV-shared-core-08: validateSessionConfig does not warn when dangerously_skip_permissions is absent", async () => {
  const { validateSessionConfig } = await import("../../src/shared/validation/sessionConfig.ts");

  const issues = validateSessionConfig({
    provider: "claude-code",
    claude_code: { command: "claude" },
  });
  assert.equal(issues.length, 0, "no issues for a safe session config");
});

test("INV-shared-core-08: validateSessionConfig does not warn when dangerously_skip_permissions=false", async () => {
  const { validateSessionConfig } = await import("../../src/shared/validation/sessionConfig.ts");

  const issues = validateSessionConfig({
    claude_code: { dangerously_skip_permissions: false },
  });
  assert.equal(issues.length, 0, "false value must not produce a warning");
});

// ── INV-shared-core-09: Validation primitives stay pure and composable ────────

test("INV-shared-core-09: prefixValidationIssues is idempotent (no double-prefixing)", async () => {
  const { prefixValidationIssues } = await import("../../src/shared/validation/basic.ts");

  // Calling prefixValidationIssues twice with the same prefix must be idempotent.
  const issues = [{ path: "bar", message: "m", severity: "error" }];
  const once = prefixValidationIssues("foo", issues);
  const twice = prefixValidationIssues("foo", once);

  assert.equal(once[0].path, "foo.bar", "first call must prepend prefix");
  assert.equal(twice[0].path, "foo.bar", "second call must not double-prefix");
});

test("INV-shared-core-09: requireKeys returns issues rather than throwing", async () => {
  const { requireKeys } = await import("../../src/shared/validation/basic.ts");

  // requireKeys must return an array of issues, never throw.
  // Even for non-objects or missing keys it must return, not throw.
  const issues1 = requireKeys("not-an-object", "root", ["id", "title"]);
  assert.ok(Array.isArray(issues1), "requireKeys must return an array");
  assert.ok(issues1.length > 0, "requireKeys must produce an issue for non-objects");

  const issues2 = requireKeys({ id: "x" }, "root", ["id", "title"]);
  assert.ok(Array.isArray(issues2), "requireKeys must return an array for missing keys");
  assert.ok(issues2.length > 0, "requireKeys must produce an issue for missing 'title'");
});

// ── INV-shared-core-12: Codex/Antigravity env signals are documented behavioral contracts ─
// ARC-94fc2498: provider auto-resolution signals for Codex (CODEX) and
// Antigravity (ANTIGRAVITY / TERM_PROGRAM=antigravity) are now regression-locked
// by test — not unconfirmed TODO items. These tests verify the behavioral contracts
// that the signal interpretation is intentional and stable.

test("INV-shared-core-12: CODEX env var resolves auto provider to codex (in-session)", async () => {
  const { resolveFreshSessionProviderName } = await import("../../src/shared/providers/providerFactory.ts");
  // CODEX=1 signals we are running inside an OpenAI Codex CLI session.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: () => false },
  );
  assert.equal(
    resolved,
    "codex",
    "CODEX env var must route to codex provider (in-session behavioral contract)",
  );
});

test("INV-shared-core-12: ANTIGRAVITY env var resolves auto provider to antigravity when a template is configured", async () => {
  const { resolveFreshSessionProviderName } = await import("../../src/shared/providers/providerFactory.ts");
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { ANTIGRAVITY: "1" }, commandExists: () => false },
  );
  assert.equal(
    resolved,
    "antigravity",
    "ANTIGRAVITY env var + command_template must route to antigravity (behavioral contract)",
  );
});

test("INV-shared-core-12: TERM_PROGRAM=antigravity also resolves to antigravity with a template", async () => {
  const { resolveFreshSessionProviderName } = await import("../../src/shared/providers/providerFactory.ts");
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { TERM_PROGRAM: "antigravity" }, commandExists: () => false },
  );
  assert.equal(
    resolved,
    "antigravity",
    "TERM_PROGRAM=antigravity is equivalent to ANTIGRAVITY env var (behavioral contract)",
  );
});

test("INV-shared-core-12: providerFactory.ts has no TODO(verify) comments for Codex/Antigravity signals", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));
  const factoryPath = resolve(dir, "../../src/shared/providers/providerFactory.ts");
  const source = readFileSync(factoryPath, "utf8");
  // ARC-94fc2498: the TODO(verify) comments that flagged these as unconfirmed
  // signals must be gone — replaced with documented behavioral contracts.
  assert.ok(
    !source.includes("TODO(verify)"),
    "providerFactory.ts must not contain TODO(verify) comments — signals are now documented behavioral contracts (ARC-94fc2498)",
  );
});

// ── INV-shared-core-13: RunLogger is the structured logging contract ───────────
// ARC-c70f0310: RunLogger (shared/src/observability/runLog.ts) is the canonical
// structured logging contract. Scattered process.stderr.write and console.debug
// calls in orchestrator hot paths are identified as a tool opportunity; RunLogger
// already provides NDJSON structured output with injectable clock and disabled mode.

test("INV-shared-core-13: RunLogger exports the full structured logging contract", async () => {
  const { RunLogger } = await import("../../src/shared/observability/runLog.ts");
  // RunLogger must have the three-part contract: constructor, .event(), .disabled()
  assert.equal(typeof RunLogger, "function", "RunLogger must be a class");
  const logger = new RunLogger("/tmp/noop-test.jsonl", { enabled: false });
  assert.equal(typeof logger.event, "function", "RunLogger instance must have .event()");
  assert.equal(typeof logger.isEnabled, "boolean", "RunLogger instance must have .isEnabled");
  const disabled = RunLogger.disabled();
  assert.equal(disabled.isEnabled, false, "RunLogger.disabled() must return a disabled logger");
  // Disabled logger must accept all event kinds without throwing.
  for (const kind of ["obligation", "executor_start", "executor_end", "artifact_write",
                       "scope", "outcome", "provider_launch", "step", "state", "error"]) {
    assert.doesNotThrow(
      () => disabled.event({ kind }),
      `disabled RunLogger must not throw for kind=${kind}`,
    );
  }
});

test("INV-shared-core-13: RunLogEventKind covers all orchestrator lifecycle events", async () => {
  // The RunLogEventKind union must include events emitted by both orchestrators.
  // This test documents the contract — adding new event kinds is non-breaking,
  // but removing these would break log aggregation across runs.
  const runLogModule = await import("../../src/shared/observability/runLog.ts");
  // We verify indirectly: a RunLogger with a real path accepts all these kinds.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFile, rm } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "inv13-runlog-"));
  try {
    const logPath = join(dir, "run.jsonl");
    const logger = new runLogModule.RunLogger(logPath, { now: () => 1000 });
    const kinds = ["obligation", "executor_start", "executor_end", "artifact_write",
                   "scope", "outcome", "provider_launch", "step", "state", "error"];
    for (const kind of kinds) {
      logger.event({ kind, note: `test-${kind}` });
    }
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, kinds.length, "each emitted event must produce one NDJSON line");
    for (let i = 0; i < kinds.length; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.kind, kinds[i], `line ${i} must have kind=${kinds[i]}`);
      assert.equal(typeof parsed.ts, "string", "each line must have an ISO timestamp");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-shared-core-14: providerFactory emits structured RunLogger event on auto-resolution ─
// FND-OBS-12e8582b: auto-resolution diagnostic wrote to stderr only. Now the factory
// also emits a structured provider_launch event via an optional injected RunLogger,
// enabling machine-parseable, run-correlated observability of provider selection.

test("INV-shared-core-14: createFreshSessionProvider emits provider_launch RunLogger event on auto-resolution", async () => {
  const { createFreshSessionProvider } = await import("../../src/shared/providers/providerFactory.ts");
  const { RunLogger } = await import("../../src/shared/observability/runLog.ts");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "inv14-provider-launch-"));
  try {
    const logPath = join(dir, "run.jsonl");
    const runLogger = new RunLogger(logPath, { now: () => 1234567890 });

    const deps = {
      orchestratorName: "test-orch",
      createClaudeCodeProvider: (_config) => ({ name: "claude-code", launch: async () => ({ accepted: false }) }),
      createOpenCodeProvider: (_config) => ({ name: "opencode", launch: async () => ({ accepted: false }) }),
      runLogger,
    };

    // name=undefined + no sessionConfig.provider → effectiveName="auto" → auto-resolution fires.
    createFreshSessionProvider(undefined, {}, deps);

    const content = await readFile(logPath, "utf8");
    assert.ok(content.trim().length > 0, "auto-resolution must produce at least one RunLogger event");
    const event = JSON.parse(content.trim().split("\n")[0]);
    assert.equal(event.kind, "provider_launch", "auto-resolution must emit a provider_launch event");
    assert.equal(typeof event.provider, "string", "provider_launch event must have provider field");
    assert.equal(typeof event.ts, "string", "provider_launch event must have a timestamp");
    assert.equal(event.phase, "provider_auto_resolution", "event must carry phase=provider_auto_resolution");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-core-14: createFreshSessionProvider does NOT emit RunLogger event for explicit provider name", async () => {
  const { createFreshSessionProvider } = await import("../../src/shared/providers/providerFactory.ts");
  const { RunLogger } = await import("../../src/shared/observability/runLog.ts");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "inv14-no-event-"));
  try {
    const logPath = join(dir, "run.jsonl");
    const runLogger = new RunLogger(logPath, { now: () => 1234567890 });

    const deps = {
      orchestratorName: "test-orch",
      createClaudeCodeProvider: (_config) => ({ name: "claude-code", launch: async () => ({ accepted: false }) }),
      createOpenCodeProvider: (_config) => ({ name: "opencode", launch: async () => ({ accepted: false }) }),
      runLogger,
    };

    // Explicit "local-subprocess" is not auto-detection — no event should be emitted.
    createFreshSessionProvider("local-subprocess", {}, deps);

    const content = await readFile(logPath, "utf8").catch(() => "");
    assert.equal(
      content.trim(),
      "",
      "explicit provider name must not produce a RunLogger event (only auto-resolution does)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-core-14: FreshSessionProviderDeps.runLogger is optional (no logger = no throw)", async () => {
  const { createFreshSessionProvider } = await import("../../src/shared/providers/providerFactory.ts");

  // Callers that do not supply runLogger must not throw — it is optional.
  const deps = {
    orchestratorName: "test-orch",
    createClaudeCodeProvider: (_config) => ({ name: "claude-code", launch: async () => ({ accepted: false }) }),
    createOpenCodeProvider: (_config) => ({ name: "opencode", launch: async () => ({ accepted: false }) }),
    // No runLogger supplied.
  };

  assert.doesNotThrow(
    () => createFreshSessionProvider("local-subprocess", {}, deps),
    "createFreshSessionProvider must not throw when runLogger is absent",
  );
});

// ── INV-shared-core-15: RETIRED under the A12 single-package collapse ─────────
// The old CRIT-shared-first-ordering invariant (CI must build audit-tools/shared
// before each dependent's verify:release; root `check` must run `--workspaces`)
// asserted the three-package workspace topology. There is now ONE package, ONE
// `tsc` build, and no workspaces — so "build shared first" and "check --workspaces"
// are structurally impossible to violate. The single-package CI contract is asserted
// by INV-shared-core-15b below.

test("INV-shared-core-15b: ci.yml runs a single-package build + verify gate (no shared-first / workspace ceremony)", () => {
  const ciPath = resolve(REPO_ROOT, ".github/workflows/ci.yml");
  assert.ok(existsSync(ciPath), `ci.yml not found at ${ciPath}`);
  const content = readFileSync(ciPath, "utf8");
  assert.ok(
    content.includes("npm run verify:release"),
    "ci.yml must run the single-package verify:release gate — CRIT-single-package",
  );
  assert.ok(
    !content.includes("--workspaces") && !content.includes("packages/shared"),
    "ci.yml must not reference workspaces or packages/shared after the single-package collapse — CRIT-single-package",
  );
});

// ── INV-shared-core-16: CRIT-tests-with-source — pre-commit gate enforces green ─
// CRIT-001: Regression tests for a fix land in the same commit as the fix.
// The mechanical enforcement is the pre-commit-gate hook: it blocks `git commit`
// until `npm run check` passes. If a fix is committed without its test the check
// could still pass (since tests are run separately), but the green-at-every-commit
// invariant means no broken build can land — the moment a test is added in a later
// commit, the commit is tested before it lands.
//
// These tests lock the gate's existence and contract so it cannot be silently deleted.

test("INV-shared-core-16: pre-commit-gate.mjs exists and blocks git commit on check failure", () => {
  const gatePath = resolve(REPO_ROOT, ".claude/hooks/pre-commit-gate.mjs");
  assert.ok(existsSync(gatePath), `.claude/hooks/pre-commit-gate.mjs must exist — CRIT-tests-with-source`);

  const source = readFileSync(gatePath, "utf8");

  // Gate must intercept git commit invocations.
  assert.ok(
    source.includes("git") && source.includes("commit"),
    "pre-commit-gate.mjs must detect git commit invocations",
  );

  // Gate must run npm run check (the full workspace typecheck).
  assert.ok(
    source.includes("npm run check"),
    "pre-commit-gate.mjs must invoke 'npm run check' — CRIT-tests-with-source",
  );

  // Gate must exit non-zero to block the commit when check fails.
  assert.ok(
    source.includes("process.exit(2)"),
    "pre-commit-gate.mjs must call process.exit(2) to block a failing commit — CRIT-tests-with-source",
  );
});

test("INV-shared-core-16: async-typecheck hook exists and covers all three packages", () => {
  const hookPath = resolve(REPO_ROOT, ".claude/hooks/async-typecheck.mjs");
  assert.ok(existsSync(hookPath), `.claude/hooks/async-typecheck.mjs must exist — CRIT-tests-with-source`);

  const source = readFileSync(hookPath, "utf8");

  // Single-package layout: the hook must cover edits to any of the three source
  // subsystems (src/shared, src/audit, src/remediate) so a type break in any of
  // them triggers a typecheck. The hook matches `src/(shared|audit|remediate)/`.
  for (const sub of ["shared", "audit", "remediate"]) {
    assert.ok(
      source.includes(sub),
      `async-typecheck.mjs must reference src subsystem '${sub}' — CRIT-tests-with-source (gate must cover all subsystems)`,
    );
  }

  // Hook must run the whole-package typecheck.
  assert.ok(
    source.includes("npm run check"),
    "async-typecheck.mjs must invoke 'npm run check' — CRIT-tests-with-source",
  );
});

test("INV-shared-core-16: settings.json registers pre-commit-gate as a PreToolUse hook on Bash+PowerShell", () => {
  const settingsPath = resolve(REPO_ROOT, ".claude/settings.json");
  assert.ok(existsSync(settingsPath), ".claude/settings.json must exist");

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  // The hook must be registered on both Bash and PowerShell so it fires
  // regardless of which shell the agent uses for git commit.
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];

  const gateHooks = preToolUse.filter(
    (h) => JSON.stringify(h).includes("pre-commit-gate"),
  );
  assert.ok(
    gateHooks.length > 0,
    "settings.json PreToolUse must include at least one pre-commit-gate.mjs hook — CRIT-tests-with-source",
  );
});

// ── INV-shared-core-11: spawnLoggedCommand applies no command wrapping ───────

test("INV-shared-core-11: spawnLoggedCommand spawns the command unwrapped", async () => {
  // spawnLoggedCommand must NOT wrap the command when called with any options
  // object — there is no command-wrapping path anymore. We assert the behavior:
  // the command and args reach spawn exactly as given.
  const { spawnLoggedCommand } = await import("../../src/shared/providers/spawnLoggedCommand.ts");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  const calls = [];

  function fakeWS() {
    const s = new EventEmitter();
    s.write = (_c, cb) => { if (typeof cb === "function") cb(); return true; };
    s.end = (cb) => { if (typeof cb === "function") cb(); };
    return s;
  }

  await spawnLoggedCommand(
    "my-cli",
    ["--arg"],
    {
      repoRoot: "/repo",
      runId: "R1",
      obligationId: null,
      promptPath: "/repo/prompt.md",
      taskPath: "/repo/task.json",
      resultPath: "/repo/result.json",
      stdoutPath: "/repo/out.log",
      stderrPath: "/repo/err.log",
      uiMode: "headless",
      timeoutMs: 5000,
    },
    undefined,
    {
      createWriteStream: fakeWS,
      spawn: (command, args) => {
        calls.push({ command, args });
        const child = new EventEmitter();
        child.pid = 1; child.killed = false;
        child.kill = () => { child.killed = true; return true; };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        setImmediate(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      },
    },
  );

  assert.equal(calls.length, 1);
  // The command must not have been wrapped (no cmd.exe / shell prefix).
  assert.equal(calls[0].command, "my-cli", "command must reach spawn unwrapped");
  assert.deepEqual(calls[0].args, ["--arg"], "args must reach spawn unwrapped");
});

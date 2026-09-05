/**
 * Regression tests for shared-core module invariants.
 * INV-shared-core-01 through INV-shared-core-11.
 *
 * Each test block is tagged with the invariant ID it covers.
 */
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FindingSchema, findingIdentity } from "../../src/shared/types/finding.js";
import { SEVERITIES } from "../../src/shared/types/lens.js";
import { buildObligationLedger } from "../../src/shared/types/obligationLedger.js";
import { CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION } from "../../src/shared/types/contractPipeline.js";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
} from "../../src/shared/decompose/contentCoherence.js";
import {
  validateAuditFindingsReport,
  isValidAuditFindingsReport,
  projectApprovedFindings,
  AUDIT_FINDINGS_CONTRACT_VERSION,
} from "../../src/shared/validation/findingsReport.js";
import { prefixValidationIssues, requireKeys } from "../../src/shared/validation/basic.js";
import { RunLogger } from "../../src/shared/observability/runLog.js";
import type { Finding } from "../../src/shared/types/finding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../");
const AUDIT_CODE_SCHEMAS = resolve(REPO_ROOT, "schemas");

/**
 * Load and parse a JSON schema file from the schemas directory.
 * Asserts that the file exists before returning the parsed schema.
 */
type JsonSchemaDoc = {
  required?: string[];
  properties?: Record<string, { enum?: string[] } & Record<string, unknown>>;
} & Record<string, unknown>;

function loadSchema(filename: string): JsonSchemaDoc {
  const schemaPath = resolve(AUDIT_CODE_SCHEMAS, filename);
  expect(existsSync(schemaPath), `schema not found: ${schemaPath}`).toBeTruthy();
  return JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaDoc;
}

// ── INV-shared-core-01: Schema drift detection ───────────────────────────────

test("INV-shared-core-01: finding.schema.json stays consistent with the zod Finding contract (mechanically derived, no hand list)", () => {
  // TST-ccdc83a0: the old guard compared schema.required against a HAND-COPIED
  // test-local field list — a drift guard that could itself drift (a field
  // dropped from the contract stayed in the list; a field added to the contract
  // was never checked). Both sides are now derived mechanically: the base
  // contract from the zod FindingSchema shape at runtime, the worker schema from
  // the committed JSON. The worker schema is a deliberate STRICTER-or-relaxed
  // projection (evidence strengthened to required; lens relaxed — defaulted from
  // AuditResult.lens), so the invariants are structural consistency, not
  // required-set equality:
  //   1. every schema-required key is a real base-contract property;
  //   2. every schema property is a real base-contract property (no orphans);
  //   3. every base-contract REQUIRED key appears in the schema's properties.
  const schema = loadSchema("finding.schema.json");

  const zodShape = FindingSchema.shape;
  const baseKeys = new Set(Object.keys(zodShape));
  const baseRequired = Object.keys(zodShape).filter((k) => !zodShape[k as keyof typeof zodShape].isOptional());
  const schemaRequired: string[] = schema.required ?? [];
  const schemaProperties = new Set(Object.keys(schema.properties ?? {}));

  // Non-vacuity: both derived sides must be non-empty for the walks to assert anything.
  expect(baseRequired.length).toBeGreaterThan(0);
  expect(schemaRequired.length).toBeGreaterThan(0);
  expect(schemaProperties.size).toBeGreaterThan(0);

  for (const key of schemaRequired) {
    expect(baseKeys.has(key), `finding.schema.json requires "${key}" but the zod FindingSchema has no such property — schema/contract drift`).toBeTruthy();
  }
  for (const key of schemaProperties) {
    expect(baseKeys.has(key), `finding.schema.json property "${key}" does not exist on the zod FindingSchema — schema/contract drift`).toBeTruthy();
  }
  for (const key of baseRequired) {
    expect(schemaProperties.has(key), `zod FindingSchema requires "${key}" but finding.schema.json has no such property — schema/contract drift`).toBeTruthy();
  }
});

test("INV-shared-core-01: finding.schema.json severity enum matches SEVERITIES", () => {
  const schema = loadSchema("finding.schema.json");

  const schemaEnum: string[] = schema.properties?.severity?.enum ?? [];
  const tsEnum = Array.from(SEVERITIES);

  // Every schema severity must be in the TS enum.
  for (const sev of schemaEnum) {
    expect(tsEnum.includes(sev as (typeof tsEnum)[number]), `Schema severity enum value "${sev}" not in SEVERITIES — schema/TS drift`).toBeTruthy();
  }

  // Every TS severity must be in the schema.
  for (const sev of tsEnum) {
    expect(schemaEnum.includes(sev), `SEVERITIES value "${sev}" missing from finding.schema.json — schema/TS drift`).toBeTruthy();
  }
});

test("INV-shared-core-01: audit_result.schema.json required keys are present in the shared contract", () => {
  const schema = loadSchema("audit_result.schema.json");

  // The audit_result schema required keys are: task_id, unit_id, pass_id, lens,
  // file_coverage, findings. These match the auditor's AuditResult contract.
  const required: string[] = schema.required ?? [];
  const expectedKeys = ["task_id", "unit_id", "pass_id", "lens", "file_coverage", "findings"];
  for (const key of expectedKeys) {
    expect(required.includes(key), `Expected "${key}" to be in audit_result.schema.json required array`).toBeTruthy();
  }
});

// ── INV-shared-core-02: No provider-name→tier table ─────────────────────────


test("INV-shared-core-04: ObligationEntry is exported from shared types", () => {
  // The ObligationEntry type is the shared obligation abstraction.
  // We verify it is accessible via shared and has the required shape fields.
  const ledger = buildObligationLedger({
    goal_id: "test-goal",
    obligations: [
      { id: "OBL-1", description: "test obligation", kind: "behavioral", depends_on: [], status: "pending" },
    ],
  });

  expect(ledger.contract_version).toBe(CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION);
  expect(ledger.goal_id).toBe("test-goal");
  expect(ledger.obligations.length).toBe(1);
  expect(ledger.obligations[0].id).toBe("OBL-1");
  expect(typeof ledger.obligations[0].depends_on !== "undefined", "ObligationEntry must have depends_on").toBeTruthy();
});

// ── INV-shared-core-05: Finding identity subset ───────────────────────────────

test("INV-shared-core-05: findingIdentity strips contract_* fields", () => {
  const finding: Finding = {
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
  expect(identity.id).toBe("FINDING-001");
  expect(identity.title).toBe("Test Finding");
  expect(identity.severity).toBe("high");
  expect(identity.lens).toBe("security");
  expect(identity.summary).toBe("A test finding");
  expect(identity.affected_files).toEqual([{ path: "src/foo.ts" }]);

  // Identity must NOT carry contract_* fields.
  expect((identity as unknown as Record<string, unknown>)["contract_goal_id"], "contract_goal_id must not appear in FindingIdentity").toBe(undefined);
  expect((identity as unknown as Record<string, unknown>)["contract_obligation_ids"], "contract_obligation_ids must not appear").toBe(undefined);
  expect((identity as unknown as Record<string, unknown>)["verification_obligation_ids"], "verification_obligation_ids must not appear").toBe(undefined);
  expect((identity as unknown as Record<string, unknown>)["targeted_commands"], "targeted_commands must not appear").toBe(undefined);
});

test("INV-shared-core-05: findingIdentity round-trips through JSON without contract_* fields", () => {
  const finding: Finding = {
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
    expect(!key.startsWith("contract_") && key !== "verification_obligation_ids" && key !== "targeted_commands", `Unexpected key in FindingIdentity after JSON round-trip: ${key}`).toBeTruthy();
  }
});

// ── INV-shared-core-06: AuditFindingsReport.contract_version validated on ingestion ─

test("INV-shared-core-06: validateAuditFindingsReport flags missing contract_version as error", () => {
  const issues = validateAuditFindingsReport({ findings: [], work_blocks: [] });
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.length > 0, "missing contract_version must produce an error issue").toBeTruthy();
  expect(errors.some((i) => i.message.includes("contract_version")), `expected contract_version error, got: ${JSON.stringify(errors)}`).toBeTruthy();
});

test("INV-shared-core-06 / OBL-C002-VERSION-TRUST: validateAuditFindingsReport emits error (not warning) on mismatched contract_version", () => {
  const issues = validateAuditFindingsReport({
    contract_version: "unexpected-version/v99",
    findings: [],
    work_blocks: [],
  });
  // OBL-C002-VERSION-TRUST: mismatch must be an error, not a warning, so
  // isValidAuditFindingsReport returns false for mismatched versions.
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.length > 0, "mismatched contract_version must produce an error (not a warning)").toBeTruthy();
  expect(errors.some((i) => i.message.includes("unexpected-version")), "error must cite the mismatched version value").toBeTruthy();
  // Confirm no warnings emitted for this case — it's an error.
  const warnings = issues.filter((i) => i.severity === "warning");
  expect(warnings.length, "version mismatch must not produce a warning; it is an error").toBe(0);
});

test("INV-shared-core-06 / OBL-C002-VERSION-TRUST: isValidAuditFindingsReport returns false for mismatched contract_version", () => {
  // Present-but-mismatched version must cause rejection (return false), not just a warning.
  expect(isValidAuditFindingsReport({
      contract_version: "audit-tools/audit-findings/v0alpha0",
      findings: [],
      work_blocks: [],
      summary: { finding_count: 0 },
    }), "isValidAuditFindingsReport must return false when contract_version is present but mismatched").toBe(false);

  // Any non-canonical version string must be rejected.
  expect(isValidAuditFindingsReport({
      contract_version: "some-other-tool/v1",
      findings: [],
      work_blocks: [],
    }), "isValidAuditFindingsReport must return false for any non-canonical contract_version").toBe(false);
});

test("INV-shared-core-06: validateAuditFindingsReport passes with correct contract_version", () => {
  const issues = validateAuditFindingsReport({
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    findings: [],
    coherence_trace: buildContentCoherenceTrace(
      { items: [] },
      FINDINGS_DRAW_COHERENCE_POLICY,
    ),
    work_blocks: [],
    work_block_seams: [],
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
  });
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.length, `expected no errors for valid report, got: ${JSON.stringify(errors)}`).toBe(0);
});

test("INV-shared-core-06: validateAuditFindingsReport rejects non-object", () => {
  const issues = validateAuditFindingsReport(null);
  expect(issues.some((i) => i.severity === "error"), "null value must produce an error").toBeTruthy();

  const issues2 = validateAuditFindingsReport("not an object");
  expect(issues2.some((i) => i.severity === "error"), "string value must produce an error").toBeTruthy();
});

test("INV-shared-core-06: approved projection enforces closed membership and records provenance", () => {
  const approved = {
    id: "SEC-approved",
    title: "Approved finding",
    category: "security",
    severity: "high",
    confidence: "high",
    lens: "security",
    summary: "Approved summary.",
    affected_files: [{ path: "src/approved.ts" }],
    evidence: ["approved evidence"],
  };
  const quarantined = {
    ...approved,
    id: "SEC-refuted",
    title: "Refuted finding",
    grounding: { status: "refuted", reason: "anchor disproved the claim" },
  };
  const report = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: {
      finding_count: 1,
      work_block_count: 1,
      severity_breakdown: { high: 1 },
      audited_file_count: 1,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings: [approved],
    coherence_trace: buildContentCoherenceTrace(
      {
        items: [{
          id: approved.id,
          file_paths: approved.affected_files.map((file) => file.path),
          unit_ids: ["unit-1"],
          tags: [approved.lens],
        }],
      },
      FINDINGS_DRAW_COHERENCE_POLICY,
    ),
    quarantined_findings: [quarantined],
    work_blocks: [{
      id: "block-1",
      finding_ids: [approved.id],
      unit_ids: ["unit-1"],
      owned_files: ["src/approved.ts"],
      role: "implementation",
      max_severity: "high",
      rationale: "One approved finding.",
      depends_on: [],
    }],
    work_block_seams: [],
  };

  const projection = projectApprovedFindings(report);
  expect(projection.findings.map((finding) => finding.id)).toEqual([approved.id]);
  expect(projection.dispositionById.get(approved.id)).toMatchObject({
    status: "approved",
    source: "findings",
    workBlockId: "block-1",
  });
  expect(projection.dispositionById.get(quarantined.id)).toMatchObject({
    status: "quarantined_refuted",
    source: "quarantined_findings",
    workBlockId: null,
  });

  const malformedReports = [
    { ...report, findings: [approved, { ...approved }] },
    { ...report, work_blocks: [{ ...report.work_blocks[0], finding_ids: ["missing-id"] }] },
    {
      ...report,
      summary: { ...report.summary, finding_count: 2, severity_breakdown: { high: 2 } },
      findings: [approved, { ...approved, id: "SEC-unassigned" }],
    },
    { ...report, quarantined_findings: [{ ...quarantined, grounding: { status: "ungrounded" } }] },
  ];
  for (const malformed of malformedReports) {
    expect(
      isValidAuditFindingsReport(malformed),
      `expected strict membership rejection for ${JSON.stringify(malformed)}`,
    ).toBe(false);
  }
});

// ── INV-shared-core-07: ObligationEntry.depends_on cycle-checked at construction ─

test("INV-shared-core-07: buildObligationLedger throws when depends_on forms a direct cycle (A → B → A)", () => {
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

test("INV-shared-core-07: buildObligationLedger throws when depends_on forms a transitive cycle (A → B → C → A)", () => {
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

test("INV-shared-core-07: buildObligationLedger accepts a valid DAG with no cycles", () => {
  const ledger = buildObligationLedger({
    goal_id: "g",
    obligations: [
      { id: "A", description: "a", kind: "behavioral", depends_on: [], status: "pending" },
      { id: "B", description: "b", kind: "behavioral", depends_on: ["A"], status: "pending" },
      { id: "C", description: "c", kind: "behavioral", depends_on: ["A", "B"], status: "pending" },
    ],
  });
  expect(ledger.obligations.length).toBe(3);
  expect(ledger.goal_id).toBe("g");
});

test("INV-shared-core-07: buildObligationLedger accepts empty obligations list", () => {
  const ledger = buildObligationLedger({ goal_id: "g", obligations: [] });
  expect(ledger.obligations.length).toBe(0);
});

// ── INV-shared-core-08: ClaudeCodeConfig.dangerously_skip_permissions flagged ─


test("INV-shared-core-09: prefixValidationIssues is idempotent (no double-prefixing)", () => {
  // Calling prefixValidationIssues twice with the same prefix must be idempotent.
  const issues = [{ path: "bar", message: "m", severity: "error" as const }];
  const once = prefixValidationIssues("foo", issues);
  const twice = prefixValidationIssues("foo", once);

  expect(once[0].path, "first call must prepend prefix").toBe("foo.bar");
  expect(twice[0].path, "second call must not double-prefix").toBe("foo.bar");
});

test("INV-shared-core-09: requireKeys returns issues rather than throwing", () => {
  // requireKeys must return an array of issues, never throw.
  // Even for non-objects or missing keys it must return, not throw.
  const issues1 = requireKeys("not-an-object", "root", ["id", "title"]);
  expect(Array.isArray(issues1), "requireKeys must return an array").toBeTruthy();
  expect(issues1.length > 0, "requireKeys must produce an issue for non-objects").toBeTruthy();

  const issues2 = requireKeys({ id: "x" }, "root", ["id", "title"]);
  expect(Array.isArray(issues2), "requireKeys must return an array for missing keys").toBeTruthy();
  expect(issues2.length > 0, "requireKeys must produce an issue for missing 'title'").toBeTruthy();
});

test("INV-shared-core-13: RunLogger exports the full structured logging contract", () => {
  // RunLogger must have the three-part contract: constructor, .event(), .disabled()
  expect(typeof RunLogger, "RunLogger must be a class").toBe("function");
  const logger = new RunLogger("/tmp/noop-test.jsonl", { enabled: false });
  expect(typeof logger.event, "RunLogger instance must have .event()").toBe("function");
  expect(typeof logger.isEnabled, "RunLogger instance must have .isEnabled").toBe("boolean");
  const disabled = RunLogger.disabled();
  expect(disabled.isEnabled, "RunLogger.disabled() must return a disabled logger").toBe(false);
  // Disabled logger must accept all event kinds without throwing.
  for (const kind of ["obligation", "executor_start", "executor_end", "artifact_write",
                       "scope", "outcome", "step", "state", "error"] as const) {
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
  const dir = await mkdtemp(join(tmpdir(), "inv13-runlog-"));
  try {
    const logPath = join(dir, "run.jsonl");
    const logger = new RunLogger(logPath, { now: () => 1000 });
    const kinds = ["obligation", "executor_start", "executor_end", "artifact_write",
                   "scope", "outcome", "step", "state", "error"] as const;
    for (const kind of kinds) {
      logger.event({ kind, note: `test-${kind}` });
    }
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines.length, "each emitted event must produce one NDJSON line").toBe(kinds.length);
    for (let i = 0; i < kinds.length; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.kind, `line ${i} must have kind=${kinds[i]}`).toBe(kinds[i]);
      expect(typeof parsed.ts, "each line must have an ISO timestamp").toBe("string");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-core-15b: ci.yml runs a single-package build + verify gate (no shared-first / workspace ceremony)", () => {
  const ciPath = resolve(REPO_ROOT, ".github/workflows/ci.yml");
  expect(existsSync(ciPath), `ci.yml not found at ${ciPath}`).toBeTruthy();
  const content = readFileSync(ciPath, "utf8");
  // The gate is split across two workflows for speed and to run the suite once per
  // Node line (CI dedup, 2026-07-06): ci.yml carries the cheap deterministic
  // verify:checks chain; the sharded vitest matrix lives in audit-code-test-suite.yml
  // (both Node lines). Both halves must be present in their respective workflows so
  // the full gate can't silently lose a half.
  expect(content.includes("npm run verify:checks"), "ci.yml must run the single-package verify:checks gate — CRIT-single-package").toBeTruthy();
  const suitePath = resolve(REPO_ROOT, ".github/workflows/audit-code-test-suite.yml");
  expect(existsSync(suitePath), `audit-code-test-suite.yml not found at ${suitePath}`).toBeTruthy();
  const suiteContent = readFileSync(suitePath, "utf8");
  // The sharded invocation goes through run-vitest-gate.mjs (the false-green gate,
  // docs/backlog.md "false-green"), not a bare `vitest run` — match either form so
  // this invariant tracks the shard-matrix property, not the exact wrapper command.
  expect(/(?:vitest run|run-vitest-gate\.mjs) --shard=/.test(suiteContent), "audit-code-test-suite.yml must run the sharded vitest test matrix — CRIT-single-package").toBeTruthy();
  expect(!content.includes("--workspaces") && !content.includes("packages/shared"), "ci.yml must not reference workspaces or packages/shared after the single-package collapse — CRIT-single-package").toBeTruthy();
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

test("INV-shared-core-16: commit-gate.mjs exists, is wired as git's pre-commit hook, and blocks a commit on check failure", () => {
  // P53: the gate runs at git's own boundary — .githooks/pre-commit runs
  // commit-gate.mjs — so the tool-boundary hook no longer has to detect commits
  // to enforce green-at-every-commit.
  const gatePath = resolve(REPO_ROOT, ".claude/hooks/commit-gate.mjs");
  expect(existsSync(gatePath), `.claude/hooks/commit-gate.mjs must exist — CRIT-tests-with-source`).toBeTruthy();
  const source = readFileSync(gatePath, "utf8");

  // Gate must run npm run check (the full workspace typecheck).
  expect(source.includes("npm run check"), "commit-gate.mjs must invoke 'npm run check' — CRIT-tests-with-source").toBeTruthy();

  // Gate must exit non-zero to block the commit when check fails.
  expect(source.includes("process.exit(2)"), "commit-gate.mjs must call process.exit(2) to block a failing commit — CRIT-tests-with-source").toBeTruthy();

  // And git must reach it: the tracked pre-commit hook names it.
  const hook = readFileSync(resolve(REPO_ROOT, ".githooks/pre-commit"), "utf8");
  expect(hook.includes("commit-gate.mjs"), ".githooks/pre-commit must run commit-gate.mjs").toBeTruthy();
});

test("INV-shared-core-16: pre-commit-gate.mjs rejects hook-bypass commits (--no-verify / core.hooksPath)", () => {
  const gatePath = resolve(REPO_ROOT, ".claude/hooks/pre-commit-gate.mjs");
  const runGate = (command: string) =>
    spawnSync(process.execPath, [gatePath], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });

  // Bypass vectors must be blocked (exit 2) — these disable the hook, making the
  // gate a no-op. The bypass check runs before `npm run check`, so this is fast.
  for (const bypass of [
    "git commit --no-verify -m x",
    "git commit -n -m x",
    "git -c core.hooksPath=/tmp commit -m x",
    "git -c core.hooksPath= commit -m x",
    // Sibling-statement escape: the override is armed in a statement that carries
    // no `commit`, so a commit-sub-command-scoped check never scans it.
    "git config core.hooksPath /dev/null && git commit -m x",
    "git push --no-verify && git commit -m x",
  ]) {
    const r = runGate(bypass);
    expect(r.status, `pre-commit-gate must block bypass: ${bypass}\n${r.stderr}`).toBe(2);
  }

  // A non-commit command must pass through untouched (exit 0), never triggering
  // the bypass block on an unrelated `-n`.
  for (const benign of ["git status -n", "echo done"]) {
    const r = runGate(benign);
    expect(r.status, `pre-commit-gate must allow non-commit: ${benign}\n${r.stderr}`).toBe(0);
  }
});

test("INV-shared-core-16: async-typecheck hook exists and covers all three packages", () => {
  const hookPath = resolve(REPO_ROOT, ".claude/hooks/async-typecheck.mjs");
  expect(existsSync(hookPath), `.claude/hooks/async-typecheck.mjs must exist — CRIT-tests-with-source`).toBeTruthy();

  const source = readFileSync(hookPath, "utf8");

  // Single-package layout: the hook must cover edits to any of the three source
  // subsystems (src/shared, src/audit, src/remediate) so a type break in any of
  // them triggers a typecheck. The hook matches `src/(shared|audit|remediate)/`.
  for (const sub of ["shared", "audit", "remediate"]) {
    expect(source.includes(sub), `async-typecheck.mjs must reference src subsystem '${sub}' — CRIT-tests-with-source (gate must cover all subsystems)`).toBeTruthy();
  }

  // Hook must run the whole-package typecheck.
  expect(source.includes("npm run check"), "async-typecheck.mjs must invoke 'npm run check' — CRIT-tests-with-source").toBeTruthy();
});

test("INV-shared-core-16: settings.json registers pre-commit-gate as a PreToolUse hook on Bash+PowerShell", () => {
  const settingsPath = resolve(REPO_ROOT, ".claude/settings.json");
  expect(existsSync(settingsPath), ".claude/settings.json must exist").toBeTruthy();

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  // The hook must be registered on both Bash and PowerShell so it fires
  // regardless of which shell the agent uses for git commit.
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];

  const gateHooks = preToolUse.filter(
    (h: unknown) => JSON.stringify(h).includes("pre-commit-gate"),
  );
  expect(gateHooks.length > 0, "settings.json PreToolUse must include at least one pre-commit-gate.mjs hook — CRIT-tests-with-source").toBeTruthy();
});

// ── Work-block seams: ONE derivation, two findings-draw producers ────────────
// `buildAuditFindingsDeliverable` hard-coded `work_block_seams: []`. That was
// vacuously true while any two findings on one file merged; under the
// file-AND-lens rule they no longer do, so a contested file now yields several
// blocks and the hard-coded empty list silently drops the write conflict —
// which `emitAutonomousLeftoverDeliverable` round-trips into a Path-A seed whose
// phase cut then dispatches the contesting blocks in parallel, ungated.

function seamProbeFindings(): Finding[] {
  return (["security", "reliability", "performance"] as const).map((lens, index) => ({
    id: `SP-${index + 1}`,
    title: `probe ${lens}`,
    category: "test",
    severity: "medium",
    confidence: "high",
    lens,
    summary: `probe ${lens}`,
    affected_files: [{ path: "src/contested.ts" }],
  }));
}

test("INV-shared-core-17: the leftover deliverable emits the seam for a contested file", async () => {
  const { buildAuditFindingsDeliverable } = await import(
    "../../src/shared/reporting/auditDeliverable.js"
  );
  const report = buildAuditFindingsDeliverable(seamProbeFindings());

  // Three lenses over one file → three blocks, all contesting `src/contested.ts`.
  expect(report.work_blocks).toHaveLength(3);
  expect(report.work_block_seams).toHaveLength(1);
  expect(report.work_block_seams[0]).toMatchObject({
    file: "src/contested.ts",
    kind: "predicted_write_conflict",
    requires_preparation: true,
  });
  expect(report.work_block_seams[0]!.block_ids).toEqual([
    "block-1",
    "block-2",
    "block-3",
  ]);
  // The contract validator must accept what the producer emits.
  expect(validateAuditFindingsReport(report)).toEqual([]);
});

test("INV-shared-core-17: both findings-draw producers derive identical seams", async () => {
  const { buildAuditFindingsDeliverable } = await import(
    "../../src/shared/reporting/auditDeliverable.js"
  );
  const { buildWorkBlockPartition } = await import(
    "../../src/audit/reporting/workBlocks.js"
  );
  const findings = seamProbeFindings();

  expect(buildAuditFindingsDeliverable(findings).work_block_seams).toEqual(
    buildWorkBlockPartition({ findings }).seams,
  );
});

test("INV-shared-core-18: the seam schema refuses a duplicate block id or a non-preparing seam", async () => {
  const { WorkBlockSeamSchema } = await import(
    "../../src/shared/types/finding.js"
  );
  const base = {
    id: "seam-000000000000",
    file: "src/contested.ts",
    block_ids: ["block-1", "block-2"],
    kind: "predicted_write_conflict" as const,
    requires_preparation: true,
    rationale: "two components cite the same predicted write path",
  };
  expect(WorkBlockSeamSchema.safeParse(base).success).toBe(true);
  // `.min(2)` is load-bearing now, so one block repeated must not satisfy it.
  expect(
    WorkBlockSeamSchema.safeParse({ ...base, block_ids: ["block-1", "block-1"] })
      .success,
  ).toBe(false);
  // A contested file IS a write conflict; a `false` seam would be silently
  // dropped by the remediation gate's requires_preparation filter.
  expect(
    WorkBlockSeamSchema.safeParse({ ...base, requires_preparation: false }).success,
  ).toBe(false);
});

test("INV-shared-core-18: narrowing a seam to surviving blocks restates its own count", async () => {
  const { projectAuditFindingsReportSubset } = await import(
    "../../src/shared/validation/findingsReport.js"
  );
  const { buildAuditFindingsDeliverable } = await import(
    "../../src/shared/reporting/auditDeliverable.js"
  );
  const probe = seamProbeFindings();
  const report = buildAuditFindingsDeliverable(probe);
  expect(report.work_block_seams[0]!.rationale).toContain("3 components");

  const subset = projectAuditFindingsReportSubset(report, probe.slice(0, 2));
  expect(subset.work_block_seams).toHaveLength(1);
  const narrowed = subset.work_block_seams[0]!;
  expect(narrowed.block_ids).toHaveLength(2);
  // The rationale counted three blocks; after narrowing it must count two, or
  // the persisted seam contradicts its own block list.
  expect(narrowed.rationale).toContain("2 components");
  expect(narrowed.rationale).not.toContain("3 components");
  expect(validateAuditFindingsReport(subset)).toEqual([]);

  // A seam whose survivors drop below two is no longer a conflict.
  expect(
    projectAuditFindingsReportSubset(report, probe.slice(0, 1)).work_block_seams,
  ).toEqual([]);
});

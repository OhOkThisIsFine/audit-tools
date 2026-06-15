// OBL-018 — full-run round-trip: `remediation-outcomes.json` must be retryable
// on its own. The `retryable remediation-outcomes contract` describe in
// next-step.test.ts asserts individual contract fields directly; this file
// complements it by completing a run whose findings end in every terminal
// disposition class (fixed / failed / ignored / checkpoint-dropped / deduped),
// deleting state.json (and every other state artifact), and reconstructing the
// full Finding[] — with ItemSpec and RemediationBlock context — from the
// outcomes file alone, asserting deep equivalence with the original run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideNextStep } from "../src/steps/nextStep.js";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import type {
  Finding,
  ItemSpec,
  ItemSpecSummary,
  OutcomeCoverageEntry,
  RemediationOutcomeItem,
} from "../src/state/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-outcomes-roundtrip");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");
const OUTCOMES_PATH = join(REPO_DIR, ".audit-tools", "remediation-outcomes.json");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Originals — the fabricated run's source of truth, used twice: once to drive
// the run, and once (independently) as the expectation the reconstruction from
// remediation-outcomes.json must match.
// ---------------------------------------------------------------------------

function makeFinding(id: string, title: string, lens: string, path: string): Finding {
  return {
    id,
    title,
    category: lens,
    severity: "high",
    confidence: "high",
    lens,
    summary: `Fix ${title.toLowerCase()}.`,
    affected_files: [{ path }],
    evidence: [`${path}:1 evidence`],
  };
}

function makeItemSpec(findingId: string, file: string): ItemSpec {
  return {
    finding_id: findingId,
    concrete_change: `fix ${file}`,
    no_change: false,
    touched_files: [file],
    tests_to_write: [{ name: `${findingId} regression`, assertions: ["holds"] }],
    not_applicable_steps: [],
  };
}

// Planned findings — one per planned terminal class.
const F_FIX = makeFinding("F-FIX", "Fixed finding", "correctness", "src/a.ts");
const F_FAIL = makeFinding("F-FAIL", "Failed finding", "security", "src/b.ts");
const F_IGN = makeFinding("F-IGN", "Ignored finding", "tests", "src/c.ts");
// Never-planned findings — dropped before the plan was written.
const F_DUP = makeFinding("F-DUP", "Fixed finding duplicate", "maintainability", "src/a.ts");
const F_CHK = makeFinding("F-CHK", "Checkpointed finding", "performance", "src/d.ts");

const SPEC_FIX = makeItemSpec("F-FIX", "src/a.ts");
const SPEC_FAIL = makeItemSpec("F-FAIL", "src/b.ts");

const CHECKPOINT_RATIONALE =
  "Finding excluded by the intent checkpoint (filter or excluded scope).";

/**
 * Fabricate the run via the existing harness approach (state-store setup with
 * injected specs/statuses — no real providers), exactly as a run that already
 * documented and implemented its items looks when it reaches `closing`.
 */
function makeCompletedRunClosingState(): RemediationState {
  return {
    status: "closing",
    plan: {
      plan_id: "PLAN-ROUNDTRIP",
      findings: [F_FIX, F_FAIL, F_IGN],
      blocks: [
        { block_id: "B-001", items: ["F-FIX"], parallel_safe: true },
        {
          block_id: "B-002",
          items: ["F-FAIL"],
          parallel_safe: false,
          dependencies: ["B-001"],
        },
        { block_id: "B-003", items: ["F-IGN"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-FIX": {
        finding_id: "F-FIX",
        status: "resolved",
        block_id: "B-001",
        item_spec: SPEC_FIX,
        // Volatile fields — must be excluded from the normalized comparison.
        started_at: "2026-06-09T10:00:00.000Z",
        completed_at: "2026-06-09T10:05:00.000Z",
      },
      "F-FAIL": {
        finding_id: "F-FAIL",
        status: "blocked",
        block_id: "B-002",
        item_spec: SPEC_FAIL,
        failure_reason: "Implementation failed: unit tests did not pass.",
        rework_count: 2,
      },
      "F-IGN": {
        finding_id: "F-IGN",
        status: "ignored",
        block_id: "B-003",
        failure_reason: "Ignored by user decision.",
      },
    },
    closing_plan: { action: "none" },
    plan_coverage: {
      contract_version: "remediate-code-coverage/v1alpha1",
      plan_id: "PLAN-ROUNDTRIP",
      source_finding_count: 5,
      planned_count: 3,
      folded_count: 1,
      dropped_count: 0,
      checkpoint_dropped_count: 1,
      phantom_dropped_count: 0,
      entries: [
        { finding_id: "F-FIX", title: F_FIX.title, disposition: "planned", block_id: "B-001" },
        { finding_id: "F-FAIL", title: F_FAIL.title, disposition: "planned", block_id: "B-002" },
        { finding_id: "F-IGN", title: F_IGN.title, disposition: "planned", block_id: "B-003" },
        {
          finding_id: "F-DUP",
          title: F_DUP.title,
          disposition: "folded_into",
          folded_into: "F-FIX",
        },
        {
          finding_id: "F-CHK",
          title: F_CHK.title,
          disposition: "dropped_by_checkpoint",
          rationale: CHECKPOINT_RATIONALE,
        },
      ],
    },
  } as RemediationState;
}

/**
 * The structured-audit intake source carried every finding the run started
 * from. Close re-reads it (via intake/source-manifest.json) to recover full
 * payloads for never-planned findings, so the round-trip run must provide it
 * the way a real run does.
 */
async function writeStructuredAuditSource(): Promise<string> {
  const sourcePath = join(REPO_DIR, "audit-findings.json");
  await writeFile(
    sourcePath,
    JSON.stringify({
      contract_version: "audit-tools/audit-findings/v1alpha1",
      findings: [F_FIX, F_FAIL, F_IGN, F_DUP, F_CHK],
      work_blocks: [],
    }),
    "utf8",
  );
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "structured_audit", path: sourcePath, label: "audit-findings" }],
    }),
    "utf8",
  );
  return sourcePath;
}

async function acknowledgeResume(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
    JSON.stringify({ choice: "resume" }),
    "utf8",
  );
}

async function writeIntentCheckpoint(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    }),
    "utf8",
  );
}

/**
 * Drive the fabricated run through the real close path (one bounded next-step
 * on the closing state), then delete every state artifact so the reconstruction
 * can only come from remediation-outcomes.json.
 */
async function completeRunAndDeleteState(): Promise<any> {
  await writeStructuredAuditSource();
  await new StateStore(ARTIFACTS_DIR).saveState(makeCompletedRunClosingState());
  await acknowledgeResume();
  await writeIntentCheckpoint();

  // Folded: closing state runs close and returns present_report in one call.
  const step = await decideNextStep({ root: REPO_DIR });
  expect(step.step_kind).toBe("present_report");
  expect(existsSync(OUTCOMES_PATH)).toBe(true);

  // Prove no hidden dependence on the state machine file: remove state.json and
  // state.lock (close already deletes the artifacts dir; force-remove regardless),
  // plus the preserved complete-state snapshot, which the reconstruction must
  // not need either.
  await rm(join(ARTIFACTS_DIR, "state.json"), { force: true });
  await rm(join(ARTIFACTS_DIR, "state.lock"), { force: true });
  await rm(join(REPO_DIR, ".audit-tools", "remediation-state.complete.json"), {
    force: true,
  });
  expect(existsSync(join(ARTIFACTS_DIR, "state.json"))).toBe(false);
  expect(existsSync(join(ARTIFACTS_DIR, "state.lock"))).toBe(false);

  return JSON.parse(await readFile(OUTCOMES_PATH, "utf8"));
}

// ---------------------------------------------------------------------------
// Reconstruction — rebuilds the run's Finding[] (with spec and block context)
// from the outcomes file alone. Every required field is asserted with a message
// naming it: a missing field here is exactly the regression OBL-018 exists to
// catch, so the failure must say which field the contract stopped persisting.
// ---------------------------------------------------------------------------

type TerminalDisposition =
  | "fixed"
  | "failed"
  | "ignored"
  | "skipped"
  | "checkpoint_dropped"
  | "deduped";

interface ReconstructedFinding {
  finding: Finding;
  disposition: TerminalDisposition;
  item_spec?: ItemSpecSummary;
  block?: { block_id: string; block_dependencies: string[] };
  /** Surviving canonical finding a deduped entry was merged into. */
  folded_into?: string;
  /** Drop rationale for checkpoint-dropped entries. */
  drop_rationale?: string;
}

const DISPOSITION_BY_DROP_REASON: Record<string, TerminalDisposition> = {
  cross_lens_dedup: "deduped",
  intent_checkpoint: "checkpoint_dropped",
};

function reconstructFindings(report: any): ReconstructedFinding[] {
  const byId = new Map<string, ReconstructedFinding>();

  for (const entry of (report.outcomes ?? []) as RemediationOutcomeItem[]) {
    const id = entry.finding_id;
    expect(byId.has(id), `finding ${id} appears more than once in outcomes`).toBe(false);
    expect(entry.finding, `outcomes entry ${id} is missing field 'finding' (full Finding payload)`).toBeDefined();
    expect(entry.final_status, `outcomes entry ${id} is missing field 'final_status'`).toBeDefined();
    expect(entry.block_id, `outcomes entry ${id} is missing field 'block_id'`).toBeDefined();
    expect(
      entry.block_dependencies,
      `outcomes entry ${id} is missing field 'block_dependencies'`,
    ).toBeDefined();
    byId.set(id, {
      finding: entry.finding,
      disposition: entry.final_status,
      ...(entry.item_spec ? { item_spec: entry.item_spec } : {}),
      block: {
        block_id: entry.block_id,
        block_dependencies: entry.block_dependencies,
      },
    });
  }

  const coverageEntries = (report.plan_coverage?.entries ?? []) as OutcomeCoverageEntry[];
  expect(
    coverageEntries.length,
    "outcomes file is missing the 'plan_coverage.entries' coverage-ledger section",
  ).toBeGreaterThan(0);
  for (const entry of coverageEntries) {
    if (!entry.drop_reason) continue; // planned entries are reconstructed from outcomes
    const id = entry.finding_id;
    expect(byId.has(id), `never-planned finding ${id} also appears in outcomes`).toBe(false);
    expect(
      entry.finding,
      `coverage entry ${id} (drop_reason '${entry.drop_reason}') is missing field 'finding' (full Finding payload)`,
    ).toBeDefined();
    const disposition = DISPOSITION_BY_DROP_REASON[entry.drop_reason];
    expect(
      disposition,
      `coverage entry ${id} has unexpected drop_reason '${entry.drop_reason}'`,
    ).toBeDefined();
    if (entry.drop_reason === "cross_lens_dedup") {
      expect(
        entry.folded_into,
        `deduped coverage entry ${id} is missing field 'folded_into' (surviving canonical finding)`,
      ).toBeDefined();
    }
    if (entry.drop_reason === "intent_checkpoint") {
      expect(
        entry.rationale,
        `checkpoint-dropped coverage entry ${id} is missing field 'rationale' (drop reason)`,
      ).toBeTruthy();
    }
    byId.set(id, {
      finding: entry.finding!,
      disposition: disposition!,
      ...(entry.folded_into ? { folded_into: entry.folded_into } : {}),
      ...(entry.rationale ? { drop_rationale: entry.rationale } : {}),
    });
  }

  // Normalize: sorted by finding id; volatile fields (started_at, completed_at,
  // duration_ms on the outcome entries) were never copied into the
  // reconstructed shape, so the comparison is deterministic.
  return [...byId.values()].sort((a, b) => a.finding.id.localeCompare(b.finding.id));
}

function summarizeSpec(spec: ItemSpec): ItemSpecSummary {
  return {
    concrete_change: spec.concrete_change,
    no_change: spec.no_change,
    touched_files: spec.touched_files,
    tests_to_write: spec.tests_to_write.map((test) => test.name),
  };
}

describe("remediation-outcomes round-trip (OBL-018)", () => {
  it("a completed run writes an outcomes entry for every terminal disposition class", async () => {
    const report = await completeRunAndDeleteState();

    const outcomeIds = report.outcomes.map((entry: any) => entry.finding_id).sort();
    expect(outcomeIds).toEqual(["F-FAIL", "F-FIX", "F-IGN"]);

    const coverageIds = report.plan_coverage.entries
      .map((entry: any) => entry.finding_id)
      .sort();
    expect(coverageIds).toEqual(["F-CHK", "F-DUP", "F-FAIL", "F-FIX", "F-IGN"]);

    // Every source finding id is recorded exactly once across the union of the
    // item outcomes and the never-planned coverage entries.
    const reconstructed = reconstructFindings(report);
    expect(reconstructed.map((entry) => entry.finding.id)).toEqual([
      "F-CHK",
      "F-DUP",
      "F-FAIL",
      "F-FIX",
      "F-IGN",
    ]);
  });

  it("Finding[] with spec and block context round-trips from remediation-outcomes.json alone", async () => {
    const report = await completeRunAndDeleteState();

    const reconstructed = reconstructFindings(report);

    // Expected normalized originals, derived only from the fabricated run's
    // inputs (never from the outcomes file), sorted by finding id.
    const expected: ReconstructedFinding[] = [
      // Checkpoint-dropped: full payload + the checkpoint drop reason.
      {
        finding: F_CHK,
        disposition: "checkpoint_dropped",
        drop_rationale: CHECKPOINT_RATIONALE,
      },
      // Deduped: full payload, traceable to the surviving canonical finding.
      { finding: F_DUP, disposition: "deduped", folded_into: "F-FIX" },
      // Failed (exhausted retries / blocked): spec + block context preserved.
      {
        finding: F_FAIL,
        disposition: "failed",
        item_spec: summarizeSpec(SPEC_FAIL),
        block: { block_id: "B-002", block_dependencies: ["B-001"] },
      },
      // Fixed: spec + block context preserved.
      {
        finding: F_FIX,
        disposition: "fixed",
        item_spec: summarizeSpec(SPEC_FIX),
        block: { block_id: "B-001", block_dependencies: [] },
      },
      // Ignored: never documented, so no spec — but block membership survives.
      {
        finding: F_IGN,
        disposition: "ignored",
        block: { block_id: "B-003", block_dependencies: [] },
      },
    ];

    expect(reconstructed).toEqual(expected);

    // Deduped entries are traceable to a surviving canonical finding that is
    // itself present in the reconstruction.
    const deduped = reconstructed.find((entry) => entry.disposition === "deduped");
    const survivorIds = new Set(reconstructed.map((entry) => entry.finding.id));
    expect(deduped?.folded_into).toBeDefined();
    expect(survivorIds.has(deduped!.folded_into!)).toBe(true);
  });
});

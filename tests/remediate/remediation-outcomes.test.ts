import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRemediationOutcomesReport,
  readRunRecoveryFacts,
  runClosePhase,
  type ClosingResult,
} from "../../src/remediate/phases/close.js";
import type { OrchestratorOptions } from "../../src/remediate/types/options.js";
import { makeState as makeBaseState } from "./test-helpers.js";
import {
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  submissionLedgerPath,
  NO_RECOVERY,
} from "audit-tools/shared";

function finding(id: string, lens: string, files: string[]) {
  return {
    id,
    title: `Finding ${id}`,
    category: "General",
    severity: "low" as const,
    confidence: "low" as const,
    lens,
    summary: "",
    affected_files: files.map((path) => ({ path })),
  };
}

function makeState() {
  return makeBaseState({
    status: "closing",
    plan: {
      plan_id: "PLAN-1",
      findings: [
        finding("F-1", "security", ["src/a.ts"]),
        finding("F-2", "security", ["src/b.ts", "src/c.tsx"]),
        finding("F-3", "performance", ["lib/d.py"]),
        finding("F-4", "tests", ["src/e.ts"]),
      ],
      blocks: [],
      project_type: "typescript-node",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-1": { finding_id: "F-1", status: "resolved", block_id: "B", rework_count: 2 },
      "F-2": { finding_id: "F-2", status: "resolved_no_change", block_id: "B" },
      "F-3": { finding_id: "F-3", status: "deemed_inappropriate", block_id: "B" },
      "F-4": { finding_id: "F-4", status: "blocked", block_id: "B" },
    },
  });
}

function closingResult(overrides: Partial<ClosingResult> = {}): ClosingResult {
  return {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "commit",
    status: "success",
    commands: [],
    ...overrides,
  };
}

describe("buildRemediationOutcomesReport", () => {
  it("captures one outcome per finding with lens, file_exts, and rework_count", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult(),
    );

    expect(report.total).toBe(4);
    expect(report.contract_version).toBe("remediate-code-outcomes/v1alpha1");

    const f1 = report.outcomes.find((o) => o.finding_id === "F-1")!;
    expect(f1.outcome).toBe("resolved");
    expect(f1.lens).toBe("security");
    expect(f1.file_exts).toEqual([".ts"]);
    expect(f1.rework_count).toBe(2);
    expect(f1.closing_status).toBe("success");

    const f2 = report.outcomes.find((o) => o.finding_id === "F-2")!;
    expect(f2.outcome).toBe("verified_no_change");
    expect(f2.file_exts).toEqual([".ts", ".tsx"]);
    expect(f2.rework_count).toBe(0);

    expect(report.outcomes.find((o) => o.finding_id === "F-3")!.outcome).toBe(
      "inappropriate",
    );
    expect(report.outcomes.find((o) => o.finding_id === "F-4")!.outcome).toBe(
      "blocked",
    );
  });

  it("aggregates by outcome and by lens", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult(),
    );

    expect(report.by_outcome.resolved).toBe(1);
    expect(report.by_outcome.verified_no_change).toBe(1);
    expect(report.by_outcome.inappropriate).toBe(1);
    expect(report.by_outcome.blocked).toBe(1);
    expect(report.by_outcome.ignored).toBe(0);

    expect(report.by_lens.security).toEqual({
      resolved: 1,
      verified_no_change: 1,
    });
    expect(report.by_lens.performance).toEqual({ inappropriate: 1 });
    expect(report.by_lens.tests).toEqual({ blocked: 1 });
  });

  it("sets closing_status_reason for skipped close", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult({ action: "none", status: "skipped" }),
    );

    expect(report.outcomes).toHaveLength(4);
    for (const outcome of report.outcomes) {
      expect(outcome.closing_status).toBe("skipped");
      expect(outcome.closing_status_reason).toBe(
        "closing action is 'none' — no commit/push/publish configured",
      );
    }
  });

  it("omits closing_status_reason for successful close", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult({ action: "commit", status: "success" }),
    );

    for (const outcome of report.outcomes) {
      expect(outcome.closing_status).toBe("success");
      expect(outcome.closing_status_reason).toBeUndefined();
      expect(outcome).not.toHaveProperty("closing_status_reason");
    }
  });

  it("sets closing_status_reason for failed close", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult({ action: "publish", status: "failed" }),
    );

    for (const outcome of report.outcomes) {
      expect(outcome.closing_status).toBe("failed");
      expect(outcome.closing_status_reason).toBe(
        "closing action 'publish' failed",
      );
    }
  });

  it("includes item timing and aggregate duration fields when timestamps exist", () => {
    const state = makeState();
    state.items!["F-1"].started_at = "2026-06-05T12:00:00.000Z";
    state.items!["F-1"].completed_at = "2026-06-05T12:00:05.000Z";
    state.items!["F-2"].started_at = "2026-06-05T12:00:02.000Z";
    state.items!["F-2"].completed_at = "2026-06-05T12:00:10.000Z";
    state.items!["F-3"].started_at = "2026-06-05T12:00:03.000Z";
    state.items!["F-3"].completed_at = "2026-06-05T12:00:04.000Z";
    state.items!["F-4"].started_at = "2026-06-05T12:00:01.000Z";
    state.items!["F-4"].completed_at = "2026-06-05T12:00:07.000Z";

    const report = buildRemediationOutcomesReport(
      state,
      closingResult(),
    );

    const f1 = report.outcomes.find((o) => o.finding_id === "F-1")!;
    expect(f1.started_at).toBe("2026-06-05T12:00:00.000Z");
    expect(f1.completed_at).toBe("2026-06-05T12:00:05.000Z");
    expect(f1.duration_ms).toBe(5000);

    for (const outcome of report.outcomes) {
      expect(outcome.started_at).toEqual(expect.any(String));
      expect(outcome.completed_at).toEqual(expect.any(String));
      expect(outcome.duration_ms).toEqual(expect.any(Number));
    }
    expect(report.started_at).toBe("2026-06-05T12:00:00.000Z");
    expect(report.completed_at).toBe("2026-06-05T12:00:10.000Z");
    expect(report.duration_ms).toBe(10000);
  });

  it("omits timing fields and aggregate timing when timestamps are absent", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult(),
    );

    expect(report.started_at).toBeUndefined();
    expect(report.completed_at).toBeUndefined();
    expect(report.duration_ms).toBeUndefined();
    for (const outcome of report.outcomes) {
      expect(outcome).not.toHaveProperty("started_at");
      expect(outcome).not.toHaveProperty("completed_at");
      expect(outcome).not.toHaveProperty("duration_ms");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The submission ledger's READER (E1) — a recovered run must be distinguishable
// from a clean one in the OUTCOMES CONTRACT, not only in raw NDJSON.
// ─────────────────────────────────────────────────────────────────────────────

/** One ledger event, as the producer writes it. */
function ledgerEvent(
  kind: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
    run_id: "PLAN-1",
    submission_id: "B-1",
    lane: "implement",
    kind,
    recorded_at: "2026-06-05T12:00:00.000Z",
    ...overrides,
  };
}

function writeLedger(artifactsDir: string, events: unknown[]): void {
  mkdirSync(join(artifactsDir, "submissions"), { recursive: true });
  writeFileSync(
    submissionLedgerPath(artifactsDir),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

describe("readRunRecoveryFacts — the remediate ledger's close-phase reader (E1)", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e1-recovery-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
    mkdirSync(artifactsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("NEGATIVE: a clean run's ledger yields no recovery marks — neither kind", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("expected"),
      ledgerEvent("accepted"),
      ledgerEvent("dispatched"),
      ledgerEvent("lane_outcome"),
    ]);

    const recovery = await readRunRecoveryFacts(artifactsDir, makeState());

    expect(recovery).toEqual(NO_RECOVERY);
    expect(recovery.recovered_by_hand).toEqual([]);
    expect(recovery.accepted_via_recovery).toEqual([]);
  });

  it("POSITIVE: an accepted_via_recovery mark is read back with its submission, lane and kind", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("accepted", { submission_id: "B-clean" }),
      ledgerEvent("accepted_via_recovery", {
        submission_id: "B-recovered",
        lane: "implement",
        issue_code: "orphaned_submission",
        recorded_at: "2026-06-05T13:00:00.000Z",
      }),
    ]);

    const recovery = await readRunRecoveryFacts(artifactsDir, makeState());

    expect(recovery.accepted_via_recovery).toEqual([
      {
        kind: "accepted_via_recovery",
        submission_id: "B-recovered",
        lane: "implement",
        issue_code: "orphaned_submission",
        recorded_at: "2026-06-05T13:00:00.000Z",
      },
    ]);
    // The two readmission kinds are NOT folded together: this submission was
    // admitted through a RELAXED check, not re-landed by hand.
    expect(recovery.recovered_by_hand).toEqual([]);
  });

  it("POSITIVE: recovered_by_hand is reported under its own kind, never merged with accepted_via_recovery", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("recovered_by_hand", { submission_id: "B-hand" }),
    ]);

    const recovery = await readRunRecoveryFacts(artifactsDir, makeState());

    expect(recovery.recovered_by_hand).toEqual([
      {
        kind: "recovered_by_hand",
        submission_id: "B-hand",
        lane: "implement",
        recorded_at: "2026-06-05T12:00:00.000Z",
      },
    ]);
    expect(recovery.accepted_via_recovery).toEqual([]);
  });

  it("NEGATIVE: another run's recovery mark does not mark THIS run", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("accepted_via_recovery", {
        submission_id: "B-other",
        run_id: "PLAN-OTHER",
      }),
    ]);

    const recovery = await readRunRecoveryFacts(artifactsDir, makeState());

    expect(recovery).toEqual(NO_RECOVERY);
  });

  it("NEGATIVE: an absent ledger reads as no recovery, never as a throw", async () => {
    const recovery = await readRunRecoveryFacts(
      join(root, "never-written"),
      makeState(),
    );

    expect(recovery).toEqual(NO_RECOVERY);
  });

  it("POSITIVE: unreadable ledger lines are COUNTED, so a reader cannot report a cleaner run than the file held", async () => {
    mkdirSync(join(artifactsDir, "submissions"), { recursive: true });
    writeFileSync(
      submissionLedgerPath(artifactsDir),
      [
        JSON.stringify(ledgerEvent("accepted_via_recovery")),
        "{ this line is torn",
        JSON.stringify({ ...ledgerEvent("accepted"), contract_version: "other/v9" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const recovery = await readRunRecoveryFacts(artifactsDir, makeState());

    expect(recovery.accepted_via_recovery).toHaveLength(1);
    expect(recovery.dropped_lines).toBe(2);
  });
});

describe("buildRemediationOutcomesReport — recovery is a first-class contract field (E1)", () => {
  it("NEGATIVE: a clean run carries an explicit empty recovery, never an omitted key", () => {
    const report = buildRemediationOutcomesReport(makeState(), closingResult());

    expect(report).toHaveProperty("recovery");
    expect(report.recovery).toEqual(NO_RECOVERY);
  });

  it("POSITIVE: a recovered run carries the mark in the outcomes contract", () => {
    const report = buildRemediationOutcomesReport(
      makeState(),
      closingResult(),
      undefined,
      {
        recovered_by_hand: [],
        accepted_via_recovery: [
          {
            kind: "accepted_via_recovery",
            submission_id: "B-recovered",
            lane: "implement",
            issue_code: "orphaned_submission",
            recorded_at: "2026-06-05T13:00:00.000Z",
          },
        ],
        dropped_lines: 0,
      },
    );

    expect(report.recovery.accepted_via_recovery).toHaveLength(1);
    expect(report.recovery.accepted_via_recovery[0]!.submission_id).toBe(
      "B-recovered",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E1, end to end: the RENDERED surfaces of a real close. The builders above
// prove the threading; these prove the property the entry actually states —
// "a recovered run is distinguishable from a clean one in a rendered surface".
// ─────────────────────────────────────────────────────────────────────────────

describe("runClosePhase — a recovered run renders differently from a clean one (E1)", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e1-close-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
    mkdirSync(artifactsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A closing-phase state whose close runs to completion with no test command. */
  function closingState() {
    return makeBaseState({
      status: "closing",
      plan: {
        plan_id: "PLAN-1",
        findings: [
          {
            id: "F-1",
            title: "Finding F-1",
            category: "General",
            severity: "low" as const,
            confidence: "low" as const,
            lens: "security",
            summary: "",
            affected_files: [{ path: "src/a.ts" }],
          },
        ],
        blocks: [],
        project_type: "typescript-node",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-1": {
          finding_id: "F-1",
          status: "resolved",
          block_id: "B",
          rework_count: 0,
        },
      },
      closing_plan: { action: "none", pre_authorized: true },
    });
  }

  /** The four artifacts a completed close writes beside the artifacts dir. */
  async function readRenderedSurfaces(): Promise<{
    report: string;
    outcomes: { recovery: unknown };
  }> {
    const outputDir = join(root, ".audit-tools");
    return {
      report: await readFile(join(outputDir, "remediation-report.md"), "utf8"),
      outcomes: JSON.parse(
        await readFile(join(outputDir, "remediation-outcomes.json"), "utf8"),
      ) as { recovery: unknown },
    };
  }

  it("NEGATIVE: a clean run's report and outcomes carry an explicit empty recovery", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("expected"),
      ledgerEvent("accepted"),
    ]);

    await runClosePhase(
      closingState(),
      { root, artifactsDir } as OrchestratorOptions,
    );

    const { report, outcomes } = await readRenderedSurfaces();
    expect(outcomes).toEqual(
      expect.objectContaining({ recovery: NO_RECOVERY }),
    );
    expect(report).toContain("## Recovery");
    expect(report).toContain(
      "None — no submission was readmitted; every accepted submission passed the normal lane's checks.",
    );
    expect(report).not.toContain("READMITTED");
  });

  it("POSITIVE: a recovered run's report and outcomes both carry the mark", async () => {
    writeLedger(artifactsDir, [
      ledgerEvent("accepted", { submission_id: "B-clean" }),
      ledgerEvent("accepted_via_recovery", {
        submission_id: "B-recovered",
        lane: "implement",
        issue_code: "orphaned_submission",
        recorded_at: "2026-06-05T13:00:00.000Z",
      }),
    ]);

    await runClosePhase(
      closingState(),
      { root, artifactsDir } as OrchestratorOptions,
    );

    const { report, outcomes } = await readRenderedSurfaces();
    expect(outcomes).toEqual(
      expect.objectContaining({
        recovery: expect.objectContaining({
          accepted_via_recovery: [expect.objectContaining({ submission_id: "B-recovered" })],
        }),
      }),
    );
    expect(report).toContain("## Recovery");
    expect(report).toContain("`B-recovered` (lane `implement`)");
    expect(report).toContain(
      "Accepted via recovery (a corroboration check was relaxed)",
    );
  });
});

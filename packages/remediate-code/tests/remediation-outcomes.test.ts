import { describe, it, expect } from "vitest";
import {
  buildRemediationOutcomesReport,
  type ClosingResult,
} from "../src/phases/close.js";
import { makeState as makeBaseState } from "./test-helpers.js";

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

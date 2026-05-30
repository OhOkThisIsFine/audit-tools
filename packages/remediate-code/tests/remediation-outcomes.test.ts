import { describe, it, expect } from "vitest";
import { buildRemediationOutcomesReport } from "../src/phases/close.js";
import type { RemediationState } from "../src/state/store.js";

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

function makeState(): RemediationState {
  return {
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
  } as unknown as RemediationState;
}

describe("buildRemediationOutcomesReport", () => {
  it("captures one outcome per finding with lens, file_exts, and rework_count", () => {
    const report = buildRemediationOutcomesReport(makeState(), "success");

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
    const report = buildRemediationOutcomesReport(makeState(), "success");

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
});

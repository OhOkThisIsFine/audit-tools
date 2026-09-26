/**
 * Packet 10 — Make fan-out requirements and demand reliable.
 *
 * Two properties, both failures the host hits when it MATCHES work to a worker
 * from a ranking the tool under-states:
 *
 *   1. REVIEW MODE. A lane's value can DEPEND on the reviewer not being the
 *      author of the work under review. That fact is NOT expressible in a
 *      size/complexity/risk ranking — a one-file adversarial check is still
 *      `small`, but it must never become a self-review. The closed
 *      `LaneReviewMode` vocabulary (`ordinary` / `independence_required` /
 *      `degraded_permitted`) states it, and the execution-line renderer +
 *      the bound step metadata record it. ACCEPTANCE: an `independence_required`
 *      lane whose independent context is unavailable PAUSES — it never renders
 *      a "run it yourself" fallback.
 *
 *   2. MEANINGFUL DEMAND. A lane whose prompt is a SHORT POINTER at a materialized
 *      packet (the charter evidence packet, the fidelity packet, the findings
 *      report a synthesis lane names) is LARGE work, but deriving demand from the
 *      pointer bytes alone ranks it `small`. ACCEPTANCE: granted packet content
 *      and file counts fold into the ranking, so a short pointer at a large
 *      packet is not classified `small` by default; and semantic review passes
 *      (charter/conceptual/contract/second-order) floor complexity at `standard`
 *      and risk at `high`.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveLaneDemand,
  LaneReviewModeSchema,
  SHARED_SEMANTIC_DEMAND_FLOORS,
  renderFanoutExecutionLines,
} from "../../src/shared/index.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { AUDIT_GATE_SUBMISSION_SCOPE } from "../../src/audit/cli/laneSubmissions.js";

const roots: string[] = [];
async function freshArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fanout-review-mode-"));
  roots.push(dir);
  return dir;
}

describe("review-mode classification is closed and provider-neutral", () => {
  it("admits exactly the three modes and rejects a provider-shaped field", () => {
    for (const mode of ["ordinary", "independence_required", "degraded_permitted"]) {
      expect(LaneReviewModeSchema.safeParse(mode).success, mode).toBe(true);
    }
    expect(LaneReviewModeSchema.safeParse("self_review").success).toBe(false);
    expect(LaneReviewModeSchema.safeParse("subagent").success).toBe(false);
  });
});

describe("required independent review never degrades to self-review", () => {
  const lanes = [
    { label: "Adversary", promptPath: "/run/adversary.md" },
  ];

  it("independence_required renders a pause, not a do-it-yourself fallback", () => {
    const text = renderFanoutExecutionLines({
      lanes,
      reviewMode: "independence_required",
    }).join("\n");
    // The lane's value IS independence: the text must stop when no independent
    // context exists, and must never name a self-execution fallback.
    expect(text).toContain("stop and report that this review could not be performed independently");
    expect(text).not.toContain("sequentially yourself");
    expect(text).not.toContain("self-review");
  });

  it("ordinary lanes keep the inline-sequential path", () => {
    const text = renderFanoutExecutionLines({ lanes }).join("\n");
    expect(text).toContain("sequentially yourself");
  });

  it("degraded_permitted records its degradation in the output", () => {
    const text = renderFanoutExecutionLines({
      lanes,
      reviewMode: "degraded_permitted",
    }).join("\n");
    expect(text).toContain("degraded");
    expect(text).toContain("self-conducted");
  });
});

describe("granted packet content and semantic floors keep demand meaningful", () => {
  it("a short pointer at a large packet is not classified small", async () => {
    const dir = await freshArtifactsDir();
    // A tiny pointer prompt naming a huge materialized packet.
    const fanout = await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: "pointer",
          label: "Pointer at a large packet",
          promptFilename: "pointer-prompt.md",
          promptText: "# Read the packet at /run/packet.md\n",
          grantedContentBytes: 200_000,
        },
      ],
    });
    expect(fanout.lanes[0]!.demand.size).toBe("large");
    expect(fanout.lanes[0]!.demand.complexity).toBe("deep");
  });

  it("a semantic review lane floors complexity and risk even with a short pointer", async () => {
    const dir = await freshArtifactsDir();
    const fanout = await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: "semantic",
          label: "Whole-repo cross-cutting review",
          promptFilename: "semantic-prompt.md",
          promptText: "# Review the whole repo\n",
          complexityFloor: SHARED_SEMANTIC_DEMAND_FLOORS.complexity,
          riskFloor: SHARED_SEMANTIC_DEMAND_FLOORS.risk,
        },
      ],
    });
    // A short pointer with the semantic floors applied must not rank `focused`
    // complexity or `low` risk.
    expect(fanout.lanes[0]!.demand.complexity).not.toBe("focused");
    expect(fanout.lanes[0]!.demand.risk).toBe("high");
  });

  it("the deriver honors the floors directly", () => {
    const floored = deriveLaneDemand({
      tokenEstimate: 100,
      fileCount: 0,
      riskScore: 0,
      complexityFloor: "standard",
      riskFloor: "high",
    });
    expect(floored.complexity).toBe("standard");
    expect(floored.risk).toBe("high");
    // And does not lift an already-deep ranking down.
    const deep = deriveLaneDemand({
      tokenEstimate: 50_000,
      fileCount: 0,
      riskScore: 1,
      complexityFloor: "standard",
      riskFloor: "high",
    });
    expect(deep.complexity).toBe("deep");
    expect(deep.risk).toBe("high");
  });
});

describe("the bound transport records the declared review mode, never a claim of proof", () => {
  it("materializeFanoutLanes surfaces laneReviews with mode and reason", async () => {
    const dir = await freshArtifactsDir();
    const fanout = await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: "adv",
          label: "Adversarial review",
          promptFilename: "adv-prompt.md",
          promptText: "# Review\n",
          reviewMode: "independence_required",
          reviewReason: "attacks the host's own authored artifacts",
        },
        {
          id: "plain",
          label: "Ordinary enrichment",
          promptFilename: "plain-prompt.md",
          promptText: "# Enrich\n",
        },
      ],
    });
    const byLane = new Map(fanout.laneReviews.map((r) => [r.lane, r]));
    expect(byLane.get("adv")).toEqual({
      lane: "adv",
      mode: "independence_required",
      reason: "attacks the host's own authored artifacts",
    });
    // The ordinary lane records `ordinary` and no reason — the metadata carries
    // no basis claim it does not have.
    expect(byLane.get("plain")).toEqual({ lane: "plain", mode: "ordinary" });
  });
});

// Clean up temp dirs.
import { afterEach } from "vitest";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

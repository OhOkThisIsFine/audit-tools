import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceCitesRealPath,
  groundAffectedFiles,
  groundEvidence,
  groundExtractedFindings,
} from "../src/phases/grounding.js";
import { runPlanPhase } from "../src/phases/plan.js";
import { decideNextStep } from "../src/steps/nextStep.js";
import type { Finding } from "../src/state/types.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(testDir, ".test-grounding");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

function mkFinding(id: string, opts: {
  files?: string[];
  evidence?: string[];
  confidence?: string;
} = {}): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "General",
    severity: "medium",
    confidence: (opts.confidence ?? "high") as Finding["confidence"],
    lens: "correctness",
    summary: `Summary for ${id}.`,
    affected_files: (opts.files ?? []).map((path) => ({ path })),
    evidence: opts.evidence ?? ["Some evidence."],
  } as Finding;
}

async function rmWithRetry(path: string, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if (e.code !== "EBUSY" || i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

beforeEach(async () => {
  await rmWithRetry(TEST_DIR);
  await mkdir(join(TEST_DIR, "src"), { recursive: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(TEST_DIR, "src", "real.ts"), "line1\nline2\nline3\n", "utf8");
  await writeFile(join(TEST_DIR, "src", "other.ts"), "const x = 1;\n", "utf8");
});

afterEach(async () => {
  await rmWithRetry(TEST_DIR);
});

describe("groundAffectedFiles (WS1)", () => {
  it("strips phantom paths and keeps real ones", () => {
    const finding = mkFinding("F-1", { files: ["src/real.ts", "src/ghost.ts"] });
    const result = groundAffectedFiles(TEST_DIR, [finding]);

    expect(finding.affected_files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(result.phantomPathsByFinding.get("F-1")).toEqual(["src/ghost.ts"]);
    expect(result.zeroRealPathFindingIds).toEqual([]);
  });

  it("flags findings whose every cited path is phantom", () => {
    const finding = mkFinding("F-2", { files: ["nope/a.ts", "nope/b.ts"] });
    const result = groundAffectedFiles(TEST_DIR, [finding]);

    expect(finding.affected_files).toEqual([]);
    expect(result.zeroRealPathFindingIds).toEqual(["F-2"]);
  });

  it("leaves findings that never cited a path untouched (legitimate discovery state)", () => {
    const finding = mkFinding("F-3", { files: [] });
    const result = groundAffectedFiles(TEST_DIR, [finding]);

    expect(result.zeroRealPathFindingIds).toEqual([]);
    expect(result.phantomPathsByFinding.size).toBe(0);
  });

  it("accepts directory paths as real", () => {
    const finding = mkFinding("F-4", { files: ["src"] });
    const result = groundAffectedFiles(TEST_DIR, [finding]);

    expect(finding.affected_files.map((f) => f.path)).toEqual(["src"]);
    expect(result.phantomPathsByFinding.size).toBe(0);
  });
});

describe("evidenceCitesRealPath (WS2)", () => {
  it("accepts a real path with a valid line", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/real.ts:2 — broken logic")).toBe(true);
  });

  it("rejects a real path with an out-of-range line", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/real.ts:9999 — broken logic")).toBe(false);
  });

  it("accepts a real path without a line", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "see src/real.ts for the handler")).toBe(true);
  });

  it("rejects phantom paths and bare prose", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/ghost.ts:1 is wrong")).toBe(false);
    expect(evidenceCitesRealPath(TEST_DIR, "the login flow loses the session")).toBe(false);
  });
});

describe("groundEvidence (WS2)", () => {
  it("marks grounded findings and preserves their confidence", () => {
    const finding = mkFinding("F-5", { evidence: ["src/real.ts:1 — bug here"] });
    const result = groundEvidence(TEST_DIR, [finding]);

    expect(finding.evidence_grounded).toBe(true);
    expect(finding.confidence).toBe("high");
    expect(result.ungroundedFindingIds).toEqual([]);
  });

  it("downgrades ungrounded findings to low confidence without dropping them", () => {
    const finding = mkFinding("F-6", { evidence: ["the auth flow feels wrong"] });
    const result = groundEvidence(TEST_DIR, [finding]);

    expect(finding.evidence_grounded).toBe(false);
    expect(finding.confidence).toBe("low");
    expect(result.ungroundedFindingIds).toEqual(["F-6"]);
  });
});

describe("groundExtractedFindings (WS1+WS2)", () => {
  it("gives all-phantom findings one bounded repair attempt and re-validates the repair", async () => {
    const repairable = mkFinding("F-REPAIR", { files: ["wrong/place.ts"] });
    const unrepairable = mkFinding("F-DROP", { files: ["also/wrong.ts"] });
    let repairCalls = 0;

    const result = await groundExtractedFindings([repairable, unrepairable], {
      root: TEST_DIR,
      repairZeroPathFindings: async (requests) => {
        repairCalls++;
        expect(requests.map((r) => r.finding.id).sort()).toEqual(["F-DROP", "F-REPAIR"]);
        return new Map([
          ["F-REPAIR", ["src/real.ts"]],
          // Repair output is untrusted: still-phantom paths must not survive.
          ["F-DROP", ["still/phantom.ts"]],
        ]);
      },
    });

    expect(repairCalls).toBe(1);
    expect(result.findings.map((f) => f.id)).toEqual(["F-REPAIR"]);
    expect(repairable.affected_files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(result.dropped.map((d) => d.finding.id)).toEqual(["F-DROP"]);
    expect(result.dropped[0].phantomPaths).toEqual(["also/wrong.ts"]);
  });

  it("drops zero-path findings without a repair hook and records the phantoms", async () => {
    const finding = mkFinding("F-GONE", { files: ["nowhere.ts"] });
    const result = await groundExtractedFindings([finding], { root: TEST_DIR });

    expect(result.findings).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].phantomPaths).toEqual(["nowhere.ts"]);
  });

  it("survives a throwing repair hook by dropping the unrepaired findings", async () => {
    const finding = mkFinding("F-ERR", { files: ["nowhere.ts"] });
    const result = await groundExtractedFindings([finding], {
      root: TEST_DIR,
      repairZeroPathFindings: async () => {
        throw new Error("provider exploded");
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.dropped.map((d) => d.finding.id)).toEqual(["F-ERR"]);
  });
});

describe("runPlanPhase — extracted-input grounding (WS1+WS2)", () => {
  async function writeProseInput(): Promise<string> {
    const path = join(TEST_DIR, "feedback.md");
    await writeFile(path, "# Feedback\n\nPlease fix things.\n", "utf8");
    return path;
  }

  it("grounds extracted findings: strips phantoms, drops unrepaired, records the ledger", async () => {
    const input = await writeProseInput();
    const state = await runPlanPhase(
      { status: "pending" },
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR, input },
      {
        enumerateTestFiles: () => [],
        extractFindings: async () => ({
          findings: [
            mkFinding("F-MIXED", {
              files: ["src/real.ts", "src/ghost.ts"],
              evidence: ["src/real.ts:2 — wrong return"],
            }),
            mkFinding("F-PHANTOM", {
              files: ["imaginary/file.ts"],
              evidence: ["imaginary/file.ts:1 — made up"],
            }),
            mkFinding("F-PROSE", {
              files: ["src/other.ts"],
              evidence: ["the user said the config is duplicated"],
            }),
          ],
          blocks: [],
        }),
        repairExtractedFindingPaths: async () => new Map(),
      },
    );

    const ids = state.plan!.findings.map((f) => f.id).sort();
    expect(ids).toEqual(["F-MIXED", "F-PROSE"]);

    const mixed = state.plan!.findings.find((f) => f.id === "F-MIXED")!;
    expect(mixed.affected_files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(mixed.evidence_grounded).toBe(true);
    expect(mixed.confidence).toBe("high");

    const prose = state.plan!.findings.find((f) => f.id === "F-PROSE")!;
    expect(prose.evidence_grounded).toBe(false);
    expect(prose.confidence).toBe("low");

    const coverage = state.plan_coverage!;
    expect(coverage.phantom_dropped_count).toBe(1);
    const byId = Object.fromEntries(coverage.entries.map((e) => [e.finding_id, e]));
    expect(byId["F-PHANTOM"].disposition).toBe("dropped_phantom_paths");
    expect(byId["F-PHANTOM"].phantom_paths_removed).toEqual(["imaginary/file.ts"]);
    expect(byId["F-MIXED"].disposition).toBe("planned");
    expect(byId["F-MIXED"].phantom_paths_removed).toEqual(["src/ghost.ts"]);
    expect(byId["F-MIXED"].evidence_grounded).toBe(true);
    expect(byId["F-PROSE"].evidence_grounded).toBe(false);
  });

  it("keeps a zero-path finding repaired by the bounded retry", async () => {
    const input = await writeProseInput();
    const state = await runPlanPhase(
      { status: "pending" },
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR, input },
      {
        enumerateTestFiles: () => [],
        extractFindings: async () => ({
          findings: [
            mkFinding("F-FIXABLE", {
              files: ["guessed/path.ts"],
              evidence: ["src/real.ts:1 — evidence holds"],
            }),
          ],
          blocks: [],
        }),
        repairExtractedFindingPaths: async () =>
          new Map([["F-FIXABLE", ["src/real.ts"]]]),
      },
    );

    const finding = state.plan!.findings.find((f) => f.id === "F-FIXABLE")!;
    expect(finding.affected_files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(state.plan_coverage!.phantom_dropped_count).toBe(0);
  });

  it("structured audit-findings input is exempt from grounding (control)", async () => {
    // A structured report citing a since-deleted path must NOT be dropped or
    // annotated — stale paths there are the integrity check's replan concern.
    const reportPath = join(TEST_DIR, "audit-findings.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        contract_version: "audit-tools/audit-findings/v1alpha1",
        summary: {
          finding_count: 1,
          work_block_count: 0,
          severity_breakdown: {},
          audited_file_count: 0,
          excluded_file_count: 0,
          runtime_validation_status_breakdown: {},
        },
        findings: [
          mkFinding("F-AUDIT", {
            files: ["deleted/since/audit.ts"],
            evidence: ["prose evidence without a path"],
          }),
        ],
        work_blocks: [],
      }),
      "utf8",
    );

    const state = await runPlanPhase(
      { status: "pending" },
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR, input: reportPath },
      { enumerateTestFiles: () => [] },
    );

    const finding = state.plan!.findings.find((f) => f.id === "F-AUDIT")!;
    expect(finding.affected_files.map((f) => f.path)).toEqual(["deleted/since/audit.ts"]);
    expect(finding.evidence_grounded).toBeUndefined();
    expect(finding.confidence).toBe("high");
    expect(state.plan_coverage!.phantom_dropped_count).toBe(0);
    const entry = state.plan_coverage!.entries.find((e) => e.finding_id === "F-AUDIT")!;
    expect(entry.evidence_grounded).toBeUndefined();
  });
});

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

describe("decideNextStep — extracted-plan.json grounding (WS1+WS2)", () => {
  it("grounds a pending extracted plan and records coverage on state", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "PLAN-GROUND",
        findings: [
          mkFinding("F-OK", {
            files: ["src/real.ts", "phantom/one.ts"],
            evidence: ["src/real.ts:3 — cited"],
          }),
          mkFinding("F-BAD", {
            files: ["phantom/two.ts"],
            evidence: ["phantom/two.ts:9 — invented"],
          }),
        ],
        blocks: [
          { block_id: "B-001", items: ["F-OK", "F-BAD"], parallel_safe: true },
        ],
      }),
      "utf8",
    );
    await writeIntentCheckpoint();

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(state.plan.findings.map((f: Finding) => f.id)).toEqual(["F-OK"]);
    expect(state.plan.findings[0].affected_files.map((f: { path: string }) => f.path)).toEqual([
      "src/real.ts",
    ]);
    expect(state.plan.blocks.flatMap((b: { items: string[] }) => b.items)).toEqual(["F-OK"]);

    const coverage = state.plan_coverage;
    expect(coverage.phantom_dropped_count).toBe(1);
    const bad = coverage.entries.find((e: { finding_id: string }) => e.finding_id === "F-BAD");
    expect(bad.disposition).toBe("dropped_phantom_paths");
    expect(bad.phantom_paths_removed).toEqual(["phantom/two.ts"]);
  });

  it("contract-pipeline-promoted plans keep their confidence (grounded by construction)", async () => {
    // Promoted findings carry obligation-reference evidence, not path:line
    // citations; the traceability gate already grounded them. They must not be
    // blanket-downgraded by the evidence pass.
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "CP-PLAN",
        source: "contract_pipeline",
        findings: [
          mkFinding("CP-001", {
            files: [],
            evidence: ["Satisfies contract obligation: O-1"],
          }),
        ],
        blocks: [
          { block_id: "CP-BLOCK-CP-001", items: ["CP-001"], parallel_safe: true },
        ],
      }),
      "utf8",
    );
    await writeIntentCheckpoint();

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(state.plan.findings[0].confidence).toBe("high");
    expect(state.plan.findings[0].evidence_grounded).toBeUndefined();
  });

  it("re-emits extraction when every extracted finding cited only phantom paths", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "PLAN-ALL-PHANTOM",
        findings: [mkFinding("F-X", { files: ["void/x.ts"] })],
        blocks: [],
      }),
      "utf8",
    );
    await writeIntentCheckpoint();

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    // The corrupted-plan recovery removes the ungroundable plan so the host
    // re-extracts with the grounding-tightened prompt.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(false);
  });
});

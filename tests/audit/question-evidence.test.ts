import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent } from "../../src/shared/hash.js";
import { hashAnalyzerSnippet } from "../../src/shared/analyzers/provenance.js";
import {
  buildCommandEvidence,
  collectQuestionEvidence,
  evidenceApplicability,
  fingerprintDiscoveredSet,
  fingerprintExecutionConditions,
  makeAnalyzerCalibration,
  resolveEvidenceReference,
  reuseAnalyzerCalibration,
} from "../../src/audit/orchestrator/questionEvidence.js";
import type { ReviewDependency, ReviewEvidence } from "../../src/shared/types/reviewQuestion.js";
import { admitSpawn } from "../../src/shared/analyzers/acquisitionEngine.js";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../../src/shared/analyzers/candidates.js";

vi.mock("node:fs/promises", async (load) => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

const members = (names: string[], rule = "registration-rule-v1") =>
  fingerprintDiscoveredSet("registered-commands", rule, names);
const filter: ReviewDependency = { kind: "evidence", key: "effective-filter", fingerprint: "manual-and-scheduled" };
const evidence: ReviewEvidence = {
  schema_version: "audit-tools/question-review/v1",
  evidence_id: "shared-command",
  snapshot_id: "frozen",
  kind: "command",
  source_refs: [],
  dependencies: [filter, members(["manual", "scheduled"])],
  status: "observed",
  description: "One fixture command exercised two routes",
  execution: { tool: "fixture", tool_version: "1", config_fingerprint: "cfg", input_fingerprint: "input", environment_fingerprint: "env", exclusions: [], executed: true },
  observations: [
    { observation_id: "manual", statement: "Manual command resumed" },
    { observation_id: "scheduled", statement: "Scheduled command stayed pending" },
  ],
};

describe("question evidence reuse", () => {
  it("exposes anchored leads without raw output and only binds named current runtime receipts", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "question-evidence-"));
    const actual = "first\nflagged\n";
    await writeFile(join(sourceRoot, "a.ts"), actual);
    const sourceFiles = new Map([["a.ts", hashContent(actual)]]);
    const item = { id: "n", category: "c", severity: "low", path: "a.ts", line_start: 2, summary: "do not copy", raw: "never export",
      provenance: { analyzer_id: "local", path: "a.ts", snippet_hash: hashAnalyzerSnippet(actual, 2)! } };
    const conditions = fingerprintExecutionConditions("conditions", evidence.execution!);
    const receipt = { conditions_key: "conditions", record: { ...evidence, dependencies: [],
      source_refs: [{ path: "a.ts", start_line: 2 }] } };
    const collected = await collectQuestionEvidence({
      snapshot_id: "frozen", sourceRoot, sourceFiles, currentDependencies: [conditions],
      analyzerResults: [{ tool: "local", results: [item, { ...item, line_start: 1 }] }],
      runtimeReceipts: [receipt, { ...receipt, record: { ...receipt.record, evidence_id: "exit-only", observations: [] } }],
    });
    expect(collected.map(r => r.kind).sort()).toEqual(["command", "source"]);
    expect(JSON.stringify(collected)).not.toMatch(/do not copy|never export|exit-only/);
    expect(collected.find(r => r.kind === "source")?.observations).toBeUndefined();
    const stale = await collectQuestionEvidence({ snapshot_id: "frozen", sourceRoot,
      sourceFiles: new Map([["a.ts", "stale"]]), analyzerResults: [{ tool: "local", results: [item] }],
      runtimeReceipts: [receipt], currentDependencies: [conditions] });
    expect(stale).toEqual([]);
    const noConditions = await collectQuestionEvidence({ snapshot_id: "frozen", sourceRoot, sourceFiles,
      runtimeReceipts: [receipt] });
    expect(noConditions).toEqual([]);
  });

  it("reads one frozen file once for concurrent receipt refs without merging their checks", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "question-evidence-receipt-"));
    const content = "first\nsecond\n";
    const ref = (start_line: number) => ({ path: "a.ts", start_line });
    try {
      await writeFile(join(sourceRoot, "a.ts"), content);
      const beforeReads = vi.mocked(readFile).mock.calls.length;
      const record = {
        ...evidence, dependencies: [],
        source_refs: [ref(1)],
        observations: [
          { ...evidence.observations![0]!, source_refs: [ref(1), ref(2)] },
          { ...evidence.observations![1]!, source_refs: [ref(2)] },
        ],
      };
      const inputs = {
        snapshot_id: evidence.snapshot_id, sourceRoot,
        sourceFiles: new Map([["a.ts", hashContent(content)]]),
        currentDependencies: [fingerprintExecutionConditions("conditions", record.execution!)],
      };
      const collected = await collectQuestionEvidence({
        ...inputs, runtimeReceipts: [{ conditions_key: "conditions", record }],
      });
      expect(collected).toHaveLength(1);
      expect(collected[0]?.source_refs).toEqual([ref(1), ref(2)]);
      expect(vi.mocked(readFile).mock.calls.length - beforeReads).toBe(1);
      expect(await collectQuestionEvidence({
        ...inputs, runtimeReceipts: [{ conditions_key: "conditions", record: { ...record, source_refs: [ref(4)] } }],
      })).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("reuses exact portable calibration, not a changed version or a copied fingerprint", () => {
    const options = { tool: "tool", tool_version: "1", config_fingerprint: "config", selected_paths: ["a.ts"], exclusions: [] };
    const stored = makeAnalyzerCalibration(options);
    expect(reuseAnalyzerCalibration(stored, options)).toEqual(stored);
    expect(reuseAnalyzerCalibration(stored, { ...options, tool_version: "2" })).toBeUndefined();
    expect(reuseAnalyzerCalibration({ ...stored, tool_version: "2" }, options)).toBeUndefined();
  });
  it("binds recorded execution conditions without inferring observations from a successful command", () => {
    const execution = evidence.execution!;
    const record = buildCommandEvidence({ ...evidence, observations: [] }, "command-settings");
    expect(record.observations).toEqual([]);
    const binding = fingerprintExecutionConditions("command-settings", execution);
    expect(record.dependencies).toContainEqual(binding);
    expect(evidenceApplicability([binding], [fingerprintExecutionConditions("command-settings",
      { ...execution, config_fingerprint: "changed-filter" })]).status).toBe("changed");
    expect(() => buildCommandEvidence({ ...evidence, execution: { ...execution, executed: false } }, "command-settings"))
      .toThrow("requires recorded execution");
    expect(() => buildCommandEvidence({ ...evidence, status: "not_run" }, "command-settings"))
      .toThrow("cannot name observations");
  });

  it("resolves distinct named observations from one execution without treating the exit as an observation", () => {
    const observed = (observation_id: string) => resolveEvidenceReference(evidence, { evidence_id: evidence.evidence_id, observation_id });
    expect(observed("manual")?.statement).toBe("Manual command resumed");
    expect(observed("scheduled")?.statement).toBe("Scheduled command stayed pending");
    expect(observed("not-reported")).toBeUndefined();
    expect(resolveEvidenceReference(evidence, { evidence_id: evidence.evidence_id })).toBeUndefined();
    expect(resolveEvidenceReference({ ...evidence, status: "unavailable" }, { evidence_id: evidence.evidence_id, observation_id: "manual" })).toBeUndefined();
  });

  it("distinguishes changed filter, changed discovered membership, and unavailable inputs", () => {
    const before = evidence.dependencies;
    expect(evidenceApplicability(before, [filter, members(["scheduled", "manual", "manual"])]))
      .toEqual({ status: "applicable", changed: [], unknown: [] });
    expect(evidenceApplicability(before, [{ ...filter, fingerprint: "manual" }, before[1]!]))
      .toEqual({ status: "changed", changed: [filter], unknown: [] });
    expect(evidenceApplicability(before, [filter, members(["manual", "scheduled", "queued"])]))
      .toEqual({ status: "changed", changed: [before[1]], unknown: [] });
    expect(evidenceApplicability(before, [filter])).toEqual({ status: "unknown", changed: [], unknown: [before[1]] });
    expect(evidenceApplicability([filter], [filter, { ...filter, fingerprint: "conflicting" }]).status).toBe("unknown");
    expect(evidenceApplicability(before, [filter, members(["manual", "scheduled"], "new-discovery-rule")]).status).toBe("changed");
    expect(evidenceApplicability([filter], [filter, members(["new-unrelated-command"])]).status).toBe("applicable");
  });

  it("keeps a calibration fingerprint stable across runs without carrying execution authorization", () => {
    const candidate = EXTERNAL_ANALYZER_CANDIDATES.find((tool) => !tool.defaultRun)!;
    const settings = { tool: candidate.id, tool_version: "1", config_fingerprint: "cfg", selected_paths: ["a", "b"], exclusions: ["generated"] };
    const calibrated = makeAnalyzerCalibration({ ...settings, run_id: "first", consentToken: "prior-run-grant" } as typeof settings);
    const same = makeAnalyzerCalibration({ ...settings, selected_paths: ["b", "a"] });
    expect(calibrated).toEqual(same);
    expect(calibrated).not.toHaveProperty("run_id");
    expect(calibrated).not.toHaveProperty("consentToken");
    expect(makeAnalyzerCalibration({ ...settings, tool_version: "2" }).fingerprint).not.toBe(calibrated.fingerprint);
    expect(admitSpawn(candidate, "permanent", undefined)).toContain("consent not recorded");
  });
});

// Review lanes receive pre-digested, obligation-specific evidence they can read whole: a compact
// index in the prompt plus one call-site slice per unit, never an order to read a raw
// multi-hundred-KB artifact. Found in a dogfood run of 0.55.15 on itself: the design-review map was
// one 480 KB file every lane fell back to grepping, the systemic round was ordered to read ~650 KB of
// raw artifacts every round, its map anchored only the ground it was told to leave, and its prompt
// taught an excluded lens by example.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LENSES } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { Finding } from "../../src/audit/types.js";
import type { IntentCheckpoint } from "../../src/shared/index.js";
import { designReviewFileMapContext } from "../../src/audit/orchestrator/designReviewPrompt.js";
import { buildReviewFileMap } from "../../src/audit/systemic/reviewFileMap.js";
import {
  adversaryFileMapContext,
  renderSecondOrderAdversaryPrompt,
  systemicEvidencePaths,
} from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import { aggregateMetricsDigest } from "../../src/audit/systemic/aggregateMetricsDigest.js";
import { foldChallengeRound } from "../../src/audit/systemic/systemicChallengeLoop.js";
import { systemicChallengeSchemaForBundle } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";
import { laneSubmissionValidator } from "../../src/audit/cli/laneValidators.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { prepareConceptualDispatch } from "../../src/audit/cli/conceptualDispatch.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES } from "../../src/audit/cli/laneSubmissions.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const files = ["src/a/one.ts", "src/a/two.ts", "src/b/three.ts", "src/b/four.ts", "src/c/five.ts"];

function lead(id: string, path: string, title: string): Finding {
  return {
    id,
    title,
    category: "complexity_hotspot",
    severity: "low",
    confidence: "medium",
    lens: "maintainability",
    summary: title,
    affected_files: [{ path }],
  };
}

function banked(id: string, path: string): Finding {
  return {
    id,
    title: `banked ${id}`,
    category: "inferred_contract_gap",
    severity: "medium",
    confidence: "medium",
    lens: "architecture",
    summary: `banked ${id}`,
    evidence: [`\`run\` in ${path}`],
    affected_files: [{ path }],
  };
}

function bundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "right-sizing", root: "/repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: files.map((path) => ({ path, language: "typescript", size_bytes: 10 })),
    },
    graph_bundle: {
      graphs: {
        imports: [
          { from: "src/a/one.ts", to: "src/b/three.ts" },
          { from: "src/b/four.ts", to: "src/a/two.ts" },
          { from: "src/c/five.ts", to: "src/b/four.ts" },
        ],
        // Temporal coupling from git history: changed together, never a call site.
        co_change: [{ from: "src/a/one.ts", to: "src/c/five.ts" }],
      },
    },
    unit_manifest: {
      units: [
        { unit_id: "unit-a", name: "A", files: ["src/a/one.ts", "src/a/two.ts"], required_lenses: ["architecture"] },
        { unit_id: "unit-b", name: "B", files: ["src/b/three.ts", "src/b/four.ts"], required_lenses: ["architecture"] },
        { unit_id: "unit-c", name: "C", files: ["src/c/five.ts"], required_lenses: ["architecture"] },
      ],
    },
    risk_register: {
      items: [
        { unit_id: "unit-a", risk_score: 9, signals: [] },
        { unit_id: "unit-b", risk_score: 8, signals: [] },
      ],
    },
  };
}

function withAssessment(base: ArtifactBundle): ArtifactBundle {
  return {
    ...base,
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [
        lead("L1", "src/b/four.ts", "Complexity hotspot in four"),
        lead("L2", "src/a/one.ts", "Complexity hotspot in one"),
      ],
      contract_findings: [banked("CR-1", "src/a/one.ts")],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
  };
}

const excludesPerformance: IntentCheckpoint = {
  schema_version: "intent-checkpoint/v1",
  confirmed_at: "2026-01-01T00:00:00Z",
  confirmed_by: "host",
  scope_summary: "everything",
  intent_summary: "full audit",
  lens_selection: { include: ["architecture", "maintainability"], exclude: ["performance", "operability"] },
} as IntentCheckpoint;

describe("design-review call-site map: an index plus one slice per unit", () => {
  test("each starting-point unit gets its own slice; no slice carries another unit's anchors", () => {
    const context = designReviewFileMapContext(bundle(), { max_units: 2 });
    const slices = context.contextFiles;
    expect(slices.map((file) => file.filename)).toEqual([
      "review-call-site-map.unit-a.md",
      "review-call-site-map.unit-b.md",
    ]);
    expect(slices[0]!.text).toContain("- **src/a/one.ts**");
    expect(slices[0]!.text).not.toContain("- **src/b/three.ts**");
    expect(slices[1]!.text).toContain("- **src/b/four.ts**");
    expect(slices[1]!.text).not.toContain("- **src/a/one.ts**");
    // The prompt carries the index: each unit, its counts, and the slice that holds it.
    const summary = context.summaryLines.join("\n");
    expect(summary).toMatch(/unit-a.*review-call-site-map\.unit-a\.md/);
    expect(summary).toMatch(/unit-b.*review-call-site-map\.unit-b\.md/);
    expect(summary).not.toMatch(/Read it\s+BEFORE re-deriving/);
  });

  test("a co-change pair is not listed as a call site, and the omission is stated", () => {
    const context = designReviewFileMapContext(bundle(), { max_units: 2 });
    const unitA = context.contextFiles[0]!.text;
    expect(unitA).toContain("- **src/a/one.ts**\n  - referenced by: (none recorded)\n  - references: src/b/three.ts\n");
    expect(context.summaryLines.join("\n")).toMatch(/co_change \(1 edge\(s\)\).*not a call site/);
  });
});

describe("systemic call-site map: uncovered ground", () => {
  test("anchors deterministic-lead files no banked finding names, with the leads inline; banked files are not anchored", () => {
    const context = adversaryFileMapContext(withAssessment(bundle()));
    const text = context.contextFiles.map((file) => file.text).join("\n");
    expect(text).toContain("- **src/b/four.ts**");
    expect(text).toContain("Complexity hotspot in four");
    // src/a/one.ts is named by banked CR-1: covered ground, a plain list in the prompt, not recon.
    expect(text).not.toContain("- **src/a/one.ts**");
  });

  test("the prompt's unit-level index names every unit, with covered and uncovered counts", () => {
    const b = withAssessment(bundle());
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest(b),
      submissionPath: "<submission>",
      bundle: b,
      evidencePaths: [],
    });
    for (const unit of ["unit-a", "unit-b", "unit-c"]) expect(prompt).toContain(`| ${unit} |`);
    expect(prompt).toContain("**Components already implicated:** src/a/one.ts");
  });

  test("a file two units list counts as covered once, in the unit that owns it", () => {
    // The map gives a shared file to the FIRST unit listing it; the covered count
    // must follow the same owner, or the index sums to more files than exist.
    const base = withAssessment(bundle());
    const b: ArtifactBundle = {
      ...base,
      unit_manifest: {
        units: base.unit_manifest!.units.map((unit) =>
          unit.unit_id === "unit-c" ? { ...unit, files: [...unit.files, "src/a/one.ts"] } : unit,
        ),
      },
    };
    const summary = adversaryFileMapContext(b).summaryLines;
    // columns: unit | under review | anchored | no edge | covered (banked) | uncovered leads | slice
    const covered = (unit: string) => summary.find((line) => line.startsWith(`| ${unit} |`))!.split("|")[5]!.trim();
    expect(covered("unit-a")).toBe("1");
    expect(covered("unit-c")).toBe("0");
  });
});

describe("slice file names", () => {
  test("unit ids differing only in case get names that differ case-insensitively", () => {
    const b: ArtifactBundle = {
      ...bundle(),
      unit_manifest: {
        units: [
          { unit_id: "Unit", name: "U1", files: ["src/a/one.ts"], required_lenses: ["architecture"] },
          { unit_id: "unit", name: "U2", files: ["src/b/three.ts"], required_lenses: ["architecture"] },
        ],
      },
    };
    const map = buildReviewFileMap(b, { files: ["src/a/one.ts", "src/b/three.ts"], basis: "both" });
    const names = map.slices.map((slice) => slice.filename.toLowerCase());
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe("systemic evidence is pre-digested, not an order to read raw artifacts", () => {
  test("design_assessment.json is neither granted nor named; the rest are reference, not required reading", () => {
    const b = withAssessment(bundle());
    const paths = systemicEvidencePaths(b, "/artifacts");
    expect(paths.some((path) => path.endsWith("design_assessment.json"))).toBe(false);
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest(b),
      submissionPath: "<submission>",
      bundle: b,
      evidencePaths: paths,
    });
    expect(prompt).not.toContain("design_assessment.json");
    expect(prompt).not.toMatch(/Read these full artifacts/);
  });

  test("a lane told to verify source holds a grant on the snapshot it is told to read", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "grant-"));
    roots.push(artifactsDir);
    const sourceRoot = join(artifactsDir, "snapshot");
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      sourceRoot,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [{
        id: GATE_LANES.design_review_conceptual,
        label: "Review",
        promptFilename: "review.md",
        promptText: "Review.",
        fileCount: 1,
        riskScore: 0.1,
      }],
    });
    expect(fanout.readPaths).toContain(sourceRoot);
  });

  test("the design-review step grants the snapshot, shallow and deep", async () => {
    for (const settings of [
      { conceptual_depth: "shallow" as const, max_units: 2 },
      { conceptual_depth: "deep" as const, perspectives: 2, max_units: 2 },
    ]) {
      const artifactsDir = await mkdtemp(join(tmpdir(), "grant-conceptual-"));
      roots.push(artifactsDir);
      const sourceRoot = join(artifactsDir, "snapshot");
      const dispatch = await prepareConceptualDispatch({ artifactsDir, sourceRoot, bundle: bundle(), settings });
      expect(dispatch.readPaths, settings.conceptual_depth).toContain(sourceRoot);
    }
  });
});

// Owner decision (2026-11-05): a finding keeps its TRUE lens everywhere, as the
// design-review lanes have since 7a624e00. The selection is the round's FOCUS,
// stated in the prompt; it is never an admission filter.
describe("systemic lens selection is the focus, and findings keep their true lens", () => {
  const scoped = (): ArtifactBundle => ({ ...withAssessment(bundle()), intent_checkpoint: excludesPerformance });

  test("the prompt names the selected lenses as the focus and never teaches an excluded one", () => {
    const b = scoped();
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest(b),
      submissionPath: "<submission>",
      bundle: b,
      evidencePaths: [],
    });
    expect(prompt).toMatch(/selected these lenses for this audit: .*architecture.*maintainability/);
    // The closed vocabulary is the whole lens set: a true lens is always fileable.
    const lensLine = prompt.split("\n").find((line) => line.startsWith("- `lens`:"))!;
    for (const lens of LENSES) expect(lensLine).toContain(lens);
    expect(prompt).not.toContain('"lens": "performance"');
    expect(prompt).not.toMatch(/is\s+REFUSED[^.]*lens|lens[^.]*is\s+REFUSED/);
  });

  const submission = (lens: string) => ({
    findings: [{ ...banked("x", "src/b/four.ts"), lens }],
  });

  test("the gate and the recovery validator accept an excluded-lens finding, and the fold keeps its true lens", () => {
    const b = scoped();
    // The binding the fold's gate and its apply path both read.
    expect(systemicChallengeSchemaForBundle(b).safeParse(submission("performance")).success).toBe(true);
    const validate = laneSubmissionValidator(GATE_LANES.systemic_challenge, { repoFiles: new Set(files) })!;
    expect(validate(submission("performance"))).toBeNull();
    const folded = foldChallengeRound({
      prior: [],
      submitted: submission("performance").findings,
      round: 1,
      repoManifest: b.repo_manifest,
    });
    expect(folded.findings.map((finding) => finding.lens)).toEqual(["performance"]);
  });
});

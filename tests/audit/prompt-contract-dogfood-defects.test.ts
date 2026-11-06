/**
 * Prompt-contract defects found by auditing audit-tools with itself (0.55.15).
 *
 * Each test renders the prompt a host actually reads and checks it against the
 * contract the tool actually enforces, so obeying the prompt is sufficient:
 *
 * 1. The charter comparison prompt states the shape of a `reject` entry, and
 *    that shape is one `CharterComparisonSubmissionSchema` accepts.
 * 3. A design-review prompt that tells the reader to keep a structural lead's
 *    category on confirmation lists that category among the permitted ones.
 * 4. The judge prompt states where `round_id` goes inside the
 *    review-submission/v1 envelope the lane is bound to, and a submission built
 *    to that placement passes the envelope parse and the judge schema.
 */
import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { renderCharterComparisonPrompt } from "../../src/audit/cli/charterComparisonPrompt.js";
import {
  renderConceptualJudgePrompt,
  renderConceptualReviewPrompt,
  renderContractReviewPrompt,
} from "../../src/audit/orchestrator/designReviewPrompt.js";
import { ConceptualJudgeSubmissionSchema } from "../../src/audit/types/conceptualAdjudication.js";
import { CharterComparisonSubmissionSchema } from "../../src/shared/decompose/charterExtraction.js";
import { parseReviewSubmissionEnvelope } from "../../src/shared/types/reviewIndependence.js";

const CANDIDATE_ID = "cand-0123456789";

const comparisonBundle = {
  charter_register: {
    candidates: [
      {
        candidate_id: CANDIDATE_ID,
        members: [
          { kind: "stated", node_ids: ["keep-windows"] },
          { kind: "structural", node_ids: ["window-module"] },
        ],
        basis: "file_overlap",
        evidence_paths: ["src/scheduling/window.ts"],
      },
    ],
  },
} as unknown as ArtifactBundle;

/** The smallest bundle a design-review prompt renders from, plus one stamped structural lead. */
const designReviewBundle = {
  unit_manifest: {
    units: [
      {
        unit_id: "u1",
        path: "scripts/nightly",
        disposition: "in_scope",
        files: ["scripts/nightly/a.mjs", "scripts/nightly/b.mjs"],
        required_lenses: ["architecture"],
      },
    ],
  },
  repo_manifest: {
    repository: { name: "dogfood-fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: [
      { path: "scripts/nightly/a.mjs", language: "javascript", size_bytes: 100 },
      { path: "scripts/nightly/b.mjs", language: "javascript", size_bytes: 100 },
    ],
  },
  design_assessment: {
    generated_at: "2026-01-01T00:00:00.000Z",
    findings: [
      {
        id: "DA-001",
        title: "Dependency cycle: 2 modules",
        category: "dependency_cycle",
        severity: "medium",
        confidence: "high",
        lens: "architecture",
        summary: "Circular dependency among scripts/nightly/a.mjs → scripts/nightly/b.mjs → scripts/nightly/a.mjs.",
        affected_files: [{ path: "scripts/nightly/a.mjs" }, { path: "scripts/nightly/b.mjs" }],
        systemic: true,
        lead_lineage: { producer: "detectCycleFindings", source_hash: "a".repeat(64), confirmation: "lead" },
      },
    ],
  },
} as unknown as ArtifactBundle;

/** Every category a rendered prompt names as permitted, across all its "`category` is one of:" sentences. */
function permittedCategories(prompt: string): Set<string> {
  const permitted = new Set<string>();
  for (const match of prompt.matchAll(/`category` is one of: ([a-z_, ]+)/g)) {
    for (const value of match[1]!.split(",")) permitted.add(value.trim());
  }
  for (const match of prompt.matchAll(/keeps? (?:that|the) lead's category[^:]*: ([a-z_, ]+)/g)) {
    for (const value of match[1]!.split(",")) permitted.add(value.trim());
  }
  return permitted;
}

/** The categories the prompt's lead list tells the reader to retain on confirmation. */
function confirmationCategories(prompt: string): string[] {
  return [...prompt.matchAll(/Confirmation identity: (\{.*\})/g)].map(
    (match) => (JSON.parse(match[1]!) as { category: string }).category,
  );
}

describe("prompt contracts found by the 0.55.15 dogfood run", () => {
  it("charter comparison prompt states a reject entry the submission schema accepts", () => {
    const prompt = renderCharterComparisonPrompt(comparisonBundle, {
      submissionPath: "fixture/submission.json",
      laneGraphPaths: { stated: "fixture/stated.json", structural: "fixture/structural.json", revealed: "fixture/revealed.json" },
    });
    const rejectExample = prompt.match(/`(\{[^`]*"verdict": ?"reject"[^`]*\})`/);
    expect(rejectExample, "the prompt must state the exact shape of a reject entry").not.toBeNull();
    const entry: unknown = JSON.parse(rejectExample![1]!);
    const parsed = CharterComparisonSubmissionSchema.safeParse({
      correspondences: [entry],
      differences: [],
      no_correspondences: true,
    });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("design-review prompts permit the category of every structural lead they say to keep", () => {
    for (const prompt of [
      renderContractReviewPrompt(designReviewBundle),
      renderConceptualReviewPrompt(designReviewBundle),
    ]) {
      const kept = confirmationCategories(prompt);
      expect(kept).toContain("dependency_cycle");
      const permitted = permittedCategories(prompt);
      for (const category of kept) {
        expect([...permitted], `a confirmed ${category} lead must be a permitted category`).toContain(category);
      }
    }
  });

  it("judge prompt places round_id inside the envelope's result, and that placement validates", () => {
    const prompt = renderConceptualJudgePrompt(
      designReviewBundle,
      [{ name: "The Simplifier", path: "fixture/p1.json", contributor_id: "perspective:the-simplifier" }],
      "round-0001",
    );
    expect(prompt).not.toMatch(/top-level `round_id`/);
    expect(prompt).toContain("`result.round_id`");

    const digest = "b".repeat(64);
    const envelope = {
      contract_version: "review-submission/v1",
      prompt_sha256: digest,
      review: { mode: "independent", reason: "fresh context" },
      result: { round_id: "round-0001", findings: [], candidate_dispositions: [], final_finding_shares: [] },
    };
    const unwrapped = parseReviewSubmissionEnvelope(envelope, { requirement: "independent", promptSha256: digest });
    expect(unwrapped.ok).toBe(true);
    expect(ConceptualJudgeSubmissionSchema.safeParse(unwrapped.ok ? unwrapped.result : undefined).success).toBe(true);
    // Every key the judge schema requires is named at its envelope placement.
    for (const key of Object.keys(ConceptualJudgeSubmissionSchema.shape)) {
      expect(prompt, `the judge prompt must place ${key} at result.${key}`).toContain(`\`result.${key}\``);
    }
  });
});

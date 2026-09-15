import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
/**
 * CP-NODE-8 — Phase C residual: charters threaded into the conceptual prompt.
 *   - renderCharterContext renders, per correspondence, each channel's account
 *     side by side + the opine/flag disposition per account
 *   - shallow + deep conceptual prompts carry the charter block when present
 *   - byte-identical charter-unaware fallback when register is
 *     absent / omitted / empty (no correspondence)
 */
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import type { CharterLaneGraph, CharterConfidence } from "audit-tools/shared";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";

const {
  renderCharterContext,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  selectPerspectives,
  DEFAULT_CONCEPTUAL_PERSPECTIVES,
  CONCEPTUAL_PERSPECTIVES,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");

function baseBundle(charterRegister: CharterRegister | undefined): ArtifactBundle {
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [] },
  };
  if (charterRegister !== undefined) bundle.charter_register = charterRegister;
  return bundle;
}

function lane(
  kind: CharterLaneGraph["kind"],
  purpose: string,
  confidence: CharterConfidence = "high",
): CharterLaneGraph {
  return {
    kind,
    nodes: [
      {
        node_id: `${kind}-1`,
        purpose,
        premise_height: 0,
        files: ["src/shared/quota/a.ts", "src/shared/quota/b.ts"],
        provenance: [],
        confidence,
      },
    ],
    edges: [],
  };
}

function omittedRegister(): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00Z",
    target: "charter",
    ceiling: { rung: "shallow" },
    status: "omitted",
    ...EMPTY_REGISTER_BODY,
  };
}

function populatedRegister(): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00Z",
    target: "charter",
    ceiling: { rung: "deep" },
    ...EMPTY_REGISTER_BODY,
    lanes: [
      lane("stated", "quota exists so cooperating auditors share finite budgets"),
      lane("revealed", "quota actually optimizes for single-auditor throughput", "low"),
    ],
    correspondences: [
      {
        correspondence_id: "quota",
        members: [
          { kind: "stated", node_ids: ["stated-1"] },
          { kind: "revealed", node_ids: ["revealed-1"] },
        ],
        basis: "tool",
        evidence: [],
      },
    ],
  };
}

// ── renderCharterContext ──────────────────────────────────────────────────────

test("renderCharterContext: renders each correspondence's accounts side by side with telos framing", () => {
  const block = renderCharterContext(baseBundle(populatedRegister()));
  expect(block).toMatch(/Subsystem charters/);
  expect(block).toMatch(/\*\*quota\*\*/);
  expect(block).toMatch(/src\/shared\/quota\/a\.ts/);
  expect(block).toMatch(/\[stated\] quota exists so cooperating auditors/);
  expect(block).toMatch(/\[revealed\] quota actually optimizes/);
  // per-account opine framing present; never a merged sentence
  expect(block).toMatch(/Opine PER ACCOUNT/);
  expect(block).toMatch(/never merged/);
});

test("renderCharterContext: low-confidence account is FLAGGED not opined", () => {
  const block = renderCharterContext(baseBundle(populatedRegister()));
  // the low-confidence revealed account carries the flag-for-human disposition
  expect(block).toMatch(/\[revealed\] quota actually optimizes.*LOW-CONFIDENCE account: FLAG for human/);
  // the confident stated account carries no such marker on its own line
  const statedLine = block
    .split("\n")
    .find((l) => l.includes("[stated] quota exists"));
  expect(statedLine).not.toMatch(/LOW-CONFIDENCE/);
});

test("renderCharterContext: empty when register absent / omitted / no correspondence", () => {
  // absent (old bundle)
  expect(renderCharterContext(baseBundle(undefined))).toBe("");
  // omitted (shallow ceiling)
  expect(renderCharterContext(baseBundle(omittedRegister()))).toBe("");
  // present with lanes but nothing corresponds — no account pair to opine on
  expect(
    renderCharterContext(baseBundle({ ...populatedRegister(), correspondences: [] })),
  ).toBe("");
});

// ── threading into the conceptual prompts ─────────────────────────────────────

test("shallow conceptual prompt carries the charter block when the register is populated", () => {
  const prompt = renderConceptualReviewPrompt(baseBundle(populatedRegister()), {
    max_units: 5,
  });
  expect(prompt).toMatch(/Subsystem charters/);
  expect(prompt).toMatch(/\[stated\] quota exists/);
});

test("deep perspective prompt carries the charter block when the register is populated", () => {
  const [p] = selectPerspectives(5);
  const prompt = renderConceptualPerspectivePrompt(
    baseBundle(populatedRegister()),
    p,
    0,
    5,
    { max_units: 5 },
  );
  expect(prompt).toMatch(/Subsystem charters/);
  expect(prompt).toMatch(/\[revealed\] quota actually optimizes/);
});

// ── byte-identical charter-unaware fallback ───────────────────────────────────

test("shallow conceptual prompt is byte-identical with an absent vs omitted vs empty register", () => {
  const absent = renderConceptualReviewPrompt(baseBundle(undefined), { max_units: 5 });
  const omitted = renderConceptualReviewPrompt(baseBundle(omittedRegister()), { max_units: 5 });
  expect(omitted).toBe(absent);
  // and neither mentions the charter block
  expect(absent).not.toMatch(/Subsystem charters/);
});

test("deep perspective prompt is byte-identical when the register is absent vs omitted", () => {
  const [p] = selectPerspectives(5);
  const absent = renderConceptualPerspectivePrompt(baseBundle(undefined), p, 0, 5, {
    max_units: 5,
  });
  const omitted = renderConceptualPerspectivePrompt(baseBundle(omittedRegister()), p, 0, 5, {
    max_units: 5,
  });
  expect(omitted).toBe(absent);
  expect(absent).not.toMatch(/Subsystem charters/);
});

// P0, simplification workflow gap: the deep fan-out must CONTAIN the two reviewers the
// workflow is built around, not merely list them in the roster.
//
// Pinned at a NARROWED count, which is the only place the reservation can be observed.
// The default now covers the whole roster, so asserting against the default would pass
// against `slice(0, count)` too — a vacuous test that proves the roster is complete,
// which was never in doubt. 3 is the smallest count above the clamp floor that still
// leaves room for a non-required perspective, so it distinguishes "reserved" from
// "happens to fit". [[test-must-reach-the-code-it-claims]]
test("a narrowed deep fan-out still selects both required simplification reviewers", () => {
  const names = selectPerspectives(3).map((p) => p.name);
  expect(names, "the structural-simplification reviewer must be selected").toContain(
    "Mathematician seeking elegance",
  );
  expect(names, "the purpose/telos challenger must be selected").toContain("Minimalist");
  expect(names, "a narrowed count must still honour the count").toHaveLength(3);
});

// The default dispatches every perspective. It was 5 against a 7-entry roster with no
// recorded reason, which silently encoded a judgement about which reviewers matter least
// — a judgement nothing in this repo can support, because findings record a `lens` and
// never the perspective that produced them.
test("the default deep fan-out dispatches the whole roster", () => {
  expect(selectPerspectives()).toHaveLength(DEFAULT_CONCEPTUAL_PERSPECTIVES);
  expect(selectPerspectives(), "the default must not silently drop a perspective").toEqual(
    CONCEPTUAL_PERSPECTIVES,
  );
});

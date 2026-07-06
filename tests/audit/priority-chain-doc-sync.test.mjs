import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Lockstep guard: the obligation priority chain documented in CLAUDE.md must
// stay byte-for-byte in step with the `PRIORITY` array in the orchestrator.
// Importing from source (not dist) ensures the test guards un-rebuilt changes.
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.ts";
import {
  expectObligationOrder,
  expectObligationEndpoint,
} from "./helpers/advancedBundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> audit-code/ -> packages/ -> repo root
const repoRoot = join(here, "..", "..");
const claudeMdPath = join(repoRoot, "CLAUDE.md");

test("CLAUDE.md priority chain matches the exported PRIORITY array", async () => {
  const claudeMd = await readFile(claudeMdPath, "utf8");

  // Locate the single sentence that documents the chain.
  const chainLine = claudeMd
    .split(/\r?\n/)
    .find((line) => line.includes("The priority chain in `nextStep.ts`:"));
  expect(chainLine, "Could not find the priority-chain sentence in CLAUDE.md (expected a line containing 'The priority chain in `nextStep.ts`:')").toBeTruthy();

  // Isolate just the arrow-chain clause: the text after "nextStep.ts`:" up to
  // the period that ends it, so trailing prose (which mentions artifact
  // filenames and re-uses obligation names) doesn't leak into the id list.
  const chainClause = chainLine.split("`nextStep.ts`:")[1]?.split(". ")[0] ?? "";

  // Every backtick-quoted token in that clause is an obligation id.
  const ids = [...chainClause.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  expect(ids.length, `Expected 23 obligation ids in the CLAUDE.md chain sentence, found ${ids.length}: ${ids.join(", ")}`).toBe(23);

  // doc == code: same ids, same order.
  expect(ids, "The CLAUDE.md priority chain is out of sync with the exported PRIORITY array").toEqual(PRIORITY);

  // Endpoints are semantic invariants: provider_confirmation MUST be the session
  // gate (first), friction_capture_current MUST be the terminal close-out (last).
  // Asserted by endpoint, not literal index, so they don't churn when a phase is
  // inserted between them.
  expectObligationEndpoint(expect, "provider_confirmation", "first");
  expectObligationEndpoint(expect, "friction_capture_current", "last");

  expect(!PRIORITY.includes("design_review_completed"), "design_review_completed should no longer be in PRIORITY").toBeTruthy();

  // The full RELATIVE ordering of the chain's key obligations — the actual
  // sequencing invariant. Keyed by `PRIORITY.indexOf` relationships, never literal
  // integers: inserting a new obligation shifts every absolute index but leaves
  // these before/after relationships intact, so a new phase is a one-line PRIORITY
  // edit rather than a sweep of every pinned number here (the recurring friction
  // this test was the worst offender for — it re-broke on the Phase-B insert).
  expectObligationOrder(expect, [
    "provider_confirmation",
    "repo_manifest",
    "file_disposition",
    "syntax_resolved",
    "external_analyzers_current",
    "structure_artifacts",
    "graph_enrichment_current",
    "design_assessment_current",
    "structure_decomposition_current",
    "intent_checkpoint_current",
    "charter_extraction_current",
    "design_review_contract_completed",
    "design_review_conceptual_completed",
    "charter_clarification_current",
    "systemic_challenge_current",
    "planning_artifacts",
    "synthesis_narrative_current",
    "friction_capture_current",
  ]);
});

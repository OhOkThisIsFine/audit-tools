import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Lockstep guard: the obligation priority chain documented in CLAUDE.md must
// stay byte-for-byte in step with the `PRIORITY` array in the orchestrator.
// Importing from source (not dist) ensures the test guards un-rebuilt changes.
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.ts";

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

  expect(ids.length, `Expected 19 obligation ids in the CLAUDE.md chain sentence, found ${ids.length}: ${ids.join(", ")}`).toBe(19);

  // doc == code: same ids, same order.
  expect(ids, "The CLAUDE.md priority chain is out of sync with the exported PRIORITY array").toEqual(PRIORITY);

  // Spot-check the endpoints and key obligations.
  expect(PRIORITY[0]).toBe("provider_confirmation");
  expect(PRIORITY[1]).toBe("repo_manifest");
  expect(PRIORITY[17]).toBe("synthesis_narrative_current");
  expect(PRIORITY[18]).toBe("friction_capture_current");

  expect(PRIORITY.includes("graph_enrichment_current")).toBeTruthy();
  expect(PRIORITY.includes("design_assessment_current")).toBeTruthy();
  expect(PRIORITY.includes("design_review_contract_completed")).toBeTruthy();
  expect(PRIORITY.includes("design_review_conceptual_completed")).toBeTruthy();
  expect(!PRIORITY.includes("design_review_completed"), "design_review_completed should no longer be in PRIORITY").toBeTruthy();

  // provider_confirmation is the session gate at index 0; intake follows.
  // external-analyzer acquisition (Slice D) sits at index 5, after syntax_resolved
  // and before structure_artifacts (index 6); graph/design obligations follow;
  // intent checkpoint sits after design_assessment_current, before design_review_contract_completed.
  expect(PRIORITY.indexOf("external_analyzers_current")).toBe(5);
  expect(PRIORITY.indexOf("structure_artifacts")).toBe(6);
  expect(PRIORITY.indexOf("graph_enrichment_current")).toBe(7);
  expect(PRIORITY.indexOf("design_assessment_current")).toBe(8);
  expect(PRIORITY.indexOf("intent_checkpoint_current")).toBe(9);
  expect(PRIORITY.indexOf("design_review_contract_completed")).toBe(10);
  expect(PRIORITY.indexOf("design_review_conceptual_completed")).toBe(11);
  expect(PRIORITY.indexOf("planning_artifacts")).toBe(12);
});

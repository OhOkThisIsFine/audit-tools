import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(
    chainLine,
    "Could not find the priority-chain sentence in CLAUDE.md (expected a line containing 'The priority chain in `nextStep.ts`:')",
  );

  // Isolate just the arrow-chain clause: the text after "nextStep.ts`:" up to
  // the period that ends it, so trailing prose (which mentions artifact
  // filenames and re-uses obligation names) doesn't leak into the id list.
  const chainClause = chainLine.split("`nextStep.ts`:")[1]?.split(". ")[0] ?? "";

  // Every backtick-quoted token in that clause is an obligation id.
  const ids = [...chainClause.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  assert.equal(
    ids.length,
    17,
    `Expected 17 obligation ids in the CLAUDE.md chain sentence, found ${ids.length}: ${ids.join(", ")}`,
  );

  // doc == code: same ids, same order.
  assert.deepEqual(
    ids,
    PRIORITY,
    "The CLAUDE.md priority chain is out of sync with the exported PRIORITY array",
  );

  // Spot-check the endpoints and key obligations.
  assert.equal(PRIORITY[0], "provider_confirmation");
  assert.equal(PRIORITY[1], "repo_manifest");
  assert.equal(PRIORITY[16], "synthesis_narrative_current");

  assert.ok(PRIORITY.includes("graph_enrichment_current"));
  assert.ok(PRIORITY.includes("design_assessment_current"));
  assert.ok(PRIORITY.includes("design_review_contract_completed"));
  assert.ok(PRIORITY.includes("design_review_conceptual_completed"));
  assert.ok(!PRIORITY.includes("design_review_completed"), "design_review_completed should no longer be in PRIORITY");

  // provider_confirmation is the session gate at index 0; intake follows.
  // graph/design obligations sit after structure_artifacts (index 5);
  // intent checkpoint sits after design_assessment_current, before design_review_contract_completed.
  assert.equal(PRIORITY.indexOf("graph_enrichment_current"), 6);
  assert.equal(PRIORITY.indexOf("design_assessment_current"), 7);
  assert.equal(PRIORITY.indexOf("intent_checkpoint_current"), 8);
  assert.equal(PRIORITY.indexOf("design_review_contract_completed"), 9);
  assert.equal(PRIORITY.indexOf("design_review_conceptual_completed"), 10);
  assert.equal(PRIORITY.indexOf("planning_artifacts"), 11);
});

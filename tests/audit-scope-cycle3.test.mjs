import assert from "node:assert/strict";
import test from "node:test";
import { questionWorkloadBindings } from "../dist/audit/cli/questionWorkloadBindings.js";
import { deriveUnitScopeDisposition, designReviewPrimaryFiles } from "../dist/audit/orchestrator/intentScopeDisposition.js";
import { reviewSourceScope } from "../dist/audit/orchestrator/reviewSourceScope.js";
import { fileExclusionReason } from "../dist/shared/intent/pathScope.js";

const child = "src/child.ts";
const sibling = "src/sibling.ts";
const hard = "src/hard.ts";
const doc = "docs/contract.md";
const outside = "other/outside.ts";
const override = (path, status, reason = status) => ({ path, status, reason });

function bundle(disposition_overrides, excluded_scope = []) {
  return {
    repo_manifest: { files: [child, sibling, hard, doc, outside].map(path => ({
      path, hash: "frozen-" + path, ...(path === hard ? { excluded: true, exclusion_reason: "Not admitted" } : {}),
    })) },
    file_disposition: { files: [child, sibling, hard, doc, outside].map(path => override(path, path === doc ? "doc_only" : "included")) },
    intent_checkpoint: { disposition_overrides, excluded_scope, must_not_touch: ["other/**"] },
  };
}

async function boundPaths(candidate) {
  const scope = reviewSourceScope(candidate);
  const expected = [...new Set([...scope.allowedSourcePaths, ...scope.allowedContractPaths])];
  const sourceFiles = expected.map(path => ({ path, line_count: 1, fingerprint: "frozen-" + path }));
  const [binding] = await questionWorkloadBindings(candidate, process.cwd(), [], sourceFiles, [], {
    snapshot_id: "fixture", inventory: [],
    questions: [{
      question_id: "fixture-question", revision_id: "fixture-revision", snapshot_id: "fixture",
      lens: "architecture", plan_status: "pending", inventory_item_ids: [],
      source_dependencies: [], evidence_dependencies: [],
    }],
  });
  return binding.sourceFiles.map(file => file.path);
}

test("conceptual classification and source-bound question assignments honor the first matching review correction", async () => {
  const candidate = bundle([override(child, "included"), override("src", "excluded", "Broad exclusion")]);
  const intent = candidate.intent_checkpoint;
  assert.deepEqual(deriveUnitScopeDisposition([child, sibling], intent), { kind: "in_scope" });
  assert.deepEqual(deriveUnitScopeDisposition([sibling], intent), { kind: "excluded", reason: "Broad exclusion" });
  assert.deepEqual(designReviewPrimaryFiles([child, sibling], intent), [child]);
  assert.deepEqual(await boundPaths(candidate), [doc, outside, child]);

  const reversed = bundle([...intent.disposition_overrides].reverse());
  assert.deepEqual(deriveUnitScopeDisposition([child], reversed.intent_checkpoint), { kind: "excluded", reason: "Broad exclusion" });
  assert.deepEqual(await boundPaths(reversed), [doc, outside]);

  for (const status of ["excluded", "generated", "vendor"]) {
    const overlap = bundle([override(child, "included"), override("src", status, "Write denied")]);
    assert.equal(fileExclusionReason(child, overlap.intent_checkpoint, "write"), "Write denied");
    assert.equal(fileExclusionReason(child, overlap.intent_checkpoint), "Write denied");
  }
  assert.match(fileExclusionReason(outside, intent, "write"), /must-not-touch/);
  assert.equal(fileExclusionReason(outside, intent, "review"), null);
});

test("explicit exclusions and nonadmitted files dominate includes; delta still permits only its existing contract exception", async () => {
  const candidate = bundle(
    [override(child, "included"), override(hard, "included")],
    [{ path: child, reason: "Explicit exclusion" }],
  );
  candidate.scope = { mode: "delta", since: "base", seed_files: [child, sibling, hard], expanded_files: [], budget: { max_files: 3 } };
  const scope = reviewSourceScope(candidate);
  assert.equal(scope.sourceStatus(child), "Explicit exclusion");
  assert.equal(fileExclusionReason(child, candidate.intent_checkpoint), "Explicit exclusion");
  assert.deepEqual(deriveUnitScopeDisposition([child], candidate.intent_checkpoint), { kind: "excluded", reason: "Explicit exclusion" });
  assert.equal(scope.sourceStatus(hard, true), "Not admitted");
  assert.deepEqual(designReviewPrimaryFiles([hard, sibling], candidate.intent_checkpoint, new Set([hard])), [sibling]);
  assert.equal(scope.sourceStatus(outside, true), "Outside the confirmed changed scope.");
  assert.deepEqual(scope.allowedSourcePaths, [sibling]);
  assert.deepEqual(scope.allowedContractPaths, [doc, sibling]);
  assert.deepEqual(await boundPaths(candidate), [doc, sibling]);
});

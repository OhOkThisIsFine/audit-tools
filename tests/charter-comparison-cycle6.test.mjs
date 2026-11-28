import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderCharterComparisonPrompt } from "../dist/audit/cli/charterComparisonPrompt.js";
import { runCharterComparisonExecutor } from "../dist/audit/orchestrator/charterComparisonExecutor.js";
import { emptyCharterRegister } from "../dist/audit/orchestrator/charterExtractionExecutor.js";
import { CharterComparisonSubmissionSchema } from "../dist/shared/decompose/charterExtraction.js";

const kinds = ["stated", "structural", "revealed"];
const fixture = (laneCount, { provenance = [], split = { kind: "three_way" } } = {}) => {
  const members = kinds.slice(0, laneCount).map(kind => ({ kind, node_ids: [kind] }));
  const candidate = { candidate_id: "cand-fixture", basis: "file_overlap", members, evidence_paths: [] };
  const register = {
    ...emptyCharterRegister({ rung: "shallow" }, "2026-01-01T00:00:00.000Z"),
    comparison_pending: true,
    lanes: members.map(({kind}) => ({ kind, nodes: [{ node_id: kind }] })),
    candidates: [candidate],
  };
  const submission = CharterComparisonSubmissionSchema.parse({
    correspondences: [{ candidate_id: candidate.candidate_id, verdict: "confirm", members }],
    differences: [{
      correspondence: candidate.candidate_id,
      dimension: "purpose",
      relation: "incompatible",
      split,
      accounts: members.map(({kind}) => ({ kind, claim: kind, provenance: kind === "revealed" ? provenance : [] })),
      gap: "The channels disagree.",
    }],
  });
  return { bundle: { charter_register: register }, submission };
};

test("checker sorting cannot shift the verdict among eleven eligible quotes", async t => {
  const root = await mkdtemp(join(tmpdir(), "audit-charter-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provenance = Array.from({length: 11}, (_, i) => ({
    kind: "code", ref: `cited-${i}.ts:1`, quote: `export const citation${i} = true;`,
  }));
  await Promise.all(provenance.map(({ref, quote}, i) =>
    writeFile(join(root, ref.split(":")[0]), i === 3 || i === 10 ? "// no matching quote\n" : `${quote}\n`)));
  const { bundle, submission } = fixture(3, { provenance });
  const run = options => runCharterComparisonExecutor(bundle, submission, options).updated.charter_register;
  const checked = run({ root });
  assert.equal(checked.fidelity_pending, false);
  assert.deepEqual(checked.differences[0].fidelity, {
    verdict: "unverifiable",
    rationale: "cited quote not found at revealed: cited-10.ts:1; revealed: cited-3.ts:1",
    decided_by: "tool",
  });
  const noRoot = run();
  assert.equal(noRoot.fidelity_pending, true);
  assert.equal(noRoot.differences[0].fidelity, undefined);
  const invalidRoot = run({ root: join(root, "absent") });
  assert.equal(invalidRoot.fidelity_pending, false);
  assert.equal(invalidRoot.differences[0].fidelity.verdict, "unverifiable");
  assert.ok(provenance.every(({ref}) => invalidRoot.differences[0].fidelity.rationale.includes(`revealed: ${ref}`)));
});

test("prompt and ingest distinguish two-channel correspondences from three-way splits", () => {
  const two = fixture(2);
  const prompt = renderCharterComparisonPrompt(two.bundle, {
    submissionPath: "result.json",
    laneGraphPaths: { stated: "stated.json", structural: "structural.json", revealed: "revealed.json" },
  });
  assert.match(prompt, /`three_way` only when\s+the correspondence spans all three channels/);
  assert.match(prompt, /Two-channel correspondences are allowed,\s+but cannot use `three_way`/);
  const execute = ({bundle, submission}) => runCharterComparisonExecutor(bundle, submission).updated.charter_register;
  const refused = execute(two);
  assert.equal(refused.correspondences.length, 1);
  assert.deepEqual(refused.differences, []);
  assert.match(refused.validation_issues[0], /three_way split on a two-lane correspondence/);
  const twoWithOddLane = execute(fixture(2, { split: { kind: "two_against_one", odd: "stated" } }));
  assert.deepEqual(twoWithOddLane.validation_issues, []);
  assert.equal(twoWithOddLane.differences[0].split.kind, "two_against_one");
  const admitted = execute(fixture(3));
  assert.deepEqual(admitted.validation_issues, []);
  assert.equal(admitted.differences[0].split.kind, "three_way");
});

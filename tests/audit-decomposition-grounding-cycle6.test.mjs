import assert from "node:assert/strict";
import test from "node:test";
import { detectNonColocalization } from "../dist/audit/decompose/findings.js";
import { groundDesignFindings } from "../dist/shared/validation/designFindingGrounding.js";

test("design review stamps its lane and replaces a verdict only when it can check paths", () => {
  const finding = {
    id: "fixture",
    title: "Fixture finding",
    summary: "A synthetic design note",
    evidence: ["original evidence"],
    evidence_lane: "other-lane",
    grounding: { status: "grounded" },
    affected_files: [{ path: "src/fixture.ts", line_start: 3, line_end: 5 }],
  };
  for (const manifest of [undefined, { files: [] }]) {
    const [result] = groundDesignFindings([finding], manifest);
    assert.equal(result.evidence_lane, "design-review-lane");
    assert.equal(Object.hasOwn(result, "grounding"), false);
    assert.deepEqual(result.affected_files, [{ path: "src/fixture.ts" }]);
    assert.deepEqual(result.evidence, finding.evidence);
  }
  const [absent] = groundDesignFindings([finding], { files: [{ path: "src/other.ts" }] });
  assert.equal(absent.grounding.status, "ungrounded");
  assert.match(absent.grounding.reason, /not found/);
  const [present] = groundDesignFindings([absent], { files: [{ path: "src/fixture.ts" }] });
  assert.deepEqual(present.grounding, { status: "grounded" });
  assert.equal(present.evidence_lane, "design-review-lane");
  assert.deepEqual(finding.grounding, { status: "grounded" });
});

test("non-colocalization counts emitted candidates independently for each kind", () => {
  const make = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}.ts`);
  const contained = make("contained", 6);
  const a = make("alpha", 3);
  const b = make("beta", 3);
  const c = make("charlie", 3);
  const purposeA = [a[0], b[0], c[0], "intent-only-a.ts"];
  const purposeB = [a[1], b[1], c[1]];
  const purposeC = [b[2], c[2]];
  const shape = {
    behaviorPartitions: [new Map([b, contained, c, a].flatMap((group, i) => group.map(path => [path, String(i)])))],
    intentBoundaries: [contained],
    purposeGroups: [purposeC, purposeB, purposeA, contained],
  };
  const project = findings => findings.map(({ id, category, affected_files }) => [id, category, affected_files.map(({ path }) => path)]);
  assert.deepEqual(project(detectNonColocalization({ ...shape, maxPerKind: 2 })), [
    ["SD-001", "non_colocalization_behavioral", a],
    ["SD-002", "non_colocalization_behavioral", b],
    ["SD-003", "non_colocalization_purpose", purposeA],
    ["SD-004", "non_colocalization_purpose", purposeB],
  ]);
  assert.deepEqual(detectNonColocalization({ ...shape, maxPerKind: 0 }), []);
  assert.equal(detectNonColocalization({ ...shape, maxPerKind: 3 }).length, 6);
});

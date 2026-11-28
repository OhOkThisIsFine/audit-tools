import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitIntentClauses } from "../dist/shared/intent/clauseBoundaries.js";
import { interpretIntent } from "../dist/shared/intent/clauseInterpreter.js";
import { constraintClausesFromIntent, unresolvedFromClauses } from "../dist/shared/intent/constraintClauses.js";
import { readOrRepairIntentInterpretation } from "../dist/remediate/intent/intentPersistence.js";

const preserved = "Use the structured audit and preserve its input and narrative";
const pinnedFreeze = "Freeze the public API of PackageX";
const pinnedMascot = "ensure the mascot stays cheerful";
const conditional = "Preserve the input and narrative if the owner agrees";
const topology = "After verifying the exact declared build, checks, hooks and unit topology, and consider the directly supported bounded closeout read/projection opportunities when worth it";

test("preservation retains source context and noun lists without creating planning authority", () => {
  const { clauses, checkpoint_questions } = interpretIntent(preserved + ".");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].text, preserved);
  assert.deepEqual(clauses[0].encoded_as, { kind: "preservation_directive", detail: preserved });
  assert.deepEqual(checkpoint_questions, []);
  assert.deepEqual(interpretIntent("Preserve input and narrative.").checkpoint_questions, []);
  assert.deepEqual(constraintClausesFromIntent(clauses), []);
  assert.deepEqual(interpretIntent(topology).clauses.map(({text}) => text), [
    "After verifying the exact declared build, checks, hooks and unit topology,",
    "consider the directly supported bounded closeout read/projection opportunities when worth it",
  ]);
});

test("split independent actions but not punctuation or conjunctions inside quoted paths", () => {
  const scoped = 'focus on "docs/v2. and ignore them; a, b.md"';
  const excluded = "ignore 'fixtures/a, b and d.ts'";
  assert.deepEqual(interpretIntent(scoped + " and " + excluded).clauses.map(({text}) => text), [
    scoped, excluded,
  ]);
  assert.deepEqual(splitIntentClauses(scoped + ", maintainability", {
    splitOnCommas: true, splitOnAnd: false,
  }), [scoped, "maintainability"]);
  assert.deepEqual(interpretIntent("focus on modules A, B, and C; ignore vendor/").clauses.map(({text}) => text), [
    "focus on modules A, B, and C", "ignore vendor/",
  ]);
});

test("explicit unresolved decisions still block and resolution keys remain distinct", () => {
  const raw = "Focus on security and " + pinnedMascot + ".  " + pinnedFreeze + ". " + conditional + ".";
  const records = constraintClausesFromIntent(interpretIntent(raw).clauses);
  assert.deepEqual(records.map(({text}) => text), [pinnedMascot, pinnedFreeze, conditional]);
  assert.deepEqual(records.map(({clause_id}) => clause_id), [
    "clause|ensure the mascot stays cheerful",
    "clause|freeze the public api of packagex",
    "clause|preserve the input and narrative if the owner agrees",
  ]);
  const [first, second] = records;
  const sameQuestion = { ...second, checkpoint_question: first.checkpoint_question };
  assert.deepEqual(unresolvedFromClauses([first, sameQuestion], {
    constraint_clauses: [{ ...first, host_answer: "Approved only for the named clause." }],
  }), [sameQuestion]);
  const conflict = "Use the structured audit and preserve its input and narrative unless a rewrite is needed";
  const rewrite = "rewrite the narrative";
  assert.equal(constraintClausesFromIntent(interpretIntent(conflict).clauses)[0].text, conflict);
  assert.deepEqual(
    constraintClausesFromIntent(interpretIntent(preserved + " and " + rewrite).clauses).map(({text}) => text),
    [rewrite],
  );
  assert.deepEqual(unresolvedFromClauses(records, {
    constraint_clauses: [{ ...first, host_answer: " " }],
  }), records);
});

test("the native remediation reader replaces stale orphan questions with readable prose only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "remediate-intent-sentence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "intent-interpretation.json");
  await writeFile(path, JSON.stringify({
    schema_version: "remediate-code-intent-interpretation/v1alpha2",
    unencodable_clauses: [{ clause_id: "clause|narrative", text: "narrative", checkpoint_question: "What does this mean?" }],
  }));
  const checkpoint = { confirmed_by: "host", free_form_intent: preserved + "." };
  const sidecar = await readOrRepairIntentInterpretation(dir, checkpoint);
  assert.deepEqual(sidecar.preservation_directives, [preserved]);
  assert.deepEqual(sidecar.unencodable_clauses, []);
  assert.deepEqual(sidecar.interpreted.lensWeights, {});
  assert.deepEqual(sidecar.interpreted.prioritySignals, []);
  assert.deepEqual(sidecar.interpreted.scopeEmphasis, []);
  assert.deepEqual(sidecar.interpreted.scopeExclusions, []);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), sidecar);
});

test("the native remediation gate does not hide an unknown action behind a lens", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "remediate-intent-unknown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = "Focus on security and reconcile the discrepancy.";
  const checkpoint = { confirmed_by: "host", free_form_intent: original + " " + preserved + "." };
  const sidecar = await readOrRepairIntentInterpretation(dir, checkpoint);
  assert.deepEqual(sidecar.preservation_directives, [preserved]);
  const unanswered = unresolvedFromClauses(sidecar.unencodable_clauses, checkpoint);
  assert.deepEqual(unanswered.map(({text}) => text), ["reconcile the discrepancy"]);
  assert.equal(unanswered[0].clause_id, "clause|reconcile the discrepancy");
});

test("the native remediation gate does not derive signals from a preservation condition", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "remediate-intent-condition-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = "Preserve the input and narrative unless security requests a rewrite";
  const checkpoint = { confirmed_by: "host", free_form_intent: text + "." };
  const sidecar = await readOrRepairIntentInterpretation(dir, checkpoint);
  assert.deepEqual(sidecar.preservation_directives, []);
  assert.deepEqual(unresolvedFromClauses(sidecar.unencodable_clauses, checkpoint).map(({text}) => text), [text]);
  assert.deepEqual(sidecar.interpreted.lensWeights, {});
  assert.deepEqual(sidecar.interpreted.scopeEmphasis, []);
  assert.deepEqual(sidecar.interpreted.scopeExclusions, []);
  assert.deepEqual(sidecar.interpreted.prioritySignals, []);
});

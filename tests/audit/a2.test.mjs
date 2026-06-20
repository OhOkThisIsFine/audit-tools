import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  scoreAudit,
  findingSignature,
  hallucinationRegressed,
  renderScorecardMarkdown,
} = await import("../../src/audit/reporting/scoreAudit.ts");

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "fixtures", "corpus");

async function readJson(name) {
  return JSON.parse(await readFile(join(corpusDir, name), "utf8"));
}

// The committed, hermetic fixture: a real audit-findings.json-shaped doc plus a
// human-applied labels file keyed on findingIdentitySignature. Every assertion
// below scores these against each other, so the test is a genuine corpus run.
const FINDINGS_DOC = await readJson("scoring-fixture.findings.json");
const LABELS = await readJson("scoring-fixture.labels.json");
const FINDINGS = FINDINGS_DOC.findings;

function score() {
  return scoreAudit(FINDINGS, LABELS);
}

test("scoreAudit is a pure function: twice-run byte-identical (determinism)", () => {
  const a = JSON.stringify(scoreAudit(FINDINGS, LABELS));
  const b = JSON.stringify(scoreAudit(FINDINGS, LABELS));
  assert.equal(a, b, "two runs over the same inputs must be byte-identical");

  // Input ORDER must not change the scorecard either (signatures are sorted).
  const shuffledFindings = [...FINDINGS].reverse();
  const shuffledLabels = { ...LABELS, labels: [...LABELS.labels].reverse() };
  const c = JSON.stringify(scoreAudit(shuffledFindings, shuffledLabels));
  assert.equal(a, c, "reordering findings/labels must not change the scorecard");

  // The rendered markdown is likewise deterministic.
  assert.equal(
    renderScorecardMarkdown(scoreAudit(FINDINGS, LABELS)),
    renderScorecardMarkdown(scoreAudit(FINDINGS, LABELS)),
  );
});

test("a reworded re-emission of a labeled finding still matches its label", () => {
  // The fixture's SEC-001 carries a deliberately reworded, line-number-laden
  // title; its label was applied under different wording. Matching is by
  // signature only, so it must still resolve to the true_positive label.
  const auth = FINDINGS.find((f) => f.id === "SEC-001");
  assert.match(auth.title, /v2, line 88/, "fixture must use a reworded title");
  assert.equal(
    findingSignature(auth),
    "anchor|src/api/auth.ts|login",
    "the volatile title must not reach the signature",
  );

  const card = score();
  assert.equal(card.counts.true_positives, 1, "the reworded TP must be re-found");

  // An even-more-reworded variant of the SAME finding still matches the label.
  const reworded = {
    ...auth,
    id: "SEC-001-rephrased",
    title: "Totally different headline about 999 things",
    affected_files: [{ path: "src/api/auth.ts", symbol: "login", line_start: 1, line_end: 2 }],
  };
  assert.equal(findingSignature(reworded), findingSignature(auth));
  const single = scoreAudit([reworded], LABELS);
  assert.equal(
    single.counts.true_positives,
    1,
    "a reworded finding alone must still match its label",
  );
});

test("unmatched accounting is explicit — nothing is silently scored", () => {
  const card = score();
  const c = card.counts;

  // Cleanly-matched 1:1 verdicts (auth=TP, hash=FP, query=hallucinated).
  assert.equal(c.findings_emitted, 6);
  assert.equal(c.labels_total, 5);
  assert.equal(c.matched, 3);
  assert.equal(c.true_positives, 1);
  assert.equal(c.false_positives, 1);
  assert.equal(c.hallucinated, 1);

  // precision / recall_against_known / hallucination_rate.
  assert.equal(card.precision, 1 / 3, "precision = TP / (TP + FP + hallucinated)");
  assert.equal(
    card.recall_against_known,
    1 / 3,
    "recall = re-found labeled TP / all labeled TP (3 labeled TP, 2 missed)",
  );
  assert.equal(c.known_true_positives_missed, 2);
  assert.equal(card.hallucination_rate, 1 / 6, "hallucinated / findings_emitted");

  // Every input that could not be cleanly scored is surfaced — and the count of
  // unmatched entries exactly accounts for them (no silent drops).
  assert.equal(c.unmatched, card.unmatched.length);
  assert.equal(c.unmatched, 3);

  const byReason = (reason) =>
    card.unmatched.filter((u) => u.reason === reason);

  const unlabeled = byReason("finding_unlabeled");
  assert.equal(unlabeled.length, 1, "the emitted-but-unlabeled finding is surfaced");
  assert.deepEqual(unlabeled[0].finding_ids, ["SEC-004"]);
  assert.deepEqual(unlabeled[0].labels, []);

  const labelMiss = byReason("label_unmatched");
  assert.equal(labelMiss.length, 1, "the not-re-found labeled TP is surfaced");
  assert.equal(labelMiss[0].signature, "anchor|src/db/missing.ts|gone");
  assert.deepEqual(labelMiss[0].labels, ["true_positive"]);

  // Conservation: every emitted finding lands in exactly one bucket
  // (matched-clean, unlabeled, or a collision group) — none vanish.
  const emittedInCollisions = card.unmatched
    .filter((u) => u.reason === "ambiguous_signature_collision")
    .flatMap((u) => u.finding_ids);
  const emittedUnlabeled = unlabeled.flatMap((u) => u.finding_ids);
  assert.equal(
    c.matched + emittedUnlabeled.length + emittedInCollisions.length,
    c.findings_emitted,
    "every emitted finding is accounted for exactly once",
  );
});

test("a signature collision (CE-010) is surfaced as ambiguous — never scored under one verdict", () => {
  // Two DISTINCT fileless findings (OPS-001, OPS-002) collide on
  // rule|operability|ci; one true_positive label sits on that signature.
  const card = score();

  const collisions = card.unmatched.filter(
    (u) => u.reason === "ambiguous_signature_collision",
  );
  assert.equal(card.counts.collisions, 1);
  assert.equal(collisions.length, 1);

  const collision = collisions[0];
  assert.equal(collision.signature, "rule|operability|ci");
  assert.deepEqual(
    collision.finding_ids,
    ["OPS-001", "OPS-002"],
    "both colliding findings are surfaced (stable id order)",
  );
  assert.deepEqual(collision.labels, ["true_positive"]);

  // The colliding findings/label are excluded from EVERY verdict: neither is
  // counted as matched, and the colliding TP label is counted as NOT re-found
  // (we cannot prove which finding satisfied it).
  assert.equal(card.counts.matched, 3, "colliding findings are not in matched");
  assert.ok(
    card.counts.known_true_positives_missed >= 1,
    "the colliding TP label is treated as a recall miss, not silently re-found",
  );

  // Two findings + label that collide on a signature: a clean single match at
  // that signature would have made matched=4 — it must not.
  assert.notEqual(card.counts.matched, 4);
});

test("the exit gate is wired SOLELY to a hallucination-rate regression", () => {
  const baseline = score(); // hallucination_rate = 1/6

  // No baseline → nothing can regress (first run establishes it).
  assert.equal(hallucinationRegressed(baseline, null), false);
  assert.equal(hallucinationRegressed(baseline, undefined), false);

  // Equal rate → not a regression (a byte-identical re-run never trips).
  assert.equal(hallucinationRegressed(baseline, baseline), false);

  // Higher current rate → regression.
  const worse = { ...baseline, hallucination_rate: 0.5 };
  assert.equal(hallucinationRegressed(worse, baseline), true);

  // Lower current rate → improvement, not a regression.
  const better = { ...baseline, hallucination_rate: 0.0 };
  assert.equal(hallucinationRegressed(better, baseline), false);

  // A null current rate (run emitted no findings) cannot regress.
  const noFindings = { ...baseline, hallucination_rate: null };
  assert.equal(hallucinationRegressed(noFindings, baseline), false);

  // A null baseline rate is treated as 0 — any positive current rate regresses.
  const nullBaseline = { ...baseline, hallucination_rate: null };
  assert.equal(hallucinationRegressed(worse, nullBaseline), true);

  // Precision / recall regressions DO NOT gate: a scorecard whose precision and
  // recall collapse but whose hallucination rate is unchanged never trips.
  const precisionCollapsed = {
    ...baseline,
    precision: 0.0,
    recall_against_known: 0.0,
    hallucination_rate: baseline.hallucination_rate,
  };
  assert.equal(
    hallucinationRegressed(precisionCollapsed, baseline),
    false,
    "precision/recall must track, not gate",
  );
});

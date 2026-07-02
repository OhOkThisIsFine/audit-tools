import { test, expect } from "vitest";
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
  expect(a, "two runs over the same inputs must be byte-identical").toBe(b);

  // Input ORDER must not change the scorecard either (signatures are sorted).
  const shuffledFindings = [...FINDINGS].reverse();
  const shuffledLabels = { ...LABELS, labels: [...LABELS.labels].reverse() };
  const c = JSON.stringify(scoreAudit(shuffledFindings, shuffledLabels));
  expect(a, "reordering findings/labels must not change the scorecard").toBe(c);

  // The rendered markdown is likewise deterministic.
  expect(renderScorecardMarkdown(scoreAudit(FINDINGS, LABELS))).toBe(renderScorecardMarkdown(scoreAudit(FINDINGS, LABELS)));
});

test("a reworded re-emission of a labeled finding still matches its label", () => {
  // The fixture's SEC-001 carries a deliberately reworded, line-number-laden
  // title; its label was applied under different wording. Matching is by
  // signature only, so it must still resolve to the true_positive label.
  const auth = FINDINGS.find((f) => f.id === "SEC-001");
  expect(auth.title, "fixture must use a reworded title").toMatch(/v2, line 88/);
  expect(findingSignature(auth), "the volatile title must not reach the signature").toBe("anchor|src/api/auth.ts|login");

  const card = score();
  expect(card.counts.true_positives, "the reworded TP must be re-found").toBe(1);

  // An even-more-reworded variant of the SAME finding still matches the label.
  const reworded = {
    ...auth,
    id: "SEC-001-rephrased",
    title: "Totally different headline about 999 things",
    affected_files: [{ path: "src/api/auth.ts", symbol: "login", line_start: 1, line_end: 2 }],
  };
  expect(findingSignature(reworded)).toBe(findingSignature(auth));
  const single = scoreAudit([reworded], LABELS);
  expect(single.counts.true_positives, "a reworded finding alone must still match its label").toBe(1);
});

test("unmatched accounting is explicit — nothing is silently scored", () => {
  const card = score();
  const c = card.counts;

  // Cleanly-matched 1:1 verdicts (auth=TP, hash=FP, query=hallucinated).
  expect(c.findings_emitted).toBe(6);
  expect(c.labels_total).toBe(5);
  expect(c.matched).toBe(3);
  expect(c.true_positives).toBe(1);
  expect(c.false_positives).toBe(1);
  expect(c.hallucinated).toBe(1);

  // precision / recall_against_known / hallucination_rate.
  expect(card.precision, "precision = TP / (TP + FP + hallucinated)").toBe(1 / 3);
  expect(card.recall_against_known, "recall = re-found labeled TP / all labeled TP (3 labeled TP, 2 missed)").toBe(1 / 3);
  expect(c.known_true_positives_missed).toBe(2);
  expect(card.hallucination_rate, "hallucinated / findings_emitted").toBe(1 / 6);

  // Every input that could not be cleanly scored is surfaced — and the count of
  // unmatched entries exactly accounts for them (no silent drops).
  expect(c.unmatched).toBe(card.unmatched.length);
  expect(c.unmatched).toBe(3);

  const byReason = (reason) =>
    card.unmatched.filter((u) => u.reason === reason);

  const unlabeled = byReason("finding_unlabeled");
  expect(unlabeled.length, "the emitted-but-unlabeled finding is surfaced").toBe(1);
  expect(unlabeled[0].finding_ids).toEqual(["SEC-004"]);
  expect(unlabeled[0].labels).toEqual([]);

  const labelMiss = byReason("label_unmatched");
  expect(labelMiss.length, "the not-re-found labeled TP is surfaced").toBe(1);
  expect(labelMiss[0].signature).toBe("anchor|src/db/missing.ts|gone");
  expect(labelMiss[0].labels).toEqual(["true_positive"]);

  // Conservation: every emitted finding lands in exactly one bucket
  // (matched-clean, unlabeled, or a collision group) — none vanish.
  const emittedInCollisions = card.unmatched
    .filter((u) => u.reason === "ambiguous_signature_collision")
    .flatMap((u) => u.finding_ids);
  const emittedUnlabeled = unlabeled.flatMap((u) => u.finding_ids);
  expect(c.matched + emittedUnlabeled.length + emittedInCollisions.length, "every emitted finding is accounted for exactly once").toBe(c.findings_emitted);
});

test("a signature collision (CE-010) is surfaced as ambiguous — never scored under one verdict", () => {
  // Two DISTINCT fileless findings (OPS-001, OPS-002) collide on
  // rule|operability|ci; one true_positive label sits on that signature.
  const card = score();

  const collisions = card.unmatched.filter(
    (u) => u.reason === "ambiguous_signature_collision",
  );
  expect(card.counts.collisions).toBe(1);
  expect(collisions.length).toBe(1);

  const collision = collisions[0];
  expect(collision.signature).toBe("rule|operability|ci");
  expect(collision.finding_ids, "both colliding findings are surfaced (stable id order)").toEqual(["OPS-001", "OPS-002"]);
  expect(collision.labels).toEqual(["true_positive"]);

  // The colliding findings/label are excluded from EVERY verdict: neither is
  // counted as matched, and the colliding TP label is counted as NOT re-found
  // (we cannot prove which finding satisfied it).
  expect(card.counts.matched, "colliding findings are not in matched").toBe(3);
  expect(card.counts.known_true_positives_missed >= 1, "the colliding TP label is treated as a recall miss, not silently re-found").toBeTruthy();

  // Two findings + label that collide on a signature: a clean single match at
  // that signature would have made matched=4 — it must not.
  expect(card.counts.matched).not.toBe(4);
});

test("the exit gate is wired SOLELY to a hallucination-rate regression", () => {
  const baseline = score(); // hallucination_rate = 1/6

  // No baseline → nothing can regress (first run establishes it).
  expect(hallucinationRegressed(baseline, null)).toBe(false);
  expect(hallucinationRegressed(baseline, undefined)).toBe(false);

  // Equal rate → not a regression (a byte-identical re-run never trips).
  expect(hallucinationRegressed(baseline, baseline)).toBe(false);

  // Higher current rate → regression.
  const worse = { ...baseline, hallucination_rate: 0.5 };
  expect(hallucinationRegressed(worse, baseline)).toBe(true);

  // Lower current rate → improvement, not a regression.
  const better = { ...baseline, hallucination_rate: 0.0 };
  expect(hallucinationRegressed(better, baseline)).toBe(false);

  // A null current rate (run emitted no findings) cannot regress.
  const noFindings = { ...baseline, hallucination_rate: null };
  expect(hallucinationRegressed(noFindings, baseline)).toBe(false);

  // A null baseline rate is treated as 0 — any positive current rate regresses.
  const nullBaseline = { ...baseline, hallucination_rate: null };
  expect(hallucinationRegressed(worse, nullBaseline)).toBe(true);

  // Precision / recall regressions DO NOT gate: a scorecard whose precision and
  // recall collapse but whose hallucination rate is unchanged never trips.
  const precisionCollapsed = {
    ...baseline,
    precision: 0.0,
    recall_against_known: 0.0,
    hallucination_rate: baseline.hallucination_rate,
  };
  expect(hallucinationRegressed(precisionCollapsed, baseline), "precision/recall must track, not gate").toBe(false);
});

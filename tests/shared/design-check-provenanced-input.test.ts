// The design-check gate's delegated lane must RECEIVE the verified recon map, not re-derive it.
//
// A step-2 sweep ran four adversarial rounds; each spawned a FRESH agent that re-grepped the same
// call-site map from scratch (~135k subagent tokens a round, nearly all of it identical recon). The
// tension with independence is false, because it conflates independence of VERDICT with independence
// of INPUT: what a round must not do is judge work it authored, and being handed a factual map it did
// not produce leaves the verdict entirely its own.
//
// The rule lives in prose, so it is pinned here. Without a guard the paragraph is one tidy-up away
// from vanishing and the cost returns silently, as tokens nobody attributes to a deleted sentence.
//
// ⚠ THE PIN WAS NOT ENOUGH, and the second half of this file is why. Pinning prose only proves the
// prose still SAYS the rule; it cannot prove anything reaches it. The audit pipeline's own review
// rounds — including the systemic adversary, which is a review round by any reading — went on
// re-deriving their call-site map, because the rule lived in a document that is loaded when a
// design-check SWEEP is opened and nowhere near the code that assembles a round. So the rule now has
// a machine half too: `buildReviewFileMap` derives the map once from artifacts no round authored,
// `renderReviewFileMap` states its provenance and its read-only-ness in the prompt, and the tests
// below exercise the real renderer rather than a paragraph. The prose tests stay — they pin the
// ORIGINAL design-check sweep, which this change does not rewire.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderConceptualReviewPrompt } from "../../src/audit/orchestrator/designReviewPrompt.js";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, ".claude", "skills", "design-check", "SKILL.md");

/** The body of a numbered `## N.` section, CRLF-normalized so the match is OS-agnostic. */
function section(n: number) {
  const doc = readFileSync(SKILL_PATH, "utf8").replace(/\r\n/g, "\n");
  const start = doc.indexOf(`\n## ${n}.`);
  expect(start, `SKILL.md must have a '## ${n}.' section`).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

const sentences = (text: string) => text.replace(/\n/g, " ").split(/(?<=[.!?])\s+/);

test("design-check §3: the delegated lane receives the verified map as a read-only, provenanced input", () => {
  const s = section(3);
  expect(
    /re-?deriv|rediscover|from scratch/i.test(s),
    "§3 must say the lane does NOT re-derive recon a prior round already established — that " +
      "re-derivation is the ~135k-tokens-a-round cost this rule exists to remove",
  ).toBe(true);
  expect(
    /read-only/i.test(s),
    "§3 must pass the verified map as a READ-ONLY input",
  ).toBe(true);
  expect(
    /provenanc/i.test(s),
    "§3 must label the map with its provenance — prior verified recon the lane did not author",
  ).toBe(true);
  expect(
    /verdict/i.test(s),
    "§3 must keep the VERDICT the lane's own; independence of verdict is what the round is for, " +
      "independence of input never carried it",
  ).toBe(true);
});

test("design-check §3: the lane cannot write back to the map", () => {
  const s = section(3);
  const writeBack = sentences(s).find((sent) => /writ\w*\s+back/i.test(sent));
  expect(
    writeBack,
    "§3 must state what happens to the map when the lane is done with it — a map a reviewer can " +
      "amend silently absorbs that reviewer's assumption and reaches the next round as fact",
  ).toBeTruthy();
  expect(
    /\b(never|not|cannot|no)\b/i.test(writeBack ?? ""),
    `§3 must FORBID the lane writing back to the map, not merely mention it: "${writeBack}"`,
  ).toBe(true);
});

test("design-check §3: a lane that disagrees with the map must say so", () => {
  const s = section(3);
  const disagreements = sentences(s).filter((sent) => /disagree/i.test(sent));
  expect(
    disagreements.length,
    "§3 must cover the case where the lane disagrees with the map — otherwise a wrong map is " +
      "laundered into the verdict as an unchallenged premise",
  ).toBeGreaterThan(0);
  expect(
    disagreements.some((sent) => /\b(say|says|state|states|name|names|surface|surfaces)\b/i.test(sent)),
    `§3 must require the lane to SAY it disagrees and name what contradicts the map: "${disagreements.join(" ")}"`,
  ).toBe(true);
});

// ── The machine half: the map the audit's own review rounds actually receive ──

/** The smallest bundle whose renderer reaches the map block. */
function reviewBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "provenance-fixture", root: "/repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/caller.ts", language: "typescript", size_bytes: 10 },
        { path: "src/target.ts", language: "typescript", size_bytes: 10 },
      ],
    },
    graph_bundle: {
      graphs: { calls: [{ from: "src/caller.ts", to: "src/target.ts" }] },
    },
  };
}

test("a review round's prompt carries the verified map, provenanced as recon it did not author", () => {
  const prompt = renderConceptualReviewPrompt(reviewBundle(), { max_units: 5 });

  // The map itself — both ends of the edge the round would otherwise re-grep.
  expect(prompt).toContain("src/caller.ts");
  expect(prompt).toContain("src/target.ts");
  // Its PROVENANCE, stated to the lane that reads it rather than assumed.
  expect(prompt, "the map must be labelled machine-derived").toMatch(/machine-derived/i);
  expect(
    prompt,
    "the lane must be told it did not author the map — that is what makes trusting it compatible " +
      "with an independent verdict",
  ).toMatch(/did NOT author/i);
});

test("a review round cannot write back to the map", () => {
  const prompt = renderConceptualReviewPrompt(reviewBundle(), { max_units: 5 });
  const writeBack = sentences(prompt).find((sent) => /writ\w* back/i.test(sent));
  expect(
    writeBack,
    "the prompt must state what happens to the map when the round is done with it — a map a " +
      "reviewer can amend silently absorbs that reviewer's assumption and reaches the next round " +
      "as fact",
  ).toBeTruthy();
  expect(
    /\b(never|not|cannot|no)\b/i.test(writeBack ?? ""),
    `the prompt must FORBID the round writing back to the map, not merely mention it: "${writeBack}"`,
  ).toBe(true);
});

test("a review round that disagrees with the map is told to say so and name what contradicts it", () => {
  const prompt = renderConceptualReviewPrompt(reviewBundle(), { max_units: 5 });
  expect(
    prompt,
    "a wrong map must not be laundered into the verdict as an unchallenged premise — the round " +
      "must be required to contradict it out loud, naming the source that disagrees",
  ).toMatch(/contradicts the map/i);
});

test("the systemic adversary — a review round — receives the same provenanced map", () => {
  // The audit's OWN review loop is where the ~135k-tokens-a-round rediscovery was
  // measured; a rule wired only into the design-check sweep leaves this lane
  // paying the same cost with nothing to notice it.
  const prompt = renderSecondOrderAdversaryPrompt({
    round: 2,
    metrics: { rollups: [], max_fan_out: 0, total_edges: 1, metric_covered_nodes: 0 },
    submissionPath: "/x/incoming/systemic-challenge.json",
    bundle: reviewBundle(),
    evidencePaths: [],
  });
  expect(prompt).toContain("src/caller.ts");
  expect(prompt).toContain("src/target.ts");
  expect(prompt).toMatch(/did NOT author/i);
  expect(prompt).toMatch(/contradicts the map/i);
});

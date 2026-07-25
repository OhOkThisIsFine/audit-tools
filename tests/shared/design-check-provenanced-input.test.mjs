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
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, ".claude", "skills", "design-check", "SKILL.md");

/** The body of a numbered `## N.` section, CRLF-normalized so the match is OS-agnostic. */
function section(n) {
  const doc = readFileSync(SKILL_PATH, "utf8").replace(/\r\n/g, "\n");
  const start = doc.indexOf(`\n## ${n}.`);
  expect(start, `SKILL.md must have a '## ${n}.' section`).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

const sentences = (text) => text.replace(/\n/g, " ").split(/(?<=[.!?])\s+/);

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
    /\b(never|not|cannot|no)\b/i.test(writeBack),
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

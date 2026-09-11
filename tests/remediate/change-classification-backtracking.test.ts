import { describe, expect, it } from "vitest";

import { assertionPolarity } from "../../src/remediate/contractPipeline/changeClassification.js";

/**
 * Super-linear backtracking at the analyzer-sweep sites
 * (`docs/reviews/analysis-tools-plan-2026-08-07.md` §4/§5): no regex — and no
 * scan standing in for one — over unbounded audited-repo content may be
 * super-linear on adversarial input.
 *
 * The sweep named six sites. Probing all sixteen regexes at those sites against
 * fourteen adversarial families confirmed
 * exactly TWO real ones; the other four sites carry no regex over repo content
 * at all (a `split("/")`, a path check, and anchored parse-time patterns), and
 * are reported as such rather than "fixed". The two real ones live here and in
 * `tests/audit/graph-route-backtracking.test.ts`.
 *
 * These are TIMING tests, which are normally a smell. They are the honest shape
 * here: the property is literally "this input class does not blow up", the old
 * code took SECONDS on inputs this test generates in microseconds, and the
 * separation between pass and fail is three orders of magnitude — so the
 * assertion does not police constant factors, it detects an asymptotic
 * regression.
 */

/** Adversarial inputs, each aimed at a different structural failure. */
const ADVERSARIAL: ReadonlyArray<readonly [string, (n: number) => string]> = [
  // The confirmed killer for the identifier mask: one unbroken alphanumeric run
  // with no delimiter. A regex `alnum+(delim+alnum+)+` restarts at every position
  // and consumes the rest of the run before failing — Θ(n²).
  ["word-run", (n) => "auth".repeat(Math.ceil(n / 4))],
  ["dangling-open", (n) => "{" + "a".repeat(n)],
  ["import-fail", (n) => "import " + "a".repeat(n)],
  ["runaway-literal", (n) => "a".repeat(n)],
  ["quote-run", (n) => "'" + "a".repeat(n) + "'"],
  ["separator-run", (n) => "a" + "-".repeat(n)],
  ["sep-alnum-alt", (n) => "a" + "-a".repeat(Math.ceil(n / 2))],
];

function elapsedMsOf(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("assertion polarity masking is linear on adversarial assertions", () => {
  it("classifies a 16,000-character unbroken run without quadratic backtracking", () => {
    // Pre-correction this took ~3,360ms (44/186/741/3360ms at 2k/4k/8k/16k — a
    // clean 4x per doubling); the linear scan is well under 10ms. The ceiling
    // sits an order of magnitude above the fixed figure and well below the
    // broken one, so it detects the asymptote without policing constants — the
    // first draft used 200ms, which the REGRESSED code cleared at 174ms and so
    // asserted nothing.
    const assertion = `Returns a token for ${"auth".repeat(4000)}`;
    expect(assertion.length).toBeGreaterThan(16_000);
    const elapsed = elapsedMsOf(() => assertionPolarity(assertion));
    expect(elapsed, `masking a ${assertion.length}-char run took ${elapsed.toFixed(1)}ms`).toBeLessThan(60);
  });

  it.each(ADVERSARIAL)("stays linear on the %s family at 16k and 32k", (_family, make) => {
    const small = make(16_000);
    const large = make(32_000);
    const smallMs = elapsedMsOf(() => assertionPolarity(small));
    const largeMs = elapsedMsOf(() => assertionPolarity(large));
    // Linear growth doubles; quadratic quadruples. Allow a generous 3x so a
    // noisy runner cannot flake, while a regression to Θ(n²) lands at ~4x.
    expect(
      largeMs,
      `${_family}: 16k=${smallMs.toFixed(2)}ms 32k=${largeMs.toFixed(2)}ms`,
    ).toBeLessThan(Math.max(smallMs * 3, 50));
  }, 120_000);

  it("still masks identifier tokens and leaves prose alone", () => {
    // The scan replaces the regex spell-for-spell: a citation's embedded polarity
    // word must not leak, and ordinary prose must reach the keyword regexes.
    expect(assertionPolarity("Returns a token for OBL-AUTH-fail-session")).toBe("positive");
    expect(assertionPolarity("rejects invalid input")).toBe("negative");
    expect(assertionPolarity("emits canonical output")).toBe("positive");
    expect(assertionPolarity("writes src/remediate/never-null.ts and succeeds")).toBe("positive");
    // A bare delimiter run is NOT an identifier token, so surrounding prose is
    // still classified normally (the `---` is simply carried through).
    expect(assertionPolarity("the value --- is rejected")).toBe("negative");
    expect(assertionPolarity("the value --- returns")).toBe("positive");
    // Equivalence with the replaced regex was verified beyond these cases: the
    // scan and `/[A-Za-z0-9]+(?:[-_/.:]+[A-Za-z0-9]+)+/g` produced byte-identical
    // output on 200,020 inputs (all structured cases above plus 200,000 random
    // strings over an alphabet of delimiters, alphanumerics, spaces and quotes).
  });

  it("treats a degenerate delimiter-only string as one non-token run", () => {
    // Guards the skip path: a run of pure delimiters qualifies as nothing, and
    // must be copied through rather than rescanned.
    expect(assertionPolarity("---")).toBe("none");
    expect(assertionPolarity("a-")).toBe("none");
    expect(assertionPolarity("-")).toBe("none");
    expect(assertionPolarity("")).toBe("none");
  });
});

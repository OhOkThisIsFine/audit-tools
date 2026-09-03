/**
 * The measured-outcome vocabulary is the ONE word set for "what did this
 * measurement actually produce", and its guarantee is structural: three
 * exhaustive `Record`s, so widening the tuple without answering all three
 * questions is a COMPILE error rather than a silent default to "the run was
 * fine".
 *
 * This test pins the two things a compile error cannot: that the questions are
 * ANSWERED correctly for each member (`not_applicable` lost nothing AND was
 * owed nothing — two questions, not one boolean), and that the worst-first
 * roll-up orders them the way every consumer reads it.
 */
import { describe, expect, it } from "vitest";

import {
  MEASURED_OUTCOMES,
  MeasuredOutcomeSchema,
  outcomeIsApplicable,
  outcomeLostCoverage,
  worstMeasuredOutcome,
  type MeasuredOutcome,
} from "../../src/shared/measurement/measuredOutcome.js";
import {
  isNonCleanAnalyzerCoverage,
  type ExternalAnalyzerCoverage,
} from "../../src/shared/analyzers/types.js";

describe("the measured-outcome vocabulary", () => {
  it("is the closed tuple the zod enum is built from", () => {
    expect([...MEASURED_OUTCOMES]).toEqual([
      "clean",
      "findings",
      "degraded",
      "not_run",
      "not_applicable",
    ]);
    expect(MeasuredOutcomeSchema.options).toEqual([...MEASURED_OUTCOMES]);
  });

  it("answers LOST-COVERAGE and WAS-ANYTHING-OWED separately", () => {
    // Collapsing the two would force `not_applicable` to read as either "fine"
    // or "coverage lost", and both are false.
    const lost = Object.fromEntries(
      MEASURED_OUTCOMES.map((outcome) => [outcome, outcomeLostCoverage(outcome)]),
    );
    expect(lost).toEqual({
      clean: false,
      findings: false,
      degraded: true,
      not_run: true,
      not_applicable: false,
    });
    const applicable = Object.fromEntries(
      MEASURED_OUTCOMES.map((outcome) => [outcome, outcomeIsApplicable(outcome)]),
    );
    expect(applicable).toEqual({
      clean: true,
      findings: true,
      degraded: true,
      not_run: true,
      not_applicable: false,
    });
  });

  it("rolls a set up worst-first, and an empty set is not_applicable", () => {
    expect(worstMeasuredOutcome([])).toBe("not_applicable");
    expect(worstMeasuredOutcome(["clean", "findings"])).toBe("findings");
    expect(worstMeasuredOutcome(["findings", "not_run"])).toBe("not_run");
    expect(worstMeasuredOutcome(["not_run", "degraded"])).toBe("degraded");
    expect(worstMeasuredOutcome(["not_applicable", "clean"])).toBe("clean");
    // Stable regardless of input order — a roll-up is a max, never a fold that
    // depends on which entry the caller happened to list first.
    const shuffled: MeasuredOutcome[] = ["clean", "degraded", "not_applicable", "findings"];
    expect(worstMeasuredOutcome(shuffled)).toBe("degraded");
    expect(worstMeasuredOutcome([...shuffled].reverse())).toBe("degraded");
  });

  it("is the SAME vocabulary the external-analyzer coverage question speaks", () => {
    // The analyzer coverage alias is the measured-outcome set minus the one
    // member an imported tool run can never be (`not_applicable`), and its
    // member-level question delegates rather than keeping a second table.
    const coverage: ExternalAnalyzerCoverage[] = [
      "clean",
      "findings",
      "degraded",
      "not_run",
    ];
    for (const value of coverage) {
      expect(isNonCleanAnalyzerCoverage(value)).toBe(outcomeLostCoverage(value));
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  rationaleAsksForRetry,
} from "../../src/remediate/steps/stepUtils.js";

describe("stepUtils exports are stable after extraction", () => {
  describe("rationaleAsksForRetry", () => {
    it("returns true for deferred retry-later rationale", () => {
      expect(
        rationaleAsksForRetry(
          "Deferred - retry in a dedicated pass after the prerequisite lands.",
        ),
      ).toBe(true);
    });

    it("returns false for explicit do-not-remediate rationale", () => {
      expect(rationaleAsksForRetry("User said this is out of scope.")).toBe(false);
    });
  });

});

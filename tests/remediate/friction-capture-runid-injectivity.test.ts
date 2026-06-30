import { describe, it, expect } from "vitest";
import { sanitizeRunId, frictionCapturePath } from "audit-tools/shared";

const ART = "/artifacts";

describe("sanitizeRunId is injective (collision-free run-id encoding)", () => {
  // The failure mode CP-NODE-7 targets: a many-to-one collapse mapped distinct
  // run ids onto the same friction artifact path. These pairs must stay DISTINCT.
  const collidingPairs: Array<[string, string]> = [
    ["a/b", "a-b"],
    ["a/b", "a_b"],
    ["a b", "a-b"],
    ["a:b", "a-b"],
    ["a//b", "a-b"],
    ["-a-", "a"],
    ["foo/bar", "foo-bar"],
    ["x\\y", "x-y"],
  ];

  for (const [left, right] of collidingPairs) {
    it(`maps ${JSON.stringify(left)} and ${JSON.stringify(right)} to distinct tokens`, () => {
      expect(sanitizeRunId(left)).not.toBe(sanitizeRunId(right));
    });
    it(`maps ${JSON.stringify(left)} and ${JSON.stringify(right)} to distinct paths`, () => {
      expect(frictionCapturePath(ART, left)).not.toBe(frictionCapturePath(ART, right));
    });
  }

  it("produces filename-safe tokens (only [A-Za-z0-9._-])", () => {
    const ids = ["a/b", "a b", "héllo", "a:b\\c", "..", "", "_", "a_b"];
    for (const id of ids) {
      expect(sanitizeRunId(id)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it("is deterministic and stable for the same input", () => {
    expect(sanitizeRunId("a/b")).toBe(sanitizeRunId("a/b"));
  });

  it("yields a non-empty stem for the empty run id", () => {
    expect(sanitizeRunId("").length).toBeGreaterThan(0);
  });

  it("does not collide the empty id with any non-empty id", () => {
    const empty = sanitizeRunId("");
    for (const id of ["run", "_", "a", "0"]) {
      expect(sanitizeRunId(id)).not.toBe(empty);
    }
  });
});

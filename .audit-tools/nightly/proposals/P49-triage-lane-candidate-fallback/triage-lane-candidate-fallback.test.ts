// P49 red-green test — the leg-2 triage lane must not die on one unusable
// roster head.
//
// Paths are written for the location this test SHIPS to, `tests/shared/`,
// because vitest excludes `.audit-tools/**` and a test that lives only beside
// its proposal never runs.
//
// RED at HEAD 5b634c7d: `resolveTriageCandidates` is not exported, so the
// binding is undefined and every case throws. GREEN once resolution returns an
// ORDERED CANDIDATE LIST and the driver preflights down it.
//
// Why a candidate LIST rather than a smarter single pick: the script's own
// comment says the router "is the only thing that knows live health and quota",
// so the script must not re-rank the roster on provider names it is not allowed
// to know (CLAUDE.md — "No execution inventory in this package"). Keeping the
// router's order and merely SURVIVING an unusable head is the smallest fix that
// does not smuggle provider knowledge into the tool.
import { describe, it, expect } from "vitest";

// @ts-expect-error — untyped .mjs script imported by an ES-module test.
import { resolveTriageCandidates } from "../../scripts/shared/triage-backlog.mjs";

const roster =
  (...ids: string[]) =>
  () =>
    JSON.stringify({ data: ids.map((id) => ({ id })) });

describe("resolveTriageCandidates", () => {
  it("returns the whole roster in the router's own order, not just its head", () => {
    const candidates = resolveTriageCandidates(
      {},
      roster("anthropic", "pool/high", "pool/low", "pool/medium"),
    );
    expect(candidates).toEqual(["anthropic", "pool/high", "pool/low", "pool/medium"]);
  });

  it("puts the router's auto alias first when the roster advertises one", () => {
    const candidates = resolveTriageCandidates({}, roster("glm-4.7", "auto", "kimi-k2.6"));
    expect(candidates[0]).toBe("auto");
  });

  it("honours an explicit TRIAGE_MODEL as the ONLY candidate, never touching discovery", () => {
    const candidates = resolveTriageCandidates({ TRIAGE_MODEL: "pool/medium" }, () => {
      throw new Error("discovery must not run when TRIAGE_MODEL is set");
    });
    expect(candidates).toEqual(["pool/medium"]);
  });

  it("still aborts loudly on an empty roster, naming the escape", () => {
    expect(() => resolveTriageCandidates({}, roster())).toThrow(/TRIAGE_MODEL=/);
  });
});

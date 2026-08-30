// The declaration that makes the machine-wide verify-green ledger DEFER here.
//
// `~/.agent-config/verify-green.mjs` reads `.claude/green-mechanism.json`. When
// it parses and carries a non-empty `ownedBy`, `check` defers and `record`
// refuses, so no second ledger can exist beside this repo's own
// `suiteGreenStamp`. When it does NOT parse, that reader treats the repo as
// unowned — deliberately, so a broken declaration cannot silently disable the
// ledger for a repo that still depends on it.
//
// That safe direction is exactly why this test exists. A typo here does not
// fail loudly: it silently restores the false red that a lap opens on
// (docs/backlog/open-bugs.md), and nothing else in this tree would notice,
// because the consumer lives OUTSIDE the repo and cannot be gated from here.
// So the shape is pinned at the only boundary this repo owns — its own tree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DECLARATION = join(ROOT, ".claude", "green-mechanism.json");

describe("green-mechanism declaration", () => {
  it("parses as JSON — an unparseable file reads as UNOWNED, restoring the false red", () => {
    expect(() => JSON.parse(readFileSync(DECLARATION, "utf8"))).not.toThrow();
  });

  it("carries a non-empty `ownedBy` — the field the reader keys on", () => {
    const raw = JSON.parse(readFileSync(DECLARATION, "utf8"));
    expect(typeof raw.ownedBy).toBe("string");
    expect(raw.ownedBy.trim().length).toBeGreaterThan(0);
  });

  it("names the mechanism that actually answers here, so the deferral is actionable", () => {
    const raw = JSON.parse(readFileSync(DECLARATION, "utf8"));
    // The deferral message prints `ownedBy` verbatim. A reader who is told to
    // "ask that mechanism" must be able to find it, so it names the real file.
    expect(raw.ownedBy).toContain("scripts/shared/suiteGreenStamp.mjs");
  });

  it("states a reason — the deferral must explain itself, not just assert", () => {
    const raw = JSON.parse(readFileSync(DECLARATION, "utf8"));
    expect(typeof raw.reason).toBe("string");
    expect(raw.reason.trim().length).toBeGreaterThan(0);
  });
});

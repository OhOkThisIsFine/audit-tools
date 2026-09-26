// Contract test for the mechanical refusal of retired backend-selection
// arguments (packet 9: "reject unsupported args mechanically rather than asking
// the host to avoid them"). The retired provider/model/routing/quota/window/
// launch axes were removed as ONE architectural cut; a host must not pass them,
// and the tool now refuses them at the command boundary instead of the loaders
// asking the host to remember (which was prose the host could forget).
import { describe, it, expect } from "vitest";
import {
  RETIRED_HOST_SELECTION_ARGS,
  assertNoRetiredHostSelectionArgs,
} from "../../src/shared/index.js";

describe("assertNoRetiredHostSelectionArgs — the register is well-formed", () => {
  it("declares one stable axis id and ≥1 flag spelling per row, with unique ids", () => {
    expect(RETIRED_HOST_SELECTION_ARGS.length).toBeGreaterThan(0);
    const ids = RETIRED_HOST_SELECTION_ARGS.map((r) => r.id);
    expect(new Set(ids).size, "axis ids double as refusal keys and must be unique").toBe(
      ids.length,
    );
    for (const row of RETIRED_HOST_SELECTION_ARGS) {
      expect(row.flags.length, `${row.id} must name its spellings`).toBeGreaterThan(0);
      for (const flag of row.flags) {
        expect(flag, `${row.id}/${flag} must use the --flag spelling`).toMatch(/^--/);
      }
    }
  });
});

describe("assertNoRetiredHostSelectionArgs — the refusal fires on every retired axis", () => {
  it("is a no-op on an argv with no retired axis", () => {
    // The real workflow surface must never trip the refusal.
    expect(() =>
      assertNoRetiredHostSelectionArgs([
        "next-step",
        "--root",
        "/repo",
        "--artifacts-dir",
        "/repo/.audit-tools/audit",
        "--since",
        "HEAD~1",
        "--allow-auto-fix",
      ]),
    ).not.toThrow();
  });

  it("rejects each retired axis and names the label in the message", () => {
    for (const row of RETIRED_HOST_SELECTION_ARGS) {
      const flag = row.flags[0];
      expect(
        () => assertNoRetiredHostSelectionArgs(["next-step", flag, "x"]),
        `${flag} must be refused`,
      ).toThrow(new RegExp(row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("lists every offending axis in ONE refusal, not just the first", () => {
    expect(() =>
      assertNoRetiredHostSelectionArgs([
        "next-step",
        "--provider",
        "anthropic",
        "--model",
        "claude-5",
        "--quota",
        "10",
      ]),
    ).toThrow(/provider selection/);
    // The single message carries all three, so a caller sees the complete set
    // of removed axes at once rather than fixing them one refuse at a time.
    const message = (() => {
      try {
        assertNoRetiredHostSelectionArgs([
          "next-step",
          "--provider",
          "x",
          "--model",
          "y",
          "--quota",
          "z",
        ]);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(message).toMatch(/provider selection/);
    expect(message).toMatch(/model selection/);
    expect(message).toMatch(/quota accounting/);
  });

  it("does not reject a retired-SPELLING absent from the argv, nor an unrelated token", () => {
    // A value that merely CONTAINS the axis word is not one of its spells.
    expect(() =>
      assertNoRetiredHostSelectionArgs(["next-step", "--root", "--providerless"]),
    ).not.toThrow();
    expect(() =>
      assertNoRetiredHostSelectionArgs(["next-step", "--input", "--provider"]),
    ).toThrow(/provider selection/);
  });
});

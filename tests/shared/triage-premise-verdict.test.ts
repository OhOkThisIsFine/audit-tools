// P17 (nightly sol-3, owner decision 2026-08-09): the leg-2 backlog sweep's
// strongest verdict was wrong every time it fired.
//
// The sweep asks the model to quote a probe fragment VERBATIM FROM THE ENTRY —
// it cannot see the repo. So "every probe absent" means the entry's own prose is
// not in whatever file the model guessed, never that the code went away. It
// stamped `gone` anyway: 3 false, 0 true across two nights. Only probe
// evaluation in the nightly writer, whose probes are authored to be checkable
// against the tree, may assert goneness.
//
// Second half: a record whose probes were all unusable stamped `unprobed`, the
// same word as a record that honestly quoted nothing checkable — 30 of 121 on
// 2026-08-09, hidden under an honest-looking coverage number.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import { premiseVerdict } from "../../scripts/shared/triage-backlog.mjs";

let root: string;

function git(...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "triage-premise-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src", "audit"), { recursive: true });
  mkdirSync(join(root, "docs", "backlog"), { recursive: true });
  writeFileSync(join(root, "src", "audit", "dispatch.ts"), "export const LIVE_SYMBOL = 1;\n");
  writeFileSync(join(root, "docs", "backlog", "open-bugs.md"), "- quotes LIVE_SYMBOL here\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const rec = (probes: unknown[]) => ({ premise_probes: probes });

describe("the sweep can no longer assert goneness", () => {
  it("stamps premise_unconfirmed — NOT gone — when every probe is absent from a real file", () => {
    // The exact shape of all three false positives: a real tracked path, and a
    // fragment the model quoted from the backlog entry that is not in it.
    const { stamp } = premiseVerdict(
      rec([{ file: "src/audit/dispatch.ts", contains: "the core dispatch-inventory READ switch" }]),
      root,
    );
    expect(stamp).toBe("premise_unconfirmed");
    expect(stamp).not.toBe("gone");
  });

  it("still reports a premise that genuinely holds", () => {
    const { stamp } = premiseVerdict(
      rec([{ file: "src/audit/dispatch.ts", contains: "LIVE_SYMBOL" }]),
      root,
    );
    expect(stamp).toBe("holds");
  });
});

describe("a record that TRIED and failed is distinct from one that honestly supplied none", () => {
  it("stamps unprobed when the entry quoted nothing checkable", () => {
    expect(premiseVerdict(rec([]), root).stamp).toBe("unprobed");
  });

  it("stamps probes_unusable when probes were supplied but none could be evaluated", () => {
    const { stamp } = premiseVerdict(
      rec([{ file: "src/audit/nowhere-at-all.ts", contains: "x" }]),
      root,
    );
    expect(stamp).toBe("probes_unusable");
  });

  it("stamps probes_unusable for a probe aimed at a RECORD path, which carries no evidence", () => {
    const { stamp } = premiseVerdict(
      rec([{ file: "docs/backlog/open-bugs.md", contains: "LIVE_SYMBOL" }]),
      root,
    );
    expect(stamp).toBe("probes_unusable");
  });

  it("stamps probes_unusable, never unprobed, for malformed probes", () => {
    const { stamp } = premiseVerdict(rec([{ file: "src/audit/dispatch.ts" }]), root);
    expect(stamp).toBe("probes_unusable");
  });
});

describe("input-side recovery repairs a probe without inventing evidence", () => {
  it("resolves a bare basename against the tracked tree and RECORDS the recovery", () => {
    const { stamp, recovered } = premiseVerdict(
      rec([{ file: "dispatch.ts", contains: "LIVE_SYMBOL" }]),
      root,
    );
    expect(stamp).toBe("holds");
    expect(recovered).toEqual([
      { from: "dispatch.ts", via: "basename", to: "src/audit/dispatch.ts" },
    ]);
  });

  it("locates a file from a SYMBOL when the entry names no path at all", () => {
    const { stamp, recovered } = premiseVerdict(
      rec([{ symbol: "LIVE_SYMBOL", contains: "LIVE_SYMBOL" }]),
      root,
    );
    expect(stamp).toBe("holds");
    expect(recovered[0]).toMatchObject({ via: "symbol", to: "src/audit/dispatch.ts" });
  });

  it("refuses to guess when a basename matches MORE than one tracked file", () => {
    mkdirSync(join(root, "src", "remediate"), { recursive: true });
    writeFileSync(join(root, "src", "remediate", "dispatch.ts"), "export const OTHER = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "second dispatch");
    const { stamp, recovered } = premiseVerdict(
      rec([{ file: "dispatch.ts", contains: "LIVE_SYMBOL" }]),
      root,
    );
    // Ambiguous: left untouched and reported as unusable rather than attached to
    // whichever file happened to sort first. Guessing is what manufactured the
    // false verdicts in the first place.
    expect(recovered).toEqual([]);
    expect(stamp).toBe("probes_unusable");
  });

  it("does not let a symbol resolve off a RECORD file that merely quotes it", () => {
    // open-bugs.md contains LIVE_SYMBOL too; if record paths were searched, the
    // symbol would be ambiguous and recovery would fail. It must resolve to the
    // one SOURCE file.
    const { recovered } = premiseVerdict(
      rec([{ symbol: "LIVE_SYMBOL", contains: "LIVE_SYMBOL" }]),
      root,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].to).toBe("src/audit/dispatch.ts");
  });
});

// P22: a `contains` probe whose target doc was RETIRED (deleted) must resolve,
// not abstain. The untracked-target refusal exists to reject a gitignored
// runtime artifact — a path that EXISTS on disk but carries no evidence. A
// deleted tracked file is the opposite case: it is absent from disk, and the
// downstream history check already distinguishes "deleted" from "never existed".
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateProbes } from "../../scripts/nightly/items.mjs";

let root: string;

function git(...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "probe-retired-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), ".audit-tools/*/*\n");
  mkdirSync(join(root, "spec"), { recursive: true });
  writeFileSync(join(root, "spec", "doomed.md"), "This spec owns the whole quota model\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a retired doc closes the item that asked for its retirement", () => {
  const item = {
    id: "docs-1",
    premise_probes: [{ file: "spec/doomed.md", contains: "This spec owns the whole quota model" }],
  };

  it("holds the item open while the doc still exists", () => {
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("present");
    expect(status).toBe("open");
  });

  it("RESOLVES once the doc is deleted and the prose is nowhere in the tree", () => {
    git("rm", "-q", "spec/doomed.md");
    git("commit", "-qm", "retire the spec");
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("absent");
    expect(probes[0]?.commit).toBeTruthy();
    expect(status).toBe("resolved");
  });

  it("stays OPEN when the prose merely MOVED to another doc", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "new-home.md"), "This spec owns the whole quota model\n");
    git("rm", "-q", "spec/doomed.md");
    git("add", "-A");
    git("commit", "-qm", "move it");
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("moved");
    expect(status).toBe("open");
  });

  it("still ABSTAINS on a gitignored runtime artifact that exists on disk", () => {
    mkdirSync(join(root, ".audit-tools", "remediation"), { recursive: true });
    writeFileSync(join(root, ".audit-tools", "remediation", "state.json"), '{"s":"idle"}\n');
    const { status, probes } = evaluateProbes(root, {
      id: "x",
      premise_probes: [{ file: ".audit-tools/remediation/state.json", contains: '"s":"idle"' }],
    });
    expect(probes[0]?.state).toBe("untrackable");
    expect(status).toBe("open");
  });

  it("reports bad_path for a probe naming a file that NEVER existed", () => {
    const { status, probes } = evaluateProbes(root, {
      id: "y",
      premise_probes: [{ file: "spec/typo.md", contains: "anything" }],
    });
    expect(probes[0]?.state).toBe("bad_path");
    expect(status).toBe("open");
  });
});

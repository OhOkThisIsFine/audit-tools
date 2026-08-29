// Round-trip journal HEAD binding (open-bugs.md:291).
//
// The staged-snapshot round-trip journals two tree SHAs before rewriting the
// working tree. A hook killed mid-round-trip may be FOLLOWED by the git command
// executing (PreToolUse death does not stop the tool call), so by the next gate
// invocation HEAD can have MOVED — and an unconditional restore then
// time-travels the worktree and index backward over the new HEAD (observed
// live: a pre-rebase snapshot restored over the rebased tree). These tests pin:
//   1. recovery REFUSES + quarantines the journal when HEAD differs;
//   2. a journal with NO head binding (older gate version) is refused the same;
//   3. history-moving verbs (rebase/merge/cherry-pick/revert/am) never take the
//      materializing round-trip — the DIRECT worktree check gates them;
//   4. `git commit` keeps the staged-snapshot round-trip;
//   5. recovery still heals normally when HEAD has NOT moved.
// Fixture + rationale in pre-commit-gate-harness.ts.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  g as gIn,
  initGateRepo,
  runGate as runGateIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
const runGate = (command?: string) => runGateIn(repo, command);
const stateDir = () => join(repo, ".claude", "hooks", ".state");
const journalPath = () => join(stateDir(), "gate-roundtrip-journal.json");
const revParse = (ref: string) => g("rev-parse", ref).stdout.trim();

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

// Two commits: data.txt "one" (c1) then "two" (c2, HEAD). Returns c1's identity
// so a test can plant a journal captured "under" c1.
function makeTwoCommits() {
  writeFileSync(join(repo, "data.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "c1");
  const c1 = revParse("HEAD");
  const t1 = revParse("HEAD^{tree}");
  writeFileSync(join(repo, "data.txt"), "two\n");
  g("add", "-A");
  g("commit", "-qm", "c2");
  return { c1, t1 };
}

function plantJournal(journal: Record<string, unknown>) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify(journal, null, 2));
}

describe("pre-commit gate: round-trip journal HEAD binding (open-bugs.md:291)", () => {
  test("recovery REFUSES and quarantines when HEAD moved since the journal", () => {
    const { c1, t1 } = makeTwoCommits();
    plantJournal({ worktreeTree: t1, stagedTree: t1, head: c1, at: new Date().toISOString() });

    // Any gated invocation runs recovery first; a non-commit command keeps the
    // rest of the gate out of the picture.
    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);

    // The journaled pre-move content must NOT be applied over the new tree…
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("two");
    // …and the index must not be time-traveled either.
    expect(g("status", "--porcelain").stdout.trim()).toBe("");
    // The journal is consumed into a QUARANTINE file, never silently applied.
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "expected exactly one quarantined journal").toBe(1);
  });

  test("a legacy journal with no head binding is refused the same way", () => {
    const { t1 } = makeTwoCommits();
    plantJournal({ worktreeTree: t1, stagedTree: t1, at: new Date().toISOString() });

    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("two");
    expect(g("status", "--porcelain").stdout.trim()).toBe("");
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "expected exactly one quarantined journal").toBe(1);
  });

  test("a history-moving command with a divergent tree takes the DIRECT check, never the round-trip", () => {
    // Staged snapshot GOOD, worktree BAD → the trees diverge. The round-trip
    // would materialize the staged GOOD and allow; the direct worktree check
    // sees BAD and blocks. Blocking here is the pinned behavior: the gate must
    // not rewrite the tree around a command whose own execution rewrites it.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");

    const r = runGate("git rebase --continue");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    // No journal exists afterwards — nothing was staged for crash recovery.
    expect(existsSync(journalPath())).toBe(false);
    // The worktree was never touched.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
  });

  test("`git commit` keeps the staged-snapshot round-trip on a divergent tree", () => {
    // Same divergence as above, but the plain commit verb: the staged GOOD is
    // what lands, so the round-trip checks it and allows.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");

    const r = runGate("git commit -m x");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
  });

  test("recovery still heals normally when HEAD has NOT moved", () => {
    // Journal captured under the CURRENT Head: recovery applies the trees —
    // the pre-crash worktree content comes back and the journal is consumed.
    const { t1 } = makeTwoCommits();
    const head = revParse("HEAD");
    plantJournal({ worktreeTree: t1, stagedTree: t1, head, at: new Date().toISOString() });

    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    // The journaled trees WERE applied: data.txt is back at the journaled "one".
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("one");
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "no quarantine on a clean recovery").toBe(0);
  });
});

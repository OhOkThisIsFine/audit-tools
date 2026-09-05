// P34 spawn smoke for the pre-commit gate's DERIVED leg loop (the unit matrix
// over the derivation itself lives in precommit-leg-derivation.test.ts; this
// file proves the real hook binary runs the derived legs end-to-end). Fixture +
// rationale in pre-commit-gate-harness.ts (shared across the
// pre-commit-gate-*.test.ts family).
//
// The fixture repo wires check:backlog-index to a marker script, stages a
// backlog doc, and asserts:
//   • a wired FAILING leg blocks the commit with the leg's script name and the
//     registry fix hint in the refusal,
//   • a wired passing leg allows the commit,
//   • an UNWIRED triggered leg is skipped with a per-leg ANNOUNCED fail-open
//     (fixture repos must never false-block on scripts they do not have).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { g as gIn, initGateRepo, runCommitGate } from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
// The derived legs run at GIT's boundary (commit-gate.mjs, P53).
const runGate = () => runCommitGate(repo);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

/** Stage a backlog doc — triggers the backlog family of derived legs. */
function stageBacklogDoc() {
  mkdirSync(join(repo, "docs", "backlog"), { recursive: true });
  writeFileSync(join(repo, "docs", "backlog", "open-bugs.md"), "- a staged backlog edit\n");
  g("add", "-A");
}

/** Wire check:backlog-index in the fixture package.json to `script`. */
function wireBacklogIndex(script: string) {
  const pkgPath = join(repo, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts["check:backlog-index"] = script;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  g("add", "package.json");
}

describe("pre-commit gate: derived leg loop (P34)", () => {
  test("BLOCKS on a wired failing derived leg, naming the script and the registry fix hint", () => {
    wireBacklogIndex('node -e "process.exit(1)"');
    stageBacklogDoc();

    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("check:backlog-index");
    // The fix hint is threaded from the guard-reach registry row.
    expect(r.stderr).toContain("generate-backlog-index");
  });

  test("ALLOWS when the wired derived leg passes", () => {
    wireBacklogIndex('node -e "process.exit(0)"');
    stageBacklogDoc();

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("an UNWIRED triggered leg skips with a per-leg announced fail-open, never a block", () => {
    // No check:backlog-index in the fixture at all — the triggered leg must
    // announce its skip (a silent fail-open is indistinguishable from a pass).
    stageBacklogDoc();

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/check:backlog-index is not wired in this repo .* SKIPPED/);
  });
});

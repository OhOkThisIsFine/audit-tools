// Pre-commit gate: branch-strand refusal + fail-open announcement. Fixture +
// rationale in pre-commit-gate-harness.ts (shared across the
// pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE,
  g as gIn,
  initGateRepo,
  runGate as runGateIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
const runGate = (command?: string) => runGateIn(repo, command);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit gate: branch-strand refusal (docs-only commit on a remediation branch)", () => {
  // `ensureRemediationBranchCheckedOut` switches the PRIMARY checkout onto
  // `remediation/<runId>` and leaves it there, so a later docs/closeout commit
  // strands off main. It bit three times; the HANDOFF warning did not prevent
  // the third, so the refusal has to be mechanical.
  function stageDoc(relPath: string, body: string = "# doc\n") {
    const parts = relPath.split("/");
    if (parts.length > 1) mkdirSync(join(repo, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(repo, ...parts), body);
    g("add", "-A");
  }

  test("BLOCKS a docs-only commit on remediation/* and names the recovery", () => {
    g("branch", "-M", "main");
    g("checkout", "-qb", "remediation/PLAN-1");
    stageDoc("docs/HANDOFF.md");

    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("remediation/PLAN-1");
    expect(r.stderr).toContain("STRAND");
    // The message must carry the recovery, not just the diagnosis.
    expect(r.stderr).toContain("git checkout main && git commit");
    expect(r.stderr).toContain("docs/HANDOFF.md");
  });

  test("the same docs-only commit on main is ALLOWED (the branch is the discriminator)", () => {
    g("branch", "-M", "main");
    stageDoc("docs/HANDOFF.md");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("STRAND");
  });

  test("a MIXED staged set on remediation/* is allowed — only an entirely-docs set strands", () => {
    // Prose committed alongside the code it documents is plausibly run output,
    // and the refusal's own message names that as the way to commit it here.
    g("branch", "-M", "main");
    g("checkout", "-qb", "remediation/PLAN-2");
    writeFileSync(join(repo, "src.txt"), "code\n");
    stageDoc("docs/notes.md");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("STRAND");
  });

  test("a code-only commit on remediation/* is untouched by the refusal", () => {
    g("branch", "-M", "main");
    g("checkout", "-qb", "remediation/PLAN-3");
    writeFileSync(join(repo, "src.txt"), "code\n");
    g("add", "-A");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("STRAND");
  });

  test("a chained `git add -A && git commit` of docs on remediation/* is blocked too", () => {
    // The strand-prone shape in practice: nothing is staged yet when the gate
    // runs, so the refusal must read the set the chained add WILL stage.
    g("branch", "-M", "main");
    g("checkout", "-qb", "remediation/PLAN-4");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "HANDOFF.md"), "# doc\n"); // left UNSTAGED

    const r = runGate("git add -A && git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("STRAND");
  });

  test("an empty staged set on remediation/* is not 'entirely docs' — no block", () => {
    g("branch", "-M", "main");
    g("checkout", "-qb", "remediation/PLAN-5");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("STRAND");
  });
});

describe("pre-commit gate: a fail-open ANNOUNCES which check it skipped", () => {
  // A silent fail-open is indistinguishable from a clean pass, so the commit it
  // waved through looks verified when nothing checked it.
  test("outside a git repo, the gate allows but says the whole gate was skipped", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "gate-nonrepo-"));
    try {
      const r = spawnSync(process.execPath, [GATE], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: notARepo },
      });
      expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
      expect(r.stderr).toContain("FAIL-OPEN");
      expect(r.stderr).toContain("SKIPPED");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test("an unparseable payload allows but says no check ran", () => {
    const r = spawnSync(process.execPath, [GATE], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("FAIL-OPEN");
  });
});

// Pre-commit gate: loop-core attestation semantics — bypass scoping, attester
// class, destination-keyed concerns, and the chained-attest impossibility.
// Spawns BOTH the pre-commit gate and the attest-loop-core-review hook
// end-to-end. Fixture + rationale in pre-commit-gate-harness.ts (shared across
// the pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  g as gIn,
  initGateRepo,
  runAttest as runAttestIn,
  runGate as runGateIn,
  stageLoopCoreFile as stageLoopCoreFileIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
const runGate = (command?: string) => runGateIn(repo, command);
const runAttest = (args: string[]) => runAttestIn(repo, args);
const stageLoopCoreFile = () => stageLoopCoreFileIn(repo);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit gate: bypass scoping, attester class, destination-keyed concerns", () => {
  test("sibling-statement core.hooksPath override is rejected (scoping regression)", () => {
    // The override is armed in a statement that carries no `commit`, so a
    // commit-sub-command-scoped check never scans it — must match whole-command.
    const r = runGate("git config core.hooksPath /dev/null && git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
  });

  test("`grep -n` in a sibling statement does not false-positive the -n check", () => {
    const r = runGate("grep -n GOOD sentinel.txt && git commit -m x");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("attest script requires --attester-class and records it + detected env markers", () => {
    stageLoopCoreFile();
    const checked = "checked the fixture loop-core edit for accounting drift and off-by-one";

    const missing = runAttest(["--reviewed-by", "t", "--checked", checked]);
    expect(missing.status, `expected fail (1); stderr:\n${missing.stderr}`).toBe(1);
    expect(missing.stderr).toContain("--attester-class");

    const ok = runAttest(["--reviewed-by", "t", "--attester-class", "agent", "--checked", checked]);
    expect(ok.status, `expected success (0); stderr:\n${ok.stderr}`).toBe(0);
    const sha = g("write-tree").stdout.trim();
    const rec = JSON.parse(readFileSync(join(repo, ".claude", "loop-core-review", `${sha}.json`), "utf8"));
    expect(rec.attester_class).toBe("agent");
    expect(Array.isArray(rec.agent_env_markers)).toBe(true);
    expect(rec.reviewed_by).toBe("t");
  });

  test("concerns without override: blocked on main, accepted on a side branch (destination-keyed)", () => {
    g("branch", "-M", "main");
    stageLoopCoreFile();
    const at = runAttest([
      "--reviewed-by", "t",
      "--attester-class", "human",
      "--verdict", "concerns",
      "--checked", "review-blocked WIP preserved pending an independent adversarial review",
    ]);
    expect(at.status, `attest failed:\n${at.stderr}`).toBe(0);

    const onMain = runGate();
    expect(onMain.status, `expected block (2) on main; stderr:\n${onMain.stderr}`).toBe(2);
    expect(onMain.stderr).toContain('verdict "concerns"');

    g("checkout", "-qb", "wip/preserve");
    const onBranch = runGate();
    expect(onBranch.status, `expected allow (0) off main; stderr:\n${onBranch.stderr}`).toBe(0);
  });
});

describe("pre-commit gate: a chained attest+commit names its own impossibility", () => {
  // PreToolUse fires ONCE, on the whole Bash call, so `attest … && git commit …`
  // is checked before the attest half has run. It must stay blocked (accepting
  // the chain would trust a verdict the gate never read) — but the generic "no
  // attestation" text sent the agent to write one it had just written.
  test("blocks and explains when the attest step is chained into the commit", () => {
    stageLoopCoreFile();
    const r = runGate(
      'node .claude/hooks/attest-loop-core-review.mjs --reviewed-by t --attester-class agent ' +
        '--checked "fixture" && git commit -m x',
    );
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("CHAINS the attestation");
    expect(r.stderr).toContain("as its OWN tool call");
  });

  test("the chained-note is absent from an ordinary missing-attestation block", () => {
    stageLoopCoreFile();
    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("no adversarial-review attestation");
    expect(r.stderr).not.toContain("CHAINS the attestation");
  });

  // The script path is QUOTED in every shape an agent naturally writes it —
  // a path with a `$CLAUDE_PROJECT_DIR` prefix is quoted by reflex, and the
  // repo's own settings.json spells hook invocations that way. Detecting the
  // chain on quote-STRIPPED text blanks the span content, so the script name
  // vanishes and the explanatory note is dropped exactly when it is needed.
  test.each([
    ['double-quoted', '"$CLAUDE_PROJECT_DIR/.claude/hooks/attest-loop-core-review.mjs"'],
    ['double-quoted relative', '".claude/hooks/attest-loop-core-review.mjs"'],
    ['single-quoted', "'.claude/hooks/attest-loop-core-review.mjs'"],
  ])("blocks and explains when the chained attest path is %s", (_shape, scriptArg) => {
    stageLoopCoreFile();
    const r = runGate(
      `node ${scriptArg} --reviewed-by t --attester-class agent --checked "fixture" && git commit -m x`,
    );
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("CHAINS the attestation");
    expect(r.stderr).toContain("as its OWN tool call");
  });

  test("re-attesting after the staged tree MOVES is the same trap (attestation is sha-keyed)", () => {
    // The attestation file is named for the staged tree, so moving the tree
    // makes it MISSING, not stale — the chained form is the natural reflex
    // there ("just re-attest and commit"), and it must be named as impossible.
    stageLoopCoreFile();
    const at = runAttest([
      "--reviewed-by", "t",
      "--attester-class", "agent",
      "--checked", "checked the fixture loop-core edit for accounting drift and off-by-one",
    ]);
    expect(at.status, `attest failed:\n${at.stderr}`).toBe(0);
    writeFileSync(join(repo, "src", "shared", "quota", "x.ts"), "export const x = 2;\n");
    g("add", "-A");
    const r = runGate("node .claude/hooks/attest-loop-core-review.mjs --reviewed-by t ; git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("CHAINS the attestation");
  });
});

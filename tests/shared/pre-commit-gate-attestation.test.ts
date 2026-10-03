// Pre-commit gate: loop-core attestation semantics — bypass scoping, attester
// class, destination-keyed concerns, and the chained-attest impossibility.
// Spawns BOTH the pre-commit gate and the attest-loop-core-review hook
// end-to-end. Fixture + rationale in pre-commit-gate-harness.ts (shared across
// the pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  g as gIn,
  initGateRepo,
  runAttest as runAttestIn,
  runCommitGate,
  runGate as runGateIn,
  stageLoopCoreFile as stageLoopCoreFileIn,
  stampStagedTreeGreen,
  STAGED_LOOP_CORE_PATH,
} from "./pre-commit-gate-harness.js";
import { isLoopCorePath } from "../../.claude/hooks/loop-core-patterns.mjs";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
// The bypass refusal is the tool-boundary hook's; the attestation legs run at
// GIT's boundary (commit-gate.mjs, P53).
const runGate = (command?: string) => runGateIn(repo, command);
const runCommit = () => runCommitGate(repo);
const runAttest = (args: string[]) => runAttestIn(repo, args);
const stageLoopCoreFile = () => stageLoopCoreFileIn(repo);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

test("reports both missing attestation classes for the same staged tree", () => {
  stageLoopCoreFile();
  writeFileSync(join(repo, "CLAUDE.md"), "# Constitutional fixture\n");
  g("add", "CLAUDE.md");
  const result = runCommit();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("CONSTITUTIONAL");
  expect(result.stderr).toContain("no adversarial-review attestation");
});

describe("the fixture helper arms what it says it arms", () => {
  // The helper's own comment says it stages a file "so the loop-core
  // attestation gate arms". It used to write src/shared/quota/x.ts, which
  // isLoopCorePath returns FALSE for — the quota substrate was retired and the
  // pattern list moved on without the fixture. Nothing was broken only because
  // one consumer wrapped the helper and added a real loop-core path; a NEW test
  // calling the helper alone would have passed VACUOUSLY against a gate that
  // never fired. This case is the demanded pin: a future narrowing of the
  // pattern list reds the FIXTURE instead of silently emptying it.
  test("stageLoopCoreFile writes a path isLoopCorePath accepts", () => {
    expect(isLoopCorePath(STAGED_LOOP_CORE_PATH)).toBe(true);
    stageLoopCoreFile();
    expect(g("diff", "--cached", "--name-only").stdout).toContain(STAGED_LOOP_CORE_PATH);
  });

  test("the helper alone is enough to block the commit for a missing attestation", () => {
    // End-to-end proof the arming is real, not just a matcher assertion: with
    // no attestation on disk the gate must refuse.
    stageLoopCoreFile();
    const r = runCommit();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("no adversarial-review attestation");
  });
});

describe("an attestation requires the full suite green on the staged tree (2026-10-01: a read-only review passed a looping change)", () => {
  const ATTEST_ARGS = ["--reviewed-by", "t", "--attester-class", "agent", "--checked", "checked the staged loop-core change end to end"];
  const records = () => {
    const dir = join(repo, ".claude", "loop-core-review");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  test("no stamp at all: refused, and nothing is written or staged", () => {
    stageLoopCoreFile();
    const stagedBefore = g("write-tree").stdout.trim();
    const r = runAttestIn(repo, ATTEST_ARGS, { stamp: false });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("no full-suite green run covers the staged tree");
    expect(records()).toEqual([]);
    expect(g("write-tree").stdout.trim()).toBe(stagedBefore);
  });

  test("a stamp on OTHER content (the suite ran before the last staged edit): refused", () => {
    stageLoopCoreFile();
    stampStagedTreeGreen(repo);
    writeFileSync(join(repo, ...STAGED_LOOP_CORE_PATH.split("/")), "export const x = 2;\n");
    g("add", "-A");
    const r = runAttestIn(repo, ATTEST_ARGS, { stamp: false });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("covered different content");
    expect(records()).toEqual([]);
  });

  test("a stamp on the staged tree: the record and the ledger review both carry tests_ran", () => {
    stageLoopCoreFile();
    const tested = stampStagedTreeGreen(repo);
    const r = runAttestIn(repo, ATTEST_ARGS, { stamp: false });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [file] = records();
    const record = JSON.parse(readFileSync(join(repo, ".claude", "loop-core-review", file!), "utf8"));
    expect(record.tests_ran).toMatchObject({ scope: "full-suite", tree: tested });
    const ledger = JSON.parse(readFileSync(join(repo, ".claude", "loop-core-attestations.json"), "utf8"));
    const reviews = Object.values(ledger.reviews) as Array<{ tests_ran?: { tree: string } }>;
    expect(reviews.map((review) => review.tests_ran?.tree)).toEqual([tested]);
  });
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

    const onMain = runCommit();
    expect(onMain.status, `expected block (2) on main; stderr:\n${onMain.stderr}`).toBe(2);
    expect(onMain.stderr).toContain('verdict "concerns"');

    g("checkout", "-qb", "wip/preserve");
    const onBranch = runCommit();
    expect(onBranch.status, `expected allow (0) off main; stderr:\n${onBranch.stderr}`).toBe(0);
  });

  test("a missing attestation for a staged loop-core path blocks, naming the record to write", () => {
    stageLoopCoreFile();
    const r = runCommit();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("no adversarial-review attestation");
  });

  // Under a git hook the attestation is read when GIT runs the commit — after
  // every earlier statement of the Bash call has executed — so `attest … &&
  // git commit …` in ONE tool call now simply works. The tool-boundary hook's
  // "chained attest can never pass" refusal, and its explanatory note, are gone
  // with the legs it guarded.
  test("an attest step chained before the commit in one command is accepted by the tool-boundary hook", () => {
    stageLoopCoreFile();
    const r = runGate(
      'node .claude/hooks/attest-loop-core-review.mjs --reviewed-by t --attester-class agent ' +
        '--checked "fixture" && git commit -m x',
    );
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("CHAINS the attestation");
  });
});

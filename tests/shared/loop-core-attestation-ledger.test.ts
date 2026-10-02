// The loop-core attestation reaches a boundary every landing path crosses
// (backlog 2026-10-01). The local review record and the commit gate live only in
// each clone, so a hook-less cloud commit and a GitHub squash merge landed
// loop-core content on main with nothing checking it. The tracked ledger binds
// each loop-core path's CONTENT (blob id) to a review, and
// `check:loop-core-attestations` — in the verify:checks catalog, so CI and both
// release gates run it — judges the whole tree that landed.
//
// Drives the REAL attest hook and the REAL check script in a throwaway repo.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { g as gIn, initGateRepo, runAttest as runAttestIn, STAGED_LOOP_CORE_PATH } from "./pre-commit-gate-harness.js";
import { catalogGates } from "../../scripts/shared/verify-steps.mjs";
import { buildPreCommitLegs } from "../../scripts/shared/derived-file-preflight.mjs";
import { LEDGER_PATH } from "../../scripts/shared/loopCoreAttestationLedger.mjs";
import { isLoopCorePath } from "../../.claude/hooks/loop-core-patterns.mjs";

const CHECK = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../scripts/check-loop-core-attestations.mjs");
const SEED = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../scripts/seed-loop-core-baseline.mjs");
const CHECKED ="checked the fixture loop-core edit for a double-release on the retry path";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
const attest = (...extra: string[]) =>
  runAttestIn(repo, ["--reviewed-by", "t", "--attester-class", "agent", "--checked", CHECKED, ...extra]);

/** Run the gate the way CI runs it; `env` stands in for the GitHub runner's. */
function check(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const inherited = { ...process.env };
  delete inherited.GITHUB_BASE_REF;
  delete inherited.GITHUB_REF;
  delete inherited.GIT_INDEX_FILE;
  return spawnSync(process.execPath, [CHECK, ...args], { cwd: repo, encoding: "utf8", env: { ...inherited, ...env } });
}

function seed(...args: string[]) {
  return spawnSync(process.execPath, [SEED, ...args], { cwd: repo, encoding: "utf8" });
}

function writeLoopCore(content: string, path = STAGED_LOOP_CORE_PATH) {
  const abs = join(repo, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Stage a loop-core edit, attest it, commit — the hooked local path. */
function attestedCommit(content: string, message = "attested") {
  writeLoopCore(content);
  g("add", "--", STAGED_LOOP_CORE_PATH);
  const a = attest();
  expect(a.status, `attest failed:\n${a.stderr}`).toBe(0);
  g("commit", "-qm", message);
}

beforeEach(() => {
  repo = initGateRepo();
  g("branch", "-M", "main");
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("check:loop-core-attestations judges the tree that landed", () => {
  test("a loop-core file with no ledger is refused", () => {
    writeLoopCore("export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "unattested");
    const r = check(["--rev", "HEAD"]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`${LEDGER_PATH} is missing`);
  });

  test("the attest hook records and stages the ledger, and the attested commit passes", () => {
    attestedCommit("export const x = 1;\n");
    expect(g("ls-files", "--", LEDGER_PATH).stdout.trim()).toBe(LEDGER_PATH);
    const ledger = JSON.parse(readFileSync(join(repo, LEDGER_PATH), "utf8"));
    const entry = ledger.entries[STAGED_LOOP_CORE_PATH];
    const review = ledger.reviews[entry.review];
    expect(review.vouches).toEqual({
      [STAGED_LOOP_CORE_PATH]: g("rev-parse", `HEAD:${STAGED_LOOP_CORE_PATH}`).stdout.trim(),
    });
    expect(review.checked).toBe(CHECKED);
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  test("a hook-less commit that changes attested loop-core content is refused", () => {
    attestedCommit("export const x = 1;\n");
    // A cloud agent's commit: no .githooks, no attestation — just a commit.
    writeLoopCore("export const x = 2;\n");
    g("commit", "-qam", "cloud edit");
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`${STAGED_LOOP_CORE_PATH}: content is not the attested content`);
  });

  test("a squash merge of an attested branch passes; of an unattested branch, is refused", () => {
    attestedCommit("export const x = 1;\n");
    g("checkout", "-qb", "feature");
    attestedCommit("export const x = 2;\n", "attested on a branch");
    g("checkout", "-q", "main");
    g("merge", "--squash", "-q", "feature");
    g("commit", "-qm", "squash (attested)");
    expect(check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" }).status).toBe(0);

    g("checkout", "-qb", "cloud");
    writeLoopCore("export const x = 3;\n");
    g("commit", "-qam", "unattested branch edit");
    g("checkout", "-q", "main");
    g("merge", "--squash", "-q", "cloud");
    g("commit", "-qm", "squash (unattested)");
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("content is not the attested content");
  });

  test("a concerns verdict without an override is refused only for a target of main", () => {
    writeLoopCore("export const x = 1;\n");
    g("add", "--", STAGED_LOOP_CORE_PATH);
    expect(attest("--verdict", "concerns").status).toBe(0);
    g("commit", "-qm", "wip");
    const intoMain = check(["--rev", "HEAD"], { GITHUB_BASE_REF: "main" });
    expect(intoMain.status, intoMain.stdout + intoMain.stderr).toBe(1);
    expect(intoMain.stderr).toContain('verdict "concerns"');
    expect(check(["--rev", "HEAD"], { GITHUB_BASE_REF: "release-prep" }).status).toBe(0);
  });

  test("deleting an attested loop-core file without re-attesting leaves a refused orphan entry", () => {
    attestedCommit("export const x = 1;\n");
    unlinkSync(join(repo, ...STAGED_LOOP_CORE_PATH.split("/")));
    g("commit", "-qam", "delete");
    const r = check(["--rev", "HEAD"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a tracked loop-core file");
  });

  test("rewriting the ledger's blob ids to new content, under the old review, is refused", () => {
    attestedCommit("export const x = 1;\n");
    const oldBlob = g("rev-parse", `HEAD:${STAGED_LOOP_CORE_PATH}`).stdout.trim();
    // The forgery: change the file, then swap the new blob id in for the old one
    // everywhere the ledger records it — every review id left as it was.
    writeLoopCore("export const x = 2;\n");
    g("add", "--", STAGED_LOOP_CORE_PATH);
    const newBlob = g("rev-parse", `:${STAGED_LOOP_CORE_PATH}`).stdout.trim();
    const ledgerFile = join(repo, LEDGER_PATH);
    const text = readFileSync(ledgerFile, "utf8");
    expect(text).toContain(oldBlob);
    writeFileSync(ledgerFile, text.split(oldBlob).join(newBlob));
    g("add", "-f", "--", LEDGER_PATH);
    g("commit", "-qm", "forged");
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("does not hash to its own key");
  });
});

describe("a baseline records starting content and claims no review", () => {
  /** Commit x.ts unreviewed, seed the baseline from that commit, commit the ledger. */
  function seededRepo() {
    writeLoopCore("export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "pre-ledger content");
    const s = seed("--commit", "HEAD");
    expect(s.status, s.stdout + s.stderr).toBe(0);
    g("add", "-f", "--", LEDGER_PATH);
    g("commit", "-qm", "seed");
  }

  test("a baseline entry passes for unchanged content, and is reported apart from reviewed files", () => {
    seededRepo();
    const ledger = JSON.parse(readFileSync(join(repo, LEDGER_PATH), "utf8"));
    const [baseline] = Object.values(ledger.baselines) as Record<string, unknown>[];
    expect(Object.keys(baseline).sort()).toEqual(["commit", "vouches"]);
    expect(ledger.reviews).toEqual({});
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("0 loop-core file(s) reviewed; 1 still baseline-only");
  });

  test("changed content under a baseline entry is refused", () => {
    seededRepo();
    writeLoopCore("export const x = 2;\n");
    g("commit", "-qam", "hook-less edit");
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`${STAGED_LOOP_CORE_PATH}: content changed since the baseline`);
  });

  test("a forged baseline (blob swapped to new content) is refused", () => {
    seededRepo();
    const oldBlob = g("rev-parse", `HEAD:${STAGED_LOOP_CORE_PATH}`).stdout.trim();
    writeLoopCore("export const x = 2;\n");
    g("add", "--", STAGED_LOOP_CORE_PATH);
    const newBlob = g("rev-parse", `:${STAGED_LOOP_CORE_PATH}`).stdout.trim();
    const ledgerFile = join(repo, LEDGER_PATH);
    writeFileSync(ledgerFile, readFileSync(ledgerFile, "utf8").split(oldBlob).join(newBlob));
    g("add", "-f", "--", LEDGER_PATH);
    g("commit", "-qm", "forged baseline");
    const r = check(["--rev", "HEAD"], { GITHUB_REF: "refs/heads/main" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("does not hash to its own key");
  });

  test("the seed refuses a ledger that already has a baseline", () => {
    seededRepo();
    const s = seed("--commit", "HEAD");
    expect(s.status, s.stdout + s.stderr).toBe(1);
    expect(s.stderr).toContain("already has a baseline");
  });

  test("the gate and the seed refuse a mistyped flag and a flag missing its value with the shared refusal", () => {
    // A bare trailing `--rev` used to be read as "no rev" and judge the index;
    // a mistyped seed flag used to fail with its own wording. Both go through
    // scripts/shared/argvGuard.mjs now: exit 2, one message shape, no work done.
    for (const r of [check(["--revv", "HEAD"]), check(["--rev"]), seed("--commitx", "HEAD"), seed("--commit")]) {
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain("refuses arguments it does not recognize");
    }
    expect(existsSync(join(repo, LEDGER_PATH))).toBe(false);
  });

  test("the attest hook cannot write a baseline: it has no flag for one, and an attest writes a review", () => {
    expect(attest("--baseline").stderr).toContain("unknown argument: --baseline");
    seededRepo();
    writeLoopCore("export const x = 2;\n");
    g("add", "--", STAGED_LOOP_CORE_PATH);
    const a = attest();
    expect(a.status, a.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(join(repo, LEDGER_PATH), "utf8"));
    expect(ledger.baselines).toEqual({}); // the only baseline entry was superseded, so it is dropped
    expect(Object.keys(ledger.entries[STAGED_LOOP_CORE_PATH])).toEqual(["review"]);
    g("commit", "-qm", "reviewed");
    const r = check(["--rev", "HEAD"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("1 loop-core file(s) reviewed; 0 still baseline-only");
  });
});

describe("the attest hook vouches only for content it is told to", () => {
  const UNVOUCHED = "src/shared/engine/y.ts";

  /** Attested x.ts, then y.ts landing unreviewed, then a staged x.ts edit. */
  function unvouchedBesideStagedEdit() {
    attestedCommit("export const x = 1;\n");
    writeLoopCore("export const y = 1;\n", UNVOUCHED);
    g("add", "-A");
    g("commit", "-qm", "unattested");
    writeLoopCore("export const x = 5;\n");
    g("add", "--", STAGED_LOOP_CORE_PATH);
  }

  test("it refuses when unvouched content outside the staged set is not named, and writes nothing", () => {
    unvouchedBesideStagedEdit();
    const ledgerBefore = readFileSync(join(repo, LEDGER_PATH), "utf8");
    const a = attest();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stderr).toContain(UNVOUCHED);
    expect(a.stderr).toContain(`--include-unvouched ${UNVOUCHED}`);
    expect(readFileSync(join(repo, LEDGER_PATH), "utf8")).toBe(ledgerBefore);
    expect(g("diff", "--cached", "--name-only").stdout.trim()).toBe(STAGED_LOOP_CORE_PATH);
    expect(existsSync(join(repo, ".claude", "loop-core-review"))
      ? readdirSync(join(repo, ".claude", "loop-core-review")).length
      : 0).toBe(1); // only the earlier attestedCommit's record
  });

  test("it refuses a --include-unvouched path that is not unvouched loop-core content", () => {
    unvouchedBesideStagedEdit();
    const a = attest("--include-unvouched", UNVOUCHED, "--include-unvouched", "src/shared/engine/typo.ts");
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stderr).toContain('"src/shared/engine/typo.ts"');
  });

  test("it vouches for each unvouched path named explicitly, and lists it", () => {
    unvouchedBesideStagedEdit();
    const a = attest("--include-unvouched", UNVOUCHED);
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain(UNVOUCHED);
    expect(a.stdout).toContain("named with --include-unvouched");
    g("commit", "-qm", "attested");
    const ledger = JSON.parse(readFileSync(join(repo, LEDGER_PATH), "utf8"));
    expect(Object.keys(ledger.reviews[ledger.entries[UNVOUCHED].review].vouches).sort()).toEqual(
      [STAGED_LOOP_CORE_PATH, UNVOUCHED].sort(),
    );
    expect(check(["--rev", "HEAD"]).status).toBe(0);
  });
});

describe("the gate runs at every boundary a landing path crosses", () => {
  test("it is in the verify:checks catalog (CI on pull requests and pushes to main, pre-tag and publish gates)", () => {
    expect(catalogGates("checks").map((gate) => gate.id)).toContain("check:loop-core-attestations");
    expect(catalogGates("release").map((gate) => gate.id)).toContain("check:loop-core-attestations");
  });

  test("its pre-commit leg fires on a staged loop-core path and on the ledger itself", () => {
    const leg = buildPreCommitLegs({ packageScripts: { "check:loop-core-attestations": "node scripts/check-loop-core-attestations.mjs" } })
      .find((l) => l.script === "check:loop-core-attestations");
    expect(leg).toBeDefined();
    expect(leg!.triggered({ root: ".", staged: ["src/audit/cli/nextStepCommand.ts"] })).toBe(true);
    expect(leg!.triggered({ root: ".", staged: [LEDGER_PATH] })).toBe(true);
  });

  test("workload composition counts as loop-core", () => {
    expect(isLoopCorePath("src/audit/cli/nextStepCommand.ts")).toBe(true);
    expect(isLoopCorePath("src/audit/cli/semanticReviewStep.ts")).toBe(true);
  });
});

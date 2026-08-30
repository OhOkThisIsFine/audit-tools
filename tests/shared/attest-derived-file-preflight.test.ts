// P19 (owner decision sol-1, 2026-08-12): an attestation binds to the exact
// staged tree, but the gate that judges that tree runs later, at commit — so a
// stale derived file (backlog seek index, HANDOFF roadmap, …) used to void the
// attestation that was just written and force the same review to be attested
// twice (4 records / 3 dates). The attest scripts now run the gate's own
// derived-file checks BEFORE binding and refuse to write an attestation for a
// tree the gate would reject. The trigger predicates are single-sourced in
// scripts/shared/derived-file-preflight.mjs — the gate and both attest scripts
// import the same module, because a hand-kept second copy of the trigger list
// is a worse trap than the one this fixes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPreCommitLegs,
  scriptWired,
} from "../../scripts/shared/derived-file-preflight.mjs";
import { worktreeTree } from "../../scripts/shared/worktree-tree.mjs";
import { EXPECTED_SRC_REACH_LEG_IDS } from "../helpers/precommitLegExpectations.js";

const REPO_ROOT = join(__dirname, "..", "..");
const ATTEST_LOOP_CORE = join(REPO_ROOT, ".claude", "hooks", "attest-loop-core-review.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A real git repo with one loop-core file and a backlog doc staged on top of a
 * base commit.
 *
 * `divergence` is applied AFTER the final `git add -A`, so the worktree tree and
 * the staged tree stop being the same object — which is the whole subject of the
 * attributability cases below.
 */
function makeFixture(
  opts: { backlogIndexScript?: string; divergence?: "unstaged-edit" | "untracked" } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "attest-preflight-"));
  dirs.push(root);
  const git = (...args: string[]) => {
    const r = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const scripts: Record<string, string> = {};
  if (opts.backlogIndexScript) scripts["check:backlog-index"] = opts.backlogIndexScript;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }, null, 2));
  // Mirrors the real .gitignore's `.claude/` line. Without it the attestation
  // this script writes under .claude/loop-core-review/ is picked up by the
  // worktree-tree hash, so a SUCCESSFUL attest would move the tree it just
  // described — and the no-mutation contract pin below could never hold.
  writeFileSync(join(root, ".gitignore"), ".claude/\n");
  mkdirSync(join(root, "src", "audit", "orchestrator"), { recursive: true });
  writeFileSync(join(root, "src", "audit", "orchestrator", "advance.ts"), "export const base = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  // Stage a loop-core edit plus a backlog doc WITHOUT any index regeneration —
  // the exact shape that used to void a freshly-written attestation.
  writeFileSync(join(root, "src", "audit", "orchestrator", "advance.ts"), "export const base = 2;\n");
  mkdirSync(join(root, "docs", "backlog"), { recursive: true });
  writeFileSync(join(root, "docs", "backlog", "open-bugs.md"), "- a stale-index-shaped edit\n");
  git("add", "-A");
  if (opts.divergence === "unstaged-edit") {
    writeFileSync(join(root, "docs", "backlog", "open-bugs.md"), "- a stale-index-shaped edit\n- unstaged\n");
  } else if (opts.divergence === "untracked") {
    writeFileSync(join(root, "docs", "backlog", "later-commit.md"), "- belongs to a LATER commit\n");
  }
  return root;
}

function runAttest(root: string) {
  return spawnSyncHidden(
    "node",
    [ATTEST_LOOP_CORE, "--attester-class", "agent", "--checked", "preflight contract test adversarial pass"],
    { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
  );
}

function attestationCount(root: string): number {
  const dir = join(root, ".claude", "loop-core-review");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("attest preflight refuses to bind a tree the gate would reject", () => {
  it("REFUSES to write an attestation when a triggered derived-file check fails", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(1)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/check:backlog-index/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/generate-backlog-index/);
    expect(attestationCount(root)).toBe(0);
  });

  it("binds normally when the triggered checks pass", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(0)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(attestationCount(root)).toBe(1);
  });

  it("FAILS OPEN with an announcement when a triggered check is not wired", () => {
    const root = makeFixture(); // no check scripts at all
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(attestationCount(root)).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/SKIPPED|not wired/);
  });
});

// ── attributability: a leg result is only a VERDICT when it judged the bound tree ──
//
// The legs run `npm run <script>` in the real root, so they read the WORKING
// tree; the attestation binds the STAGED tree. When those differ, a refusal is a
// false red — an UNSTAGED registry row naming a not-yet-tracked test file (both
// belonging to a LATER commit) once refused an attestation of a staged set that
// contained neither, forcing a commit reorder. The preflight now refuses only
// when the worktree tree equals the staged tree BEFORE and AFTER the legs, and
// otherwise ABSTAINS: it still runs the legs and still prints them, but records
// them as `unattributed` instead of issuing a verdict.
describe("the preflight issues a verdict only about the tree it actually judged", () => {
  /** The single attestation record `runAttest` wrote, parsed. */
  function readAttestation(root: string): Record<string, any> {
    const dir = join(root, ".claude", "loop-core-review");
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    return JSON.parse(readFileSync(join(dir, names[0]!), "utf8"));
  }

  for (const divergence of ["unstaged-edit", "untracked"] as const) {
    it(`ABSTAINS instead of refusing when the worktree diverges from the staged tree (${divergence})`, () => {
      const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(1)"', divergence });
      const r = runAttest(root);
      // At HEAD this is status 1 / 0 attestations: the failing leg refused a
      // tree it never judged. The divergence belongs to a LATER commit.
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(attestationCount(root)).toBe(1);
      const record = readAttestation(root);
      expect(record.preflight.attributable).toBe(false);
      expect(record.preflight.unattributed).toContainEqual({
        id: "check:backlog-index",
        outcome: "failed",
      });
      // The abstention is announced, and it names the boundary that owns the question.
      expect(`${r.stdout}${r.stderr}`).toMatch(/NOT a verdict about the staged tree/);
      expect(`${r.stdout}${r.stderr}`).toMatch(/pre-commit gate materializes the staged tree/);
    });
  }

  it("records an unattributed PASS too — the false-GREEN half, silent until now", () => {
    const root = makeFixture({
      backlogIndexScript: 'node -e "process.exit(0)"',
      divergence: "unstaged-edit",
    });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const record = readAttestation(root);
    expect(record.preflight.attributable).toBe(false);
    // An unstaged fix can mask a broken STAGED tree just as easily as unstaged
    // breakage can mask a sound one. A pass that judged the disk is not evidence.
    expect(record.preflight.unattributed).toContainEqual({
      id: "check:backlog-index",
      outcome: "passed",
    });
  });

  it("still REFUSES, and now says so truthfully, when the trees are identical", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(1)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(attestationCount(root)).toBe(0);
    // The status/count pair alone is green before AND after this change — this
    // assertion is what makes the case honestly red-before. The refusal text may
    // now claim the staged tree only because identity was established, so the
    // marker is a contract, not prose.
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /verified against the staged tree \(working tree is identical\)/,
    );
  });

  it("CONTRACT PIN (not part of the red-green proof): a successful attest mutates nothing", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(0)"' });
    const treeBefore = worktreeTree(root);
    const stagedBefore = spawnSyncHidden("git", ["write-tree"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const statusBefore = spawnSyncHidden("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    // Reintroducing checkout-index or any other materialization at this boundary
    // reds this test. The checkout is shared with concurrent sessions and with a
    // background typecheck hook, so in-place surgery here is not available.
    expect(worktreeTree(root)).toBe(treeBefore);
    expect(spawnSyncHidden("git", ["write-tree"], { cwd: root, encoding: "utf8" }).stdout.trim()).toBe(stagedBefore);
    expect(spawnSyncHidden("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout).toBe(statusBefore);
  });

  it("the constitutional-doc attest abstains on the same divergence — one module, both callers", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(1)"', divergence: "unstaged-edit" });
    writeFileSync(join(root, "CLAUDE.md"), "# fixture constitutional doc\n");
    const add = spawnSyncHidden("git", ["add", "CLAUDE.md"], { cwd: root, encoding: "utf8" });
    expect(add.status).toBe(0);
    const r = spawnSyncHidden(
      "node",
      [
        join(REPO_ROOT, "scripts", "attest-constitutional-doc-change.mjs"),
        "--attester-class",
        "agent",
        "--owner-decision",
        "preflight attributability contract test, escalated in this test file",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const dir = join(root, ".claude", "constitutional-doc-review");
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, names[0]!), "utf8"));
    expect(record.preflight.attributable).toBe(false);
  });
});

describe("the leg set is the gate's, derived from the registry — single-sourced", () => {
  /** The leg ids buildPreCommitLegs would fire for a staged set in `root`. */
  function triggeredIds(root: string, staged: string[]): string[] {
    return buildPreCommitLegs({})
      .filter((leg) => leg.triggered({ root, staged }))
      .map((leg) => leg.id);
  }

  it("script wiring is probed per repo (fixture unwired, this repo wired)", () => {
    const root = makeFixture();
    expect(scriptWired(root, "check:guard-reach")).toBe(false);
    expect(scriptWired(REPO_ROOT, "check:guard-reach")).toBe(true);
  });

  it("a loop-core-only staged set triggers no doc/backlog legs — only the src-reach legs (test-tree typecheck, primitive gate, orphan-module gate) plus the unconditional guard-reach", () => {
    const root = makeFixture();
    const ids = triggeredIds(root, ["src/audit/orchestrator/advance.ts"]);
    expect(ids).toEqual([...EXPECTED_SRC_REACH_LEG_IDS]);
  });

  it("a staged backlog doc triggers the whole backlog family plus the md-corpus gates", () => {
    const root = makeFixture();
    const ids = triggeredIds(root, ["docs/backlog/open-bugs.md"]);
    for (const expected of [
      "check:doc-manifest",
      "check:backlog-index",
      "check:backlog-budget",
      "check:backlog-status",
      "check:handoff-roadmap",
      "check:doc-links",
      "check:guard-reach",
    ]) {
      expect(ids, `staged backlog md must trigger ${expected}`).toContain(expected);
    }
  });

  it("the gate and BOTH attest scripts import the shared module — no second copy", () => {
    for (const f of [
      ".claude/hooks/pre-commit-gate.mjs",
      ".claude/hooks/attest-loop-core-review.mjs",
      "scripts/attest-constitutional-doc-change.mjs",
    ]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8"), `${f} must import the shared module`).toMatch(
        /derived-file-preflight\.mjs/,
      );
    }
  });

  it("P19 parity holds by construction: the hook hard-codes no derived leg script of its own", () => {
    // The hook may only reach a verify:checks gate through the derived loop —
    // a hand-typed `npm run check:<derived leg>` in the hook would be a second
    // copy of the leg set, the exact divergence P19/P34 removed. The two
    // hand-coded legs (`npm run check`, `npm run test:doc-contract`) are not
    // check:* gates.
    const hook = readFileSync(join(REPO_ROOT, ".claude", "hooks", "pre-commit-gate.mjs"), "utf8");
    const code = hook
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    const hardcoded = [...code.matchAll(/npm run (check:[A-Za-z0-9:._-]+)/g)].map((m) => m[1]);
    expect(hardcoded).toEqual([]);
  });
});

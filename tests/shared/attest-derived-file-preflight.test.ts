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
  legCommand,
  legRunnable,
  reconcilePinObligations,
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

  // ── the abstention NAMES the divergence ────────────────────────────────────
  // The entry this closes: "the attest preflight's REFUSAL is now sound, but the
  // divergent case gets no verdict at all". The half that was still wrong is the
  // SILENCE — `failures.length === 0` looks identical whether the legs judged the
  // bound tree green or no leg judged it at all, so a caller holding an
  // abstention could not tell it apart from a pass. The reason is built where
  // both tree ids are in hand, and recorded, so the record says which side moved.
  it("names the divergence and records it — an abstention is not a silent pass", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(0)"', divergence: "unstaged-edit" });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const record = readAttestation(root);
    expect(record.preflight.attributable).toBe(false);
    // Recorded as data, not merely printed: the record outlives the scrollback.
    expect(typeof record.preflight.abstention).toBe("string");
    expect(record.preflight.abstention).toMatch(/the worktree is not the staged tree/);
    // It names BOTH sides by their tree ids, which is what makes it diagnosable.
    expect(record.preflight.abstention).toContain(String(record.preflight.worktree_tree_before).slice(0, 12));
    expect(record.preflight.abstention).toContain(String(record.preflight.staged_tree).slice(0, 12));
    // And the announcement on stderr says the same thing.
    expect(`${r.stdout}${r.stderr}`).toMatch(/the preflight ABSTAINED — NOT a verdict about the staged tree/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/the worktree is not the staged tree/);
  });

  it("records NO abstention when the trees are identical — the field means something", () => {
    // The negative half: if `abstention` were set unconditionally it would carry
    // no information, and the case above would pass vacuously.
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(0)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const record = readAttestation(root);
    expect(record.preflight.attributable).toBe(true);
    expect(record.preflight.abstention).toBeNull();
  });

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

/** The leg ids buildPreCommitLegs would fire for a staged set in `root`. */
function triggeredIds(root: string, staged: string[]): string[] {
  return buildPreCommitLegs({})
    .filter((leg) => leg.triggered({ root, staged }))
    .map((leg) => leg.id);
}

describe("the leg set is the gate's, derived from the registry — single-sourced", () => {
  it("script wiring is probed per repo (fixture unwired, this repo wired)", () => {
    const root = makeFixture();
    expect(scriptWired(root, "check:guard-reach")).toBe(false);
    expect(scriptWired(REPO_ROOT, "check:guard-reach")).toBe(true);
  });

  it("a loop-core-only staged set triggers no doc/backlog legs — only the pinned src-reach and unconditional legs", () => {
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
      ".claude/hooks/commit-gate.mjs",
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
    const hook = readFileSync(join(REPO_ROOT, ".claude", "hooks", "commit-gate.mjs"), "utf8");
    const code = hook
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    const hardcoded = [...code.matchAll(/npm run (check:[A-Za-z0-9:._-]+)/g)].map((m) => m[1]);
    expect(hardcoded).toEqual([]);
  });
});

// ── SUBJECT-KEYED pin legs ────────────────────────────────────────────────────
// The open half of the 2026-08-29 bite: a derived literal is pinned in a test
// OUTSIDE the change's neighborhood, one copy is updated, and the other is
// found shard-by-shard in CI. Reach triggers cannot see it (the pin's owner is
// untouched), so the obligation is declared as data — `PINS` maps a SUBJECT to
// the tests that assert about it — and the reconciler holds each row to what it
// CAN prove.
describe("subject-keyed pin legs oblige the tests that assert about a staged subject", () => {
  it("the SHIPPED PINS rows all resolve against this tracked tree", () => {
    // The real graph, not a fixture: a row that stops resolving obliges nothing
    // and would read as coverage. This is the same reconciliation
    // `check:pin-obligations` runs in verify:checks, asserted here so the
    // failure lands in the suite that owns the mechanism.
    const tracked = spawnSyncHidden("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    expect(
      reconcilePinObligations(tracked, (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")),
    ).toEqual([]);
  });

  it("staging a pinned SUBJECT fires its pin leg — the case reach triggers cannot see", () => {
    const root = makeFixture();
    // No reach row covers this binding: the subject's own guard row fires
    // check:guard-reach, and the pin adds the TESTS that assert about it.
    const ids = triggeredIds(root, ["scripts/guard-reach-data.mjs"]);
    expect(ids).toContain("pin:tests/shared/precommit-leg-derivation.test.ts");
    expect(ids).toContain("pin:tests/shared/guard-reach-gate.test.ts");
    // …and the leg is IDENTIFIED by its subject, so the refusal can name why.
    const leg = buildPreCommitLegs({}).find(
      (l) => l.id === "pin:tests/shared/precommit-leg-derivation.test.ts",
    );
    expect(leg?.pinSubject).toBe("scripts/guard-reach-data.mjs");
    expect(leg?.testPath).toBe("tests/shared/precommit-leg-derivation.test.ts");
  });

  it("staging a MAPPED contract-bearing doc obliges the tests the map names — the projection is live", () => {
    // The doc → test consumer map answers "which test asserts this doc's
    // content?" at CONFIGURATION time, where there is no subject to oblige; the
    // pin graph is what has a subject. So `PINS` is PROJECTED from the map, and
    // this case is what makes that projection mechanical rather than a comment:
    // without it the map is a repo-wide shape check that names tests nothing
    // ever runs when the doc it maps is the thing being edited.
    const root = makeFixture();
    const ids = triggeredIds(root, ["docs/HANDOFF.md"]);
    expect(ids).toContain("pin:tests/shared/handoff-roadmap.test.ts");
    const leg = buildPreCommitLegs({}).find(
      (l) => l.id === "pin:tests/shared/handoff-roadmap.test.ts",
    );
    expect(leg?.pinSubject).toBe("docs/HANDOFF.md");
  });

  it("staging an UNPINNED file fires no pin leg — the obligation stays narrow", () => {
    const root = makeFixture();
    const ids = triggeredIds(root, ["src/audit/orchestrator/advance.ts"]);
    expect(ids.filter((id) => id.startsWith("pin:"))).toEqual([]);
  });

  it("a pin leg is run as a TEST FILE, not as an npm script", () => {
    // The kind is a property of the leg, and both runners (the commit gate and
    // the attest preflight) ask the one shared decision for it. Deriving
    // `npm run <path>` here would make the leg silently unwired — and a skipped
    // leg reads as a pass.
    const pin = buildPreCommitLegs({}).find((l) => l.id.startsWith("pin:"));
    expect(pin).toBeDefined();
    expect(legCommand(pin!)).toEqual({
      kind: "test",
      command: `node scripts/shared/run-vitest-gate.mjs ${pin!.testPath}`,
    });
    expect(legCommand({ script: "check:guard-reach" })).toEqual({
      kind: "npm",
      command: "npm run check:guard-reach",
    });
  });

  it("runnability is judged per leg kind — a fixture repo has no tests/ tree", () => {
    const root = makeFixture();
    // The npm kind probes package.json; the test kind probes the file on disk.
    expect(legRunnable(root, { script: "check:guard-reach" })).toBe(false);
    expect(legRunnable(REPO_ROOT, { script: "check:guard-reach" })).toBe(true);
    expect(legRunnable(root, { script: "t", testPath: "tests/shared/nope.test.ts" })).toBe(false);
    expect(
      legRunnable(REPO_ROOT, { script: "t", testPath: "tests/shared/doc-manifest-gate.test.ts" }),
    ).toBe(true);
  });
});

describe("the PINS reconciler refuses a row that obliges nothing", () => {
  // Each error text is the FIX HINT the check prints, so the case asserts the
  // message names the broken half rather than merely a count.
  // A FIXTURE graph, not the shipped one: the refusals cannot be exercised
  // against `PINS` without breaking the real tree, and the `pins` seam exists
  // precisely so these paths are exercised rather than merely written.
  const SUBJECT = "src/shared/loopCorePaths.ts";
  const TEST = "tests/shared/loop-core-gate-parity.test.ts";
  const fixture = new Map([[SUBJECT, [TEST]]]);
  const clean = (p: string) => (p === TEST ? "import { x } from '../../src/shared/y.js';\n" : "");

  it("a subject that is not tracked is reported — the pin can never fire", () => {
    const errors = reconcilePinObligations([TEST], () => "export {};\n", fixture);
    expect(errors.join("\n")).toMatch(/src\/shared\/loopCorePaths\.ts/);
    expect(errors.join("\n")).toMatch(/NOT a tracked file — the pin can never fire/);
  });

  it("a subject with NO bound test is reported — an obligation that obliges nothing", () => {
    const errors = reconcilePinObligations([SUBJECT], () => "", new Map([[SUBJECT, []]]));
    expect(errors.join("\n")).toMatch(/with NO bound test/);
  });

  it("a bound test that is not tracked is reported", () => {
    const errors = reconcilePinObligations([SUBJECT], () => "", fixture);
    expect(errors.join("\n")).toMatch(/tests\/shared\/loop-core-gate-parity\.test\.ts/);
    expect(errors.join("\n")).toMatch(/which is NOT a tracked file/);
  });

  it("a bound test that cannot be read is reported rather than crashing the check", () => {
    const errors = reconcilePinObligations([SUBJECT, TEST], () => {
      throw new Error("EACCES");
    }, fixture);
    expect(errors.join("\n")).toMatch(/could not be read/);
  });

  it("a bound test importing the BUILT package is reported — no dist/ in a fresh worktree", () => {
    // A dist-dependent leg would red for a reason unrelated to the pin, so the
    // row is refused at CONFIGURATION time instead of at commit time.
    for (const source of [
      "import { isLoopCorePath } from 'audit-tools/shared';\n",
      "import { x } from '../../dist/shared/index.js';\n",
    ]) {
      const errors = reconcilePinObligations([SUBJECT, TEST], () => source, fixture);
      expect(errors.join("\n"), source).toMatch(/imports the BUILT package/);
    }
  });

  it("a well-formed row reconciles clean — the errors above are not unconditional", () => {
    // The negative half: without it every case above would pass vacuously
    // against a reconciler that reported something for any input.
    expect(reconcilePinObligations([SUBJECT, TEST], clean, fixture)).toEqual([]);
    // And a row that is clean EXCEPT for one broken half still reports exactly
    // that half — the checks are independent, not one early-return.
    const errors = reconcilePinObligations([SUBJECT, TEST], clean, new Map([[SUBJECT, [TEST, "tests/shared/ghost.test.ts"]]]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ghost\.test\.ts/);
  });
});

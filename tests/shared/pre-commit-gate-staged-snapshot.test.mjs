// Focused test for the pre-commit gate's STAGED-SNAPSHOT semantics (CP-NODE-1).
//
// The gate must validate the snapshot that will actually be COMMITTED — the
// staged index — not the dirty working tree. These tests drive the real hook
// binary end-to-end against a throwaway git repo whose `npm run check` is a
// trivial marker script that passes iff a sentinel file's content is "GOOD".
// By staging vs. leaving-in-the-worktree different sentinel values we prove the
// gate checks the STAGED content and always restores the worktree afterward.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATE = resolve(HERE, "../../.claude/hooks/pre-commit-gate.mjs");

let repo;

function g(...args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

// Run the gate with a fake `git commit` payload, CLAUDE_PROJECT_DIR = repo.
function runGate(command = "git commit -m x") {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
}

// A `check` script that passes iff sentinel.txt === "GOOD". This stands in for
// `npm run check` — the gate reads `npm run check` from the repo's package.json.
const CHECK_SCRIPT = `import { readFileSync } from "node:fs";
const v = readFileSync(new URL("./sentinel.txt", import.meta.url), "utf8").trim();
process.exit(v === "GOOD" ? 0 : 1);
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gate-staged-"));
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        type: "module",
        scripts: {
          check: "node check.mjs",
          // The doc-triggered subsets are no-ops here: these tests are about
          // WHICH gate fires for a staged markdown set, not about the content
          // checks themselves, and a missing script would make npm's own error
          // read as a gate block.
          "test:doc-contract": "node --version",
          "check:doc-manifest": "node --version",
          "check:handoff-roadmap": "node --version",
          "check:doc-links": "node --version",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(repo, "check.mjs"), CHECK_SCRIPT);
  writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
  // Mirror the real repo: the attestation dir is gitignored, so the untracked
  // attestation record survives the staged-snapshot materialization round-trip.
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  g("add", "-A");
  g("commit", "-qm", "init");
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit gate: staged-snapshot validation (CP-NODE-1)", () => {
  test("BLOCKS when the STAGED content is broken even if the working tree is good", () => {
    // Stage a BAD sentinel, then overwrite the WORKING TREE with GOOD (unstaged).
    // A working-tree check would pass (GOOD) and wrongly allow the commit; the
    // staged-snapshot check must see BAD and block.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // unstaged working-tree fix

    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("npm run check");

    // The unstaged working-tree change must be restored intact.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("GOOD");
    // Staged content is unchanged (still BAD).
    expect(g("diff", "--cached", "sentinel.txt").stdout).toContain("+BAD");
  });

  test("ALLOWS when the STAGED content is good even if the working tree is broken", () => {
    // Stage GOOD (already committed GOOD; re-stage to be explicit), then break the
    // WORKING TREE (unstaged BAD). A working-tree check would fail (BAD) and
    // wrongly block; the staged-snapshot check must see GOOD and allow.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // unstaged working-tree break

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);

    // The unstaged working-tree change must be restored intact.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
  });

  test("fast path: clean-vs-index tree checks directly and allows a good staged commit", () => {
    // Everything staged (working tree == index), sentinel GOOD → allow, no churn.
    writeFileSync(join(repo, "new.txt"), "x");
    g("add", "-A");
    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("restores untracked files after the staged-snapshot check", () => {
    // Stage a good change, leave an UNTRACKED file in the tree. The materialized
    // staged snapshot omits it; the restore must bring it back.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "untracked.txt"), "keepme");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(existsSync(join(repo, "untracked.txt")), "untracked file must be restored").toBe(true);
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("keepme");
  });

  test("git-rm trap: a staged deletion is honored and the tree restores cleanly", () => {
    // Add an extra tracked file, then `git rm` it (stages the deletion
    // immediately) while leaving an unstaged edit elsewhere. The gate must
    // materialize the staged tree (extra.txt deleted), check GOOD, allow, and
    // restore the unstaged worktree edit + keep the staged deletion.
    writeFileSync(join(repo, "extra.txt"), "e");
    g("add", "extra.txt");
    g("commit", "-qm", "add extra");
    g("rm", "-q", "extra.txt"); // stages the deletion immediately
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // unstaged worktree churn

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    // Unstaged worktree change restored; staged deletion still staged.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
    const staged = g("diff", "--cached", "--name-status").stdout;
    expect(staged).toContain("extra.txt");
  });

  test("hook-bypass (--no-verify) is still rejected before any snapshot work", () => {
    const r = runGate("git commit --no-verify -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
  });
});

describe("pre-commit gate: commit detection is subcommand-positional", () => {
  test("a read-only git command naming a path containing 'commit' is a no-op", () => {
    // `git diff -- .claude/hooks/pre-commit-gate.mjs` contains the token
    // "commit" only inside a PATH. A substring match treats it as a commit and
    // runs the full staged-snapshot round-trip (tree/index rewrites + check) on
    // a read-only command — observed live clobbering the real index. With BAD
    // staged and GOOD in the worktree, a round-trip would BLOCK; a correct
    // detector never engages at all.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent worktree
    const indexTreeBefore = g("write-tree").stdout.trim();

    const r = runGate("git diff --stat -- .claude/hooks/pre-commit-gate.mjs");
    expect(r.status, `expected no-op allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(g("write-tree").stdout.trim(), "real index must be untouched").toBe(indexTreeBefore);
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim(), "worktree must be untouched").toBe("GOOD");
  });

  test("`git -C <path> commit` is still detected through global options", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    const r = runGate(`git -C ${JSON.stringify(repo)} commit -m x`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("crash recovery: a journal left by a killed round-trip heals tree + index on the next call", () => {
    // Build the exact mid-round-trip state a killed gate instance leaves:
    // staged BAD, worktree GOOD + an untracked file → the gate journals both
    // tree SHAs, materializes the STAGED tree (worktree becomes BAD, untracked
    // file deleted) — then dies before restoring. The next gate invocation
    // (ANY command, not just a commit) must restore the worktree and index from
    // the journal.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent worktree
    writeFileSync(join(repo, "untracked.txt"), "keepme"); // untracked

    // Compute the two tree SHAs the same way the gate does.
    const stagedTree = g("write-tree").stdout.trim();
    const scratch = join(repo, "scratch-idx");
    const gs = (...args) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: scratch } });
    gs("read-tree", "HEAD");
    gs("add", "-A");
    const worktreeTree = gs("write-tree").stdout.trim();
    rmSync(scratch, { force: true });

    // Simulate the crash: worktree clobbered to the staged snapshot + journal present, no live lock.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    rmSync(join(repo, "untracked.txt"), { force: true });
    mkdirSync(join(repo, ".claude", "hooks", ".state"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "hooks", ".state", "gate-roundtrip-journal.json"),
      JSON.stringify({ worktreeTree, stagedTree, at: new Date().toISOString() }),
    );

    const r = runGate("echo hi"); // NOT a commit — recovery must still run
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("recovered an INTERRUPTED");
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim(), "worktree healed").toBe("GOOD");
    expect(existsSync(join(repo, "untracked.txt")), "untracked file healed").toBe(true);
    expect(g("write-tree").stdout.trim(), "index healed to the staged tree").toBe(stagedTree);
    expect(
      existsSync(join(repo, ".claude", "hooks", ".state", "gate-roundtrip-journal.json")),
      "journal consumed",
    ).toBe(false);
  });

  test("a LIVE lock makes a divergent-tree commit fail open (no interleaved tree surgery)", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent → round-trip path
    mkdirSync(join(repo, ".claude", "hooks", ".state", "gate-roundtrip.lock"), { recursive: true });

    const r = runGate(); // BAD staged would block — but the live lock must fail open
    expect(r.status, `expected fail-open allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("another staged-snapshot round-trip is in flight");
    // Worktree untouched by the skipped round-trip.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("GOOD");
  });

  test("chained `git add -A && git commit` gates the WORKTREE (what actually lands)", () => {
    // Staged GOOD, worktree BAD: the chained add will stage the BAD content, so
    // that is what the commit carries — the gate must check the worktree and
    // block. (The old behavior materialized the PRE-add staged snapshot: GOOD →
    // false allow → unchecked content landed.)
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // will be swept in by add -A

    const r = runGate("git add -A && git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("`git commit -am x` is a stage command too (cluster flag, not just `-a`)", () => {
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");

    const r = runGate("git commit -am x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test('`echo "git commit -m x"` is text, not a commit — gate never engages', () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent tree
    const indexTreeBefore = g("write-tree").stdout.trim();

    const r = runGate('echo "git commit -m x"');
    expect(r.status, `expected no-op allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(g("write-tree").stdout.trim()).toBe(indexTreeBefore);
  });

  test("a line-continuation commit (`git \\<newline>commit`) is still detected", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // worktree == index, both BAD

    const r = runGate("git \\\ncommit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("2c blocks a settings-referenced hook that is PRESENT on disk but gitignored", () => {
    // The commit would not carry the hook file (ignored + untracked), yet it is
    // physically present — an existsSync check passes here; the committed-tree
    // membership check must block.
    writeFileSync(join(repo, ".gitignore"), ".claude/hooks/\n");
    mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ghost.mjs"' }] } }),
    );
    writeFileSync(join(repo, ".claude", "hooks", "ghost.mjs"), "// present but ignored\n");
    g("add", "-A"); // stages settings.json + .gitignore; ghost.mjs stays ignored

    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("ghost.mjs");
  });

  test("`-n` inside a quoted commit message is text, not the no-verify flag", () => {
    // Good staged content → the commit must be ALLOWED; a raw-text `-n` match
    // inside the -m string would false-block it as a hook bypass.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    const r = runGate('git commit -m "tests: assert on grep -n output; split on -n boundaries"');
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("hook-bypass");
  });
});

const ATTEST = resolve(HERE, "../../.claude/hooks/attest-loop-core-review.mjs");

function runAttest(args) {
  return spawnSync(process.execPath, [ATTEST, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
}

// Stage a loop-core file in the fixture repo so the loop-core attestation gate arms.
function stageLoopCoreFile() {
  mkdirSync(join(repo, "src", "shared", "quota"), { recursive: true });
  writeFileSync(join(repo, "src", "shared", "quota", "x.ts"), "export const x = 1;\n");
  g("add", "-A");
}

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

describe("pre-commit gate: branch-strand refusal (docs-only commit on a remediation branch)", () => {
  // `ensureRemediationBranchCheckedOut` switches the PRIMARY checkout onto
  // `remediation/<runId>` and leaves it there, so a later docs/closeout commit
  // strands off main. It bit three times; the HANDOFF warning did not prevent
  // the third, so the refusal has to be mechanical.
  function stageDoc(relPath, body = "# doc\n") {
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

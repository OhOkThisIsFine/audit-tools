/**
 * CP-BLOCK-N-dispatch-seam — verification and write-scope primitives.
 *
 * Covers OBL-DS-01..07 and CE-001:
 *  - the write-scope gate enforces declared scope against the ACTUAL git edit set
 *    (fail-closed when git is a repo but the probe fails; never trusts
 *    self-reported amended_files).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBuildFreeVerifyCommand,
  isWholeSuiteTestCommand,
  normalizeNodeTestCommand,
  writeScopeViolations,
  enforceWriteScope,
  adjudicateWriteScope,
  verifyCommandsForEdits,
  selfContainedVerifyCommands,
  isDistDependentVerifyCommand,
  isWorktreeHostileVerifyCommand,
  partitionDeferredVerifyCommands,
  pathTokensInCommand,
  worktreeBranchForBlock,
  type GitEditedFiles,
} from "../../src/remediate/steps/dispatch.js";
import { scratchDir } from "../helpers/scratch.js";

// ---------------------------------------------------------------------------
// isBuildFreeVerifyCommand
// ---------------------------------------------------------------------------

describe("isBuildFreeVerifyCommand", () => {
  it("accepts build-free commands", () => {
    expect(isBuildFreeVerifyCommand("npm run check")).toBe(true);
    expect(isBuildFreeVerifyCommand("npx vitest run tests/foo.test.ts")).toBe(true);
    expect(isBuildFreeVerifyCommand("vitest run tests/foo.test.ts")).toBe(true);
    expect(isBuildFreeVerifyCommand("node --test tests/foo.test.mjs")).toBe(true);
    expect(isBuildFreeVerifyCommand("tsc --noEmit -p tsconfig.json")).toBe(true);
  });

  it("rejects build and build-prepending commands", () => {
    expect(isBuildFreeVerifyCommand("npm run build")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm run build --if-present")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm t")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test -- tests/remediate/x.test.ts")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm run test")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -b")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc --build")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -p tsconfig.json")).toBe(false);
    expect(isBuildFreeVerifyCommand("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDistDependentVerifyCommand — dist-dependence partition (2026-07-23 dogfood
// false-red family: a build-free worktree has no dist/, so a command whose
// named test files import/spawn dist deterministically false-reds; deferred to
// the central close gate instead).
// ---------------------------------------------------------------------------

describe("isDistDependentVerifyCommand / partitionDeferredVerifyCommands", () => {
  it("flags a command string that references a dist path directly", () => {
    expect(isDistDependentVerifyCommand("node dist/audit/index.js status")).toBe(true);
    expect(isDistDependentVerifyCommand("node dist\\remediate\\index.js validate")).toBe(true);
  });

  it("does not flag dist-free commands at the string level", () => {
    expect(isDistDependentVerifyCommand("npm run check")).toBe(false);
    expect(isDistDependentVerifyCommand("npx vitest run tests/foo.test.ts")).toBe(false);
    // 'redistribute' must not match the dist token.
    expect(isDistDependentVerifyCommand("node scripts/redistribute.mjs")).toBe(false);
  });

  it("flags a command whose named test FILE imports or spawns dist (content scan)", () => {
    const root = mkdtempSync(join(tmpdir(), "distdep-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "spawns-dist.test.mjs"),
      `import { spawnSyncHidden } from "../helpers/spawn.mjs";\n` +
        `const entry = new URL("../../dist/audit/index.js", import.meta.url);\n`,
    );
    writeFileSync(
      join(root, "tests", "joins-dist.test.mjs"),
      `import { join } from "node:path";\nconst entry = join(root, "dist", "audit", "index.js");\n`,
    );
    writeFileSync(
      join(root, "tests", "clean.test.mjs"),
      `import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(1));\n`,
    );
    expect(
      isDistDependentVerifyCommand("npx vitest run tests/spawns-dist.test.mjs", root),
    ).toBe(true);
    expect(
      isDistDependentVerifyCommand("npx vitest run tests/joins-dist.test.mjs", root),
    ).toBe(true);
    expect(isDistDependentVerifyCommand("npx vitest run tests/clean.test.mjs", root)).toBe(false);
    // A named file that does not exist in the tree cannot vouch either way.
    expect(isDistDependentVerifyCommand("npx vitest run tests/absent.test.mjs", root)).toBe(false);

    const partition = partitionDeferredVerifyCommands(
      [
        "npm run check",
        "npx vitest run tests/spawns-dist.test.mjs",
        "npx vitest run tests/clean.test.mjs",
      ],
      root,
    );
    expect(partition.kept).toEqual(["npm run check", "npx vitest run tests/clean.test.mjs"]);
    expect(partition.deferred).toEqual(["npx vitest run tests/spawns-dist.test.mjs"]);
  });
});

// ---------------------------------------------------------------------------
// isWorktreeHostileVerifyCommand — driver-lifecycle deferral (accept/reverify
// cluster defect 8): a test file that spawns the `audit-code` / `remediate-code`
// CLIs cannot pass INSIDE a node worktree — the v0.34.19 worker-context guard
// mechanically refuses driver lifecycle commands there — so a node touching such
// a test could NEVER accept. Same conservative-toward-deferral family as the
// dist-dependence probe: defer to the central close gate (root cwd).
// ---------------------------------------------------------------------------

describe("isWorktreeHostileVerifyCommand / partitionDeferredVerifyCommands", () => {
  it("flags a command whose named test FILE spawns a driver CLI (content scan)", () => {
    const root = mkdtempSync(join(tmpdir(), "wthostile-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "drives-cli.test.mjs"),
      `import { spawnSyncHidden } from "../helpers/spawn.mjs";\n` +
        `spawnSyncHidden("node", ["remediate-code.mjs", "next-step"]);\n`,
    );
    writeFileSync(
      join(root, "tests", "clean.test.mjs"),
      `import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(1));\n`,
    );
    expect(
      isWorktreeHostileVerifyCommand("npx vitest run tests/drives-cli.test.mjs", root),
    ).toBe(true);
    expect(
      isWorktreeHostileVerifyCommand("npx vitest run tests/clean.test.mjs", root),
    ).toBe(false);
    expect(
      isWorktreeHostileVerifyCommand("npx vitest run tests/absent.test.mjs", root),
    ).toBe(false);
    expect(isWorktreeHostileVerifyCommand("npm run check", root)).toBe(false);
  });

  it("partitionDeferredVerifyCommands defers BOTH classes, deduplicated, keeps the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "wthostile2-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "drives-cli.test.mjs"),
      `spawn("audit-code", ["next-step"]);\n`,
    );
    writeFileSync(
      join(root, "tests", "spawns-dist.test.mjs"),
      `const entry = join(root, "dist", "audit", "index.js");\n`,
    );
    writeFileSync(join(root, "tests", "clean.test.mjs"), `it("x", () => {});\n`);
    const partition = partitionDeferredVerifyCommands(
      [
        "npm run check",
        "npx vitest run tests/drives-cli.test.mjs",
        "npx vitest run tests/spawns-dist.test.mjs",
        "npx vitest run tests/clean.test.mjs",
        // Duplicate — the close gate's replay has no dedup of its own, so the
        // deferred list itself must not double an entry (refutation-lane concern).
        "npx vitest run tests/drives-cli.test.mjs",
      ],
      root,
    );
    expect(partition.kept).toEqual(["npm run check", "npx vitest run tests/clean.test.mjs"]);
    expect(partition.deferred).toEqual([
      "npx vitest run tests/drives-cli.test.mjs",
      "npx vitest run tests/spawns-dist.test.mjs",
    ]);
  });
});

// ---------------------------------------------------------------------------
// isWholeSuiteTestCommand — scope guard against whole-suite/directory verifies
// (the structural deadlock proven 2026-06-30: a per-node verify that runs the
// whole suite fails on a stale test owned by a different node).
// ---------------------------------------------------------------------------

describe("isWholeSuiteTestCommand", () => {
  it("flags whole-directory / whole-suite test runs", () => {
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate")).toBe(true);
    expect(isWholeSuiteTestCommand("vitest run tests/audit")).toBe(true);
    expect(isWholeSuiteTestCommand("npx vitest run")).toBe(true);
    expect(isWholeSuiteTestCommand("vitest")).toBe(true);
    expect(isWholeSuiteTestCommand("node --test tests/audit/")).toBe(true);
    expect(isWholeSuiteTestCommand("node --import tsx/esm --test tests/shared")).toBe(true);
  });

  it("keeps file-scoped test runs (a concrete .test.<ext> target)", () => {
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate/foo.test.ts")).toBe(false);
    expect(isWholeSuiteTestCommand("vitest run tests/remediate/foo.test.ts")).toBe(false);
    expect(isWholeSuiteTestCommand("node --test tests/audit/bar.test.mjs")).toBe(false);
    expect(isWholeSuiteTestCommand("node --import tsx/esm --test tests/audit/bar.test.mjs")).toBe(false);
  });

  it("does not flag non-test commands", () => {
    expect(isWholeSuiteTestCommand("npm run check")).toBe(false);
    expect(isWholeSuiteTestCommand("grep -c '/packages/' .gitignore")).toBe(false);
    expect(isWholeSuiteTestCommand("node scripts/whatever.mjs")).toBe(false);
  });

  it("a whole-suite command is build-free but must still be dropped from per-node verify", () => {
    // It passes the build-free gate (so the prior filter let it through)...
    expect(isBuildFreeVerifyCommand("npx vitest run tests/remediate")).toBe(true);
    // ...but the scope guard catches it.
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selfContainedVerifyCommands — drop a per-node verify command that references a
// SIBLING node's not-yet-created deliverable (the cross-node deadlock proven
// 2026-07-03: a node's targeted_command was `node scripts/remediate/verify-hosts.mjs`,
// another node's pending output → guaranteed-fail per-node verify).
// ---------------------------------------------------------------------------

describe("pathTokensInCommand", () => {
  it("extracts repo-relative path-like tokens (slash + extension)", () => {
    expect(pathTokensInCommand("node scripts/remediate/verify-hosts.mjs")).toEqual([
      "scripts/remediate/verify-hosts.mjs",
    ]);
    expect(pathTokensInCommand("npx vitest run tests/remediate/foo.test.ts")).toEqual([
      "tests/remediate/foo.test.ts",
    ]);
  });
  it("returns none for commands with no path tokens", () => {
    expect(pathTokensInCommand("npm run check")).toEqual([]);
    expect(pathTokensInCommand("vitest run")).toEqual([]);
  });
});

describe("selfContainedVerifyCommands", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = scratchDir(`.tmp-selfcontained-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tmp, "scripts"), { recursive: true });
    await writeFile(join(tmp, "scripts", "present.mjs"), "// present\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps a command referencing only the node's OWN declared path", () => {
    const cmds = selfContainedVerifyCommands(
      ["node scripts/remediate/verify-hosts.mjs"],
      ["scripts/remediate/verify-hosts.mjs"],
      tmp,
    );
    expect(cmds).toEqual(["node scripts/remediate/verify-hosts.mjs"]);
  });

  it("keeps a command whose path already exists in the tree", () => {
    const cmds = selfContainedVerifyCommands(["node scripts/present.mjs"], [], tmp);
    expect(cmds).toEqual(["node scripts/present.mjs"]);
  });

  it("drops a command referencing a sibling's not-yet-created deliverable", () => {
    // Not the node's own path and not present in the tree → cross-node deadlock.
    const cmds = selfContainedVerifyCommands(
      ["node scripts/remediate/verify-hosts.mjs"],
      ["src/remediate/steps/dispatch.ts"],
      tmp,
    );
    expect(cmds).toEqual([]);
  });

  it("keeps a path-free command (e.g. npm run check) unconditionally", () => {
    expect(selfContainedVerifyCommands(["npm run check"], [], tmp)).toEqual(["npm run check"]);
  });
});

// ---------------------------------------------------------------------------
// normalizeNodeTestCommand — inject the tsx loader into bare node --test
// ---------------------------------------------------------------------------

describe("normalizeNodeTestCommand — tsx loader for node:test (.mjs) verify", () => {
  it("injects --import tsx/esm into a bare node --test command", () => {
    expect(normalizeNodeTestCommand("node --test tests/audit/x.test.mjs")).toBe(
      "node --import tsx/esm --test tests/audit/x.test.mjs",
    );
    expect(
      normalizeNodeTestCommand("node --test tests/audit/a.test.mjs tests/audit/b.test.mjs"),
    ).toBe("node --import tsx/esm --test tests/audit/a.test.mjs tests/audit/b.test.mjs");
  });

  it("is idempotent — leaves a command that already carries a loader untouched", () => {
    const already = "node --import tsx/esm --test tests/audit/x.test.mjs";
    expect(normalizeNodeTestCommand(already)).toBe(already);
    const loader = "node --loader tsx/esm --test tests/audit/x.test.mjs";
    expect(normalizeNodeTestCommand(loader)).toBe(loader);
  });

  it("leaves non-node-test commands alone", () => {
    expect(normalizeNodeTestCommand("npm run check")).toBe("npm run check");
    expect(normalizeNodeTestCommand("npx vitest run tests/foo.test.ts")).toBe(
      "npx vitest run tests/foo.test.ts",
    );
    // `node` without `--test` (e.g. a script run) is not a node:test invocation.
    expect(normalizeNodeTestCommand("node scripts/seed.mjs")).toBe("node scripts/seed.mjs");
  });
});

// ---------------------------------------------------------------------------
// Write-scope primitives + gate decision
// ---------------------------------------------------------------------------

describe("writeScopeViolations", () => {
  const root = "/repo";
  it("returns nothing when all edits are within declared scope", () => {
    const declared = ["src/a.ts", "src/b.ts"];
    const edited = new Set(["src/a.ts", "src/b.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });

  it("flags an edited file outside the declared scope", () => {
    const declared = ["src/a.ts"];
    const edited = new Set(["src/a.ts", "src/secret.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual(["src/secret.ts"]);
  });

  it("exempts result JSON and the agent-feedback file from the scope check", () => {
    const declared = ["src/a.ts"];
    const edited = new Set([
      "src/a.ts",
      ".audit-tools/remediation/runs/R/implement/implement-B.result.json",
      ".audit-tools/remediation/agent-feedback.jsonl",
    ]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });

  it("normalizes absolute and back-slashed declared paths to repo-relative", () => {
    const declared = ["/repo/src/a.ts", "src\\b.ts"];
    const edited = new Set(["src/a.ts", "src/b.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });
});

describe("enforceWriteScope — gate decision (fail-closed; ignores amended_files)", () => {
  const root = "/repo";

  it("does NOT block when there is no git ground truth (not a repo)", () => {
    const edited: GitEditedFiles = { available: false, reason: "not_a_repo", error: "x" };
    expect(enforceWriteScope(["src/a.ts"], edited, root)).toEqual({ blocked: false });
  });

  it("FAILS CLOSED when git is a repo but the probe failed", () => {
    const edited: GitEditedFiles = { available: false, reason: "probe_failed", error: "boom" };
    const decision = enforceWriteScope(["src/a.ts"], edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/fail/i);
    expect(decision.reason).toMatch(/git probe failed/i);
  });

  it("does not block when actual edits are within declared scope", () => {
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts"]) };
    expect(enforceWriteScope(["src/a.ts"], edited, root)).toEqual({ blocked: false });
  });

  it("blocks when an actual edit is outside declared scope (amended_files never consulted)", () => {
    const edited: GitEditedFiles = {
      available: true,
      files: new Set(["src/a.ts", "src/elsewhere.ts"]),
    };
    const decision = enforceWriteScope(["src/a.ts"], edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("src/elsewhere.ts");
    expect(decision.reason).toMatch(/amended_files set is not trusted/i);
  });
});

describe("adjudicateWriteScope — git-actual edits, unowned-grant + seam-block (no self-report)", () => {
  const root = "/repo";
  const scopes = [
    { block_id: "A", write_paths: ["src/a.ts"] },
    { block_id: "B", write_paths: ["src/b.ts"] },
  ];

  it("does not block an edit inside the node's own declared scope", () => {
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts"]) };
    expect(adjudicateWriteScope(scopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("GRANTS an edit to an UNOWNED file no sibling declared (the defect-1 fix): not blocked", () => {
    // src/util.ts is in no block's declared scope → unowned → granted, even though
    // node A's declared scope (src/a.ts) does not list it and the worker reported nothing.
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts", "src/util.ts"]) };
    expect(adjudicateWriteScope(scopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("BLOCKS (seam conflict) an edit to a file in another block's declared scope", () => {
    // Node A edits src/b.ts, which block B owns → seam conflict, not a silent grant.
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts", "src/b.ts"]) };
    const decision = adjudicateWriteScope(scopes, "A", edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/seam conflict/i);
    expect(decision.reason).toContain("src/b.ts owned by B");
  });

  it("grants an empty-declared-scope node's edits when no sibling owns them", () => {
    const emptyScopes = [{ block_id: "A", write_paths: [] }];
    const edited: GitEditedFiles = { available: true, files: new Set(["src/x.ts", "tests/x.test.mjs"]) };
    expect(adjudicateWriteScope(emptyScopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("normalises absolute declared paths so ownership compares like-for-like", () => {
    const absScopes = [
      { block_id: "A", write_paths: [`${root}/src/a.ts`] },
      { block_id: "B", write_paths: [`${root}/src/b.ts`] },
    ];
    const edited: GitEditedFiles = { available: true, files: new Set(["src/b.ts"]) };
    const decision = adjudicateWriteScope(absScopes, "A", edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("owned by B");
  });

  it("fails closed when git could not be probed (no ground truth)", () => {
    const edited: GitEditedFiles = { available: false, reason: "probe_failed", error: "boom" };
    expect(adjudicateWriteScope(scopes, "A", edited, root).blocked).toBe(true);
  });
});

describe("verifyCommandsForEdits — derive per-node verify from touched tests (defect-2 fix)", () => {
  it("always typechecks and that command is build-free", () => {
    const cmds = verifyCommandsForEdits([]);
    expect(cmds).toEqual(["npm run check"]);
    expect(isBuildFreeVerifyCommand(cmds[0])).toBe(true);
  });

  it("runs a touched .mjs vitest file via `vitest run <file>` (no build), not the whole suite", () => {
    const cmds = verifyCommandsForEdits(["src/audit/cli/x.ts", "tests/audit/x.test.mjs"]);
    expect(cmds).toEqual([
      "npm run check",
      "npx vitest run tests/audit/x.test.mjs",
    ]);
    cmds.forEach((c) => expect(isBuildFreeVerifyCommand(c)).toBe(true));
  });

  it("runs a touched .ts vitest file via `vitest run <file>`", () => {
    const cmds = verifyCommandsForEdits(["tests/remediate/y.test.ts"]);
    expect(cmds).toEqual(["npm run check", "npx vitest run tests/remediate/y.test.ts"]);
    cmds.forEach((c) => expect(isBuildFreeVerifyCommand(c)).toBe(true));
  });

  it("groups ALL touched test files (.mjs + .ts) into one vitest run; ignores non-test edits; normalises separators", () => {
    const cmds = verifyCommandsForEdits([
      "tests\\audit\\b.test.mjs",
      "tests/audit/a.test.mjs",
      "src/x.ts",
      "tests/remediate/c.test.ts",
      "docs/readme.md",
    ]);
    expect(cmds).toEqual([
      "npm run check",
      "npx vitest run tests/audit/a.test.mjs tests/audit/b.test.mjs tests/remediate/c.test.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// worktreeBranchForBlock naming convention
// ---------------------------------------------------------------------------

describe("worktreeBranchForBlock", () => {
  it("mirrors the worktree dir naming: remediate-<blockId>-<runId>", () => {
    expect(worktreeBranchForBlock("CP-BLOCK-N-x", "RUN-9")).toBe(
      "remediate-CP-BLOCK-N-x-RUN-9",
    );
  });
});

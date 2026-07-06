import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RemediationState } from "../../state/store.js";
import { gitEditedFilesForBranch } from "./common.js";

// ---------------------------------------------------------------------------
// Build-free per-node verification commands (residual CE-001)
// ---------------------------------------------------------------------------

/**
 * The host manages the build centrally; a per-node verify command that runs
 * `npm run build` (or a `npm test` whose package script prepends a build) races
 * the central build's dist/ and is therefore forbidden. A command is build-free
 * only when it neither builds nor invokes a build-prepending test script.
 *
 * Forbidden (return false):
 *  - `npm run build` / `npm run build -w ...` / `tsc` emit (`tsc -b`, `tsc --build`)
 *  - bare `npm test` / `npm t` / `npm run test` (the package script prepends build)
 *
 * Allowed (return true):
 *  - `npm run check` (no emit)
 *  - `npx vitest run <path>` / `vitest run <path>`
 *  - `node --test <path>`
 */
export function isBuildFreeVerifyCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase().replace(/\s+/g, " ");
  if (c.length === 0) return false;
  // Any explicit build step is forbidden.
  if (/\bnpm\s+run\s+build\b/.test(c)) return false;
  if (/\btsc\b.*(-b\b|--build\b)/.test(c)) return false;
  if (/(^|\s)tsc(\s|$)/.test(c) && !/--noemit\b/.test(c)) {
    // A bare `tsc` (or `tsc -p ...`) emits unless --noEmit is set.
    return false;
  }
  // A build-prepending `npm test` / `npm t` / `npm run test` is forbidden; the
  // build-free runner (vitest run / node --test) must be invoked directly.
  if (/\bnpm\s+(test|t)\b/.test(c)) return false;
  if (/\bnpm\s+run\s+test\b/.test(c)) return false;
  return true;
}

/**
 * Inject the tsx ESM loader into a bare `node --test <file>` command so the `.mjs`
 * node:test suites (which import `audit-tools/shared` via tsconfig `paths`, honored
 * only by tsx) resolve in a per-node worktree with no built `dist/`. A host- or
 * DAG-authored `node --test tests/audit/x.test.mjs` would otherwise fail module
 * resolution; the tool normalizes it so correctness can't depend on the host
 * remembering to add the loader. Idempotent: a command already carrying
 * `--import tsx/esm` or a `--loader` is left untouched. Mirrors the runner the
 * derived verify uses ({@link verifyCommandsForEdits}), so the displayed per-node
 * command and the in-process verify match.
 */
export function normalizeNodeTestCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!/^node\b/.test(trimmed)) return cmd;
  if (!/\s--test\b/.test(trimmed)) return cmd;
  if (/--import\s+tsx\/esm\b/.test(trimmed) || /--loader\b/.test(trimmed)) return cmd;
  return trimmed.replace(/^node\b/, "node --import tsx/esm");
}

/**
 * True when `cmd` is a test-runner invocation whose target is a whole directory
 * or the entire suite rather than specific test files — e.g. `npx vitest run
 * tests/remediate`, `vitest run` (no path), `node --test tests/audit/`. Such a
 * command, run as an *additional* per-node verify alongside the scoped derive,
 * re-enters the FULL suite inside a per-node worktree. That is the structural
 * deadlock proven 2026-06-30: a source node's whole-suite verify fails on a
 * stale test owned by a DIFFERENT node, and concurrent worktrees race shared
 * test temp dirs. The derived verify already runs this node's OWN touched
 * tests, so a host/DAG-authored whole-suite command adds only risk — the tool
 * drops it rather than relying on the author to scope it (enforce-in-tooling,
 * never host discretion). A command naming at least one concrete `.test.<ext>`
 * file is scoped and kept.
 */
export function isWholeSuiteTestCommand(cmd: string): boolean {
  const c = cmd.trim();
  const isVitest = /\bvitest\b\s+run\b/.test(c) || /\bvitest\b(?!\s+run)/.test(c);
  const isNodeTest = /^node\b/.test(c) && /\s--test\b/.test(c);
  if (!isVitest && !isNodeTest) return false;
  // Tokenise; a concrete test file makes it scoped. Anything that is a runner
  // with no concrete test-file target (bare runner, or a directory/glob target)
  // is whole-suite.
  const namesConcreteTestFile = /(^|\s)[^\s]*\.test\.(ts|tsx|mjs|cjs|js)(\s|$)/.test(c);
  return !namesConcreteTestFile;
}

/**
 * Filter a node's `targeted_commands` to the build-free subset for the per-node
 * verify section. Build-prepending or build commands are dropped (the host runs
 * the build centrally) rather than emitted into the prompt. Whole-suite /
 * whole-directory test runs are dropped too — they re-enter the full suite in a
 * per-node worktree and re-create the cross-node verify deadlock (the scoped
 * derive already covers this node's own tests). Surviving `node --test`
 * commands are normalized to carry the tsx loader.
 */
export function buildFreeVerifyCommands(commands: string[] | undefined): string[] {
  if (!Array.isArray(commands)) return [];
  return commands
    .filter(
      (c) =>
        typeof c === "string" &&
        isBuildFreeVerifyCommand(c) &&
        !isWholeSuiteTestCommand(c),
    )
    .map(normalizeNodeTestCommand);
}

/**
 * Repo-relative path-like tokens in a shell command — tokens containing a `/` and a
 * file extension (e.g. `scripts/remediate/verify-hosts.mjs`, `tests/x.test.ts`).
 * Used to decide whether a targeted verify command is self-contained.
 */
export function pathTokensInCommand(cmd: string): string[] {
  const tokens = cmd.match(/(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g) ?? [];
  return [...new Set(tokens.map((t) => t.replace(/\\/g, "/")))];
}

/**
 * Keep only the targeted verify commands that are SELF-CONTAINED for this node:
 * every path-like token they reference is either one of the node's own paths (its
 * declared write set ∪ the files it actually edited on its branch) or already
 * present in the tree. A command referencing a path this node doesn't own and that
 * isn't in the tree depends on a SIBLING node's not-yet-created deliverable —
 * running it in per-node verify is a guaranteed-fail deadlock (proven 2026-07-03: a
 * node's `targeted_command` was `node scripts/remediate/verify-hosts.mjs`, another
 * node's pending output). Per-node verify must be self-contained; such a cross-node
 * command is dropped here and deferred to the integration/close gate. A command with
 * no path tokens (e.g. `npm run check`) is always kept.
 */
export function selfContainedVerifyCommands(
  commands: string[],
  ownPaths: Iterable<string>,
  treeRoot: string,
): string[] {
  const owned = new Set([...ownPaths].map((p) => p.replace(/\\/g, "/")));
  return commands.filter((cmd) => {
    for (const token of pathTokensInCommand(cmd)) {
      if (owned.has(token)) continue;
      if (existsSync(join(treeRoot, token))) continue;
      return false;
    }
    return true;
  });
}

/** A repo-relative test path → the runner that executes that file directly. */
function verifyRunnerForTestFile(repoRelPath: string): string | undefined {
  // ONE vitest runner across all suites (audit / shared / remediate). The node:test
  // split was retired 2026-07-02, so every tracked `.test.mjs` / `.test.ts` file is a
  // vitest file — running a `.mjs` vitest suite under `node --test` throws "Vitest
  // failed to access its internal state". vitest resolves `audit-tools/shared` via its
  // config alias, so a per-node worktree needs no prior build (`npx vitest run <file>`).
  if (/^tests\/.+\.test\.(mjs|ts|tsx)$/.test(repoRelPath)) return "vitest";
  return undefined;
}

/**
 * Derive a node's per-node verify commands from the test files it ACTUALLY touched
 * on its worktree branch (the git ground truth), instead of trusting host-authored
 * `targeted_commands` whose paths/runner can drift from where the worker put the
 * test. Always typechecks (`npm run check`, no emit), then runs ONLY this node's
 * own touched test files with the repo's runners — never the whole suite (which
 * would re-enter worktree-spawning tests inside a nested worktree). Build-free: the
 * host owns the central build; a node's own test imports the source it changed via
 * the tsx loader. Returns `[]` when there is no git ground truth so the caller can
 * skip the gate rather than fabricate a command.
 */
/** Pure assembly (git-free) of the verify commands for a set of edited paths —
 *  the testable core of {@link deriveVerifyCommandsFromBranch}. */
export function verifyCommandsForEdits(editedFiles: Iterable<string>): string[] {
  const vitestTests: string[] = [];
  for (const f of editedFiles) {
    const rel = f.replace(/\\/g, "/");
    if (verifyRunnerForTestFile(rel) === "vitest") vitestTests.push(rel);
  }
  const cmds = ["npm run check"];
  if (vitestTests.length > 0) {
    cmds.push(`npx vitest run ${vitestTests.sort().join(" ")}`);
  }
  return cmds;
}

export function deriveVerifyCommandsFromBranch(root: string, branch: string): string[] {
  const edited = gitEditedFilesForBranch(root, branch);
  if (!edited.available) return [];
  return verifyCommandsForEdits(edited.files);
}

/**
 * A node's own `targeted_commands` for the per-node verify (task_7d35176d) — the union
 * of the block's `targeted_commands` and its findings' `targeted_commands` (the
 * auditor-specified, fix-specific verification). `acceptNodeWorktree` runs these IN
 * ADDITION to the derived touched-test commands (build-free subset, deduped), so a
 * fix-specific regression check is honoured even when the fix touches no test file.
 */
export function targetedCommandsForBlock(state: RemediationState, blockId: string): string[] {
  const block = state.plan?.blocks?.find((b) => b.block_id === blockId);
  if (!block) return [];
  const out = [...(block.targeted_commands ?? [])];
  for (const fid of block.items) {
    const finding = state.plan?.findings?.find((f) => f.id === fid);
    for (const c of finding?.targeted_commands ?? []) out.push(c);
  }
  return [...new Set(out)];
}

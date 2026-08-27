/**
 * remediate-code `--root` resolution — the same two arms audit-code's
 * `getRootDir` grows in `src/audit/cli/args.ts`.
 *
 * The commander default used to be the literal `"."` on every `--root`-bearing
 * command, so a run launched from a nested cwd rooted the remediation at that
 * SUBDIRECTORY and minted a second `.audit-tools/remediation` tree there. The
 * property is now tool-guaranteed rather than something the host must remember
 * by passing `--root` on every call (auditor-agnostic robustness):
 *
 *   • no `--root` → DISCOVERED from the caller's working directory (nearest
 *     ancestor owning `.audit-tools/` or `.git`, below the HOME ceiling), so
 *     every cwd inside one repository resolves the SAME root.
 *   • `--root <X>` → `resolveRepoRoot(X)` verbatim, so a sub-project inside a
 *     larger repo stays the sub-project and running from outside the target
 *     repository keeps its explicit override.
 */
import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDIT_TOOLS_CALLER_CWD_ENV } from "audit-tools/shared";
import { program, resolveRootOption } from "../../src/remediate/index.js";

/** Run `fn` with the wrapper-stamped caller cwd pointed at `dir`. */
function withCallerCwd<T>(dir: string, fn: () => T): T {
  const previous = process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
  process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
    else process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = previous;
  }
}

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "remediate-cli-root-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

// ---------------------------------------------------------------------------
// The CLASS guard, not one instance: NO `--root`-bearing command may carry a
// literal default. A `"."` default collapses "the user passed `--root .`" and
// "no `--root`" into the same value, which is precisely what makes the absent
// arm undiscoverable — so a future command that reintroduces one reds here
// rather than silently rooting a remediation at the caller's subdirectory.
// ---------------------------------------------------------------------------

test("every remediate-code command declaring --root leaves it defaultless", () => {
  const withRoot = program.commands
    .map((cmd) => ({
      name: cmd.name(),
      opt: cmd.options.find((o) => o.long === "--root"),
    }))
    .filter((entry) => entry.opt !== undefined);

  // Guard the guard: if the option disappears from every command this test must
  // fail loudly rather than pass vacuously over an empty list.
  expect(withRoot.map((entry) => entry.name).sort()).toEqual([
    "next-step",
    "recover-ingest",
    "recover-submission",
    "validate-artifact",
    "validate-artifacts",
  ]);
  for (const { name, opt } of withRoot) {
    expect(opt!.defaultValue, `${name} --root must have no literal default`).toBeUndefined();
  }
});

test("resolveRootOption: no --root resolves the repo root from a NESTED cwd inside the repo", () => {
  const repo = tempRepo();
  try {
    const nested = join(repo, "src", "remediate", "steps");
    mkdirSync(nested, { recursive: true });
    expect(withCallerCwd(nested, () => resolveRootOption(undefined))).toBe(
      resolve(repo),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveRootOption: no --root resolves the repo root from a cwd inside .audit-tools/", () => {
  const repo = tempRepo();
  try {
    const drifted = join(repo, ".audit-tools", "remediation", "steps");
    mkdirSync(drifted, { recursive: true });
    expect(withCallerCwd(drifted, () => resolveRootOption(undefined))).toBe(
      resolve(repo),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveRootOption: an explicit --root . resolves the caller's cwd verbatim through resolveRepoRoot", () => {
  const repo = tempRepo();
  try {
    // A sub-project inside a larger repo: an explicit root is an INSTRUCTION,
    // never a hint, so discovery must not re-home it to the outer repo.
    const subProject = join(repo, "packages", "widget");
    mkdirSync(subProject, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(subProject);
    try {
      // `--root .` is the literal the old commander default supplied on every
      // command; supplied EXPLICITLY it must still mean "the cwd", unclimbed.
      expect(withCallerCwd(repo, () => resolveRootOption("."))).toBe(
        resolve(process.cwd()),
      );
    } finally {
      process.chdir(previousCwd);
    }
    // And an explicit absolute root wins over the caller's cwd entirely — the
    // run-from-outside-the-target-repository case the flag exists for.
    const elsewhere = mkdtempSync(join(tmpdir(), "remediate-cli-elsewhere-"));
    try {
      expect(
        withCallerCwd(elsewhere, () => resolveRootOption(subProject)),
      ).toBe(resolve(subProject));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

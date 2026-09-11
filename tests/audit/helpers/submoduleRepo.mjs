/**
 * A real parent repo with one committed first-party submodule — the fixture for
 * every test whose subject is `git ls-files --recurse-submodules`.
 *
 * WHY IT LIVES HERE. Two suites need it now: `submodule-tracked-corpus.test.ts`
 * (the disposition rule and the grounding corpus must agree about what
 * "tracked" means) and `scope-index-staleness.test.ts` (the index probe behind
 * `scope_index_key` must see a submodule's index move, or a stale
 * `file_disposition.json` is carried forward). A second hand-copied fixture
 * would be a drift made of memory: the failure mode under test is the git
 * INVOCATION's flags, so a copy that quietly stopped recursing would keep its
 * own suite green while proving nothing.
 *
 * Only a real index can distinguish the two invocations, which is why this
 * builds a real repo on disk rather than mocking git.
 *
 * The returned root owns everything it created; the caller deletes it (both
 * suites collect the roots and `rm -rf` them in `afterEach`).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The window-hidden wrapper, per INV-WH — a test file never imports a raw
// spawn/exec entry point from node:child_process.
import { execFileHidden as execFile } from "../../helpers/spawn.mjs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Run one git command in `cwd`, rejecting on a non-zero exit. */
export async function git(cwd, args) {
  await run("git", args, { cwd, windowsHide: true });
}

/** True when a `git` binary can be run at all — the suites' skip predicate. */
export async function gitAvailable() {
  try {
    await run("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A parent repo (`outer`) with one committed submodule at `sub` containing
 * `sub/a.ts`, plus a plain tracked sibling `b.ts` at the parent root.
 *
 * Returns `{ root, dispose }`: `root` is the PARENT repo (the one whose index
 * the callers probe), `dispose` removes everything the fixture created —
 * including the scratch directory holding both repos, which removing `root`
 * alone would leave behind.
 */
export async function submoduleRepo() {
  const base = await mkdtemp(join(tmpdir(), "audit-submodule-"));
  const inner = join(base, "inner");
  const outer = join(base, "outer");
  await mkdir(inner, { recursive: true });
  await mkdir(outer, { recursive: true });

  await git(inner, ["init", "-q"]);
  await git(inner, ["config", "user.email", "t@example.invalid"]);
  await git(inner, ["config", "user.name", "t"]);
  await writeFile(join(inner, "a.ts"), "export const x = 1;\n");
  await git(inner, ["add", "-A"]);
  await git(inner, ["commit", "-qm", "inner"]);

  await git(outer, ["init", "-q"]);
  await git(outer, ["config", "user.email", "t@example.invalid"]);
  await git(outer, ["config", "user.name", "t"]);
  await writeFile(join(outer, "b.ts"), "export const y = 2;\n");
  await git(outer, ["add", "-A"]);
  await git(outer, ["commit", "-qm", "outer"]);
  await git(outer, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "../inner",
    "sub",
  ]);
  await git(outer, ["commit", "-qm", "add submodule"]);
  return {
    root: outer,
    dispose: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

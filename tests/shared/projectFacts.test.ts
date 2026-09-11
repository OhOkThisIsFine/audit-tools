// Project-fact detection offers closing-action CANDIDATES from what the
// repository's shape makes appropriate; it never selects one (owner decision
// 92b0e2dd7cfdc06d, 2026-08-31). These tests pin the derivation rule on real
// fixture repos and the pure rule on synthetic signals.
import { test, expect } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  CLOSING_ACTIONS,
  candidateClosingActions,
  detectProjectFacts,
  type ProjectSignals,
} from "audit-tools/shared";

async function withFixtureRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "project-facts-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(root: string, ...args: string[]): void {
  const result = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

const NO_SIGNALS: ProjectSignals = {
  git_repo: false,
  remotes: [],
  manifests: [],
  package_private: null,
  package_publishable: false,
  release_scripts: [],
  ci_config: [],
};

test("a bare directory offers only none and custom, and is of unknown type", async () => {
  await withFixtureRepo(async (root) => {
    const facts = await detectProjectFacts(root);
    expect(facts.project_type).toBe("unknown");
    expect(facts.candidate_closing_actions).toEqual(["none", "custom"]);
    expect(facts.signals.git_repo).toBe(false);
    expect(facts.signals.remotes).toEqual([]);
  });
});

test("a git repo without a remote offers commit and tag but never push or open-pr", async () => {
  await withFixtureRepo(async (root) => {
    git(root, "init", "--quiet");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts: { test: "vitest" } }),
    );
    const facts = await detectProjectFacts(root);
    expect(facts.project_type).toBe("node");
    expect(facts.candidate_closing_actions).toEqual(["commit", "tag", "none", "custom"]);
    expect(facts.signals.package_private).toBe(true);
    expect(facts.signals.package_publishable).toBe(false);
    expect(facts.commands.test).toEqual(["npm", "test"]);
    // Rationale names the fact behind every offered candidate, and only those.
    expect(Object.keys(facts.candidate_rationale).sort()).toEqual(
      [...facts.candidate_closing_actions].sort(),
    );
  });
});

test("a remote makes push and open-pr appropriate, and a publishable package.json makes publish appropriate", async () => {
  await withFixtureRepo(async (root) => {
    git(root, "init", "--quiet");
    git(root, "remote", "add", "origin", "https://example.invalid/fixture.git");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { "release:patch": "x" } }),
    );
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    const facts = await detectProjectFacts(root);
    expect(facts.candidate_closing_actions).toEqual([
      "commit", "push", "open-pr", "publish", "tag", "none", "custom",
    ]);
    expect(facts.signals.remotes).toEqual(["origin"]);
    expect(facts.signals.remotes.join(" ")).not.toContain("example.invalid");
    expect(facts.signals.release_scripts).toEqual(["release:patch"]);
    expect(facts.signals.ci_config).toEqual([".github/workflows"]);
    expect(facts.candidate_rationale.push).toContain("origin");
  });
});

test("a python manifest sets the project type and offers publish by manifest shape", async () => {
  await withFixtureRepo(async (root) => {
    await writeFile(join(root, "pyproject.toml"), '[project]\nname = "fixture"\n');
    await writeFile(join(root, "go.mod"), "module fixture\n");
    const facts = await detectProjectFacts(root);
    expect(facts.project_type).toBe("python+go");
    expect(facts.candidate_closing_actions).toEqual(["publish", "none", "custom"]);
    expect(facts.candidate_rationale.publish).toContain("pyproject.toml");
  });
});

test("a malformed package.json narrows the facts instead of throwing", async () => {
  await withFixtureRepo(async (root) => {
    await writeFile(join(root, "package.json"), "{ not json");
    const facts = await detectProjectFacts(root);
    expect(facts.project_type).toBe("node");
    expect(facts.signals.package_private).toBeNull();
    expect(facts.candidate_closing_actions).toEqual(["none", "custom"]);
  });
});

test("the candidate rule emits CLOSING_ACTIONS order and always keeps none and custom", () => {
  const everything = candidateClosingActions({
    git_repo: true,
    remotes: ["origin", "upstream"],
    manifests: ["package.json"],
    package_private: false,
    package_publishable: true,
    release_scripts: [],
    ci_config: [],
  });
  expect(everything.candidates).toEqual([...CLOSING_ACTIONS]);
  expect(everything.rationale.push).toContain("origin, upstream");

  const nothing = candidateClosingActions(NO_SIGNALS);
  expect(nothing.candidates).toEqual(["none", "custom"]);

  const releaseOnly = candidateClosingActions({ ...NO_SIGNALS, release_scripts: ["publish"] });
  expect(releaseOnly.candidates).toEqual(["publish", "none", "custom"]);
  expect(releaseOnly.rationale.publish).toContain("publish");
});

// ── The isolated-branch landing gap is CLOSED BY DECISION, and pinned ────────
//
// A forward-tracks entry asked for `merge-to-base` back, conditioned on one
// premise: that a remediation run is dispatched ON its own `remediation/<runId>`
// branch. The tool created that branch (`ensureRemediationBranchCheckedOut`)
// until the execution substrate was retired in 467b1e8f, and it exists nowhere
// in `src/` now — the host owns branch and worktree selection, like every other
// execution choice. So the premise is gone and the decision is that
// isolated-branch dispatch is NOT returning; the vocabulary stays as it is.
//
// Pinned, not merely written down: the decision's whole content is the ABSENCE
// of branch-creating tooling, and an absence has no other way to hold. A future
// change that reintroduces the tool side of the pairing fails here by name and
// has to re-open the decision deliberately.
test("no landing action, because nothing in the tool creates a run branch", async () => {
  expect(CLOSING_ACTIONS).not.toContain("merge-to-base");

  const walk = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(abs)));
      else if (entry.name.endsWith(".ts")) found.push(abs);
    }
    return found;
  };
  // The branch CREATOR, by the name it had while it existed. Comment text is
  // stripped so the doc comments that RECORD the deletion do not trip this.
  const creatorPattern = /ensureRemediationBranchCheckedOut|checkoutBranchForRun/;
  const hits: string[] = [];
  for (const file of await walk(join(process.cwd(), "src"))) {
    const source = await readFile(file, "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    if (creatorPattern.test(code)) hits.push(file);
  }
  expect(hits).toEqual([]);
});

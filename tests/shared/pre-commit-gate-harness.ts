// Shared fixture for the pre-commit-gate-*.test.ts family (split from the
// former single pre-commit-gate-staged-snapshot.test.ts so no one file
// dominates a CI shard — the wall-clock brief's T4; these tests are sequential
// within a file, so file-splitting is what buys parallelism).
//
// The fixture drives the real hook binaries end-to-end against a throwaway git
// repo whose `npm run check` is a trivial marker script that passes iff a
// sentinel file's content is "GOOD". By staging vs. leaving-in-the-worktree
// different sentinel values the tests prove the gate checks the STAGED content
// and always restores the worktree afterward.
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const GATE = resolve(HERE, "../../.claude/hooks/pre-commit-gate.mjs");
export const ATTEST = resolve(HERE, "../../.claude/hooks/attest-loop-core-review.mjs");

// A `check` script that passes iff sentinel.txt === "GOOD". This stands in for
// `npm run check` — the gate reads `npm run check` from the repo's package.json.
const CHECK_SCRIPT = `import { readFileSync } from "node:fs";
const v = readFileSync(new URL("./sentinel.txt", import.meta.url), "utf8").trim();
process.exit(v === "GOOD" ? 0 : 1);
`;

export function g(repo: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

// Run the gate with a fake `git commit` payload, CLAUDE_PROJECT_DIR = repo.
// `sessionId` (when given) rides the payload as `session_id` — the child-session
// refusal keys on it; existing callers omit it and the payload stays shape-
// identical to before. The spawn env SCRUBS the two dispatch vars before
// applying overrides: a dispatched child session carries
// AUDIT_TOOLS_CHILD_SESSION=1 and an exported AUDIT_TOOLS_AGENT_GIT in the dev
// shell would silently disable the very refusal under test (the
// hook-trap-guards scrub rationale). A case testing one re-adds it via `env`.
export function runGate(
  repo: string,
  command: string = "git commit -m x",
  { sessionId, env = {} }: { sessionId?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const inherited = { ...process.env };
  delete inherited.AUDIT_TOOLS_AGENT_GIT;
  delete inherited.AUDIT_TOOLS_CHILD_SESSION;
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    }),
    encoding: "utf8",
    env: { ...inherited, CLAUDE_PROJECT_DIR: repo, ...env },
  });
}

export function runAttest(repo: string, args: string[]) {
  return spawnSync(process.execPath, [ATTEST, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
}

// Stage a loop-core file in the fixture repo so the loop-core attestation gate arms.
export function stageLoopCoreFile(repo: string) {
  mkdirSync(join(repo, "src", "shared", "quota"), { recursive: true });
  writeFileSync(join(repo, "src", "shared", "quota", "x.ts"), "export const x = 1;\n");
  g(repo, "add", "-A");
}

// Create the throwaway fixture repo (initial commit: GOOD sentinel, marker
// check script, gitignored .claude/). Callers own removal in afterEach.
export function initGateRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gate-staged-"));
  g(repo, "init", "-q");
  g(repo, "config", "user.email", "t@t");
  g(repo, "config", "user.name", "t");
  g(repo, "config", "commit.gpgsign", "false");
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
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  return repo;
}

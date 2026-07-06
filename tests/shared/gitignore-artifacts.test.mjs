import { test, expect } from "vitest";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  ALWAYS_IGNORE_PATTERNS,
  PUBLIC_TREE_IGNORE,
  DELIVERABLE_REINCLUDES,
  AGENT_FEEDBACK_REINCLUDE,
  PRIVATE_TREE_PATTERNS,
  renderGitignoreBlock,
  mergeGitignoreBlock,
  detectRepoVisibility,
  ensureArtifactGitignore,
  parseVisibilityOverride,
  REPO_VISIBILITY_ENV,
  GITIGNORE_BLOCK_BEGIN,
  GITIGNORE_BLOCK_END,
} = await import("../../src/shared/io/gitignoreArtifacts.ts");

/** Exact-line membership (avoids `.audit-tools/` substring-matching `.audit-tools/*`). */
function blockLines(block) {
  return block.split("\n").map((l) => l.trim());
}

// readEnv stub that resolves nothing (no env config/override) — keeps the
// detector from reading the real process.env in tests.
const noEnv = () => undefined;

// Stubbed visibility detector — NO live gh. Returns gh-shaped stdout for a given
// isPrivate, or null to simulate gh missing/failed.
function stubGh(isPrivate) {
  return () => (isPrivate === null ? null : JSON.stringify({ isPrivate }));
}

// In-memory fs hooks so ensureArtifactGitignore never touches disk.
function memFs(initial) {
  const store = new Map(initial ? [[".gitignore", initial]] : []);
  return {
    fileExists: (p) => store.has(key(p)),
    readFile: (p) => store.get(key(p)) ?? "",
    writeFile: (p, c) => store.set(key(p), c),
    read: () => store.get(".gitignore"),
  };
  function key(p) {
    return p.endsWith(".gitignore") ? ".gitignore" : p;
  }
}

const REPO = "/tmp/repo";

test("always-ignore patterns present for BOTH private and public", () => {
  for (const visibility of ["private", "public"]) {
    const block = renderGitignoreBlock(visibility);
    for (const pat of ALWAYS_IGNORE_PATTERNS) {
      expect(block.includes(pat), `${visibility} block should ignore ${pat}`).toBeTruthy();
    }
  }
});

test("private re-includes deliverables + reflections over a contents-level ignore; public blanket-ignores the tree", () => {
  const priv = blockLines(renderGitignoreBlock("private"));
  const pub = blockLines(renderGitignoreBlock("public"));

  // Private: the runtime tree is ignored at the CONTENTS level (never the dir
  // itself, else re-includes can't work), and every deliverable + reflections
  // file is re-included.
  expect(priv.includes(".audit-tools/*"), "private ignores top-level contents").toBeTruthy();
  expect(priv.includes(".audit-tools/*/*"), "private ignores subdir contents").toBeTruthy();
  expect(!priv.includes(PUBLIC_TREE_IGNORE), "private must NOT blanket-ignore the dir").toBeTruthy();
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(priv.includes(reinclude), `private re-includes ${reinclude}`).toBeTruthy();
  }

  // Public: a single blanket dir-ignore, no re-includes.
  expect(pub.includes(PUBLIC_TREE_IGNORE), "public blanket-ignores the tree").toBeTruthy();
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(!pub.includes(reinclude), `public must NOT re-include ${reinclude}`).toBeTruthy();
  }
});

test("private re-include chain actually tracks deliverables under real git (and ignores runtime state)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gi-real-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    for (const d of ["audit/steps", "remediation"]) mkdirSync(path.join(dir, ".audit-tools", d), { recursive: true });
    const files = [
      ".audit-tools/state.json",
      ".audit-tools/audit-report.md",
      ".audit-tools/audit-findings.json",
      ".audit-tools/remediation-report.md",
      ".audit-tools/remediation-outcomes.json",
      ".audit-tools/audit/agent-feedback.jsonl",
      ".audit-tools/audit/audit_results.jsonl",
      ".audit-tools/audit/steps/current-step.json",
      ".audit-tools/remediation/agent-feedback.jsonl",
    ];
    for (const f of files) writeFileSync(path.join(dir, f), "x");
    writeFileSync(path.join(dir, ".gitignore"), renderGitignoreBlock("private") + "\n");
    const isIgnored = (f) => {
      try {
        execFileSync("git", ["-C", dir, "check-ignore", "-q", f]);
        return true;
      } catch {
        return false;
      }
    };
    // Tracked (NOT ignored): the 4 deliverables + both reflections files.
    for (const f of [
      ".audit-tools/audit-report.md",
      ".audit-tools/audit-findings.json",
      ".audit-tools/remediation-report.md",
      ".audit-tools/remediation-outcomes.json",
      ".audit-tools/audit/agent-feedback.jsonl",
      ".audit-tools/remediation/agent-feedback.jsonl",
    ]) {
      expect(!isIgnored(f), `${f} must be tracked (not ignored)`).toBeTruthy();
    }
    // Ignored: runtime state.
    for (const f of [
      ".audit-tools/state.json",
      ".audit-tools/audit/audit_results.jsonl",
      ".audit-tools/audit/steps/current-step.json",
    ]) {
      expect(isIgnored(f), `${f} must be ignored`).toBeTruthy();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("friction sidecar ignored at any depth UNDER the artifact tree (anchored, never shadows source)", () => {
  const frictionPats = ALWAYS_IGNORE_PATTERNS.filter((p) => p.includes("friction"));
  expect(frictionPats.length, "exactly one friction always-ignore pattern").toBe(1);
  const pat = frictionPats[0];
  // Any-depth UNDER the artifact tree — covers `.audit-tools/audit/friction/`,
  // `.audit-tools/remediation/friction/`, and any nested artifacts dir.
  expect(pat.startsWith(".audit-tools/"), `friction pattern is anchored to the artifact tree: ${pat}`).toBeTruthy();
  expect(pat.includes("**/"), `friction pattern is any-depth under the anchor: ${pat}`).toBeTruthy();
  expect(pat.endsWith("friction/"), `friction pattern targets the dir: ${pat}`).toBeTruthy();
  // The anchor is load-bearing: a bare `**/friction/` also matches the
  // `src/shared/friction/` SOURCE dir (which once dropped a new source file from a
  // node merge and broke the base build). The pattern must NOT match a source path.
  expect(!pat.startsWith("**/"), "friction pattern is NOT a bare any-depth glob (would shadow src/shared/friction/)").toBeTruthy();
});

test("patterns are OS-agnostic — forward slashes, LF only", () => {
  const block = renderGitignoreBlock("public");
  expect(!block.includes("\\"), "no backslashes").toBeTruthy();
  expect(!block.includes("\r"), "no CR").toBeTruthy();
  for (const pat of [
    ...ALWAYS_IGNORE_PATTERNS,
    PUBLIC_TREE_IGNORE,
    ...PRIVATE_TREE_PATTERNS,
  ]) {
    expect(!pat.includes("\\"), `${pat} uses forward slashes`).toBeTruthy();
  }
});

test("detector: stubbed private => private, public => public", () => {
  expect(detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv })).toBe("private");
  expect(detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv })).toBe("public");
});

test("detector: missing/failing gh degrades to UNKNOWN (never silent private), never throws", () => {
  expect(detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(null), readEnv: noEnv })).toBe("unknown");
  expect(detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv })).toBe("unknown");
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      runGh: () => {
        throw new Error("gh blew up");
      },
    })).toBe("unknown");
  expect(detectRepoVisibility({ repoRoot: REPO, runGh: () => "not json", readEnv: noEnv })).toBe("unknown");
});

test("detector: committed visibility file pins the decision over gh", () => {
  // Public repo per gh, but the committed file forces track (private).
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      readVisibilityFile: () => "track",
      runGh: stubGh(false),
    })).toBe("private");
  // File `ignore` => public even if gh says private.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      readVisibilityFile: () => "ignore",
      runGh: stubGh(true),
    })).toBe("public");
  // Unrecognized / absent file => falls through to gh.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      readVisibilityFile: () => null,
      runGh: stubGh(false),
    })).toBe("public");
});

test("detector authority order: override > env > file > gh > unknown", () => {
  // env beats the committed file.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: (n) => (n === REPO_VISIBILITY_ENV ? "public" : undefined),
      readVisibilityFile: () => "track",
      runGh: stubGh(true),
    })).toBe("public");
  // file beats gh.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      readVisibilityFile: () => "track",
      runGh: stubGh(false),
    })).toBe("private");
});

test("detector authority order: override > env config > gh > unknown", () => {
  // 1. Explicit override beats env + gh.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      override: "private",
      readEnv: () => "public",
      runGh: stubGh(false),
    })).toBe("private");
  // 2. Env config beats gh when no explicit override.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: (n) => (n === REPO_VISIBILITY_ENV ? "public" : undefined),
      runGh: stubGh(true),
    })).toBe("public");
  // env alias track => private.
  expect(detectRepoVisibility({
      repoRoot: REPO,
      readEnv: (n) => (n === REPO_VISIBILITY_ENV ? "track" : undefined),
      runGh: stubGh(false),
    })).toBe("private");
  // 3. gh used when no override/env.
  expect(detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv, runGh: stubGh(false) })).toBe("public");
  // 4. unknown when nothing resolves.
  expect(detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv, runGh: stubGh(null) })).toBe("unknown");
});

test("parseVisibilityOverride: aliases + unrecognized => null", () => {
  expect(parseVisibilityOverride("private")).toBe("private");
  expect(parseVisibilityOverride("track")).toBe("private");
  expect(parseVisibilityOverride("PUBLIC")).toBe("public");
  expect(parseVisibilityOverride("ignore")).toBe("public");
  expect(parseVisibilityOverride("")).toBe(null);
  expect(parseVisibilityOverride(undefined)).toBe(null);
  expect(parseVisibilityOverride("maybe")).toBe(null);
});

test("explicit override always wins over gh detection", () => {
  // gh says public, override forces private.
  expect(detectRepoVisibility({ repoRoot: REPO, override: "private", runGh: stubGh(false), readEnv: noEnv })).toBe("private");
  // gh says private, override forces public.
  expect(detectRepoVisibility({ repoRoot: REPO, override: "public", runGh: stubGh(true), readEnv: noEnv })).toBe("public");
});

test("unknown visibility => tracked default + LOUD warning", () => {
  const fs = memFs();
  const warnings = [];
  const res = ensureArtifactGitignore({
    repoRoot: REPO,
    runGh: stubGh(null),
    readEnv: noEnv,
    warn: (m) => warnings.push(m),
    ...fs,
  });
  expect(res.visibility).toBe("unknown");
  // Tracked default: deliverables re-included, not blanket-ignored.
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(fs.read().includes(reinclude)).toBeTruthy();
  }
  expect(!blockLines(fs.read()).includes(PUBLIC_TREE_IGNORE)).toBeTruthy();
  // Always-ignore still present.
  for (const pat of ALWAYS_IGNORE_PATTERNS) expect(fs.read().includes(pat)).toBeTruthy();
  // Loud warning emitted, naming the env override.
  expect(warnings.length).toBe(1);
  expect(warnings[0].includes(REPO_VISIBILITY_ENV)).toBeTruthy();
});

test("ensure: private repo tracks deliverables, public ignores them", () => {
  const priv = memFs();
  const privRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv, ...priv });
  expect(privRes.visibility).toBe("private");
  for (const pat of ALWAYS_IGNORE_PATTERNS) expect(priv.read().includes(pat)).toBeTruthy();
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(priv.read().includes(reinclude), `private re-includes ${reinclude}`).toBeTruthy();
  }
  expect(!blockLines(priv.read()).includes(PUBLIC_TREE_IGNORE)).toBeTruthy();

  const pub = memFs();
  const pubRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...pub });
  expect(pubRes.visibility).toBe("public");
  expect(blockLines(pub.read()).includes(PUBLIC_TREE_IGNORE)).toBeTruthy();
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(!pub.read().includes(reinclude)).toBeTruthy();
  }
});

test("ensure: override flips the conditional decision", () => {
  // gh says public but operator overrides to private => deliverables tracked.
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, override: "private", runGh: stubGh(false), readEnv: noEnv, ...fs });
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(fs.read().includes(reinclude)).toBeTruthy();
  }
  expect(!blockLines(fs.read()).includes(PUBLIC_TREE_IGNORE)).toBeTruthy();
});

test("ensure: re-run is idempotent (no duplicate blocks)", () => {
  const fs = memFs();
  const first = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs });
  expect(first.changed).toBe(true);
  const content1 = fs.read();
  const second = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs });
  expect(second.changed, "second run makes no change").toBe(false);
  expect(fs.read(), "byte-identical on re-run").toBe(content1);
  const begins = content1.split(GITIGNORE_BLOCK_BEGIN).length - 1;
  const ends = content1.split(GITIGNORE_BLOCK_END).length - 1;
  expect(begins, "exactly one managed block").toBe(1);
  expect(ends).toBe(1);
});

test("ensure: visibility change replaces block in place, never duplicates", () => {
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv, ...fs }); // private
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs }); // public
  const content = fs.read();
  expect(content.split(GITIGNORE_BLOCK_BEGIN).length - 1).toBe(1);
  // Now public: the blanket tree-ignore is present, the private re-includes gone.
  expect(blockLines(content).includes(PUBLIC_TREE_IGNORE)).toBeTruthy();
  for (const reinclude of [...DELIVERABLE_REINCLUDES, AGENT_FEEDBACK_REINCLUDE]) {
    expect(!content.includes(reinclude)).toBeTruthy();
  }
});

test("merge: never clobbers user lines outside markers", () => {
  const userLines = "node_modules/\ndist/\n*.log\n";
  const merged = mergeGitignoreBlock(userLines, renderGitignoreBlock("public"));
  expect(merged.includes("node_modules/")).toBeTruthy();
  expect(merged.includes("*.log")).toBeTruthy();
  expect(merged.includes(GITIGNORE_BLOCK_BEGIN)).toBeTruthy();
  // Re-merge with a fresh block must keep the user lines and not stack blocks.
  const remerged = mergeGitignoreBlock(merged, renderGitignoreBlock("private"));
  expect(remerged.includes("node_modules/")).toBeTruthy();
  expect(remerged.split(GITIGNORE_BLOCK_BEGIN).length - 1).toBe(1);
});

test("merge: CRLF input normalizes to LF with single trailing newline", () => {
  const crlf = "node_modules/\r\ndist/\r\n";
  const merged = mergeGitignoreBlock(crlf, renderGitignoreBlock("private"));
  expect(!merged.includes("\r")).toBeTruthy();
  expect(merged.endsWith("\n")).toBeTruthy();
  expect(!merged.endsWith("\n\n")).toBeTruthy();
});

test("ensure: degrades to no-op when writeFile throws (never propagates)", () => {
  const res = ensureArtifactGitignore({
    repoRoot: REPO,
    runGh: stubGh(false),
    fileExists: () => false,
    readFile: () => "",
    writeFile: () => {
      throw new Error("disk full");
    },
  });
  expect(res.changed).toBe(false);
  expect(res.visibility).toBe("public");
});

import test from "node:test";
import assert from "node:assert/strict";

const {
  ALWAYS_IGNORE_PATTERNS,
  VISIBILITY_CONDITIONAL_PATTERNS,
  renderGitignoreBlock,
  mergeGitignoreBlock,
  detectRepoVisibility,
  ensureArtifactGitignore,
  parseVisibilityOverride,
  REPO_VISIBILITY_ENV,
  GITIGNORE_BLOCK_BEGIN,
  GITIGNORE_BLOCK_END,
} = await import("../../src/shared/io/gitignoreArtifacts.ts");

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
      assert.ok(block.includes(pat), `${visibility} block should ignore ${pat}`);
    }
  }
});

test("deliverables + reflections ABSENT for private, PRESENT for public", () => {
  const priv = renderGitignoreBlock("private");
  const pub = renderGitignoreBlock("public");
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) {
    assert.ok(!priv.includes(pat), `private must NOT ignore ${pat}`);
    assert.ok(pub.includes(pat), `public must ignore ${pat}`);
  }
});

test("friction sidecar ignored at ANY depth (repo-relative ** glob, not single-segment)", () => {
  const frictionPats = ALWAYS_IGNORE_PATTERNS.filter((p) => p.includes("friction"));
  assert.equal(frictionPats.length, 1, "exactly one friction always-ignore pattern");
  const pat = frictionPats[0];
  // Any-depth glob, not the old single-segment `.audit-tools/*/friction/`.
  assert.ok(pat.startsWith("**/"), `friction pattern is any-depth: ${pat}`);
  assert.ok(pat.endsWith("friction/"), `friction pattern targets the dir: ${pat}`);
  // Old single-segment form was `.audit-tools/*/friction/`; new form is not pinned there.
  assert.ok(!pat.includes(".audit-tools/"), "not pinned to a fixed .audit-tools layout");
});

test("patterns are OS-agnostic — forward slashes, LF only", () => {
  const block = renderGitignoreBlock("public");
  assert.ok(!block.includes("\\"), "no backslashes");
  assert.ok(!block.includes("\r"), "no CR");
  for (const pat of [...ALWAYS_IGNORE_PATTERNS, ...VISIBILITY_CONDITIONAL_PATTERNS]) {
    assert.ok(!pat.includes("\\"), `${pat} uses forward slashes`);
  }
});

test("detector: stubbed private => private, public => public", () => {
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv }),
    "private",
  );
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv }),
    "public",
  );
});

test("detector: missing/failing gh degrades to UNKNOWN (never silent private), never throws", () => {
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(null), readEnv: noEnv }),
    "unknown",
  );
  assert.equal(detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv }), "unknown");
  assert.equal(
    detectRepoVisibility({
      repoRoot: REPO,
      readEnv: noEnv,
      runGh: () => {
        throw new Error("gh blew up");
      },
    }),
    "unknown",
  );
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: () => "not json", readEnv: noEnv }),
    "unknown",
  );
});

test("detector authority order: override > env config > gh > unknown", () => {
  // 1. Explicit override beats env + gh.
  assert.equal(
    detectRepoVisibility({
      repoRoot: REPO,
      override: "private",
      readEnv: () => "public",
      runGh: stubGh(false),
    }),
    "private",
  );
  // 2. Env config beats gh when no explicit override.
  assert.equal(
    detectRepoVisibility({
      repoRoot: REPO,
      readEnv: (n) => (n === REPO_VISIBILITY_ENV ? "public" : undefined),
      runGh: stubGh(true),
    }),
    "public",
  );
  // env alias track => private.
  assert.equal(
    detectRepoVisibility({
      repoRoot: REPO,
      readEnv: (n) => (n === REPO_VISIBILITY_ENV ? "track" : undefined),
      runGh: stubGh(false),
    }),
    "private",
  );
  // 3. gh used when no override/env.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv, runGh: stubGh(false) }),
    "public",
  );
  // 4. unknown when nothing resolves.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, readEnv: noEnv, runGh: stubGh(null) }),
    "unknown",
  );
});

test("parseVisibilityOverride: aliases + unrecognized => null", () => {
  assert.equal(parseVisibilityOverride("private"), "private");
  assert.equal(parseVisibilityOverride("track"), "private");
  assert.equal(parseVisibilityOverride("PUBLIC"), "public");
  assert.equal(parseVisibilityOverride("ignore"), "public");
  assert.equal(parseVisibilityOverride(""), null);
  assert.equal(parseVisibilityOverride(undefined), null);
  assert.equal(parseVisibilityOverride("maybe"), null);
});

test("explicit override always wins over gh detection", () => {
  // gh says public, override forces private.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, override: "private", runGh: stubGh(false), readEnv: noEnv }),
    "private",
  );
  // gh says private, override forces public.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, override: "public", runGh: stubGh(true), readEnv: noEnv }),
    "public",
  );
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
  assert.equal(res.visibility, "unknown");
  // Tracked default: conditional patterns are NOT ignored.
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(!fs.read().includes(pat));
  // Always-ignore still present.
  for (const pat of ALWAYS_IGNORE_PATTERNS) assert.ok(fs.read().includes(pat));
  // Loud warning emitted, naming the env override.
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(REPO_VISIBILITY_ENV));
});

test("ensure: private repo tracks deliverables, public ignores them", () => {
  const priv = memFs();
  const privRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv, ...priv });
  assert.equal(privRes.visibility, "private");
  for (const pat of ALWAYS_IGNORE_PATTERNS) assert.ok(priv.read().includes(pat));
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(!priv.read().includes(pat));

  const pub = memFs();
  const pubRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...pub });
  assert.equal(pubRes.visibility, "public");
  for (const pat of [...ALWAYS_IGNORE_PATTERNS, ...VISIBILITY_CONDITIONAL_PATTERNS]) {
    assert.ok(pub.read().includes(pat));
  }
});

test("ensure: override flips the conditional decision", () => {
  // gh says public but operator overrides to private => deliverables tracked.
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, override: "private", runGh: stubGh(false), readEnv: noEnv, ...fs });
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(!fs.read().includes(pat));
});

test("ensure: re-run is idempotent (no duplicate blocks)", () => {
  const fs = memFs();
  const first = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs });
  assert.equal(first.changed, true);
  const content1 = fs.read();
  const second = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs });
  assert.equal(second.changed, false, "second run makes no change");
  assert.equal(fs.read(), content1, "byte-identical on re-run");
  const begins = content1.split(GITIGNORE_BLOCK_BEGIN).length - 1;
  const ends = content1.split(GITIGNORE_BLOCK_END).length - 1;
  assert.equal(begins, 1, "exactly one managed block");
  assert.equal(ends, 1);
});

test("ensure: visibility change replaces block in place, never duplicates", () => {
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), readEnv: noEnv, ...fs }); // private
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), readEnv: noEnv, ...fs }); // public
  const content = fs.read();
  assert.equal(content.split(GITIGNORE_BLOCK_BEGIN).length - 1, 1);
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(content.includes(pat));
});

test("merge: never clobbers user lines outside markers", () => {
  const userLines = "node_modules/\ndist/\n*.log\n";
  const merged = mergeGitignoreBlock(userLines, renderGitignoreBlock("public"));
  assert.ok(merged.includes("node_modules/"));
  assert.ok(merged.includes("*.log"));
  assert.ok(merged.includes(GITIGNORE_BLOCK_BEGIN));
  // Re-merge with a fresh block must keep the user lines and not stack blocks.
  const remerged = mergeGitignoreBlock(merged, renderGitignoreBlock("private"));
  assert.ok(remerged.includes("node_modules/"));
  assert.equal(remerged.split(GITIGNORE_BLOCK_BEGIN).length - 1, 1);
});

test("merge: CRLF input normalizes to LF with single trailing newline", () => {
  const crlf = "node_modules/\r\ndist/\r\n";
  const merged = mergeGitignoreBlock(crlf, renderGitignoreBlock("private"));
  assert.ok(!merged.includes("\r"));
  assert.ok(merged.endsWith("\n"));
  assert.ok(!merged.endsWith("\n\n"));
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
  assert.equal(res.changed, false);
  assert.equal(res.visibility, "public");
});

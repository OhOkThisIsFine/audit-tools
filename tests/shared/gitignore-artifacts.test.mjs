import test from "node:test";
import assert from "node:assert/strict";

const {
  ALWAYS_IGNORE_PATTERNS,
  VISIBILITY_CONDITIONAL_PATTERNS,
  renderGitignoreBlock,
  mergeGitignoreBlock,
  detectRepoVisibility,
  ensureArtifactGitignore,
  GITIGNORE_BLOCK_BEGIN,
  GITIGNORE_BLOCK_END,
} = await import("../../src/shared/io/gitignoreArtifacts.ts");

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
    detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(true) }),
    "private",
  );
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(false) }),
    "public",
  );
});

test("detector: missing/failing gh degrades to private (default-safe), never throws", () => {
  assert.equal(detectRepoVisibility({ repoRoot: REPO, runGh: stubGh(null) }), "private");
  assert.equal(detectRepoVisibility({ repoRoot: REPO }), "private");
  assert.equal(
    detectRepoVisibility({
      repoRoot: REPO,
      runGh: () => {
        throw new Error("gh blew up");
      },
    }),
    "private",
  );
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, runGh: () => "not json" }),
    "private",
  );
});

test("explicit override always wins over gh detection", () => {
  // gh says public, override forces private.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, override: "private", runGh: stubGh(false) }),
    "private",
  );
  // gh says private, override forces public.
  assert.equal(
    detectRepoVisibility({ repoRoot: REPO, override: "public", runGh: stubGh(true) }),
    "public",
  );
});

test("ensure: private repo tracks deliverables, public ignores them", () => {
  const priv = memFs();
  const privRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), ...priv });
  assert.equal(privRes.visibility, "private");
  for (const pat of ALWAYS_IGNORE_PATTERNS) assert.ok(priv.read().includes(pat));
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(!priv.read().includes(pat));

  const pub = memFs();
  const pubRes = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), ...pub });
  assert.equal(pubRes.visibility, "public");
  for (const pat of [...ALWAYS_IGNORE_PATTERNS, ...VISIBILITY_CONDITIONAL_PATTERNS]) {
    assert.ok(pub.read().includes(pat));
  }
});

test("ensure: override flips the conditional decision", () => {
  // gh says public but operator overrides to private => deliverables tracked.
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, override: "private", runGh: stubGh(false), ...fs });
  for (const pat of VISIBILITY_CONDITIONAL_PATTERNS) assert.ok(!fs.read().includes(pat));
});

test("ensure: re-run is idempotent (no duplicate blocks)", () => {
  const fs = memFs();
  const first = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), ...fs });
  assert.equal(first.changed, true);
  const content1 = fs.read();
  const second = ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), ...fs });
  assert.equal(second.changed, false, "second run makes no change");
  assert.equal(fs.read(), content1, "byte-identical on re-run");
  const begins = content1.split(GITIGNORE_BLOCK_BEGIN).length - 1;
  const ends = content1.split(GITIGNORE_BLOCK_END).length - 1;
  assert.equal(begins, 1, "exactly one managed block");
  assert.equal(ends, 1);
});

test("ensure: visibility change replaces block in place, never duplicates", () => {
  const fs = memFs();
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(true), ...fs }); // private
  ensureArtifactGitignore({ repoRoot: REPO, runGh: stubGh(false), ...fs }); // public
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

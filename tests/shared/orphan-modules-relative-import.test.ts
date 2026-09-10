// Contract test for the relative-import pass of check:orphan-modules
// (Track 2.5, docs/backlog/forward-tracks.md).
//
// The class: a production module whose only production importers are BARRELS
// that nothing in production consumes, so its whole production story is a
// re-export chain ending in nothing — and its only real reader is its own test.
// knip cannot see it (its vitest plugin makes test files entries), and the
// file-level reachability walk cannot either (a re-export edge is an edge).
//
// The pass asks the SYMBOL question through a real TypeScript program, because
// only the checker follows `export { x } from "./y.js"` through aliasing and
// barrel depth. This test drives it over fixture trees on disk, so both the
// detection and the exemptions are pinned rather than assumed.
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { relativeImportOrphans } from "../../scripts/check-orphan-modules.mjs";

const roots: string[] = [];

/** Write a throwaway tree and return its root, staging the named files. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "orphan-relative-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  // `roots.pop()` read into a local: `while (roots.length)` does not narrow the
  // element out of `string | undefined` when the pop is a call ARGUMENT, and a
  // JSDoc cast is inert in a .ts file (`check:tests` caught exactly this).
  let dir = roots.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = roots.pop();
  }
});

/** Run the pass over a fixture, treating every staged `src/**` file as production. */
function run(root: string, files: Record<string, string>) {
  const prodFiles = Object.keys(files).filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  const testFiles = Object.keys(files).filter((f) => f.startsWith("tests/"));
  return relativeImportOrphans({ root, prodFiles, testFiles });
}

const ENTRY = 'export * from "./dead.js";\n';

describe("relative-import pass — a module whose only production edge is an unconsumed re-export", () => {
  test("the slimdown shape: a module re-exported by an entry nothing in production consumes", () => {
    const files: Record<string, string> = {
      "src/shared/index.ts": ENTRY,
      "src/shared/dead.ts": "export const deadHelper = (): number => 1;\n",
      "tests/shared/dead.test.ts": 'import { deadHelper } from "../../src/shared/dead.js";\n',
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual(["src/shared/dead.ts"]);
  });

  test("a module reached through a NON-entry barrel that production also consumes is not flagged", () => {
    // The barrel itself is imported by a consumer that USES the symbol, so the
    // name flows — the chain does not end in nothing.
    const files: Record<string, string> = {
      "src/audit/index.ts": 'export * from "./impl.js";\n',
      "src/audit/impl.ts": 'import { liveHelper } from "./barrel.js";\nexport const impl = () => liveHelper();\n',
      "src/audit/barrel.ts": 'export { liveHelper } from "./live.js";\n',
      "src/audit/live.ts": "export const liveHelper = (): number => 1;\n",
      "tests/audit/live.test.ts": 'import { liveHelper } from "../../src/audit/live.js";\n',
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual([]);
  });

  test("a production file that merely re-exports the name counts as consumption", () => {
    // `export { x } from "./dead.js"` inside a NON-entry module IS a production
    // reference: some production file asked for that name by name.
    const files: Record<string, string> = {
      "src/shared/index.ts": 'export * from "./mid.js";\n',
      "src/shared/mid.ts": 'export { liveHelper } from "./live.js";\n',
      "src/shared/live.ts": "export const liveHelper = (): number => 1;\n",
      "tests/shared/live.test.ts": 'import { liveHelper } from "../../src/shared/live.js";\n',
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual([]);
  });

  test("a package ENTRY is never flagged, whatever references it", () => {
    // The entries are the PUBLISHED SURFACE — consumers outside this repository
    // address them through the `audit-tools/shared` subpath, so "no src file
    // references this name" is their normal, correct state.
    const files: Record<string, string> = {
      "src/shared/index.ts": "export const publishedHelper = (): number => 1;\n",
      "tests/shared/published.test.ts": 'import { publishedHelper } from "../../src/shared/index.js";\n',
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual([]);
  });

  test("a module the tests never reach is left to the file-level pass and knip", () => {
    // Claiming it here would put two gates on one property — the same reason
    // the loop-core closure rule leaves orphans to this gate.
    const files: Record<string, string> = {
      "src/shared/index.ts": 'export * from "./dead.js";\n',
      "src/shared/dead.ts": "export const deadHelper = (): number => 1;\n",
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual([]);
  });

  test("a module with a production consumer USING the symbol directly is not flagged", () => {
    const files: Record<string, string> = {
      "src/shared/index.ts": 'export * from "./live.js";\n',
      "src/shared/consumer.ts": 'import { liveHelper } from "./live.js";\nexport const c = () => liveHelper();\n',
      "src/shared/live.ts": "export const liveHelper = (): number => 1;\n",
      "tests/shared/live.test.ts": 'import { liveHelper } from "../../src/shared/live.js";\n',
    };
    const root = fixture(files);
    expect(run(root, files)).toEqual([]);
  });

  test("the LIVE tree raises no relative-import orphan", () => {
    // The gate runs this in verify:checks; asserting it here keeps the pass red
    // at the same place every other contract test is.
    const repoRoot = join(import.meta.dirname, "..", "..");
    const tracked = execFileSyncHidden("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((f) => f.replace(/\\/g, "/"));
    const prodFiles = tracked.filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
    const testFiles = tracked.filter(
      (f) => f.startsWith("tests/") && (f.endsWith(".ts") || f.endsWith(".mjs")),
    );
    expect(relativeImportOrphans({ root: repoRoot, prodFiles, testFiles })).toEqual([]);
  });
});

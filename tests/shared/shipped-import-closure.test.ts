// The shipped-import closure, pinned.
//
// `package.json`'s `files` list names the shipped scripts one by one and nothing
// connected it to the import graph those scripts form. On 2026-09-10
// `wrapper/audit-code-wrapper-build.mjs` began importing
// `scripts/shared/primitives.mjs` (85255cc5); every local gate and `verify:checks`
// stayed green, and the defect arrived as `smoke:packaged-audit-code` dying on
// ERR_MODULE_NOT_FOUND inside a temp install — a package defect that reads as a
// smoke flake. The one-file fix (8f411d11) extended the list by hand, which is
// the shape this repo bans: a hand-kept list a human must remember to extend.
//
// This is a CONTRACT TEST rather than a gate script on purpose — the property is
// about the TREE (which files `files` covers versus which the graph reaches), and
// this repo's rule is that a tree property is enforced by a contract test, with
// the trap deleted rather than restated.
//
// The first case below is the real property over this repository; the fixture
// cases pin the walk's transitivity and its refusal over synthetic trees, so the
// live case cannot pass vacuously (an empty root set satisfies it).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shipCoverage, isShipped } from "../../scripts/shared/shipCoverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files?: string[] };
  return Array.isArray(pkg.files) ? pkg.files : [];
}

/** A throwaway package tree: `files` plus the relative-import graph it ships. */
function fixture(files: string[], sources: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ship-coverage-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", files }));
  for (const [rel, body] of Object.entries(sources)) {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

describe("ship coverage: the packed package carries everything its scripts import", () => {
  it("every file reachable from a shipped module by relative import is covered by package.json `files`", () => {
    const { roots, reachable, unshipped } = shipCoverage({ repoRoot: ROOT, files: packageFiles() });

    // The walk must actually run: an empty root set would satisfy the assertion
    // below for the wrong reason (the failure this test exists for is "nothing
    // looked", not "nothing found").
    expect(roots.length, "the shipped module roots must be derived, not empty").toBeGreaterThan(0);
    expect(reachable.length).toBeGreaterThanOrEqual(roots.length);

    expect(
      unshipped.map((row) => `${row.file} (imported from ${row.importedFrom.join(", ")})`),
      "a file a shipped script imports by relative path but `files` does not cover packs an " +
        "ERR_MODULE_NOT_FOUND for every consumer — add it to package.json `files`",
    ).toEqual([]);
  });

  it("reaches the wrapper's build module and the shared primitives it imports", () => {
    // The exact pair from the incident, asserted by name so a walk that silently
    // stops descending cannot call this file green.
    const { reachable } = shipCoverage({ repoRoot: ROOT, files: packageFiles() });
    expect(reachable).toContain("wrapper/audit-code-wrapper-build.mjs");
    expect(reachable).toContain("scripts/shared/primitives.mjs");
  });

  it("refuses a reachable file `files` does not cover — the 2026-09-10 shape, red", () => {
    // The live red proof: drop the one entry the incident added and the walk must
    // name the file AND the importer that makes it reachable.
    const before = packageFiles();
    const withoutPrimitives = before.filter((pattern) => pattern !== "scripts/shared/primitives.mjs");
    expect(withoutPrimitives.length, "the list under test must be the real one, minus one").toBe(
      before.length - 1,
    );

    const { unshipped } = shipCoverage({ repoRoot: ROOT, files: withoutPrimitives });
    const named = unshipped.find((row) => row.file === "scripts/shared/primitives.mjs");
    expect(named, "dropping a shipped import target must be refused").toBeTruthy();
    expect(named!.importedFrom).toContain("wrapper/audit-code-wrapper-build.mjs");
  });

  it("is transitive: a file reached only through an intermediate is still refused", () => {
    const root = fixture(["a.mjs", "middle.mjs"], {
      "a.mjs": 'import "./middle.mjs";\n',
      "middle.mjs": 'import "./leaf.mjs";\n',
      "leaf.mjs": "export const leaf = true;\n",
    });
    try {
      const { unshipped, reachable } = shipCoverage({ repoRoot: root, files: ["a.mjs", "middle.mjs"] });
      expect(reachable).toContain("leaf.mjs");
      expect(unshipped.map((row) => row.file)).toEqual(["leaf.mjs"]);
      expect(unshipped[0]!.importedFrom).toEqual(["middle.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks a directory pattern's modules as roots, so a new shipped script is covered without an edit", () => {
    const root = fixture(["bin/**"], {
      "bin/one.mjs": 'import "../lib/shared.mjs";\n',
      "lib/shared.mjs": "export const shared = true;\n",
      "unrelated.mjs": "export const idle = true;\n",
    });
    try {
      const { roots, unshipped } = shipCoverage({ repoRoot: root, files: ["bin/**"] });
      expect(roots).toEqual(["bin/one.mjs"]);
      // `lib/shared.mjs` is reached from a shipped root and is not covered: the
      // defect. `unrelated.mjs` is covered by nothing and reached by nothing —
      // this walk is not a whole-tree reach audit.
      expect(unshipped.map((row) => row.file)).toEqual(["lib/shared.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report a bare specifier as unshipped", () => {
    // `audit-tools/shared` and every external package resolve outside `files`;
    // following them would report node internals as packaging defects.
    const root = fixture(["a.mjs"], {
      "a.mjs": 'import { readFileSync } from "node:fs";\nimport { x } from "audit-tools/shared";\nimport y from "./b.mjs";\n',
      "b.mjs": "export default 1;\n",
    });
    try {
      const { unshipped } = shipCoverage({ repoRoot: root, files: ["a.mjs", "b.mjs"] });
      expect(unshipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches `files` entries with npm's glob grammar, not a substring test", () => {
    expect(isShipped(["wrapper/**"], "wrapper/audit-code-wrapper-lib.mjs")).toBe(true);
    expect(isShipped(["wrapper/**"], "wrapper/nested/deep.mjs")).toBe(true);
    expect(isShipped(["wrapper/**"], "scripts/wrapper/x.mjs")).toBe(false);
    expect(isShipped(["dist/**"], "dist/audit/index.js")).toBe(true);
    expect(isShipped(["audit-code.mjs"], "audit-code.mjs")).toBe(true);
    // A bare `*` does not cross a path segment, so `dist/audit/index.js` can
    // never be covered by naming `*.js`.
    expect(isShipped(["*.js"], "dist/audit/index.js")).toBe(false);
  });

  it("names the shipped roots from `files` rather than a hand-kept entry list", () => {
    // The roots are DERIVED: every shipped module is a root, so an entry added to
    // `files` is walked without editing the walker. A hand-kept root list would
    // let this file pass while the next shipped module went unwalked.
    const source = readFileSync(join(ROOT, "scripts", "shared", "shipCoverage.mjs"), "utf8");
    expect(source).toMatch(/function shippedModuleRoots/);
    expect(source, "the roots must come from the `files` patterns").toMatch(
      /shippedModuleRoots\(root, files\)/,
    );
    for (const handKept of ["audit-code.mjs", "remediate-code.mjs"]) {
      expect(
        source.includes(`"${handKept}"`),
        `${handKept} must not be hard-coded in the walker — derive it from \`files\``,
      ).toBe(false);
    }
  });
});

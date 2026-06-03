import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { typescriptAnalyzer } = await import(
  "../src/extractors/analyzers/typescript.ts"
);
const { buildPathLookup } = await import("../src/extractors/graph.ts");

const FILES = {
  "src/base.ts": [
    "export class Base {}",
    "export interface Contract { run(): number; }",
    "",
  ].join("\n"),
  "src/b.ts": ["export function b(): number {", "  return 1;", "}", ""].join("\n"),
  "src/barrel.ts": ['export * from "./b";', ""].join("\n"),
  "src/a.ts": [
    'import { b } from "./b";',
    'import { Base, Contract } from "./base";',
    "",
    "export class A extends Base implements Contract {",
    "  run(): number {",
    "    return b();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

async function writeFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  for (const [path, content] of Object.entries(FILES)) {
    await writeFile(join(root, path), content);
  }
}

function repoManifest() {
  return {
    files: Object.keys(FILES).map((path) => ({
      path,
      size_bytes: FILES[path].length,
      language: "typescript",
      excluded: false,
    })),
  };
}

test("typescript analyzer resolves imports, re-exports, inheritance, and a cross-file call", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-analyzer-"));
  try {
    await writeFixture(root);
    const repo = repoManifest();
    const pathLookup = buildPathLookup(repo, new Map());
    const includedFiles = [...new Set(pathLookup.values())];

    const output = await typescriptAnalyzer.analyze(
      includedFiles.filter((file) => typescriptAnalyzer.supports(file)),
      {
        root,
        repoManifest: repo,
        disposition: undefined,
        includedFiles,
        pathLookup,
        dependencyPath: undefined, // fall back to the bundled compiler
      },
    );

    const has = (from, to, kind) =>
      output.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

    assert.ok(has("src/a.ts", "src/b.ts", "ts-import"), "import b → b.ts");
    assert.ok(has("src/a.ts", "src/base.ts", "ts-import"), "import Base/Contract → base.ts");
    assert.ok(has("src/barrel.ts", "src/b.ts", "ts-reexport"), "barrel re-exports b.ts");
    assert.ok(has("src/a.ts", "src/base.ts", "ts-extends"), "A extends Base");
    assert.ok(has("src/a.ts", "src/base.ts", "ts-implements"), "A implements Contract");
    assert.ok(has("src/a.ts", "src/b.ts", "ts-call"), "run() calls b() cross-file");

    // No edge ever targets a file outside the audited set.
    assert.ok(
      output.edges.every((e) => includedFiles.includes(e.to)),
      "every analyzer edge targets an audit-included file",
    );

    // Import edges carry the high analyzer confidence so they win the merge.
    const importEdge = output.edges.find(
      (e) => e.from === "src/a.ts" && e.to === "src/b.ts" && e.kind === "ts-import",
    );
    assert.equal(importEdge.confidence, 0.99);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typescript analyzer returns no edges for an empty file set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-analyzer-empty-"));
  try {
    const output = await typescriptAnalyzer.analyze([], {
      root,
      repoManifest: { files: [] },
      includedFiles: [],
      pathLookup: new Map(),
    });
    assert.deepEqual(output.edges, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

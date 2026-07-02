import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { typescriptAnalyzer } = await import("../../src/audit/extractors/analyzers/typescript.ts");
const { buildPathLookup } = await import("../../src/audit/extractors/graph.ts");

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

    expect(has("src/a.ts", "src/b.ts", "ts-import"), "import b → b.ts").toBeTruthy();
    expect(has("src/a.ts", "src/base.ts", "ts-import"), "import Base/Contract → base.ts").toBeTruthy();
    expect(has("src/barrel.ts", "src/b.ts", "ts-reexport"), "barrel re-exports b.ts").toBeTruthy();
    expect(has("src/a.ts", "src/base.ts", "ts-extends"), "A extends Base").toBeTruthy();
    expect(has("src/a.ts", "src/base.ts", "ts-implements"), "A implements Contract").toBeTruthy();
    expect(has("src/a.ts", "src/b.ts", "ts-call"), "run() calls b() cross-file").toBeTruthy();

    // No edge ever targets a file outside the audited set.
    expect(output.edges.every((e) => includedFiles.includes(e.to)), "every analyzer edge targets an audit-included file").toBeTruthy();

    // Import edges carry the high analyzer confidence so they win the merge.
    const importEdge = output.edges.find(
      (e) => e.from === "src/a.ts" && e.to === "src/b.ts" && e.kind === "ts-import",
    );
    expect(importEdge.confidence).toBe(0.99);
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
    expect(output.edges).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// collectFileEdges helper extraction tests — one edge type per test

async function analyzeFixture(files) {
  const root = await mkdtemp(join(tmpdir(), "ts-cfe-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(root, path), content);
    }
    const repo = {
      files: Object.keys(files).map((path) => ({
        path,
        size_bytes: files[path].length,
        language: "typescript",
        excluded: false,
      })),
    };
    const pathLookup = buildPathLookup(repo, new Map());
    const includedFiles = [...new Set(pathLookup.values())];
    return await typescriptAnalyzer.analyze(
      includedFiles.filter((f) => typescriptAnalyzer.supports(f)),
      { root, repoManifest: repo, disposition: undefined, includedFiles, pathLookup, dependencyPath: undefined },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("collectFileEdges: emits ts-import edge for a static import declaration", async () => {
  const output = await analyzeFixture({
    "src/other.ts": "export const x = 1;\n",
    "src/main.ts": 'import { x } from "./other";\nconsole.log(x);\n',
  });
  const importEdges = output.edges.filter(
    (e) => e.from === "src/main.ts" && e.to === "src/other.ts" && e.kind === "ts-import",
  );
  expect(importEdges.length, "exactly one ts-import edge from main→other").toBe(1);
  expect(importEdges[0].from).toBe("src/main.ts");
  expect(importEdges[0].to).toBe("src/other.ts");
});

test("collectFileEdges: emits ts-reexport edge for a re-export declaration", async () => {
  const output = await analyzeFixture({
    "src/impl.ts": "export const y = 2;\n",
    "src/barrel.ts": 'export { y } from "./impl";\n',
  });
  const reexportEdges = output.edges.filter(
    (e) => e.from === "src/barrel.ts" && e.to === "src/impl.ts" && e.kind === "ts-reexport",
  );
  expect(reexportEdges.length, "exactly one ts-reexport edge").toBe(1);
});

test("collectFileEdges: emits ts-import edge for a dynamic import call expression", async () => {
  const output = await analyzeFixture({
    "src/lazy.ts": "export const z = 3;\n",
    "src/main.ts": 'async function load() { return import("./lazy"); }\n',
  });
  const dynamicEdges = output.edges.filter(
    (e) => e.from === "src/main.ts" && e.to === "src/lazy.ts" && e.kind === "ts-import",
  );
  expect(dynamicEdges.length, "exactly one ts-import edge for dynamic import").toBe(1);
});

test("collectFileEdges: emits ts-call edge and deduplicates repeated calls", async () => {
  const output = await analyzeFixture({
    "src/util.ts": "export function greet() { return 'hi'; }\n",
    "src/main.ts": [
      'import { greet } from "./util";',
      "greet();",
      "greet();", // second call — must not produce a second edge
      "",
    ].join("\n"),
  });
  const callEdges = output.edges.filter(
    (e) => e.from === "src/main.ts" && e.to === "src/util.ts" && e.kind === "ts-call",
  );
  expect(callEdges.length, "duplicate calls produce exactly one ts-call edge").toBe(1);
});

test("collectFileEdges: emits ts-extends edge for class heritage", async () => {
  const output = await analyzeFixture({
    "src/base.ts": "export class Animal {}\n",
    "src/dog.ts": 'import { Animal } from "./base";\nexport class Dog extends Animal {}\n',
  });
  const extendsEdges = output.edges.filter(
    (e) => e.from === "src/dog.ts" && e.to === "src/base.ts" && e.kind === "ts-extends",
  );
  expect(extendsEdges.length, "exactly one ts-extends edge").toBe(1);
});

test("collectFileEdges: emits ts-implements edge for interface heritage", async () => {
  const output = await analyzeFixture({
    "src/iface.ts": "export interface Runnable { run(): void; }\n",
    "src/task.ts": 'import { Runnable } from "./iface";\nexport class Task implements Runnable { run() {} }\n',
  });
  const implEdges = output.edges.filter(
    (e) => e.from === "src/task.ts" && e.to === "src/iface.ts" && e.kind === "ts-implements",
  );
  expect(implEdges.length, "exactly one ts-implements edge").toBe(1);
});

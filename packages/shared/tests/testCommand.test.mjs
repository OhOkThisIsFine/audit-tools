import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { discoverProjectCommands } = await import("../src/tooling/testCommand.ts");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-testcmd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Node project: npm test plus e2e/build/lint scripts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          "test:e2e": "playwright test",
          build: "tsc",
          lint: "eslint .",
        },
      }),
      "utf8",
    );
    const cmds = discoverProjectCommands(dir);
    assert.deepEqual(cmds.test, ["npm", "test"]);
    assert.deepEqual(cmds.e2e, ["npm", "run", "test:e2e"]);
    assert.deepEqual(cmds.build, ["npm", "run", "build"]);
    assert.deepEqual(cmds.lint, ["npm", "run", "lint"]);
  });
});

test("Node project with the npm-init placeholder test is treated as no test", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
      "utf8",
    );
    const cmds = discoverProjectCommands(dir);
    assert.equal(cmds.test, undefined);
  });
});

test("Go project falls through to go test", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    assert.deepEqual(cmds.test, ["go", "test", "./..."]);
    assert.deepEqual(cmds.build, ["go", "build", "./..."]);
  });
});

test("Python project falls through to pytest", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    assert.deepEqual(cmds.test, ["python", "-m", "pytest"]);
  });
});

test("Node package.json without a test script still falls through to Go", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    assert.deepEqual(cmds.test, ["go", "test", "./..."]);
  });
});

test("Node package.json with no scripts key falls through to Go", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}), "utf8");
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    assert.deepEqual(cmds.test, ["go", "test", "./..."]);
  });
});

test("Node package.json with no scripts key and no other project files yields no commands", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}), "utf8");
    assert.deepEqual(discoverProjectCommands(dir), {});
  });
});

test("empty directory yields no commands", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(discoverProjectCommands(dir), {});
  });
});

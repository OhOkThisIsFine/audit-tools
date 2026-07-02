import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { discoverProjectCommands } = await import("../../src/shared/tooling/testCommand.ts");

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
    expect(cmds.test).toEqual(["npm", "test"]);
    expect(cmds.e2e).toEqual(["npm", "run", "test:e2e"]);
    expect(cmds.build).toEqual(["npm", "run", "build"]);
    expect(cmds.lint).toEqual(["npm", "run", "lint"]);
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
    expect(cmds.test).toBe(undefined);
  });
});

test("Go project falls through to go test", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    expect(cmds.test).toEqual(["go", "test", "./..."]);
    expect(cmds.build).toEqual(["go", "build", "./..."]);
  });
});

test("Python project falls through to pytest", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    expect(cmds.test).toEqual(["python", "-m", "pytest"]);
  });
});

test("Node package.json without a test script still falls through to Go", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    expect(cmds.test).toEqual(["go", "test", "./..."]);
  });
});

test("Node package.json with no scripts key falls through to Go", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}), "utf8");
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    const cmds = discoverProjectCommands(dir);
    expect(cmds.test).toEqual(["go", "test", "./..."]);
  });
});

test("Node package.json with no scripts key and no other project files yields no commands", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}), "utf8");
    expect(discoverProjectCommands(dir)).toEqual({});
  });
});

test("empty directory yields no commands", async () => {
  await withTempDir(async (dir) => {
    expect(discoverProjectCommands(dir)).toEqual({});
  });
});

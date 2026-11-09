import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectCommands } from "../../src/shared/tooling/testCommand.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
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

test.each([
  ["package", '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n'],
  ["workspace", '[workspace]\nmembers = ["crates/example"]\n'],
])("Cargo %s discovers native test and build commands", async (_kind, manifest) => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "Cargo.toml"), manifest);
    expect(discoverProjectCommands(dir)).toEqual({
      test: ["cargo", "test"], build: ["cargo", "build"],
    });
  });
});

test("Cargo fallback preserves declared npm roles", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "Cargo.toml"), '[workspace]\nmembers = []\n');
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build", lint: "eslint ." } }));
    expect(discoverProjectCommands(dir)).toEqual({
      test: ["cargo", "test"], build: ["npm", "run", "build"], lint: ["npm", "run", "lint"],
    });
  });
});

test("Cargo does not replace existing test-command precedence", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "Cargo.toml"), '[workspace]\nmembers = []\n');
    await writeFile(join(dir, "go.mod"), "module example.com/x\n");
    expect(discoverProjectCommands(dir)).toEqual({ test: ["go", "test", "./..."], build: ["go", "build", "./..."] });
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }));
    expect(discoverProjectCommands(dir)).toEqual({ test: ["npm", "test"], build: ["npm", "run", "build"] });
  });
});

test("Cargo preserves the existing Python test command in a mixed project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "example"\n');
    await writeFile(join(dir, "Cargo.toml"), '[workspace]\nmembers = []\n');
    // Discovery only inspects this nonempty fixture; it never executes Python.
    await writeFile(join(dir, "python.exe"), "fixture");
    const previousPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(discoverProjectCommands(dir)).toEqual({ test: ["python", "-m", "pytest"] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("a Cargo lockfile alone does not declare a Rust project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "Cargo.lock"), "version = 4\n");
    expect(discoverProjectCommands(dir)).toEqual({});
  });
});

test("malformed test script values preserve valid roles and the Go fallback", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    for (const test of [42, true, [], {}, null]) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test, build: "tsc" } }), "utf8");
      expect(discoverProjectCommands(dir)).toEqual({ test: ["go", "test", "./..."], build: ["npm", "run", "build"] });
    }
  });
});

test("malformed role candidates do not hide valid lower-priority scripts", async () => {
  await withTempDir(async (dir) => {
    for (const invalid of [42, true, [], {}, null]) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {
        test: "vitest run", e2e: invalid, "test:e2e": "playwright test", build: invalid,
        lint: invalid, "lint:check": "eslint .", typecheck: invalid, "check:types": "tsc --noEmit",
      } }), "utf8");
      expect(discoverProjectCommands(dir)).toEqual({
        test: ["npm", "test"], e2e: ["npm", "run", "test:e2e"],
        lint: ["npm", "run", "lint:check"], typecheck: ["npm", "run", "check:types"],
      });
    }
  });
});

test("unusable script containers yield no Node commands without blocking other ecosystems", async () => {
  await withTempDir(async (dir) => {
    for (const scripts of [42, true, [], ["vitest run"], {}, null, "vitest run"]) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts }), "utf8");
      expect(discoverProjectCommands(dir)).toEqual({});
    }
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    expect(discoverProjectCommands(dir)).toEqual({ test: ["go", "test", "./..."], build: ["go", "build", "./..."] });
  });
});

import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProjectCommands } from "../../src/shared/tooling/testCommand.js";
import { isAdmittedProjectTestCommand } from "../../src/shared/tooling/projectTestAdmission.js";
import { platformCommand, resolveExecArgv } from "../../src/shared/tooling/exec.js";
import { finalGateBinding } from "../../src/remediate/steps/gateCommands.js";
import { readFinalGateVerdict, runToolOwnedFinalGate, writeFinalGateVerdict } from "../../src/remediate/steps/finalGate.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "maven-discovery-"));
  roots.push(root);
  return root;
}
const POM = '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>example</artifactId><version>1</version></project>';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("Maven manifest discovers native compile and test phases", () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  expect(discoverProjectCommands(root)).toEqual({ test: ["mvn", "test"], build: ["mvn", "compile"] });
});

test("Maven fallback preserves declared npm build and lint roles", () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build", lint: "eslint ." } }));
  expect(discoverProjectCommands(root)).toEqual({ test: ["mvn", "test"], build: ["npm", "run", "build"], lint: ["npm", "run", "lint"] });
});

test("Maven does not replace existing npm or Go test commands", () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  writeFileSync(join(root, "go.mod"), "module example.com/project\n");
  expect(discoverProjectCommands(root)).toEqual({ test: ["go", "test", "./..."], build: ["go", "build", "./..."] });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  expect(discoverProjectCommands(root)).toEqual({ test: ["npm", "test"] });
});

test("Maven preserves Python precedence without depending on installed Python", () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "example"\n');
  writeFileSync(join(root, "python.exe"), "fixture, never executed");
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    expect(discoverProjectCommands(root)).toEqual({ test: ["python", "-m", "pytest"] });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Maven test admission requires the exact discovered command", () => {
  const root = repo();
  expect(isAdmittedProjectTestCommand(["mvn", "test"], root)).toBe(false);
  writeFileSync(join(root, "pom.xml"), POM);
  expect(isAdmittedProjectTestCommand(["mvn", "test"], root)).toBe(true);
  expect(isAdmittedProjectTestCommand(["mvn", "test", "-DskipTests"], root)).toBe(false);
  expect(isAdmittedProjectTestCommand(["mvn", "compile"], root)).toBe(false);
});

test("Maven uses the existing safe Windows batch boundary", () => {
  expect(platformCommand("mvn", "win32")).toBe("mvn.cmd");
  expect(platformCommand("mvn", "linux")).toBe("mvn");
  expect(platformCommand("mvn.cmd", "win32")).toBe("mvn.cmd");
  expect(resolveExecArgv(["mvn", "test"], { platform: "win32" }).slice(1)).toEqual(["/d", "/s", "/c", "mvn.cmd test"]);
  expect(resolveExecArgv(["mvn", "test"], { platform: "linux" })).toEqual(["mvn", "test"]);
});

test.each([0, 1])("Maven phases reach the final gate and preserve test exit code %i", async (testStatus) => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  const calls: { argv: string[]; cwd: string }[] = [];
  const gate = await runToolOwnedFinalGate(root, {
    runner: (argv, cwd) => { calls.push({ argv, cwd }); return { status: argv[1] === "test" ? testStatus : 0 }; },
  });
  expect(calls).toEqual([{ argv: ["mvn", "compile"], cwd: root }, { argv: ["mvn", "test"], cwd: root }]);
  expect(gate.passed).toBe(testStatus === 0);
  expect(gate.scoped_out).toBe(false);
  expect(gate.outcome).toBe("executed");
});

test("a failed Maven compile stops before tests and cannot authorize completion", async () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  const calls: string[][] = [];
  const gate = await runToolOwnedFinalGate(root, {
    runner: (argv) => { calls.push(argv); return { status: 1 }; },
  });
  expect(calls).toEqual([["mvn", "compile"]]);
  expect(gate.passed).toBe(false);
  expect(gate.scoped_out).toBe(false);
});

test("Maven manifest changes invalidate cached green even with the same tree id", async () => {
  const root = repo();
  writeFileSync(join(root, "pom.xml"), POM);
  const binding = finalGateBinding(root);
  await writeFinalGateVerdict(root, { scope: "phase 1", tree: "same-tree", binding, passed: true, scoped_out: false, outcome: "executed", results: [] });
  expect(await readFinalGateVerdict(root, "phase 1", "same-tree", binding)).toBeDefined();
  writeFileSync(join(root, "pom.xml"), POM.replace("<version>1</version>", "<version>2</version>"));
  expect(await readFinalGateVerdict(root, "phase 1", "same-tree", finalGateBinding(root))).toBeUndefined();
});

import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectCommands } from "../../src/shared/tooling/testCommand.js";
import { isAdmittedProjectTestCommand } from "../../src/shared/tooling/projectTestAdmission.js";
import { finalGateBinding } from "../../src/remediate/steps/gateCommands.js";
import { readFinalGateVerdict, runToolOwnedFinalGate, writeFinalGateVerdict } from "../../src/remediate/steps/finalGate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "command-integration-")); roots.push(root); return root;
}
function scripts(root: string, value: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: value }));
}
function manifests(root: string): void {
  writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = []\n');
  writeFileSync(join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
}

test.each([
  ["Cargo.toml", "cargo", "build", '[workspace]\nmembers = []\n'],
  ["pom.xml", "mvn", "compile", "<project><modelVersion>4.0.0</modelVersion></project>"],
])("malformed npm declarations retain usable roles and %s fallback", (manifest, command, build, content) => {
  const root = repo();
  writeFileSync(join(root, manifest), content);
  for (const invalid of [42, true, [], {}, null]) {
    scripts(root, { test: invalid, build: invalid, lint: "eslint ." });
    expect(discoverProjectCommands(root)).toEqual({ test: [command, "test"], build: [command, build], lint: ["npm", "run", "lint"] });
    expect(isAdmittedProjectTestCommand([command, "test"], root)).toBe(true);
    expect(isAdmittedProjectTestCommand([command, "test", "--skip"], root)).toBe(false);
  }
});

test("mixed Cargo and Maven declarations retain deterministic precedence and exact admission", () => {
  const root = repo(); manifests(root);
  expect(discoverProjectCommands(root)).toEqual({ test: ["cargo", "test"], build: ["cargo", "build"] });
  expect(isAdmittedProjectTestCommand(["cargo", "test"], root)).toBe(true);
  expect(isAdmittedProjectTestCommand(["mvn", "test"], root)).toBe(false);
  scripts(root, { test: "vitest run", build: "vite build" });
  expect(discoverProjectCommands(root)).toEqual({ test: ["npm", "test"], build: ["npm", "run", "build"] });
  expect(isAdmittedProjectTestCommand(["cargo", "test"], root)).toBe(false);
  scripts(root, { test: {}, build: "vite build", lint: "eslint .", typecheck: "tsc --noEmit" });
  expect(discoverProjectCommands(root)).toEqual({ test: ["cargo", "test"], build: ["npm", "run", "build"],
    lint: ["npm", "run", "lint"], typecheck: ["npm", "run", "typecheck"] });
});

test.each(["Cargo.toml", "pom.xml"])("mixed-project cached green is invalidated by an edit to %s", async manifest => {
  const root = repo(); manifests(root);
  const binding = finalGateBinding(root);
  await writeFinalGateVerdict(root, { scope: "combined", tree: "same-tree", binding, passed: true, scoped_out: false, outcome: "executed", results: [] });
  expect(await readFinalGateVerdict(root, "combined", "same-tree", binding)).toBeDefined();
  writeFileSync(join(root, manifest), manifest === "Cargo.toml" ? '[workspace]\nmembers = ["changed"]\n' : "<project><artifactId>changed</artifactId></project>");
  expect(await readFinalGateVerdict(root, "combined", "same-tree", finalGateBinding(root))).toBeUndefined();
});

test.each([0, 1])("mixed-project final gate preserves npm build and Cargo test exit %i", async status => {
  const root = repo(); manifests(root); scripts(root, { test: 42, build: "vite build" });
  const calls: string[][] = [];
  const result = await runToolOwnedFinalGate(root, { runner: (argv, cwd) => {
    expect(cwd).toBe(root); calls.push(argv); return { status: argv[1] === "test" ? status : 0 };
  } });
  expect(calls).toEqual([["npm", "run", "build"], ["cargo", "test"]]);
  expect(result.outcome).toBe("executed");
  expect(result.passed).toBe(status === 0);
});

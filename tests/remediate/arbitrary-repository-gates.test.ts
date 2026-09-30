import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProjectCommands } from "../../src/shared/tooling/testCommand.js";
import { runToolOwnedFinalGate } from "../../src/remediate/steps/finalGate.js";
const roots: string[] = [];
function repo(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "arbitrary-gates-")); roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts })); return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("arbitrary npm repositories execute all declared verification roles in order", async () => {
  const root = repo({ build: "build", typecheck: "types", lint: "lint", test: "test" });
  const calls: string[][] = [];
  const gate = await runToolOwnedFinalGate(root, { runner: (argv) => { calls.push(argv); return { status: 0 }; } });
  expect(calls).toEqual([["npm", "run", "build"], ["npm", "run", "typecheck"], ["npm", "run", "lint"], ["npm", "test"]]);
  expect(gate.passed).toBe(true);
  expect(gate.outcome).toBe("executed");
});
test("absence of executable project gates never authorizes completion", async () => {
  const gate = await runToolOwnedFinalGate(repo(), { runner: () => { throw Error("must not spawn"); } });
  expect(gate.passed).toBe(false);
});
test("check:types is explicit typechecking but arbitrary check is not", () => {
  expect(discoverProjectCommands(repo({ "check:types": "tsc" }))).toMatchObject({ typecheck: ["npm", "run", "check:types"] });
  expect(discoverProjectCommands(repo({ check: "something" }))).not.toHaveProperty("typecheck");
});

test("explicit test overrides retain all other declared checks and preserve argv spaces", async () => {
  const calls: string[][] = [];
  await runToolOwnedFinalGate(repo({ build: "b", typecheck: "c", lint: "l", test: "t" }), {
    testCommand: ["node", "test suite/check.mjs"], runner: argv => { calls.push(argv); return { status: 0 }; },
  });
  expect(calls).toEqual([["npm", "run", "build"], ["npm", "run", "typecheck"], ["npm", "run", "lint"], ["node", "test suite/check.mjs"]]);
});
test("failed project commands stop the floor without authorizing completion", async () => {
  const calls: string[][] = [];
  const gate = await runToolOwnedFinalGate(repo({ build: "b", test: "t" }), { runner: argv => { calls.push(argv); return { status: 1, stderr: "broken" }; } });
  expect(gate.passed).toBe(false);
  expect(calls).toHaveLength(1);
  expect(gate.results[0]?.stderr_tail).toBe("broken");
});
test("existing Go and Python fallback command discovery reaches the same gate", async () => {
  for (const [marker, expected] of [["go.mod", [["go", "build", "./..."], ["go", "test", "./..."]]], ["pyproject.toml", [["python", "-m", "pytest"]]]] as const) {
    const root = repo(); writeFileSync(join(root, marker), ""); const calls: string[][] = [];
    expect((await runToolOwnedFinalGate(root, { runner: argv => { calls.push(argv); return { status: 0 }; } })).passed).toBe(true);
    expect(calls).toEqual(expected);
  }
});
import { finalGateBinding } from "../../src/remediate/steps/gateCommands.js";
import { readFinalGateVerdict, writeFinalGateVerdict } from "../../src/remediate/steps/finalGate.js";
test("changed declarations invalidate cached green even with the same tree id", async () => {
  const root = repo({ test: "node old.mjs" }); const binding = finalGateBinding(root);
  await writeFinalGateVerdict(root, { scope: "phase 1", tree: "same-tree", binding, passed: true, scoped_out: false, outcome: "executed", results: [] });
  expect(await readFinalGateVerdict(root, "phase 1", "same-tree", binding)).toBeDefined();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node new.mjs" } }));
  expect(await readFinalGateVerdict(root, "phase 1", "same-tree", finalGateBinding(root))).toBeUndefined();
});

import { readFileSync } from "node:fs";
test("real npm commands run in the target repository and recover from a failing command", async () => {
  const root = repo(Object.fromEntries(["build", "typecheck", "lint", "test"].map(role => [role, `node record.cjs ${role}`])));
  writeFileSync(join(root, "record.cjs"), 'const fs = require("node:fs"); fs.appendFileSync("commands.log", process.argv[2] + "\\n"); if (process.argv[2] === "lint" && fs.existsSync("fail")) process.exit(1);');
  writeFileSync(join(root, "fail"), "");
  expect((await runToolOwnedFinalGate(root)).passed).toBe(false);
  expect(readFileSync(join(root, "commands.log"), "utf8")).toBe("build\ntypecheck\nlint\n");
  rmSync(join(root, "fail"));
  expect((await runToolOwnedFinalGate(root)).passed).toBe(true);
  expect(readFileSync(join(root, "commands.log"), "utf8")).toBe("build\ntypecheck\nlint\nbuild\ntypecheck\nlint\ntest\n");
}, 30_000);

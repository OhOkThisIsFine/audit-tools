import { expect, test } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function runFixture(script: string, setup?: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "remediate-smoke-fixture-"));
  try {
    for (const path of ["scripts/shared/hermetic-state-dir.mjs", `scripts/remediate/${script}`]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(join(repoRoot, path), join(root, path));
    }
    await setup?.(root);
    const result = spawnSyncHidden(process.execPath, [join(root, "scripts", "remediate", script)], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    return { ...result, root, calls: setup ? JSON.parse(await readFile(join(root, "calls.json"), "utf8")) as string[][] : [] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing built gate names its path and root build command", async () => {
  const result = await runFixture("smoke-remediate-gate.mjs");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(join(result.root, "dist", "remediate", "steps", "finalGate.js"));
  expect(result.stderr).toContain("npm run build");
});

test("linked smoke validates one fresh response then advances the same root with input", async () => {
  const result = await runFixture("smoke-linked-remediate-code.mjs", async root => {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(join(root, "calls.json"), "[]");
    await writeFile(join(root, "remediate-code.mjs"), `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      const path = new URL('./calls.json', import.meta.url);
      const calls = JSON.parse(readFileSync(path)); calls.push(args); writeFileSync(path, JSON.stringify(calls));
      if (args[0] === '--version') console.log('1.0.0');
      if (args[0] === '--help') console.log('run install ensure validate');
      if (args[0] === 'next-step') {
        const input = args.indexOf('--input');
        const supplied = input >= 0 && existsSync(args[input + 1]);
        console.log(JSON.stringify({ contract_version: 'remediate-code-step/v1alpha1', status: supplied ? 'ready' : 'blocked',
          step_kind: supplied ? 'synthesize_intake' : 'collect_starting_point', allowed_commands: [] }));
      }`);
  });
  expect(result.status, result.stderr).toBe(0);
  const calls = result.calls.filter(args => args[0] === "next-step");
  expect(calls).toHaveLength(2);
  expect(calls[0]).not.toContain("--input");
  expect(calls[1]).toContain("--input");
  expect(calls[0]![calls[0]!.indexOf("--root") + 1]).toBe(calls[1]![calls[1]!.indexOf("--root") + 1]);
});

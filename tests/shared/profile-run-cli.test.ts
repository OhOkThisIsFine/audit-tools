import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogCommands } from "../../scripts/shared/verify-steps.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

/** Invoke the real CLI; replace only its OS child boundary in the fresh process. */
async function run(args: string[], failAt = -1) {
  const dir = await mkdtemp(join(tmpdir(), "profile-run-cli-"));
  cleanups.push(dir);
  const callsPath = join(dir, "calls.jsonl");
  const hook = join(dir, "children.mjs");
  await writeFile(hook, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
let call = 0;
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({command, args, cwd: options.cwd}) + '\\n');
  return { status: call++ === ${failAt} ? 7 : 0, signal: null, stdout: '', stderr: '' };
};
syncBuiltinESMExports();
`);
  const profile = `adapter-test-${randomUUID()}`;
  const latest = join(root, ".audit-tools-profile", `${profile}-latest.json`);
  cleanups.push(latest, join(root, ".audit-tools-profile", `${profile}-history.ndjson`));
  let status = 0;
  try {
    execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, join(root, "scripts/shared/profile-run.mjs"), profile, ...args], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" }, stdio: "pipe",
    });
  } catch (error) {
    status = (error as { status: number }).status;
  }
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { command: string; args: string[]; cwd: string });
  const ledger = JSON.parse(await readFile(latest, "utf8")) as { steps: { label: string }[] };
  return { status, calls, ledger };
}

it("executes the checks and release catalogs through the real CLI and profiler", async () => {
  for (const stage of ["checks", "release"] as const) {
    const outcome = await run([`--catalog=${stage}`]);
    const expected = catalogCommands(stage, undefined, process.platform === "win32" ? "npm.cmd" : "npm");
    expect(outcome.status).toBe(0);
    expect(outcome.ledger.steps.map(step => step.label)).toEqual(expected.map(step => step.label));
    expect(outcome.calls).toHaveLength(expected.length);
    // POSIX exposes argv directly. Windows shims go through the production shell adapter.
    for (const [index, command] of expected.entries()) {
      const actual = outcome.calls[index]!;
      expect(actual.cwd).toBe(root);
      if (process.platform !== "win32" || !command.command.endsWith(".cmd")) {
        expect(actual.command).toBe(command.command);
        expect(actual.args).toEqual(command.args);
      } else {
        expect(actual.args.join(" ")).toContain(command.args.join(" "));
      }
    }
  }
});

it("retains explicit script order and stops on the first failed child", async () => {
  const outcome = await run(["check:first", "check:second", "check:never"], 1);
  expect(outcome.status).toBe(1);
  expect(outcome.calls).toHaveLength(2);
  expect(outcome.ledger.steps.map(step => step.label)).toEqual(["check:first", "check:second"]);
  expect(outcome.calls.map(call => call.args.join(" ")).join("\n")).not.toContain("check:never");
});

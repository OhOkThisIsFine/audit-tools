import { afterEach, beforeEach, expect, it } from "vitest";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const repo = resolve(import.meta.dirname, "../..");
let fixture: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "stale wrapper "));
  cpSync(join(repo, "wrapper"), join(fixture, "wrapper"), { recursive: true });
  mkdirSync(join(fixture, "scripts/shared"), { recursive: true });
  copyFileSync(join(repo, "scripts/shared/primitives.mjs"), join(fixture, "scripts/shared/primitives.mjs"));
  for (const bin of ["audit-code.mjs", "remediate-code.mjs"]) copyFileSync(join(repo, bin), join(fixture, bin));
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "audit-tools", type: "module", exports: { "./shared": "./shared.mjs" } }));
  writeFileSync(join(fixture, "shared.mjs"), "export function renderHostAsset() {}");
  mkdirSync(join(fixture, "src"));
  writeFileSync(join(fixture, "tsconfig.json"), "{}");
  for (const product of ["audit", "remediate"]) {
    mkdirSync(join(fixture, "dist", product), { recursive: true });
    const staleEntry = join(fixture, "dist", product, "index.js");
    writeFileSync(staleEntry, 'throw Error("stale distribution executed");');
    utimesSync(staleEntry, 1, 1);
  }
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "path"));
  env.PATH = fixture + delimiter + (process.env.PATH ?? "");
  env.BUILD_EXIT = "23";
  if (process.platform === "win32") {
    env.ComSpec = join(fixture, "fixture shell.exe");
    copyFileSync(process.env.ComSpec!, env.ComSpec);
    writeFileSync(join(fixture, "npm.cmd"), "@echo off\r\necho shim-build:%CD%:%*\r\nexit /b %BUILD_EXIT%\r\n");
  } else {
    writeFileSync(join(fixture, "npm"), '#!/bin/sh\necho "shim-build:$PWD:$*"\nexit "$BUILD_EXIT"\n', { mode: 0o755 });
  }
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function run(bin: string, preload?: string) {
  return spawnSyncHidden(process.execPath, [
    ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    join(fixture, bin), "status",
  ], { cwd: tmpdir(), env, encoding: "utf8" });
}

it.each(["audit-code.mjs", "remediate-code.mjs"])("rebuilds stale %s with npm run build in the package directory", (bin) => {
  const out = run(bin);
  expect(out.stderr).toContain(`shim-build:${fixture}:run build`);
  expect(out.stdout).toBe("");
  expect(out.status).toBe(bin === "audit-code.mjs" ? 1 : 23);
  if (bin === "audit-code.mjs") expect(out.stderr).toContain("exit code 23");
});

it("removes the lock and preserves a close error alongside a failed build", () => {
  const preload = join(fixture, "fail-close.mjs");
  const lock = join(fixture, ".audit-code-build.lock");
  writeFileSync(preload, [
    "import fs from 'node:fs/promises';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const open = fs.open;",
    "fs.open = async (...args) => {",
    "  const file = await open(...args);",
    `  if (args[0] === ${JSON.stringify(lock)}) {`,
    "    const close = file.close.bind(file);",
    "    file.close = async () => { await close(); throw Error('fixture close failed'); };",
    "  }",
    "  return file;",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const out = run("audit-code.mjs", preload);
  expect(out.status).toBe(1);
  expect(existsSync(lock)).toBe(false);
  expect(out.stderr).toContain("exit code 23");
  expect(out.stderr).toContain("fixture close failed");
});

it.each(["0", "23"])("reports a retained lock when unlink fails after a build exiting %s", (code) => {
  env.BUILD_EXIT = code;
  const preload = join(fixture, "deny-unlink.mjs");
  const lock = join(fixture, ".audit-code-build.lock");
  writeFileSync(preload, [
    "import fs from 'node:fs/promises';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const unlink = fs.unlink;",
    `fs.unlink = (file) => file === ${JSON.stringify(lock)} ? Promise.reject(Error('fixture unlink denied')) : unlink(file);`,
    "syncBuiltinESMExports();",
  ].join("\n"));
  const out = run("audit-code.mjs", preload);
  expect(out.status).toBe(1);
  expect(existsSync(lock)).toBe(true);
  expect(out.stderr).toContain("fixture unlink denied");
  expect(out.stderr).toContain(lock);
  expect(out.stderr).not.toContain("build_lock_released");
  if (code === "23") expect(out.stderr).toContain("exit code 23");
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORKER_SCHEMA_SOURCES, renderWorkerJsonSchema } from "../dist/audit/contracts/workerSchemas.js";
import { extractFileLockExportSurface, renderSurfacePin } from "../scripts/shared/generate-filelock-export-surface.mjs";

const LF = (value) => value.replace(/\r\n/g, "\n");
test("shipped worker schemas match their canonical contract", async () => {
  for (const name of Object.keys(WORKER_SCHEMA_SOURCES)) {
    const tracked = await readFile(new URL("../schemas/" + name, import.meta.url), "utf8");
    assert.equal(LF(tracked), JSON.stringify(renderWorkerJsonSchema(name), null, 2) + "\n", name);
  }
});
test("the checked-in file lock interface matches its public exports", async () => {
  const tracked = await readFile(new URL("../scripts/shared/filelock-export-surface.generated.json", import.meta.url), "utf8");
  assert.equal(LF(tracked), renderSurfacePin(extractFileLockExportSurface()));
});

test("legacy worker schemas remain checked tooling inputs after question review replaced their producers", async () => {
  const generator = await readFile(new URL("../scripts/audit/generate-schemas.mjs", import.meta.url), "utf8");
  assert.match(generator, /src\/audit\/contracts\/workerSchemas\.ts/);
  const { LENS_VERIFICATION_TAG } = await import("../dist/audit/orchestrator/selectiveDeepening/shared.js");
  assert.equal(LENS_VERIFICATION_TAG, "lens_verification");
});

async function checkFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "audit-tools-artifact-check-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q");
  async function write(path, body) {
    const file = join(cwd, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  function run(script, env) {
    return spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url))], {
      cwd, env: { ...process.env, ...env }, encoding: "utf8",
    });
  }
  return { cwd, git, write, run };
}

test("memory citations resolve dotted paths and explicit directories without mistaking prose for paths", async (t) => {
  const { cwd, git, write, run } = await checkFixture(t);
  await write("src/.config/current.ts", "");
  await write(".githooks/pre-commit", "");
  await write("docs/backlog/README.md", "");
  git("add", ".");
  const valid = [
    "src/.config/current.ts", "./src/.config/current.ts:7", "src/.config/", "src/",
    ".githooks/pre-commit", "docs/backlog", "docs/backlog/",
  ];
  const outOfScope = [
    "src/../outside.ts", "src/./current.ts", "src//current.ts", "src/.config//",
    "https://example.test/src/missing.ts", "src/not a file", "on/off", "src/[ab].ts", "src/${name}.ts",
  ];
  const note = (paths) => paths.map((path) => `See \`${path}\`.`).join("\n");
  const check = () => run("check-memory-citations", { AUDIT_TOOLS_MEMORY_DIR: join(cwd, "memory") });
  await write("memory/example.md", note([...valid, ...outOfScope]));
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);

  const stale = ["src/.config/missing.ts", "src/old.config/", "src/.config/current.ts/"];
  await write("memory/example.md", note([...valid, ...outOfScope, ...stale]));
  const failed = check();
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /3 repo path\(s\)/);
  for (const path of stale) assert.ok(failed.stderr.includes(path), failed.stderr);
});

test("proposal RED-AT check reads the index and verifies companion presence, not execution", async (t) => {
  const { cwd, git, write, run } = await checkFixture(t);
  const dir = ".audit-tools/nightly/proposals/example";
  const record = `${dir}/RED-AT.txt`;
  await write(`${dir}/example.test.mjs`, 'throw new Error("presence check must not run this");\n');
  git("add", ".");
  const check = () => run("check-proposal-red-at", { CLAUDE_PROJECT_DIR: cwd });
  await write(record, "untracked note\n");
  assert.match(check().stderr, /no tracked/);
  await write(record, " \n");
  git("add", record);
  await write(record, "unstaged note\n");
  const stagedBlank = check();
  assert.equal(stagedBlank.status, 1, stagedBlank.stdout);
  assert.match(stagedBlank.stderr, /staged.*blank/);

  git("add", record);
  await write(record, "");
  const stagedNonBlank = check();
  assert.equal(stagedNonBlank.status, 0, stagedNonBlank.stderr);
  assert.match(stagedNonBlank.stdout, /non-empty/);
  assert.match(stagedNonBlank.stdout, /test execution not verified/);
});

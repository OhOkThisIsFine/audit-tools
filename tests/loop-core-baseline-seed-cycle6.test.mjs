import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_PATH } from "../scripts/shared/loopCoreAttestationLedger.mjs";

const seed = fileURLToPath(new URL("../scripts/seed-loop-core-baseline.mjs", import.meta.url));
const check = fileURLToPath(new URL("../scripts/check-loop-core-attestations.mjs", import.meta.url));
const keep = "src/audit/cli/nextStepCommand.ts";
const deleted = "src/audit/cli/nextStepHelpers.ts";
const replacement = "src/audit/cli/laneValidators.ts";

function setup(t) {
  const repo = mkdtempSync(join(tmpdir(), "loop-core-seed-fixture-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (file, ...args) => spawnSync(file, args, { cwd: repo, encoding: "utf8", windowsHide: true });
  const git = (...args) => {
    const r = run("git", ...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (path, body) => {
    const destination = join(repo, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  };
  git("init", "-q", "-b", "main");
  write(keep, "export const fixture = 1;\n");
  write(deleted, "export const oldFixture = 2;\n");
  git("add", "--", keep, deleted);
  git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "-qm", "historical fixture");
  const historical = git("rev-parse", "HEAD");
  return { git, run, write, historical, ledger: join(repo, LEDGER_PATH) };
}

test("seed retains indexed historical paths and verifies exact historical blobs", t => {
  const { git, run, write, historical, ledger } = setup(t);
  git("rm", "--", deleted);
  const seeded = run(process.execPath, seed, "--commit", historical);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.match(seeded.stdout, /wrote .*baseline of 2 loop-core path\(s\).*\(1 still tracked\)\. Not staged\./);
  assert.equal(git("ls-files", "--", LEDGER_PATH), "");
  const report = JSON.parse(readFileSync(ledger, "utf8"));
  assert.deepEqual(Object.keys(report.entries), [keep]);
  assert.equal(Object.keys(report.baselines).length, 1);
  const baseline = report.baselines[report.entries[keep].baseline];
  assert.equal(baseline.commit, historical);
  assert.equal(baseline.vouches[keep], git("rev-parse", `${historical}:${keep}`));
  git("add", "--", LEDGER_PATH);
  const unchanged = run(process.execPath, check);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /0 loop-core file\(s\) reviewed; 1 still baseline-only/);
  write(keep, "export const fixture = 3;\n");
  git("add", "--", keep);
  const changed = run(process.execPath, check);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /nextStepCommand\.ts: content changed since the baseline/);
});

test("a historical tree disjoint from the current index cannot create a ledger", t => {
  const { git, run, write, historical, ledger } = setup(t);
  git("rm", "--", keep, deleted);
  write(replacement, "export const newFixture = 4;\n");
  git("add", "--", replacement);
  const refused = run(process.execPath, seed, "--commit", historical);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /no loop-core paths from commit .* remain in the index/);
  assert.match(refused.stderr, /select a commit with retained paths or review current loop-core files/);
  assert.equal(existsSync(ledger), false);
  assert.equal(git("ls-files", "--", LEDGER_PATH), "");
});

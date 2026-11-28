import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const runner = "scripts/shared/run-contract-tests.mjs";

function runFixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), "audit-contract-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [runner, "scripts/shared/primitives.mjs", "scripts/shared/worktree-tree.mjs",
    "scripts/shared/suiteGreenStamp.mjs", "scripts/shared/loopCoreAttestationLedger.mjs",
    ".claude/hooks/loop-core-patterns.mjs"]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(import.meta.dirname, "..", path), target);
  }
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "fixture.test.mjs"), `import test from 'node:test';\n${body}`);
  const options = { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000 };
  const init = spawnSync("git", ["init", "--quiet"], options);
  assert.equal(init.status, 0, init.stderr);
  const commit = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.hooksPath=.git/no-hooks", "commit", "--allow-empty", "--no-gpg-sign", "--quiet", "-m", "fixture"], options);
  assert.equal(commit.status, 0, commit.stderr);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner], { ...options, env });
}

test("an early failure stays named in the retained gate stderr after a long passing TAP tail", t => {
  const result = runFixture(t, `
    test('early failure identity', () => { throw new Error('fixture-body-only-secret'); });
    for (let i = 0; i < 200; i++) test('passing tail ' + i, () => {});
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^not ok 1 - early failure identity/m);
  assert.match(result.stdout, /fixture-body-only-secret/);
  assert.match(result.stdout, /^ok 201 - passing tail 199/m);
  assert.match(result.stdout, /^# fail 1/m);
  assert.doesNotMatch(result.stdout.slice(-4_000), /early failure identity/);
  const retained = result.stderr.slice(-4_000);
  assert.match(retained, /Failing contract tests:\r?\n  early failure identity/);
  assert.match(retained, /Contract tests exited 1/);
  assert.doesNotMatch(retained, /fixture-body-only-secret|passing tail/);
});

test("stderr names are bounded and omit diagnostic bodies and path or payload tokens", t => {
  const result = runFixture(t, String.raw`
    test('named failure C:\\private\\sensitive personal.txt', () => {
      throw new Error('fixture-diagnostic-secret\nnot ok 99 - misleading-diagnostic');
    });
    test('second named failure token=fixture-title-secret', () => { throw new Error('fixture-body-only-secret'); });
    test('receipt for customer.csv', () => { throw new Error('fixture-body-only-secret'); });
    test('red fixture token: fixture-title-secret', () => { throw new Error('fixture-body-only-secret'); });
    for (let i = 0; i < 25; i++) test('long failure ' + i + ' ' + 'a'.repeat(500), () => {
      throw new Error('fixture-body-only-secret');
    });
  `);
  assert.equal(result.status, 1, result.stderr);
  const summary = result.stderr.match(/Failing contract tests:\r?\n(?:  [^\r\n]+\r?\n)+/)?.[0];
  assert.ok(summary);
  assert.ok(summary.length < 1_300);
  assert.match(summary, /named failure/);
  assert.match(summary, /second named failure/);
  assert.match(summary, /receipt for \[redacted\]/);
  assert.match(summary, /red fixture \[redacted\]/);
  assert.match(summary, /additional failing tests omitted/);
  assert.doesNotMatch(summary, /fixture-.*secret|personal\.txt|private\.txt|customer\.csv|misleading-diagnostic|long failure 24|a{141}/);
  assert.match(result.stdout, /receipt for customer\.csv/);
  assert.match(result.stdout, /red fixture token: fixture-title-secret/);
  assert.match(result.stdout, /^# fail 29/m);
});

test("a green run retains its TAP output without claiming failures", t => {
  const result = runFixture(t, "test('green identity', () => {});");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok 1 - green identity/m);
  assert.match(result.stdout, /^# fail 0/m);
  assert.equal(result.stderr, "");
});

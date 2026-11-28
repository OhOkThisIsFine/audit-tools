import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const runner = "scripts/shared/run-contract-tests.mjs";

function createFixture(t, body) {
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
  const stampPath = join(root, ".claude/hooks/.state/suite-green/latest.json");
  return {
    stampPath,
    run: ({ childOverride, args = [] } = {}) => {
      // Override only the suite child. The real runner still checks the Git
      // tree, handles its holder and must decide whether to write a stamp.
      const setup = childOverride ? ["--import", `data:text/javascript;base64,${Buffer.from(`
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const spawn = childProcess.spawnSync;
        childProcess.spawnSync = (file, args, options) =>
          file === process.execPath && args[0] === '--test'
            ? (${childOverride})
            : spawn(file, args, options);
        syncBuiltinESMExports();
      `).toString("base64")}`] : [];
      return spawnSync(process.execPath, [...setup, runner, ...args], { ...options, env });
    },
  };
}

const runFixture = (t, body) => createFixture(t, body).run();

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

test("suite child timeout is infrastructure red, followed by a stamp on an unchanged full rerun", t => {
  const fixture = createFixture(t, "test('green identity', () => {});");
  const timedOut = fixture.run({ childOverride: `{
    status: null, signal: 'SIGTERM',
    error: Object.assign(new Error('synthetic spawnSync failure'), { code: 'ETIMEDOUT' }),
    stdout: 'TAP version 13\\nnot ok 1 - incomplete result\\n'
  }` });
  assert.equal(timedOut.status, 1, timedOut.stderr);
  assert.match(timedOut.stdout, /incomplete result/);
  const expectedSeconds = process.platform === "win32" ? 240 : 120;
  assert.ok(timedOut.stderr.includes(`Contract suite timed out (ETIMEDOUT) after ${expectedSeconds}s`), timedOut.stderr);
  assert.match(timedOut.stderr, /Rerun npm run test:built unfiltered on the same unchanged checkout/);
  assert.doesNotMatch(timedOut.stderr, /Failing contract tests|synthetic spawnSync failure|incomplete result/);
  assert.equal(existsSync(fixture.stampPath), false);

  const green = fixture.run();
  assert.equal(green.status, 0, green.stderr);
  const stamp = JSON.parse(readFileSync(fixture.stampPath, "utf8"));
  assert.match(stamp.tree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.equal(stamp.run_evidence.tree_before, stamp.tree);
  assert.equal(stamp.run_evidence.tree_after, stamp.tree);
  assert.deepEqual(stamp.run_evidence.vitest_args, []);
});

test("partial TAP, filter args and a completed assertion failure cannot stamp green", t => {
  const fixture = createFixture(t, "test('assertion red', () => { throw new Error('hidden'); });");
  const partial = fixture.run({ childOverride: `{ status: 0, stdout: 'TAP version 13\\nok 1 - partial\\n' }` });
  assert.equal(partial.status, 1, partial.stderr);
  assert.match(partial.stderr, /Missing or incomplete Node test summary/);
  assert.equal(existsSync(fixture.stampPath), false);

  const filtered = fixture.run({ args: ["--test-name-pattern=assertion"] });
  assert.equal(filtered.status, 1, filtered.stderr);
  assert.match(filtered.stderr, /does not support filters/);
  assert.equal(existsSync(fixture.stampPath), false);

  const red = fixture.run();
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stderr, /Failing contract tests:\r?\n  assertion red/);
  assert.doesNotMatch(red.stderr, /timed out|hidden/);
  assert.equal(existsSync(fixture.stampPath), false);
});

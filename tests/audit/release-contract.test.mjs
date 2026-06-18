import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// Single-package repo: CI workflows live at the repo root (.github/workflows/).
async function readText(relativePath) {
  return await readFile(join(repoRoot, relativePath), "utf8");
}

async function readWorkflow(name) {
  return normalizeLineEndings(
    await readFile(join(repoRoot, ".github", "workflows", name), "utf8"),
  );
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

function collectWorkflowUses(workflow) {
  return workflow
    .split("\n")
    .map((line) => line.match(/^\s*uses:\s*([^#\s]+)/)?.[1])
    .filter((uses) => typeof uses === "string");
}

test("publish contract uses public access and GitHub OIDC trusted publishing", async () => {
  const packageJson = JSON.parse(await readText("package.json"));
  const workflow = await readWorkflow("publish-package.yml");

  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(
    packageJson.scripts?.["release:patch"],
    "node scripts/release-and-publish.mjs patch --bump-only",
  );
  assert.equal(
    packageJson.scripts?.["release:minor"],
    "node scripts/release-and-publish.mjs minor --bump-only",
  );
  assert.equal(
    packageJson.scripts?.["release:major"],
    "node scripts/release-and-publish.mjs major --bump-only",
  );
  assert.equal(
    packageJson.scripts?.["release:patch:publish"],
    "node scripts/release-and-publish.mjs patch",
  );
  assert.equal(
    packageJson.scripts?.["release:minor:publish"],
    "node scripts/release-and-publish.mjs minor",
  );
  assert.equal(
    packageJson.scripts?.["release:major:publish"],
    "node scripts/release-and-publish.mjs major",
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm install -g npm@11\.5\.1 --ignore-scripts/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /Registry propagation succeeded after/);
  assert.match(workflow, /for attempt in \{1\.\.24\}/);
  assert.match(workflow, /publish_tag/);
  assert.match(workflow, /publish-npm-logs/);
  assert.match(workflow, /Upload npm debug logs/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
});

test("release docs point at trusted publishing instead of token-based npm auth", async () => {
  const releaseDocs = await Promise.all([
    readText("docs/audit-pkg/release.md"),
    readText("docs/audit-pkg/product.md"),
    readText("docs/audit-pkg/operator-guide.md"),
    readText("docs/audit-pkg/contracts.md"),
    readText("docs/audit-pkg/development.md"),
  ]);

  for (const content of releaseDocs) {
    assert.doesNotMatch(content, /secrets\.NPM_TOKEN/i);
    assert.doesNotMatch(content, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./i);
  }

  const releasing = releaseDocs[0];
  assert.match(releasing, /Trusted Publishing/i);
  assert.match(releasing, /publish-package\.yml/);
  assert.match(releasing, /workflow_dispatch/);
  assert.match(releasing, /Node `20` and Node `22`/);
  assert.match(releasing, /dry_run=true/);
  assert.match(releasing, /\*-npm-logs/);
  assert.match(releasing, /npm run release:patch/);
  assert.match(releasing, /npm run release:patch:publish/);
  assert.match(releasing, /release:minor/);
  assert.match(releasing, /release:major/);
  assert.match(releasing, /publish-package\.yml/);
});

test("one-command release helper wires the trusted publishing path", async () => {
  const helper = normalizeLineEndings(
    await readText("scripts/release-and-publish.mjs"),
  );

  assert.match(helper, /--bump-only/);
  assert.match(helper, /verify:release/);
  assert.match(helper, /run\(npm, \["version", bump, "--no-git-tag-version"\]\)/);
  assert.match(helper, /run\("git", \["add", "package\.json", "package-lock\.json"\]\)/);
  assert.match(helper, /run\("git", \["commit", "-m", `release: \$\{tag\}`\]\)/);
  assert.match(helper, /run\("git", \["tag", "-a", tag, "-m", tag\]\)/);
  assert.match(helper, /const releaseBranch = bumpOnly \? null : ensureMainBranch\(\)/);
  assert.match(helper, /run\("git", \["push", remoteName, releaseBranch\]\)/);
  assert.match(helper, /waiting for publish run/);
  assert.match(helper, /waiting for npm registry/);
  assert.match(helper, /run\("git", \["push", remoteName, tag\]\)/);
  assert.match(helper, /run\("gh", \["release", "create", tag, "--title", tag, "--generate-notes"\]\)/);
  assert.match(helper, /publish-package\.yml/);
  assert.match(helper, /waitForRegistryVersion/);
  assert.match(helper, /commandName\("npm"\)/);
  assert.match(helper, /`\$\{packageName\}@\$\{version\}`/);
});

test("the single release script imports the pure poll-log throttle helper", async () => {
  // Single-package repo: there is ONE release script (scripts/release-and-publish.mjs)
  // and ONE canonical helper module (scripts/poll-log-throttle.mjs). The helper is a
  // side-effect-free module unit tests can import — the release script runs `await main()`
  // at top level, so the throttle must live outside it.
  const canonicalSource = normalizeLineEndings(
    await readText("scripts/poll-log-throttle.mjs"),
  );

  const constantPattern = /const POLL_LOG_EVERY_N_ATTEMPTS = \d+;/;
  const helperPattern = /function shouldLogPollAttempt\([^)]*\) \{[\s\S]*?\n\}/;

  assert.ok(
    canonicalSource.match(constantPattern)?.[0],
    "scripts/poll-log-throttle.mjs should declare POLL_LOG_EVERY_N_ATTEMPTS",
  );
  assert.ok(
    canonicalSource.match(helperPattern)?.[0],
    "scripts/poll-log-throttle.mjs should define shouldLogPollAttempt",
  );

  // The helper module is pure: no process spawns, timers, or release-script imports.
  assert.doesNotMatch(canonicalSource, /child_process|spawnSync|setTimeout|setInterval/);
  assert.doesNotMatch(canonicalSource, /import .*release-and-publish/);

  // The release script imports the helper instead of redefining it.
  const releaseScript = normalizeLineEndings(
    await readText("scripts/release-and-publish.mjs"),
  );
  assert.match(
    releaseScript,
    /import \{[^}]*shouldLogPollAttempt[^}]*\} from "\.\/poll-log-throttle\.mjs"/,
  );
  assert.doesNotMatch(releaseScript, /function shouldLogPollAttempt/);
  assert.doesNotMatch(releaseScript, /const POLL_LOG_EVERY_N_ATTEMPTS =/);

  // The legacy time-modulo throttle must not survive.
  assert.doesNotMatch(releaseScript, /pollLogIntervalMs/);
  assert.doesNotMatch(releaseScript, /shouldLogPoll\(/);
});

test("shouldLogPollAttempt throttle behavior (pure-function table test)", async () => {
  const source = normalizeLineEndings(
    await readText("scripts/poll-log-throttle.mjs"),
  );
  const constantDeclaration = source.match(
    /const POLL_LOG_EVERY_N_ATTEMPTS = (\d+);/,
  );
  const helperSource = source.match(
    /function shouldLogPollAttempt\([^)]*\) \{[\s\S]*?\n\}/,
  )?.[0];

  assert.ok(constantDeclaration, "expected POLL_LOG_EVERY_N_ATTEMPTS declaration");
  assert.ok(helperSource, "expected shouldLogPollAttempt definition");

  const everyN = Number(constantDeclaration[1]);
  assert.ok(everyN > 1, "heartbeat cadence should be greater than one attempt");

  // The helper must be pure: no clock reads or I/O inside its source.
  assert.doesNotMatch(helperSource, /Date\.now/);
  assert.doesNotMatch(helperSource, /process\./);
  assert.doesNotMatch(helperSource, /readFile|spawnSync|console\./);

  const shouldLogPollAttempt = new Function(
    `${constantDeclaration[0]}\n${helperSource}\nreturn shouldLogPollAttempt;`,
  )();

  // First attempt always logs, regardless of status keys.
  assert.equal(shouldLogPollAttempt(1, "pending", null), true);
  assert.equal(shouldLogPollAttempt(1, "queued/pending", "queued/pending"), true);

  // A genuine status/conclusion enum transition always logs.
  assert.equal(
    shouldLogPollAttempt(5, "in_progress/pending", "queued/pending"),
    true,
  );
  assert.equal(shouldLogPollAttempt(2, "pending", null), true);

  // Steady state: a non-first, non-transition, non-Nth attempt is silent.
  assert.equal(shouldLogPollAttempt(5, "pending", "pending"), false);
  assert.equal(shouldLogPollAttempt(everyN + 1, "pending", "pending"), false);

  // Every-Nth-attempt heartbeat logs even with an unchanged status key.
  assert.equal(shouldLogPollAttempt(everyN, "pending", "pending"), true);
  assert.equal(shouldLogPollAttempt(everyN * 2, "pending", "pending"), true);

  // Deterministic for fixed arguments (no hidden clock/state dependence).
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(shouldLogPollAttempt(5, "pending", "pending"), false);
    assert.equal(shouldLogPollAttempt(everyN, "pending", "pending"), true);
  }
});

test("primary CI workflows validate the lockfile, preserve diagnostics, and make tested Node lines visible", async () => {
  // Per-package CI workflows were consolidated to the monorepo root: ci.yml
  // (lockfile + diagnostics) and audit-code-test-suite.yml (the Node-matrix
  // orchestration suite that absorbed the former test-suite/product-e2e/
  // packaged-entrypoint coverage).
  const ci = await readWorkflow("ci.yml");
  const testSuite = await readWorkflow("audit-code-test-suite.yml");

  for (const workflow of [ci, testSuite]) {
    assert.match(workflow, /Validate package-lock\.json/);
    assert.match(
      workflow,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.match(workflow, /npm-debug\.log\*/);
  }

  assert.match(ci, /CI_NODE_VERSION: "22\.14\.0"/);

  assert.match(testSuite, /name: Orchestration tests \(Node \$\{\{ matrix\.node-version \}\}\)/);
  assert.match(testSuite, /fail-fast: false/);
  assert.ok(testSuite.includes('- "20.19.2"'));
  assert.ok(testSuite.includes('- "22.14.0"'));
  assert.match(testSuite, /audit-code-test-suite-npm-logs-node-\$\{\{ matrix\.node-version \}\}/);
});

test("test-suite workflow pins external GitHub Actions to commit SHAs", async () => {
  const testSuite = await readWorkflow("audit-code-test-suite.yml");
  const usesValues = collectWorkflowUses(testSuite);
  const externalActions = usesValues.filter((uses) => !uses.startsWith("./"));

  assert.ok(externalActions.length > 0, "expected workflow uses entries");

  for (const uses of externalActions) {
    assert.match(
      uses,
      /^[^@\s]+@[0-9a-f]{40}$/i,
      `${uses} should be pinned to a full commit SHA`,
    );
  }

  assert.ok(
    usesValues.some((uses) => uses.startsWith("actions/checkout@")),
    "expected checkout action to remain referenced",
  );
  assert.ok(
    usesValues.some((uses) => uses.startsWith("actions/setup-node@")),
    "expected setup-node action to remain referenced",
  );
  assert.ok(
    usesValues.some((uses) => uses.startsWith("actions/upload-artifact@")),
    "expected upload-artifact action to remain referenced",
  );
});

test("linked and packaged smoke contracts preserve operator diagnostics and isolate inherited npm publish env where needed", async () => {
  const packagedScript = normalizeLineEndings(
    await readText("scripts/audit/smoke-packaged-audit-code.mjs"),
  );
  const linkedScript = normalizeLineEndings(
    await readText("scripts/audit/smoke-linked-audit-code.mjs"),
  );
  const packagingDoc = await readText("docs/audit-pkg/release.md");

  assert.match(packagedScript, /const liveCommandOutput = true;/);
  assert.match(linkedScript, /const liveCommandOutput = true;/);
  assert.match(packagedScript, /function createIsolatedNpmEnv/);
  assert.match(packagedScript, /normalizedKey === "node_auth_token"/);
  assert.match(packagedScript, /normalizedKey === "npm_token"/);
  assert.match(packagedScript, /\[smoke:packaged\] success:/);
  assert.match(linkedScript, /\[smoke:linked\] success:/);
  assert.match(linkedScript, /label: "npm link"/);

  assert.match(packagingDoc, /AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code/);
  assert.match(packagingDoc, /AUDIT_CODE_VERBOSE=1 npm run smoke:linked-audit-code/);
  assert.match(packagingDoc, /npm_config_\*/, "expected packaging docs to mention npm_config_* isolation");
  assert.match(packagingDoc, /NODE_AUTH_TOKEN/);
  assert.match(packagingDoc, /NPM_TOKEN/);
});

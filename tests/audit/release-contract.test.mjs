import { test, expect } from "vitest";
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

  expect(packageJson.publishConfig?.access).toBe("public");
  expect(packageJson.scripts?.["release:patch"]).toBe("node scripts/release-and-publish.mjs patch --bump-only");
  expect(packageJson.scripts?.["release:minor"]).toBe("node scripts/release-and-publish.mjs minor --bump-only");
  expect(packageJson.scripts?.["release:major"]).toBe("node scripts/release-and-publish.mjs major --bump-only");
  expect(packageJson.scripts?.["release:patch:publish"]).toBe("node scripts/release-and-publish.mjs patch");
  expect(packageJson.scripts?.["release:minor:publish"]).toBe("node scripts/release-and-publish.mjs minor");
  expect(packageJson.scripts?.["release:major:publish"]).toBe("node scripts/release-and-publish.mjs major");
  expect(workflow).toMatch(/id-token: write/);
  expect(workflow).toMatch(/npm install -g npm@11\.5\.1 --ignore-scripts/);
  expect(workflow).toMatch(/npm pack --dry-run/);
  expect(workflow).toMatch(/Registry propagation succeeded after/);
  expect(workflow).toMatch(/for attempt in \{1\.\.24\}/);
  expect(workflow).toMatch(/publish_tag/);
  expect(workflow).toMatch(/publish-npm-logs/);
  expect(workflow).toMatch(/Upload npm debug logs/);
  expect(workflow).not.toMatch(/NPM_TOKEN/);
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
    expect(content).not.toMatch(/secrets\.NPM_TOKEN/i);
    expect(content).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./i);
  }

  const releasing = releaseDocs[0];
  expect(releasing).toMatch(/Trusted Publishing/i);
  expect(releasing).toMatch(/publish-package\.yml/);
  expect(releasing).toMatch(/workflow_dispatch/);
  expect(releasing).toMatch(/Node `20` and Node `22`/);
  expect(releasing).toMatch(/dry_run=true/);
  expect(releasing).toMatch(/\*-npm-logs/);
  expect(releasing).toMatch(/npm run release:patch/);
  expect(releasing).toMatch(/npm run release:patch:publish/);
  expect(releasing).toMatch(/release:minor/);
  expect(releasing).toMatch(/release:major/);
  expect(releasing).toMatch(/publish-package\.yml/);
});

test("one-command release helper wires the trusted publishing path", async () => {
  const helper = normalizeLineEndings(
    await readText("scripts/release-and-publish.mjs"),
  );

  expect(helper).toMatch(/--bump-only/);
  expect(helper).toMatch(/verify:release/);
  expect(helper).toMatch(/run\(npm, \["version", bump, "--no-git-tag-version"\]\)/);
  expect(helper).toMatch(/run\("git", \["add", "package\.json", "package-lock\.json"\]\)/);
  expect(helper).toMatch(/run\("git", \["commit", "-m", `release: \$\{tag\}`\]\)/);
  expect(helper).toMatch(/run\("git", \["tag", "-a", tag, "-m", tag\]\)/);
  // CP-NODE-8 (ship-from-linked-worktree): ensureMainBranch now admits a linked-worktree /
  // feature branch whose HEAD == origin/<default> (via the pure evaluateReleaseBranch), and the
  // bump lands on the remote default branch via resolveReleasePushRefspec — so the gate result is
  // `releaseGate` and the push target is the resolved refspec, not the raw branch name.
  expect(helper).toMatch(/const releaseGate = bumpOnly \? null : ensureMainBranch\(\)/);
  expect(helper).toMatch(/function evaluateReleaseBranch\(/);
  expect(helper).toMatch(/function resolveReleasePushRefspec\(/);
  expect(helper).toMatch(/const pushRefspec = resolveReleasePushRefspec\(releaseGate\)/);
  expect(helper).toMatch(/run\("git", \["push", remoteName, pushRefspec\.target\]\)/);
  expect(helper).toMatch(/waiting for publish run/);
  expect(helper).toMatch(/waiting for npm registry/);
  expect(helper).toMatch(/run\("git", \["push", remoteName, tag\]\)/);
  expect(helper).toMatch(/run\("gh", \["release", "create", tag, "--title", tag, "--generate-notes"\]\)/);
  expect(helper).toMatch(/publish-package\.yml/);
  expect(helper).toMatch(/waitForRegistryVersion/);
  expect(helper).toMatch(/commandName\("npm"\)/);
  expect(helper).toMatch(/`\$\{packageName\}@\$\{version\}`/);
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

  expect(canonicalSource.match(constantPattern)?.[0], "scripts/poll-log-throttle.mjs should declare POLL_LOG_EVERY_N_ATTEMPTS").toBeTruthy();
  expect(canonicalSource.match(helperPattern)?.[0], "scripts/poll-log-throttle.mjs should define shouldLogPollAttempt").toBeTruthy();

  // The helper module is pure: no process spawns, timers, or release-script imports.
  expect(canonicalSource).not.toMatch(/child_process|spawnSync|setTimeout|setInterval/);
  expect(canonicalSource).not.toMatch(/import .*release-and-publish/);

  // The release script imports the helper instead of redefining it.
  const releaseScript = normalizeLineEndings(
    await readText("scripts/release-and-publish.mjs"),
  );
  expect(releaseScript).toMatch(/import \{[^}]*shouldLogPollAttempt[^}]*\} from "\.\/poll-log-throttle\.mjs"/);
  expect(releaseScript).not.toMatch(/function shouldLogPollAttempt/);
  expect(releaseScript).not.toMatch(/const POLL_LOG_EVERY_N_ATTEMPTS =/);

  // The legacy time-modulo throttle must not survive.
  expect(releaseScript).not.toMatch(/pollLogIntervalMs/);
  expect(releaseScript).not.toMatch(/shouldLogPoll\(/);
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

  expect(constantDeclaration, "expected POLL_LOG_EVERY_N_ATTEMPTS declaration").toBeTruthy();
  expect(helperSource, "expected shouldLogPollAttempt definition").toBeTruthy();

  const everyN = Number(constantDeclaration[1]);
  expect(everyN > 1, "heartbeat cadence should be greater than one attempt").toBeTruthy();

  // The helper must be pure: no clock reads or I/O inside its source.
  expect(helperSource).not.toMatch(/Date\.now/);
  expect(helperSource).not.toMatch(/process\./);
  expect(helperSource).not.toMatch(/readFile|spawnSync|console\./);

  const shouldLogPollAttempt = new Function(
    `${constantDeclaration[0]}\n${helperSource}\nreturn shouldLogPollAttempt;`,
  )();

  // First attempt always logs, regardless of status keys.
  expect(shouldLogPollAttempt(1, "pending", null)).toBe(true);
  expect(shouldLogPollAttempt(1, "queued/pending", "queued/pending")).toBe(true);

  // A genuine status/conclusion enum transition always logs.
  expect(shouldLogPollAttempt(5, "in_progress/pending", "queued/pending")).toBe(true);
  expect(shouldLogPollAttempt(2, "pending", null)).toBe(true);

  // Steady state: a non-first, non-transition, non-Nth attempt is silent.
  expect(shouldLogPollAttempt(5, "pending", "pending")).toBe(false);
  expect(shouldLogPollAttempt(everyN + 1, "pending", "pending")).toBe(false);

  // Every-Nth-attempt heartbeat logs even with an unchanged status key.
  expect(shouldLogPollAttempt(everyN, "pending", "pending")).toBe(true);
  expect(shouldLogPollAttempt(everyN * 2, "pending", "pending")).toBe(true);

  // Deterministic for fixed arguments (no hidden clock/state dependence).
  for (let repeat = 0; repeat < 3; repeat += 1) {
    expect(shouldLogPollAttempt(5, "pending", "pending")).toBe(false);
    expect(shouldLogPollAttempt(everyN, "pending", "pending")).toBe(true);
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
    expect(workflow).toMatch(/Validate package-lock\.json/);
    expect(workflow).toMatch(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    expect(workflow).toMatch(/npm-debug\.log\*/);
  }

  expect(ci).toMatch(/CI_NODE_VERSION: "22\.14\.0"/);

  expect(testSuite).toMatch(/name: Orchestration tests \(Node \$\{\{ matrix\.node-version \}\}(, shard [^)]+)?\)/);
  expect(testSuite).toMatch(/fail-fast: false/);
  expect(testSuite.includes('- "20.19.2"')).toBeTruthy();
  expect(testSuite.includes('- "22.14.0"')).toBeTruthy();
  expect(testSuite).toMatch(/audit-code-test-suite-npm-logs-node-\$\{\{ matrix\.node-version \}\}/);
});

test("test-suite workflow pins external GitHub Actions to commit SHAs", async () => {
  const testSuite = await readWorkflow("audit-code-test-suite.yml");
  const usesValues = collectWorkflowUses(testSuite);
  const externalActions = usesValues.filter((uses) => !uses.startsWith("./"));

  expect(externalActions.length > 0, "expected workflow uses entries").toBeTruthy();

  for (const uses of externalActions) {
    expect(uses, `${uses} should be pinned to a full commit SHA`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/i);
  }

  expect(usesValues.some((uses) => uses.startsWith("actions/checkout@")), "expected checkout action to remain referenced").toBeTruthy();
  expect(usesValues.some((uses) => uses.startsWith("actions/setup-node@")), "expected setup-node action to remain referenced").toBeTruthy();
  expect(usesValues.some((uses) => uses.startsWith("actions/upload-artifact@")), "expected upload-artifact action to remain referenced").toBeTruthy();
});

test("linked and packaged smoke contracts preserve operator diagnostics and isolate inherited npm publish env where needed", async () => {
  const packagedScript = normalizeLineEndings(
    await readText("scripts/audit/smoke-packaged-audit-code.mjs"),
  );
  const linkedScript = normalizeLineEndings(
    await readText("scripts/audit/smoke-linked-audit-code.mjs"),
  );
  const packagingDoc = await readText("docs/audit-pkg/release.md");

  expect(packagedScript).toMatch(/const liveCommandOutput = true;/);
  expect(linkedScript).toMatch(/const liveCommandOutput = true;/);
  expect(packagedScript).toMatch(/function createIsolatedNpmEnv/);
  expect(packagedScript).toMatch(/normalizedKey === "node_auth_token"/);
  expect(packagedScript).toMatch(/normalizedKey === "npm_token"/);
  expect(packagedScript).toMatch(/\[smoke:packaged\] success:/);
  expect(linkedScript).toMatch(/\[smoke:linked\] success:/);
  expect(linkedScript).toMatch(/label: "npm link"/);

  expect(packagingDoc).toMatch(/AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code/);
  expect(packagingDoc).toMatch(/AUDIT_CODE_VERBOSE=1 npm run smoke:linked-audit-code/);
  expect(packagingDoc, "expected packaging docs to mention npm_config_* isolation").toMatch(/npm_config_\*/);
  expect(packagingDoc).toMatch(/NODE_AUTH_TOKEN/);
  expect(packagingDoc).toMatch(/NPM_TOKEN/);
});

test("update-languages writes the real extractor map path and the header points back at the script", async () => {
  // The generated map lives at src/audit/extractors/languageMap.generated.ts.
  // From scripts/audit/, the correct relative path is ../../src/audit/extractors.
  // A stale ../src/extractors target silently writes scripts/src/extractors and
  // never regenerates the real file.
  const script = normalizeLineEndings(await readText("scripts/audit/update-languages.mjs"));
  expect(script, "update-languages must target src/audit/extractors/languageMap.generated.ts").toMatch(/"\.\.\/\.\.\/src\/audit\/extractors\/languageMap\.generated\.ts"/);
  expect(script).not.toMatch(/"\.\.\/src\/extractors\//);
  expect(script).toMatch(/scripts\/audit\/update-languages\.mjs/);

  // The real generated file exists at the targeted location.
  const generated = await readText("src/audit/extractors/languageMap.generated.ts");
  expect(generated).toMatch(/LANGUAGE_BY_EXTENSION/);
});

test("audit-code test-suite CI triggers on package.json and the workflow file itself", async () => {
  const testSuite = await readWorkflow("audit-code-test-suite.yml");
  // A package.json change (scripts/deps) or a workflow change must re-run CI;
  // otherwise a broken script/dep edit ships without a gate. The workflow-file
  // trigger may be pinned explicitly or covered by the `.github/workflows/**`
  // glob (a superset that also re-runs on any sibling workflow edit).
  expect(testSuite).toMatch(/- package\.json\n/);
  expect(testSuite).toMatch(/- \.github\/workflows\/(\*\*|audit-code-test-suite\.yml)\n/);
});

test("audit-code postinstall fails non-zero when an install step fails (parity with remediate)", async () => {
  const auditPostinstall = normalizeLineEndings(
    await readText("scripts/audit/postinstall.mjs"),
  );
  const remediatePostinstall = normalizeLineEndings(
    await readText("scripts/remediate/postinstall.mjs"),
  );
  for (const source of [auditPostinstall, remediatePostinstall]) {
    expect(source, "postinstall must surface failures as a non-zero exit").toMatch(/if \(failed > 0\) \{\s*process\.exitCode = 1;\s*\}/);
  }
});

test("dead-code gate config is single-sourced in knip.json, not split into the npm script", async () => {
  const knip = JSON.parse(await readText("knip.json"));
  expect(knip.include).toEqual(["exports", "types", "nsExports", "nsTypes"]);
  const packageJson = JSON.parse(await readText("package.json"));
  expect(packageJson.scripts?.["check:deadcode"]).toBe("knip --no-config-hints");
  expect(packageJson.scripts?.["check:deadcode"] ?? "", "issue-type filter must live in knip.json, not inline in the script").not.toMatch(/--include/);
});

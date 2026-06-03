import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

async function readText(relativePath) {
  return await readFile(join(repoRoot, relativePath), "utf8");
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
  const workflow = normalizeLineEndings(
    await readText(".github/workflows/publish-package.yml"),
  );

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
  assert.match(workflow, /npm install -g npm@\^11\.5\.1/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /Registry propagation is still pending/);
  assert.match(workflow, /for attempt in \{1\.\.24\}/);
  assert.match(workflow, /publish_tag/);
  assert.match(workflow, /publish-npm-logs/);
  assert.match(workflow, /Upload npm debug logs/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
});

test("release docs point at trusted publishing instead of token-based npm auth", async () => {
  const releaseDocs = await Promise.all([
    readText("docs/release.md"),
    readText("docs/product.md"),
    readText("docs/operator-guide.md"),
    readText("docs/contracts.md"),
    readText("docs/development.md"),
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
  assert.match(helper, /run\("git", \["add", "package\.json", "package-lock\.json", "..\/..\/package-lock\.json"\]\)/);
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

test("primary CI workflows validate the lockfile, preserve diagnostics, and make tested Node lines visible", async () => {
  const ci = normalizeLineEndings(await readText(".github/workflows/ci.yml"));
  const testSuite = normalizeLineEndings(
    await readText(".github/workflows/test-suite.yml"),
  );
  const product = normalizeLineEndings(
    await readText(".github/workflows/product-e2e.yml"),
  );
  const packaged = normalizeLineEndings(
    await readText(".github/workflows/packaged-entrypoint.yml"),
  );

  for (const workflow of [ci, testSuite, product, packaged]) {
    assert.match(workflow, /Validate package-lock\.json/);
    assert.match(
      workflow,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.match(workflow, /npm-debug\.log\*/);
  }

  assert.match(ci, /CI_NODE_VERSION: "22\.14\.0"/);
  assert.match(product, /CI_NODE_VERSION: "22\.14\.0"/);
  assert.match(packaged, /CI_NODE_VERSION: "22\.14\.0"/);

  assert.match(testSuite, /name: Orchestration tests \(Node \$\{\{ matrix\.node-version \}\}\)/);
  assert.match(testSuite, /fail-fast: false/);
  assert.ok(testSuite.includes('- "20.19.2"'));
  assert.ok(testSuite.includes('- "22.14.0"'));
  assert.match(testSuite, /test-suite-npm-logs-node-\$\{\{ matrix\.node-version \}\}/);
});

test("test-suite workflow pins external GitHub Actions to commit SHAs", async () => {
  const testSuite = normalizeLineEndings(
    await readText(".github/workflows/test-suite.yml"),
  );
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
    await readText("scripts/smoke-packaged-audit-code.mjs"),
  );
  const linkedScript = normalizeLineEndings(
    await readText("scripts/smoke-linked-audit-code.mjs"),
  );
  const packagingDoc = await readText("docs/release.md");

  assert.match(packagedScript, /const liveCommandOutput = verbose \|\| process\.env\.CI === "true";/);
  assert.match(linkedScript, /const liveCommandOutput = verbose \|\| process\.env\.CI === "true";/);
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

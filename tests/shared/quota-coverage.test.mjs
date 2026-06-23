/**
 * Proactive-quota coverage classification + the unestablished-environment nudge:
 * an unsupported host provider is surfaced as `unestablished` (a loud, self-healing
 * signal) instead of silently degrading to reactive 429. See
 * docs/quota-dispatch-design.md §4.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";

const {
  classifyQuotaCoverage,
  sourceCoversProvider,
  renderUnestablishedQuotaNudge,
  REACTIVE_ONLY_PROVIDERS,
} = await import("../../src/shared/quota/coverage.ts");
const { shouldEmitQuotaNudge, quotaNudgeMarkerName, renderQuotaCoverageNudge } = await import(
  "../../src/shared/quota/quotaCoverageNudge.ts"
);
const { buildQuotaSource } = await import("../../src/shared/quota/compositeQuotaSource.ts");
const { ClaudeOAuthQuotaSource } = await import("../../src/shared/quota/claudeOAuthQuotaSource.ts");

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
function mkTmp() {
  const dir = mkdtempSync(join(tmpdir(), "quota-cov-"));
  tmpDirs.push(dir);
  return dir;
}

// ---- classifyQuotaCoverage ----

test("classifyQuotaCoverage: covered → established", () => {
  assert.equal(classifyQuotaCoverage("claude-code", true), "established");
});

test("classifyQuotaCoverage: uncovered reactive-only provider → reactive_only (not a gap)", () => {
  for (const p of REACTIVE_ONLY_PROVIDERS) {
    assert.equal(classifyQuotaCoverage(p, false), "reactive_only");
  }
});

test("classifyQuotaCoverage: uncovered unknown provider → unestablished", () => {
  assert.equal(classifyQuotaCoverage("some-future-ide", false), "unestablished");
});

// ---- coversProvider capability (no creds/network) ----

test("a proactive source covers exactly its providers; composite is the union", () => {
  const claude = new ClaudeOAuthQuotaSource();
  assert.equal(sourceCoversProvider(claude, "claude-code"), true);
  assert.equal(sourceCoversProvider(claude, "codex"), false);

  const composite = buildQuotaSource();
  assert.equal(composite.coversProvider("claude-code"), true);
  assert.equal(composite.coversProvider("codex"), true);
  // An as-yet-unsupported host provider is NOT covered.
  assert.equal(composite.coversProvider("some-future-ide"), false);
});

// ---- the nudge text ----

test("renderUnestablishedQuotaNudge names the provider and both recovery paths", () => {
  const txt = renderUnestablishedQuotaNudge("some-future-ide");
  assert.match(txt, /some-future-ide/);
  assert.match(txt, /NOT established/);
  assert.match(txt, /BUILT-IN access/);
  assert.match(txt, /search online|third-party tool/i);
});

// ---- once-per-environment gating ----

test("shouldEmitQuotaNudge fires once per (artifactDir, provider), then is quiet", () => {
  const dir = mkTmp();
  assert.equal(shouldEmitQuotaNudge(dir, "some-future-ide"), true);
  assert.ok(existsSync(join(dir, quotaNudgeMarkerName("some-future-ide"))));
  assert.equal(shouldEmitQuotaNudge(dir, "some-future-ide"), false);
  // A different provider in the same dir is independent.
  assert.equal(shouldEmitQuotaNudge(dir, "another-ide"), true);
});

// ---- renderQuotaCoverageNudge from a written dispatch-quota.json ----

function writeQuota(dir, pools) {
  const p = join(dir, "dispatch-quota.json");
  writeFileSync(p, JSON.stringify({ capacity_pools: pools }));
  return p;
}

test("renderQuotaCoverageNudge: full block first, terse after, for an unestablished pool", () => {
  const dir = mkTmp();
  const quotaPath = writeQuota(dir, [{ pool_id: "some-future-ide/*", quota_coverage: "unestablished" }]);
  const first = renderQuotaCoverageNudge(quotaPath, dir);
  assert.match(first, /NOT established/);
  assert.match(first, /some-future-ide/);
  const second = renderQuotaCoverageNudge(quotaPath, dir);
  assert.match(second, /unestablished for `some-future-ide`/);
  assert.doesNotMatch(second, /NOT established/); // terse, not the full block
});

test("renderQuotaCoverageNudge: empty for established / reactive_only / missing file", () => {
  const dir = mkTmp();
  assert.equal(renderQuotaCoverageNudge(writeQuota(dir, [{ pool_id: "claude-code/*", quota_coverage: "established" }]), dir), "");
  assert.equal(renderQuotaCoverageNudge(writeQuota(dir, [{ pool_id: "openai-compatible/*", quota_coverage: "reactive_only" }]), dir), "");
  assert.equal(renderQuotaCoverageNudge(null, dir), "");
  assert.equal(renderQuotaCoverageNudge(join(dir, "nope.json"), dir), "");
});

test("renderQuotaCoverageNudge: account-keyed pool id still resolves the provider", () => {
  const dir = mkTmp();
  const quotaPath = writeQuota(dir, [{ pool_id: "some-future-ide#acctA/model-x", quota_coverage: "unestablished" }]);
  assert.match(renderQuotaCoverageNudge(quotaPath, dir), /some-future-ide/);
});

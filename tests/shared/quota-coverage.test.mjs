/**
 * Proactive-quota coverage classification + the unestablished-environment nudge:
 * an unsupported host provider is surfaced as `unestablished` (a loud, self-healing
 * signal) instead of silently degrading to reactive 429. See
 * docs/quota-dispatch-design.md §4.
 */

import { test, afterEach, expect } from "vitest";
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
  expect(classifyQuotaCoverage("claude-code", true)).toBe("established");
});

test("classifyQuotaCoverage: uncovered reactive-only provider → reactive_only (not a gap)", () => {
  for (const p of REACTIVE_ONLY_PROVIDERS) {
    expect(classifyQuotaCoverage(p, false)).toBe("reactive_only");
  }
});

test("classifyQuotaCoverage: uncovered unknown provider → unestablished", () => {
  expect(classifyQuotaCoverage("some-future-ide", false)).toBe("unestablished");
});

// ---- coversProvider capability (no creds/network) ----

test("a proactive source covers exactly its providers; composite is the union", () => {
  const claude = new ClaudeOAuthQuotaSource();
  expect(sourceCoversProvider(claude, "claude-code")).toBe(true);
  expect(sourceCoversProvider(claude, "codex")).toBe(false);

  const composite = buildQuotaSource();
  expect(composite.coversProvider("claude-code")).toBe(true);
  expect(composite.coversProvider("codex")).toBe(true);
  // An as-yet-unsupported host provider is NOT covered.
  expect(composite.coversProvider("some-future-ide")).toBe(false);
});

// ---- the nudge text ----

test("renderUnestablishedQuotaNudge names the provider and both recovery paths", () => {
  const txt = renderUnestablishedQuotaNudge("some-future-ide");
  expect(txt).toMatch(/some-future-ide/);
  expect(txt).toMatch(/NOT established/);
  expect(txt).toMatch(/BUILT-IN access/);
  expect(txt).toMatch(/search online|third-party tool/i);
});

// ---- once-per-environment gating ----

test("shouldEmitQuotaNudge fires once per (artifactDir, provider), then is quiet", () => {
  const dir = mkTmp();
  expect(shouldEmitQuotaNudge(dir, "some-future-ide")).toBe(true);
  expect(existsSync(join(dir, quotaNudgeMarkerName("some-future-ide")))).toBeTruthy();
  expect(shouldEmitQuotaNudge(dir, "some-future-ide")).toBe(false);
  // A different provider in the same dir is independent.
  expect(shouldEmitQuotaNudge(dir, "another-ide")).toBe(true);
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
  expect(first).toMatch(/NOT established/);
  expect(first).toMatch(/some-future-ide/);
  const second = renderQuotaCoverageNudge(quotaPath, dir);
  expect(second).toMatch(/unestablished for `some-future-ide`/);
  expect(second).not.toMatch(/NOT established/); // terse, not the full block
});

test("renderQuotaCoverageNudge: empty for established / reactive_only / missing file", () => {
  const dir = mkTmp();
  expect(renderQuotaCoverageNudge(writeQuota(dir, [{ pool_id: "claude-code/*", quota_coverage: "established" }]), dir)).toBe("");
  expect(renderQuotaCoverageNudge(writeQuota(dir, [{ pool_id: "openai-compatible/*", quota_coverage: "reactive_only" }]), dir)).toBe("");
  expect(renderQuotaCoverageNudge(null, dir)).toBe("");
  expect(renderQuotaCoverageNudge(join(dir, "nope.json"), dir)).toBe("");
});

test("renderQuotaCoverageNudge: account-keyed pool id still resolves the provider", () => {
  const dir = mkTmp();
  const quotaPath = writeQuota(dir, [{ pool_id: "some-future-ide#acctA/model-x", quota_coverage: "unestablished" }]);
  expect(renderQuotaCoverageNudge(quotaPath, dir)).toMatch(/some-future-ide/);
});

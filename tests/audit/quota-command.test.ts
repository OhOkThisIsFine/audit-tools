import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// Import the .ts sources (tsx/esm transpiles on the fly) so cmdQuota and
// setQuotaStateDir share the SAME module singleton — mixing dist + src would
// give each its own quota-state-dir slot and the dir we set wouldn't be seen.
const quotaCommandUrl = pathToFileURL(
  join(repoRoot, "src", "audit", "cli", "quotaCommand.js"),
).href;
const quotaStateUrl = pathToFileURL(
  join(repoRoot, "src", "shared", "quota", "state.js"),
).href;

const { cmdQuota } = await import(quotaCommandUrl);
const { setQuotaStateDir } = await import(quotaStateUrl);

interface CapacityPreview {
  pools: Array<{ id: string; providerName: string }>;
  tier_budgets: Record<string, number> | null;
  context_budget_tokens: number;
}

// Each cmdQuota run keys quota state / discovered-limits off getQuotaStatePath()'s
// dir. Point that at a fresh temp dir per run so the preview is computed against a
// pristine cache (no learned entries leaking in) and any accidental writes land
// in the sandbox rather than the user's ~/.audit-code.
// Every cmdQuota run must be sandboxed on TWO axes: the quota-state dir (set via
// setQuotaStateDir) AND the artifacts dir. `loadSessionConfig` materializes a
// default `session-config.json` on read when the file is missing, so a cmdQuota
// call with no `--root`/`--artifacts-dir` would write it under the repo's own
// CWD-relative `.audit-tools/audit` — polluting the tree. Point --artifacts-dir
// at the per-run temp dir so that write lands in the sandbox and is cleaned up.
function sandboxArtifactsDir(stateDir: string): string {
  return join(stateDir, ".audit-tools", "audit");
}

function quotaArgv(stateDir: string, argv: string[]): string[] {
  return [
    process.execPath,
    "cli.js",
    "quota",
    "--artifacts-dir",
    sandboxArtifactsDir(stateDir),
    ...argv,
  ];
}

async function runQuota(argv: string[]) {
  const stateDir = await mkdtemp(join(tmpdir(), "quota-cmd-"));
  setQuotaStateDir(stateDir);
  try {
    const result = await captureConsole(() =>
      cmdQuota(quotaArgv(stateDir, argv)),
    );
    return { ...result, stateDir };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function parsePreview(stdout: string): CapacityPreview {
  const parsed: { capacity_preview: CapacityPreview } = JSON.parse(stdout);
  expect(parsed.capacity_preview, "output should carry a capacity_preview block").toBeTruthy();
  return parsed.capacity_preview;
}

const ROSTER = JSON.stringify([
  { rank: "small", context_tokens: 32000, output_tokens: 4000 },
  { rank: "standard", context_tokens: 200000, output_tokens: 16000 },
  { rank: "deep", context_tokens: 1000000, output_tokens: 64000 },
]);
const SCALAR_AUDITOR_ARG = JSON.stringify({
  self: {
    context_tokens: 200_000,
    output_tokens: 8_000,
  },
});

test("multi-rank --auditor roster shapes the preview and differs from a scalar handshake", async () => {
  const withRoster = await runQuota(["--auditor", JSON.stringify({self: {roster: JSON.parse(ROSTER)}})]);
  const noRoster = await runQuota(["--auditor", SCALAR_AUDITOR_ARG]);

  const rosterPreview = parsePreview(withRoster.stdout);
  const cachedPreview = parsePreview(noRoster.stdout);

  // Roster produces one pool per rank + populated tier budgets.
  expect(rosterPreview.pools.length, "one pool per reported rank").toBe(3);
  expect(rosterPreview.tier_budgets, "roster preview has tier_budgets").toBeTruthy();
  if (rosterPreview.tier_budgets === null) {
    throw new TypeError("roster preview omitted tier budgets");
  }
  expect(Object.keys(rosterPreview.tier_budgets).length >= 3, "tier_budgets populated across ranks").toBeTruthy();

  // A scalar handshake produces one pool and no per-rank tier budgets.
  expect(cachedPreview.pools.length, "scalar handshake produces one pool").toBe(1);
  expect(cachedPreview.tier_budgets, "no-roster has no tier_budgets").toBe(null);

  // Guard against a tautology: the roster-derived budget must actually reflect
  // its largest reported window rather than collapsing to the scalar handshake.
  expect(rosterPreview, "roster preview must differ from the scalar preview").not.toEqual(cachedPreview);
  expect(rosterPreview.context_budget_tokens > cachedPreview.context_budget_tokens, `roster budget (${rosterPreview.context_budget_tokens}) should exceed scalar budget (${cachedPreview.context_budget_tokens})`).toBeTruthy();
});

test("queryLimits undefined does not zero/empty the roster-derived preview", async () => {
  const { stdout } = await runQuota(["--auditor", JSON.stringify({self: {roster: JSON.parse(ROSTER)}})]);
  const preview = parsePreview(stdout);
  expect(preview.pools.length, "pools present without a live provider query").toBe(3);
  expect(preview.context_budget_tokens > 1, "context budget is the roster window, not a zeroed floor").toBeTruthy();
  if (preview.tier_budgets === null) {
    throw new TypeError("roster preview omitted tier budgets");
  }
  for (const budget of Object.values(preview.tier_budgets)) {
    expect(budget > 1, "each tier budget is non-trivial").toBeTruthy();
  }
});

// G1: the audit CLI no longer parses a roster STRING — the whole handshake arrives
// as one `--auditor <json>` value that getAuditorDescriptor validates. The
// fail-loudly guarantee is now that a malformed `--auditor` value throws rather
// than silently downgrading (the same never-swallow intent as the retired
// `--host-models` parser check).
test("malformed --auditor JSON throws loudly (not swallowed)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "quota-cmd-"));
  setQuotaStateDir(stateDir);
  try {
    await assert.rejects(
      () => cmdQuota(quotaArgv(stateDir, ["--auditor", "{not json"])),
      /JSON object/,
      "malformed --auditor JSON must throw loudly",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("scalar handshake → single-pool preview, and nothing is written to disk", async () => {
  const { stdout, stateDir, repoRootBefore } = await runQuotaKeepDir([
    "--auditor",
    SCALAR_AUDITOR_ARG,
  ]);
  try {
    const preview = parsePreview(stdout);
    expect(preview.pools.length, "single scalar-handshake pool").toBe(1);
    expect(preview.tier_budgets, "no tier budgets without a roster").toBe(null);
    // Read-only command: must not invoke finalizeDispatchQuota.
    expect(!existsSync(join(stateDir, "dispatch-quota.json")), "quota command must not write dispatch-quota.json").toBeTruthy();
    // Regression guard: loadSessionConfig's write-on-read must land in the
    // sandbox artifacts dir, NOT the repo's own CWD-relative .audit-tools/audit.
    expect(
      existsSync(join(sandboxArtifactsDir(stateDir), "session-config.json")),
      "session-config default must be written under the sandbox artifacts dir",
    ).toBeTruthy();
    expect(
      fingerprintRepoRootSessionConfig(),
      "cmdQuota must never create or modify session-config in the repo root",
    ).toBe(repoRootBefore);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// The repo-root path cmdQuota must never write. A DOGFOOD run legitimately
// creates this file in a working checkout, so its mere existence says nothing —
// asserting absence made the test a function of whether a self-audit had ever
// run here, and that false red once fanned out into 29 real dispatched tasks
// (re-dogfood-endgame-2026-07-22, RTV-TST-001). Fingerprint it instead: what the
// guard actually means is "cmdQuota did not CREATE or MODIFY it".
const repoRootSessionConfig = join(repoRoot, ".audit-tools", "audit", "session-config.json");

function fingerprintRepoRootSessionConfig(): string {
  try {
    const stat = statSync(repoRootSessionConfig);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

// Variant of runQuota that leaves the temp dir intact so the caller can assert on
// what (if anything) the command wrote.
async function runQuotaKeepDir(argv: string[]) {
  const stateDir = await mkdtemp(join(tmpdir(), "quota-cmd-"));
  setQuotaStateDir(stateDir);
  const repoRootBefore = fingerprintRepoRootSessionConfig();
  const result = await captureConsole(() =>
    cmdQuota(quotaArgv(stateDir, argv)),
  );
  return { ...result, stateDir, repoRootBefore };
}

test("explicit provider is used for capacity preview pools", async () => {
  const { stdout } = await runQuota(["--provider", "codex", "--auditor", JSON.stringify({self: {roster: JSON.parse(ROSTER)}})]);
  const preview = parsePreview(stdout);

  expect(preview.pools.length, "roster still creates one pool per rank").toBe(3);
  for (const pool of preview.pools) {
    expect(pool.providerName).toBe("codex");
    expect(pool.id.startsWith("codex/")).toBeTruthy();
  }
});

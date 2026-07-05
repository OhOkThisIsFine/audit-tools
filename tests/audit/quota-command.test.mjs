import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// Import the .ts sources (tsx/esm transpiles on the fly) so cmdQuota and
// setQuotaStateDir share the SAME module singleton — mixing dist + src would
// give each its own quota-state-dir slot and the dir we set wouldn't be seen.
const quotaCommandUrl = pathToFileURL(
  join(repoRoot, "src", "audit", "cli", "quotaCommand.ts"),
).href;
const quotaStateUrl = pathToFileURL(
  join(repoRoot, "src", "shared", "quota", "state.ts"),
).href;

const { cmdQuota } = await import(quotaCommandUrl);
const { setQuotaStateDir } = await import(quotaStateUrl);

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
function sandboxArtifactsDir(stateDir) {
  return join(stateDir, ".audit-tools", "audit");
}

function quotaArgv(stateDir, argv) {
  return [
    process.execPath,
    "cli.js",
    "quota",
    "--artifacts-dir",
    sandboxArtifactsDir(stateDir),
    ...argv,
  ];
}

async function runQuota(argv) {
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

function parsePreview(stdout) {
  const parsed = JSON.parse(stdout);
  expect(parsed.capacity_preview, "output should carry a capacity_preview block").toBeTruthy();
  return parsed.capacity_preview;
}

const ROSTER = JSON.stringify([
  { rank: "small", context_tokens: 32000, output_tokens: 4000 },
  { rank: "standard", context_tokens: 200000, output_tokens: 16000 },
  { rank: "deep", context_tokens: 1000000, output_tokens: 64000 },
]);

test("multi-rank --host-models roster shapes the preview and differs from no-roster", async () => {
  const withRoster = await runQuota(["--host-models", ROSTER]);
  const noRoster = await runQuota([]);

  const rosterPreview = parsePreview(withRoster.stdout);
  const cachedPreview = parsePreview(noRoster.stdout);

  // Roster produces one pool per rank + populated tier budgets.
  expect(rosterPreview.pools.length, "one pool per reported rank").toBe(3);
  expect(rosterPreview.tier_budgets, "roster preview has tier_budgets").toBeTruthy();
  expect(Object.keys(rosterPreview.tier_budgets).length >= 3, "tier_budgets populated across ranks").toBeTruthy();

  // No-roster preview is the conservative cached/learned single pool.
  expect(cachedPreview.pools.length, "no-roster falls back to one pool").toBe(1);
  expect(cachedPreview.tier_budgets, "no-roster has no tier_budgets").toBe(null);

  // Guard against a tautology: the roster-derived budget must actually reflect
  // the reported (large) windows, NOT collapse to the cached/learned floor.
  expect(rosterPreview, "roster preview must differ from the cached/learned preview").not.toEqual(cachedPreview);
  expect(rosterPreview.context_budget_tokens > cachedPreview.context_budget_tokens, `roster budget (${rosterPreview.context_budget_tokens}) should exceed cached floor (${cachedPreview.context_budget_tokens})`).toBeTruthy();
});

test("queryLimits undefined does not zero/empty the roster-derived preview", async () => {
  const { stdout } = await runQuota(["--host-models", ROSTER]);
  const preview = parsePreview(stdout);
  expect(preview.pools.length, "pools present without a live provider query").toBe(3);
  expect(preview.context_budget_tokens > 1, "context budget is the roster window, not a zeroed floor").toBeTruthy();
  for (const budget of Object.values(preview.tier_budgets)) {
    expect(budget > 1, "each tier budget is non-trivial").toBeTruthy();
  }
});

test("malformed --host-models JSON surfaces the shared parser error (not swallowed)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "quota-cmd-"));
  setQuotaStateDir(stateDir);
  try {
    await assert.rejects(
      () => cmdQuota(quotaArgv(stateDir, ["--host-models", "{not json"])),
      /--host-models must be valid JSON/,
      "malformed roster must throw the getHostModelRoster/parseHostModelRoster error",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("no handshake flags → cached/learned preview, and nothing is written to disk", async () => {
  const { stdout, stateDir } = await runQuotaKeepDir([]);
  try {
    const preview = parsePreview(stdout);
    expect(preview.pools.length, "single cached/learned pool").toBe(1);
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
      !existsSync(join(repoRoot, ".audit-tools", "audit", "session-config.json")),
      "cmdQuota must never write session-config into the repo root",
    ).toBeTruthy();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// Variant of runQuota that leaves the temp dir intact so the caller can assert on
// what (if anything) the command wrote.
async function runQuotaKeepDir(argv) {
  const stateDir = await mkdtemp(join(tmpdir(), "quota-cmd-"));
  setQuotaStateDir(stateDir);
  const result = await captureConsole(() =>
    cmdQuota(quotaArgv(stateDir, argv)),
  );
  return { ...result, stateDir };
}

test("explicit provider is used for capacity preview pools", async () => {
  const { stdout } = await runQuota(["--provider", "codex", "--host-models", ROSTER]);
  const preview = parsePreview(stdout);

  expect(preview.pools.length, "roster still creates one pool per rank").toBe(3);
  for (const pool of preview.pools) {
    expect(pool.providerName).toBe("codex");
    expect(pool.id.startsWith("codex/")).toBeTruthy();
  }
});

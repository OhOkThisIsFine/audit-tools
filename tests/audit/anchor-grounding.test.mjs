// S7 tier-2: executable anchors. A finding's behavior claim ("no cycle", "unused
// symbol") ships a read-only command; the tool runs it and the verdict — not the
// model's word — grounds or quarantines the finding. Safety: inspection-only
// allowlist, timeout, env kill-switch, no shell. Tested with an injected runner
// for deterministic logic plus one real allowlisted spawn end-to-end.
import { test, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..");

const { verifyFindingAnchor, combineGroundingWithAnchor, isAllowedAnchorCommand, resolveAnchorTimeoutMs, ANCHOR_TIMEOUT_MS } =
  await import("../../src/audit/validation/anchorGrounding.ts");

test("resolveAnchorTimeoutMs honors AUDIT_CODE_ANCHOR_TIMEOUT_MS and falls back to the default (B1)", () => {
  expect(resolveAnchorTimeoutMs({}), "no override → default").toBe(ANCHOR_TIMEOUT_MS);
  expect(resolveAnchorTimeoutMs({ AUDIT_CODE_ANCHOR_TIMEOUT_MS: "120000" }), "positive int override is used").toBe(120000);
  // Non-positive / non-numeric overrides fall back to the default (never 0/NaN).
  expect(resolveAnchorTimeoutMs({ AUDIT_CODE_ANCHOR_TIMEOUT_MS: "0" })).toBe(ANCHOR_TIMEOUT_MS);
  expect(resolveAnchorTimeoutMs({ AUDIT_CODE_ANCHOR_TIMEOUT_MS: "-5" })).toBe(ANCHOR_TIMEOUT_MS);
  expect(resolveAnchorTimeoutMs({ AUDIT_CODE_ANCHOR_TIMEOUT_MS: "abc" })).toBe(ANCHOR_TIMEOUT_MS);
});

function findingWithAnchor(anchor) {
  return {
    id: "F",
    title: "t",
    category: "c",
    severity: "high",
    confidence: "high",
    lens: "architecture",
    summary: "s",
    affected_files: [{ path: "src/a.ts" }],
    evidence: ["e"],
    ...(anchor ? { executable_anchor: anchor } : {}),
  };
}

const fixedRunner = (outcome) => async () => outcome;
const throwRunner = async () => {
  throw new Error("runner must not be called for a skipped anchor");
};

test("isAllowedAnchorCommand allows inspection tools + read-only git, rejects the rest", () => {
  for (const cmd of [
    ["grep", "-r", "x", "."],
    ["rg", "x"],
    ["ripgrep", "x"],
    ["findstr", "/s", "x", "."],
    ["madge", "--circular", "src"],
    ["ast-grep", "run"],
    ["sg", "-p", "x"],
    ["/usr/bin/grep", "x"],
    ["grep.exe", "x"],
  ]) {
    expect(isAllowedAnchorCommand(cmd), `should allow ${cmd.join(" ")}`).toBe(true);
  }
  for (const sub of ["grep", "log", "diff", "show", "ls-files", "cat-file", "blame", "rev-parse", "status"]) {
    expect(isAllowedAnchorCommand(["git", sub, "x"]), `should allow git ${sub}`).toBe(true);
  }
  for (const cmd of [
    ["node", "-e", "x"],
    ["npm", "run", "x"],
    ["npx", "y"],
    ["rm", "-rf", "/"],
    ["del", "x"],
    ["eslint", "--fix", "."],
    ["tsc"],
    ["git", "push"],
    ["git", "reset", "--hard"],
    ["git", "checkout", "."],
    [""],
    [],
  ]) {
    expect(isAllowedAnchorCommand(cmd), `should reject ${cmd.join(" ") || "(empty)"}`).toBe(false);
  }
});

test("verifyFindingAnchor returns undefined when the finding has no anchor", async () => {
  expect(await verifyFindingAnchor("/repo", findingWithAnchor(null))).toBe(undefined);
});

test("verifyFindingAnchor confirms/refutes by exit code", async () => {
  const f = findingWithAnchor({ command: ["madge", "--circular", "src"], confirm_if: { kind: "exit_nonzero" } });
  expect((await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: 1, timed_out: false, output: "cycle" }))).status).toBe("confirmed");
  expect((await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: 0, timed_out: false, output: "" }))).status).toBe("refuted");
});

test("verifyFindingAnchor confirms/refutes by output match (both polarities)", async () => {
  const inc = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_includes", text: "needle" } });
  expect((await verifyFindingAnchor("/repo", inc, fixedRunner({ exit_code: 0, timed_out: false, output: "has needle here" }))).status).toBe("confirmed");
  expect((await verifyFindingAnchor("/repo", inc, fixedRunner({ exit_code: 0, timed_out: false, output: "nope" }))).status).toBe("refuted");

  const exc = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_excludes", text: "needle" } });
  expect((await verifyFindingAnchor("/repo", exc, fixedRunner({ exit_code: 0, timed_out: false, output: "needle" }))).status).toBe("refuted");
  expect((await verifyFindingAnchor("/repo", exc, fixedRunner({ exit_code: 0, timed_out: false, output: "clean" }))).status).toBe("confirmed");
});

test("verifyFindingAnchor is inconclusive on spawn error, timeout, or malformed predicate", async () => {
  const f = findingWithAnchor({ command: ["madge", "src"], confirm_if: { kind: "exit_zero" } });
  expect((await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: null, timed_out: false, output: "", spawn_error: "ENOENT" }))).status).toBe("inconclusive");
  expect((await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: null, timed_out: true, output: "" }))).status).toBe("inconclusive");
  const bad = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_includes", text: "" } });
  expect((await verifyFindingAnchor("/repo", bad, fixedRunner({ exit_code: 0, timed_out: false, output: "x" }))).status).toBe("inconclusive");
});

test("verifyFindingAnchor skips off-allowlist and disabled anchors without running them", async () => {
  const offlist = findingWithAnchor({ command: ["node", "-e", "1"], confirm_if: { kind: "exit_zero" } });
  expect((await verifyFindingAnchor("/repo", offlist, throwRunner)).status).toBe("skipped");

  const allowed = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "exit_zero" } });
  process.env.AUDIT_CODE_DISABLE_ANCHORS = "1";
  try {
    expect((await verifyFindingAnchor("/repo", allowed, throwRunner)).status).toBe("skipped");
  } finally {
    delete process.env.AUDIT_CODE_DISABLE_ANCHORS;
  }
});

test("combineGroundingWithAnchor: the anchor verdict overrides tier-1 correctly", () => {
  const grounded = { status: "grounded" };
  const ungrounded = { status: "ungrounded", reason: "no quote" };

  // A confirming run grounds a finding even if its quote was missing.
  expect(combineGroundingWithAnchor(ungrounded, { status: "confirmed", summary: "x" })).toEqual({ status: "grounded" });
  // A refuting run DISPROVES a finding even if its quote matched — distinct
  // `refuted` status (B4: quarantined-excluded, not merely ungrounded).
  const refuted = combineGroundingWithAnchor(grounded, { status: "refuted", summary: "REFUTED by `madge`" });
  expect(refuted.status).toBe("refuted");
  expect(refuted.reason).toMatch(/refuted the claim/);
  // Inconclusive / skipped / absent leave tier-1 in place.
  expect(combineGroundingWithAnchor(grounded, { status: "inconclusive", summary: "x" })).toEqual(grounded);
  expect(combineGroundingWithAnchor(ungrounded, { status: "skipped", summary: "x" })).toEqual(ungrounded);
  expect(combineGroundingWithAnchor(grounded, undefined)).toEqual(grounded);
});

test("verifyFindingAnchor runs a real allowlisted command (git rev-parse) end-to-end", async () => {
  const f = findingWithAnchor({
    command: ["git", "rev-parse", "--is-inside-work-tree"],
    confirm_if: { kind: "exit_zero" },
  });
  const r = await verifyFindingAnchor(packageDir, f);
  expect(r.status, `expected confirmed, got ${r?.status}: ${r?.summary}`).toBe("confirmed");
});

// S7 tier-2: executable anchors. A finding's behavior claim ("no cycle", "unused
// symbol") ships a read-only command; the tool runs it and the verdict — not the
// model's word — grounds or quarantines the finding. Safety: inspection-only
// allowlist, timeout, env kill-switch, no shell. Tested with an injected runner
// for deterministic logic plus one real allowlisted spawn end-to-end.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");

const { verifyFindingAnchor, combineGroundingWithAnchor, isAllowedAnchorCommand } =
  await import("../src/validation/anchorGrounding.ts");

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
    assert.equal(isAllowedAnchorCommand(cmd), true, `should allow ${cmd.join(" ")}`);
  }
  for (const sub of ["grep", "log", "diff", "show", "ls-files", "cat-file", "blame", "rev-parse", "status"]) {
    assert.equal(isAllowedAnchorCommand(["git", sub, "x"]), true, `should allow git ${sub}`);
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
    assert.equal(isAllowedAnchorCommand(cmd), false, `should reject ${cmd.join(" ") || "(empty)"}`);
  }
});

test("verifyFindingAnchor returns undefined when the finding has no anchor", async () => {
  assert.equal(await verifyFindingAnchor("/repo", findingWithAnchor(null)), undefined);
});

test("verifyFindingAnchor confirms/refutes by exit code", async () => {
  const f = findingWithAnchor({ command: ["madge", "--circular", "src"], confirm_if: { kind: "exit_nonzero" } });
  assert.equal(
    (await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: 1, timed_out: false, output: "cycle" }))).status,
    "confirmed",
  );
  assert.equal(
    (await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: 0, timed_out: false, output: "" }))).status,
    "refuted",
  );
});

test("verifyFindingAnchor confirms/refutes by output match (both polarities)", async () => {
  const inc = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_includes", text: "needle" } });
  assert.equal((await verifyFindingAnchor("/repo", inc, fixedRunner({ exit_code: 0, timed_out: false, output: "has needle here" }))).status, "confirmed");
  assert.equal((await verifyFindingAnchor("/repo", inc, fixedRunner({ exit_code: 0, timed_out: false, output: "nope" }))).status, "refuted");

  const exc = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_excludes", text: "needle" } });
  assert.equal((await verifyFindingAnchor("/repo", exc, fixedRunner({ exit_code: 0, timed_out: false, output: "needle" }))).status, "refuted");
  assert.equal((await verifyFindingAnchor("/repo", exc, fixedRunner({ exit_code: 0, timed_out: false, output: "clean" }))).status, "confirmed");
});

test("verifyFindingAnchor is inconclusive on spawn error, timeout, or malformed predicate", async () => {
  const f = findingWithAnchor({ command: ["madge", "src"], confirm_if: { kind: "exit_zero" } });
  assert.equal(
    (await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: null, timed_out: false, output: "", spawn_error: "ENOENT" }))).status,
    "inconclusive",
  );
  assert.equal(
    (await verifyFindingAnchor("/repo", f, fixedRunner({ exit_code: null, timed_out: true, output: "" }))).status,
    "inconclusive",
  );
  const bad = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "output_includes", text: "" } });
  assert.equal(
    (await verifyFindingAnchor("/repo", bad, fixedRunner({ exit_code: 0, timed_out: false, output: "x" }))).status,
    "inconclusive",
  );
});

test("verifyFindingAnchor skips off-allowlist and disabled anchors without running them", async () => {
  const offlist = findingWithAnchor({ command: ["node", "-e", "1"], confirm_if: { kind: "exit_zero" } });
  assert.equal((await verifyFindingAnchor("/repo", offlist, throwRunner)).status, "skipped");

  const allowed = findingWithAnchor({ command: ["grep", "x", "f"], confirm_if: { kind: "exit_zero" } });
  process.env.AUDIT_CODE_DISABLE_ANCHORS = "1";
  try {
    assert.equal((await verifyFindingAnchor("/repo", allowed, throwRunner)).status, "skipped");
  } finally {
    delete process.env.AUDIT_CODE_DISABLE_ANCHORS;
  }
});

test("combineGroundingWithAnchor: the anchor verdict overrides tier-1 correctly", () => {
  const grounded = { status: "grounded" };
  const ungrounded = { status: "ungrounded", reason: "no quote" };

  // A confirming run grounds a finding even if its quote was missing.
  assert.deepEqual(combineGroundingWithAnchor(ungrounded, { status: "confirmed", summary: "x" }), { status: "grounded" });
  // A refuting run quarantines a finding even if its quote matched.
  const refuted = combineGroundingWithAnchor(grounded, { status: "refuted", summary: "REFUTED by `madge`" });
  assert.equal(refuted.status, "ungrounded");
  assert.match(refuted.reason, /refuted the claim/);
  // Inconclusive / skipped / absent leave tier-1 in place.
  assert.deepEqual(combineGroundingWithAnchor(grounded, { status: "inconclusive", summary: "x" }), grounded);
  assert.deepEqual(combineGroundingWithAnchor(ungrounded, { status: "skipped", summary: "x" }), ungrounded);
  assert.deepEqual(combineGroundingWithAnchor(grounded, undefined), grounded);
});

test("verifyFindingAnchor runs a real allowlisted command (git rev-parse) end-to-end", async () => {
  const f = findingWithAnchor({
    command: ["git", "rev-parse", "--is-inside-work-tree"],
    confirm_if: { kind: "exit_zero" },
  });
  const r = await verifyFindingAnchor(packageDir, f);
  assert.equal(r.status, "confirmed", `expected confirmed, got ${r?.status}: ${r?.summary}`);
});

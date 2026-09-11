import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import {
  verifyHeadEvidenceAgainstFindings,
  HEAD_EVIDENCE_MODULE,
} from "../../src/remediate/phases/closeVerifyHeadEvidence.js";
import { readFile, rm, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";
import { scratchDir } from "../helpers/scratch.js";

const REPO_DIR = scratchDir(".test-close-head-evidence");
const TEST_DIR = join(REPO_DIR, ".audit-tools", "remediation");
const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");

const DEFECTIVE_SOURCE = [
  "export function parse(input: string) {",
  "  return JSON.parse(input);",
  "}",
].join("\n");
const FIXED_SOURCE = [
  "export function parse(input: string) {",
  "  try {",
  "    return JSON.parse(input);",
  "  } catch {",
  "    return undefined;",
  "  }",
  "}",
].join("\n");

// A span present in DEFECTIVE_SOURCE and GONE from FIXED_SOURCE. The subtlety
// is the matcher: `quoteMatches` COLLAPSES whitespace, so the fixed form's
// `try { return JSON.parse(input); }` still contains any short quote of the
// call as a substring — a fixture quoting just the call would read as present
// at HEAD and the test would pass for the wrong reason. The anchor has to span
// the unguarded shape the finding actually cited.
const QUOTED_SPAN = "function parse(input: string) { return JSON.parse(input); }";

/**
 * A finding whose CITED anchor is a verbatim span of `DEFECTIVE_SOURCE` — the
 * shape the auditor's grounding pass produced. `quoted` is the machine field
 * the leg decides from, so the tests drive it directly.
 */
function findingWithAnchor(
  id: string,
  overrides: {
    path?: string;
    quoted?: string | undefined;
    lineStart?: number;
    lineEnd?: number;
  } = {},
) {
  const path = overrides.path ?? "src/parse.ts";
  const location: Record<string, unknown> = { path };
  if (overrides.lineStart !== undefined) location.line_start = overrides.lineStart;
  if (overrides.lineEnd !== undefined) location.line_end = overrides.lineEnd;
  if (overrides.quoted !== undefined) location.quoted_text = overrides.quoted;
  return {
    id,
    title: `Finding ${id}`,
    category: "correctness",
    severity: "high" as const,
    confidence: "high" as const,
    lens: "correctness",
    summary: "unguarded JSON.parse",
    affected_files: [location],
  };
}

type TestFinding = ReturnType<typeof findingWithAnchor>;

function makeState(
  findings: TestFinding[],
  statuses: Record<string, string>,
): RemediationState {
  // `makeBaseState` types the plan through the real contract, so the cast is
  // confined to THIS one fixture builder rather than sprinkled at each call.
  return makeBaseState({
    status: "closing",
    plan: {
      plan_id: "P1",
      findings: findings as never,
      blocks: [],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    closing_plan: { action: "none" },
    items: Object.fromEntries(
      findings.map((finding) => [
        finding.id,
        { finding_id: finding.id, status: statuses[finding.id] ?? "resolved_no_change" },
      ]),
    ) as never,
  }) as RemediationState;
}

/** Write `src/parse.ts` AND commit it — a generation of the file on disk. */
function commitParseSource(exec: typeof execSync, source: string): void {
  writeFileSync(join(REPO_DIR, "src", "parse.ts"), source);
  exec("git add . && git commit -m fixture", { cwd: REPO_DIR });
}

/** The current HEAD commit id of the scratch repo. */
function headSha(exec: typeof execSync): string {
  return String(exec("git rev-parse HEAD", { cwd: REPO_DIR })).trim();
}

/**
 * Build a REAL B/HEAD pair: commit the "audit read" generation, capture its
 * sha as `base`, then record the "as it stands now" generation as HEAD.
 *
 * Two real commits are load-bearing — the leg resolves `B` through
 * `gitRefExists`, so a fabricated sha is refused before any read, and a
 * one-commit repo (B === HEAD) cannot express "the span left between the two
 * reads". When the two generations are IDENTICAL the second commit has nothing
 * to record, so only the content on disk is rewritten: HEAD stays at `base`,
 * which is exactly the "span present at both reads" shape and is the honest
 * state of a repo where nothing changed.
 */
function twoGenerations(
  exec: typeof execSync,
  baseSource: string,
  headSource: string,
): { base: string } {
  commitParseSource(exec, baseSource);
  const base = headSha(exec);
  if (headSource !== baseSource) {
    commitParseSource(exec, headSource);
  } else {
    writeFileSync(join(REPO_DIR, "src", "parse.ts"), headSource);
  }
  return { base };
}

/**
 * A `readAtRef` seam that serves each read the generation that read stands for,
 * so a test states "what the audit read" and "what HEAD holds" independently
 * and the leg is exercised through its real two-read rule rather than through
 * whatever the scratch repo happens to contain.
 *
 * The leg resolves HEAD through `headCommit` before reading, so it hands the
 * seam a SHA, never the literal `"HEAD"`. The two generations are therefore
 * addressed by ROLE — `atBase` for the audit-read sha, `atHead` for every other
 * ref — which keeps the fixture honest when B and HEAD are the same commit (the
 * "present at both reads" shape) instead of relying on two distinct keys a
 * one-commit repo cannot provide.
 */
function refsReader(content: { atBase: string; atHead: string }, base: string) {
  const reads: string[] = [];
  const readAtRef = async (_root: string, ref: string, file: string) => {
    reads.push(`${ref.slice(0, 12)}:${file}`);
    return ref === base ? content.atBase : content.atHead;
  };
  return { readAtRef, reads };
}

beforeEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  await mkdir(TEST_DIR, { recursive: true });
  execSync("git init", { cwd: REPO_DIR });
  execSync("git config user.email test@test.com", { cwd: REPO_DIR });
  execSync("git config user.name Test", { cwd: REPO_DIR });
  writeFileSync(join(REPO_DIR, "initial.txt"), "hello");
  execSync("git add . && git commit -m init", { cwd: REPO_DIR });
});

afterEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
});

describe("verifyHeadEvidenceAgainstFindings (unit)", () => {
  it("is a no-op when no item resolved as resolved_no_change", async () => {
    const state = makeState([findingWithAnchor("F1", { quoted: QUOTED_SPAN })], {
      F1: "resolved",
    });
    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
    });
    expect(outcome.ran).toBe(false);
    expect(state.items!.F1.disposition_override).toBeUndefined();
  });

  it("withholds — never guesses — when the finding carries no quoted span", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState([findingWithAnchor("F1", { quoted: undefined })], {
      F1: "resolved_no_change",
    });
    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base } },
    });
    expect(outcome.ran).toBe(true);
    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(outcome.withheld).toHaveLength(1);
    expect(outcome.withheld[0].determined).toBe(false);
    expect(
      outcome.withheld[0].determined ? "" : outcome.withheld[0].reason,
    ).toMatch(/no verbatim quoted_text span/);
    // The item keeps its current disposition: no override was recorded.
    expect(state.items!.F1.disposition_override).toBeUndefined();
    expect(state.items!.F1.evidence).toBeUndefined();
    expect(state.items!.F1.recorded_by_module).toBeUndefined();
  });

  it("records NOTHING for any item when no audit-read commit B is known", async () => {
    // The production shape: no `findingBase` is supplied, so neither verdict is
    // reachable and every candidate is withheld with that reason.
    twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
    });

    expect(outcome.ran).toBe(true);
    expect(outcome.head).not.toBeNull();
    expect(outcome.base).toBeNull();
    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(outcome.withheld).toHaveLength(1);
    expect(
      outcome.withheld[0].determined ? "" : outcome.withheld[0].reason,
    ).toMatch(/no audit-read commit is recorded/);
    // The blanket invariant this leg must never break: a disposition WITHOUT a
    // B read is unfalsifiable evidence, so it must be unreachable.
    expect(state.items!.F1.disposition_override).toBeUndefined();
    expect(state.items!.F1.evidence).toBeUndefined();
    expect(state.items!.F1.recorded_by_module).toBeUndefined();
  });

  it("withholds when the supplied audit-read commit does not resolve in this repo", async () => {
    twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState([findingWithAnchor("F1", { quoted: QUOTED_SPAN })], {
      F1: "resolved_no_change",
    });

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: "f".repeat(40) } },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(outcome.base).toBeNull();
    expect(
      outcome.withheld[0].determined ? "" : outcome.withheld[0].reason,
    ).toMatch(/does not resolve to a commit/);
    expect(state.items!.F1.disposition_override).toBeUndefined();
  });

  it("reaches verified_already_fixed for a span present at B and absent at HEAD", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2, lineEnd: 2 })],
      { F1: "resolved_no_change" },
    );
    const { readAtRef, reads } = refsReader(
      { atBase: DEFECTIVE_SOURCE, atHead: FIXED_SOURCE },
      base,
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(outcome.recorded.F1).toMatchObject({
      determined: true,
      disposition: "verified_already_fixed",
      evidence: {
        file: "src/parse.ts",
        line: "2",
        mechanism: "read_at_head_verification",
      },
    });
    // BOTH reads happened — the audit-read sha first, then the resolved HEAD —
    // and the detail names both. That the triple names what was actually read
    // is the whole content of INV-ISC-EVIDENCE-EMITTED.
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(`${base.slice(0, 12)}:src/parse.ts`);
    expect(reads[1]).not.toBe(reads[0]);
    expect(reads[1]).toMatch(/:src\/parse\.ts$/);
    const detail = (
      state.items!.F1.evidence as { mechanism_detail?: string }
    ).mechanism_detail;
    expect(detail).toContain(base.slice(0, 12));
    expect(detail).toContain("HEAD");
  });

  it("reaches refuted for a span ABSENT at the audit-read commit, and names that read", async () => {
    const { base } = twoGenerations(execSync, FIXED_SOURCE, DEFECTIVE_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2, lineEnd: 2 })],
      { F1: "resolved_no_change" },
    );
    // The audit read a file that never carried the quoted span: the finding
    // misquoted its own citation. HEAD's content is irrelevant to this verdict,
    // which is exactly why the leg must read B to reach it.
    const { readAtRef, reads } = refsReader(
      { atBase: FIXED_SOURCE, atHead: DEFECTIVE_SOURCE },
      base,
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(outcome.recorded.F1).toMatchObject({
      determined: true,
      disposition: "refuted",
      evidence: {
        file: "src/parse.ts",
        line: "2",
        mechanism: "read_at_head_refutation",
      },
    });
    // ONE read — at B. HEAD cannot change an "absent at B" verdict.
    expect(reads).toEqual([`${base.slice(0, 12)}:src/parse.ts`]);
    const detail = (
      state.items!.F1.evidence as { mechanism_detail?: string }
    ).mechanism_detail;
    expect(detail).toContain(base.slice(0, 12));
  });

  it("WITHHOLDS when the cited span is present at BOTH reads, keeping the disposition", async () => {
    // The corrected rule's central case. A span still standing is NOT a
    // refutation: it proves the code is still there, and if the defect was real
    // at B it is still real at HEAD. The old single-read rule called this
    // `refuted`, which is the false determination this test pins against.
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, DEFECTIVE_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );
    const { readAtRef } = refsReader(
      { atBase: DEFECTIVE_SOURCE, atHead: DEFECTIVE_SOURCE },
      base,
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(outcome.withheld).toHaveLength(1);
    const reason = outcome.withheld[0].determined ? "" : outcome.withheld[0].reason;
    expect(reason).toMatch(/present both at the audit-read commit .* and at HEAD/);
    // Untouched: no override, no triple, no module stamp.
    expect(state.items!.F1.disposition_override).toBeUndefined();
    expect(state.items!.F1.evidence).toBeUndefined();
    expect(state.items!.F1.recorded_by_module).toBeUndefined();
  });

  it("withholds when the cited file is not readable at the audit-read commit", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState([findingWithAnchor("F1", { quoted: QUOTED_SPAN })], {
      F1: "resolved_no_change",
    });
    // B is not readable: the reader has no content for the audit-read sha.
    const { readAtRef } = refsReader({ atBase: undefined as never, atHead: FIXED_SOURCE }, base);

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(
      outcome.withheld[0].determined ? "" : outcome.withheld[0].reason,
    ).toMatch(/not a readable file at the audit-read commit/);
  });

  it("applies the emitted-line-prefix ambiguity to the B read as well as HEAD", async () => {
    // The same guard the HEAD read carries, on the OTHER side: a B read that
    // only matches after stripping an emitted `NNN| ` prefix cannot establish
    // the span's presence there, so it is withheld rather than read as present
    // (which would license a `verified_already_fixed` off the prefix alone).
    //
    // The prefix rides the QUOTE, not the file — that is the shape the worker
    // was shown and the one `checkCitations` strips (`stripEmittedLinePrefix`
    // over the quote). The file at B is the clean source.
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const prefixedQuote = `002| ${QUOTED_SPAN}`;
    const state = makeState([findingWithAnchor("F1", { quoted: prefixedQuote })], {
      F1: "resolved_no_change",
    });
    const { readAtRef } = refsReader(
      { atBase: DEFECTIVE_SOURCE, atHead: FIXED_SOURCE },
      base,
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(
      outcome.withheld[0].determined ? "" : outcome.withheld[0].reason,
    ).toMatch(/at the audit-read commit only after stripping an emitted line prefix/);
  });

  it("records no determination for a cited path that resolves to nothing at HEAD (a phantom path is not a refutation)", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { path: "src/ghost.ts", quoted: QUOTED_SPAN })],
      { F1: "resolved_no_change" },
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base } },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(state.items!.F1.disposition_override).toBeUndefined();
    expect(outcome.withheld).toHaveLength(1);
  });

  it("leaves an item that already carries an override alone", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );
    state.items!.F1.disposition_override = "refuted";
    state.items!.F1.recorded_by_module = "someoneElse";

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base } },
    });

    expect(Object.keys(outcome.recorded)).toEqual([]);
    expect(state.items!.F1.disposition_override).toBe("refuted");
    expect(state.items!.F1.recorded_by_module).toBe("someoneElse");
  });

  it("resolves a bare-basename citation through the tracked corpus rather than reading nothing", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { path: "parse.ts", quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );
    const { readAtRef } = refsReader(
      { atBase: DEFECTIVE_SOURCE, atHead: FIXED_SOURCE },
      base,
    );

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: { findingBase: { commit: base }, readAtRef },
    });

    expect(outcome.recorded.F1).toMatchObject({
      determined: true,
      disposition: "verified_already_fixed",
      evidence: { file: "src/parse.ts" },
    });
  });

  it("hands every read a resolved ref, never a null one", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN })],
      { F1: "resolved_no_change" },
    );
    const refsSeen: string[] = [];

    const outcome = await verifyHeadEvidenceAgainstFindings({
      state,
      root: REPO_DIR,
      overrides: {
        findingBase: { commit: base },
        readAtRef: async (_root, ref) => {
          refsSeen.push(ref);
          return DEFECTIVE_SOURCE;
        },
      },
    });

    // HEAD resolves in this scratch repo, so the seam IS exercised. The point
    // of capturing the refs is that `readAtRef` is never handed a null/empty
    // ref, which is what a "no HEAD, but read anyway" regression would do.
    expect(refsSeen.length).toBeGreaterThan(0);
    expect(refsSeen.every((ref) => ref.length > 0)).toBe(true);
    expect(outcome.head).not.toBeNull();
  });
});

describe("runClosePhase — the read-at-HEAD evidence leg", () => {
  it("reaches verified_already_fixed for an item whose cited span left between B and HEAD, with a triple naming both reads", async () => {
    // Two generations on disk AND through the seam: the leg reads the real refs
    // it was handed, so the seam mirrors what the two commits actually hold.
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2, lineEnd: 2 })],
      { F1: "resolved_no_change" },
    );

    const next = await runClosePhase(state, {
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      headEvidenceOverrides: {
        findingBase: { commit: base },
        readAtRef: async (_root, ref, file) =>
          ref === base ? DEFECTIVE_SOURCE : file === "src/parse.ts" ? FIXED_SOURCE : undefined,
      },
    });

    expect(next.status).toBe("complete");
    expect(next.items!.F1.disposition_override).toBe("verified_already_fixed");
    expect(next.items!.F1.recorded_by_module).toBe(HEAD_EVIDENCE_MODULE);
    expect(next.items!.F1.evidence).toMatchObject({
      file: "src/parse.ts",
      line: "2",
      mechanism: "read_at_head_verification",
    });

    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const outcome = outcomes.outcomes.find(
      (o: { finding_id: string }) => o.finding_id === "F1",
    );
    expect(outcome.outcome).toBe("verified_already_fixed");
    expect(outcome.evidence.file).toBe("src/parse.ts");
    expect(outcome.evidence.line).toBe("2");
    expect(outcome.evidence.mechanism).toBe("read_at_head_verification");
    expect(outcome.evidence.mechanism_detail).toContain(base.slice(0, 12));
    expect(outcome.recorded_by_module).toBe(HEAD_EVIDENCE_MODULE);
  });

  it("keeps the disposition and states why when the cited span is present at BOTH reads", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, DEFECTIVE_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );

    const next = await runClosePhase(state, {
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      headEvidenceOverrides: {
        findingBase: { commit: base },
        readAtRef: async () => DEFECTIVE_SOURCE,
      },
    });

    expect(next.status).toBe("complete");
    expect(next.items!.F1.disposition_override).toBeUndefined();
    expect(next.items!.F1.evidence).toBeUndefined();

    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const outcome = outcomes.outcomes.find(
      (o: { finding_id: string }) => o.finding_id === "F1",
    );
    // Unchanged: the generic status-derived disposition, not a fabricated one.
    expect(outcome.outcome).toBe("verified_no_change");
    expect(outcome.evidence).toBeUndefined();
  });

  it("keeps the item's disposition and states why when the finding carries too little evidence", async () => {
    const { base } = twoGenerations(execSync, DEFECTIVE_SOURCE, FIXED_SOURCE);
    const state = makeState([findingWithAnchor("F1", { quoted: undefined })], {
      F1: "resolved_no_change",
    });

    const next = await runClosePhase(state, {
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      headEvidenceOverrides: { findingBase: { commit: base } },
    });

    expect(next.status).toBe("complete");
    expect(next.items!.F1.disposition_override).toBeUndefined();
    expect(next.items!.F1.evidence).toBeUndefined();

    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const outcome = outcomes.outcomes.find(
      (o: { finding_id: string }) => o.finding_id === "F1",
    );
    expect(outcome.outcome).toBe("verified_no_change");
    expect(outcome.evidence).toBeUndefined();
  });

  it("PRODUCTION SHAPE: with no audit-read commit supplied, no item gets a terminal disposition", async () => {
    // The leg is wired into the real close phase and no `headEvidenceOverrides`
    // are passed, so B is unknown exactly as it is on a real run. The assertion
    // is the whole point of the fix round: the close phase must not emit
    // `verified_already_fixed` or `refuted` off a single HEAD read.
    commitParseSource(execSync, FIXED_SOURCE);
    const state = makeState(
      [findingWithAnchor("F1", { quoted: QUOTED_SPAN, lineStart: 2 })],
      { F1: "resolved_no_change" },
    );

    const next = await runClosePhase(state, {
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
    });

    expect(next.status).toBe("complete");
    expect(next.items!.F1.disposition_override).toBeUndefined();
    expect(next.items!.F1.recorded_by_module).toBeUndefined();

    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const outcome = outcomes.outcomes.find(
      (o: { finding_id: string }) => o.finding_id === "F1",
    );
    expect(outcome.outcome).toBe("verified_no_change");
    expect(outcome.evidence).toBeUndefined();
    expect(outcome.recorded_by_module).toBeUndefined();
  });
});

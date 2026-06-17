/**
 * Executable-anchor grounding for behavior claims (S7 tier-2).
 *
 * Tier-1 (quoteGrounding) proves a finding *cites code that exists*. It cannot
 * prove a *behavior* claim — "there is a cycle", "this symbol is unused", "this
 * throws". Those are exactly the claims that shipped as **not real** in the
 * 452-self-audit (a hallucinated cycle, two const-compare mistakes), caught only
 * by deterministically re-running `madge`/`grep`. Tier-2 attaches a read-only
 * command to such a claim, the tool runs it, and the confirmed bit is the tool's
 * run — never the model's word. A refuting run quarantines the finding.
 *
 * SAFETY. The command is model-authored, so it runs only when both its
 * executable AND its arguments pass the shared **default-deny allowlist**
 * (`isAllowedAnchorCommand` — CRIT ARC-a06a3945: validates args, not just the
 * executable, so `rg --pre`, `ast-grep --rewrite`, non-read-only git, etc. are
 * refused). It runs under a timeout, with the host-signalling env stripped, and
 * never via a shell — all owned by the shared `runAllowlistedReadOnlyCommand`
 * runner. Anything off the allowlist is *skipped* (recorded, not run) and the
 * finding falls back to tier-1 grounding. The whole pass can be disabled with
 * `AUDIT_CODE_DISABLE_ANCHORS=1`; the per-anchor timeout (60s default) can be
 * raised with `AUDIT_CODE_ANCHOR_TIMEOUT_MS` for slow checks on large repos.
 */
import { availableParallelism } from "node:os";
import {
  ALLOWLISTED_EXEC_TIMEOUT_MS,
  ANCHOR_ALLOWLIST,
  GIT_READONLY_SUBCOMMANDS,
  isAllowedAnchorCommand,
  normalizeForMatch,
  runAllowlistedReadOnlyCommand,
} from "@audit-tools/shared";
import type {
  AllowlistedExecOutcome,
  AllowlistedExecRunner,
  AnchorExpectation,
  ExecutableAnchor,
  Finding,
  FindingGrounding,
} from "@audit-tools/shared";

// Re-export the allowlist authority so existing audit-code import sites
// (`../validation/anchorGrounding.js`) keep working — the implementation is now
// single-sourced in shared (drift-plan E2; CRIT arg-validation).
export { isAllowedAnchorCommand, ANCHOR_ALLOWLIST, GIT_READONLY_SUBCOMMANDS };

/** Default per-anchor wall-clock budget; a slower command is killed and inconclusive. */
export const ANCHOR_TIMEOUT_MS = ALLOWLISTED_EXEC_TIMEOUT_MS;

/**
 * The effective per-anchor timeout. The 60s default suits the common anchors
 * (madge/grep/rg/git) but a legitimately slow check on a large repo would be
 * silently killed → `inconclusive`; `AUDIT_CODE_ANCHOR_TIMEOUT_MS` (a positive
 * integer in ms) lets an operator raise it per run without code changes. Read
 * per-call to mirror `AUDIT_CODE_DISABLE_ANCHORS` (no import-time capture).
 */
export function resolveAnchorTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.AUDIT_CODE_ANCHOR_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : ANCHOR_TIMEOUT_MS;
}

/**
 * Bounded concurrency for the ingest grounding pass. Anchors spawn child
 * processes, so a serial pass over many anchored findings costs the *sum* of
 * their runtimes — noticeably slow in practice. Grounding each finding under a
 * pool of this size turns that into ~N/cap batches while capping concurrent
 * spawns so the audited machine is not thrashed. CPU-derived, clamped to [2, 8].
 */
export const ANCHOR_GROUNDING_CONCURRENCY = Math.max(
  2,
  Math.min(8, availableParallelism()),
);

/** Outcome of actually running an anchor command (injectable for tests). */
export type AnchorRunOutcome = AllowlistedExecOutcome;
export type AnchorRunner = AllowlistedExecRunner;

/**
 * The single read-only command runner for anchor verification — the shared
 * allowlisted runner (argv-only, env-stripped, timeout-killed). Exposed under
 * the local name so injected test runners and callers are unchanged.
 */
const defaultAnchorRunner: AnchorRunner = runAllowlistedReadOnlyCommand;

/** Verdict of an anchor run, folded into the finding's grounding by the caller. */
export interface AnchorResult {
  status: "confirmed" | "refuted" | "inconclusive" | "skipped";
  summary: string;
  /** Last lines of the command output, for display. */
  evidence?: string[];
}

function tailEvidence(output: string): string[] {
  const lines = output.trim().length > 0 ? output.trim().split(/\r?\n/) : [];
  if (lines.length <= 10) return lines;
  return [
    `[... truncated: showing last 10 of ${lines.length} lines ...]`,
    ...lines.slice(-10),
  ];
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Evaluate whether the run satisfies the declared confirm_if condition. Returns
 * `null` when the condition is malformed (output_* with no text), so the caller
 * records the anchor inconclusive rather than guessing a polarity.
 */
function evaluateExpectation(
  expectation: AnchorExpectation,
  exitCode: number | null,
  output: string,
): { confirmed: boolean; detail: string } | null {
  switch (expectation.kind) {
    case "exit_zero":
      return {
        confirmed: exitCode === 0,
        detail: `command exited ${exitCode} (confirmed iff exit 0)`,
      };
    case "exit_nonzero":
      return {
        confirmed: exitCode !== null && exitCode !== 0,
        detail: `command exited ${exitCode} (confirmed iff non-zero exit)`,
      };
    case "output_includes":
    case "output_excludes": {
      if (typeof expectation.text !== "string" || expectation.text.trim() === "") {
        return null;
      }
      const present = normalizeForMatch(output).includes(
        normalizeForMatch(expectation.text),
      );
      const confirmed =
        expectation.kind === "output_includes" ? present : !present;
      return {
        confirmed,
        detail: `output ${present ? "contains" : "does not contain"} "${truncate(expectation.text)}"`,
      };
    }
  }
}

/**
 * Run a finding's executable anchor (if any) and return the verdict. Pure of any
 * finding mutation — the caller folds the result into `grounding` via
 * {@link combineGroundingWithAnchor}. Returns `undefined` when the finding has
 * no anchor (nothing to run).
 */
export async function verifyFindingAnchor(
  repoRoot: string,
  finding: Finding,
  run: AnchorRunner = defaultAnchorRunner,
): Promise<AnchorResult | undefined> {
  const anchor: ExecutableAnchor | undefined = finding.executable_anchor;
  if (
    !anchor ||
    !Array.isArray(anchor.command) ||
    anchor.command.length === 0 ||
    !anchor.confirm_if
  ) {
    return undefined;
  }
  if (process.env.AUDIT_CODE_DISABLE_ANCHORS === "1") {
    return {
      status: "skipped",
      summary: "executable-anchor verification disabled (AUDIT_CODE_DISABLE_ANCHORS=1)",
    };
  }
  if (!isAllowedAnchorCommand(anchor.command)) {
    return {
      status: "skipped",
      summary: `\`${anchor.command.join(" ")}\` is not on the inspection-only anchor allowlist (executable or arguments refused); not auto-run`,
    };
  }

  const timeoutMs = resolveAnchorTimeoutMs();
  const outcome = await run(anchor.command, repoRoot, timeoutMs);
  const display = anchor.command.join(" ");
  if (outcome.spawn_error) {
    return {
      status: "inconclusive",
      summary: `could not run anchor \`${display}\`: ${outcome.spawn_error}`,
      evidence: tailEvidence(outcome.output),
    };
  }
  if (outcome.timed_out) {
    return {
      status: "inconclusive",
      summary: `anchor \`${display}\` timed out after ${timeoutMs}ms`,
      evidence: tailEvidence(outcome.output),
    };
  }

  const verdict = evaluateExpectation(
    anchor.confirm_if,
    outcome.exit_code,
    outcome.output,
  );
  if (verdict === null) {
    return {
      status: "inconclusive",
      summary: `malformed anchor: ${anchor.confirm_if.kind} requires a non-empty \`text\``,
      evidence: tailEvidence(outcome.output),
    };
  }
  return {
    status: verdict.confirmed ? "confirmed" : "refuted",
    summary: `${verdict.confirmed ? "confirmed" : "REFUTED"} by \`${display}\` — ${verdict.detail}`,
    evidence: tailEvidence(outcome.output),
  };
}

/**
 * Fold an anchor verdict into the quote-and-verify (tier-1) grounding. A
 * confirming run grounds the finding (a verified behavior claim outranks a
 * missing quote); a refuting run quarantines it (the cited code may exist, but
 * the behavior claim is false); an inconclusive/skipped/absent anchor leaves the
 * tier-1 verdict in place.
 */
export function combineGroundingWithAnchor(
  tier1: FindingGrounding,
  anchor: AnchorResult | undefined,
): FindingGrounding {
  if (!anchor) return tier1;
  if (anchor.status === "confirmed") return { status: "grounded" };
  if (anchor.status === "refuted") {
    // A refuting run DISPROVED the claim — distinct from tier-1 `ungrounded`
    // ("couldn't verify"). It is quarantined-EXCLUDED at synthesis, not merely
    // surfaced, so it can never merge as actionable fact.
    return {
      status: "refuted",
      reason: `executable anchor refuted the claim: ${anchor.summary}`,
    };
  }
  return tier1;
}

/** One evidence line summarising the anchor run, appended to the finding's evidence. */
export function anchorEvidenceLine(anchor: AnchorResult): string {
  return `anchor: ${anchor.summary}`;
}

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
 * SAFETY. The command is model-authored, so it is run only when its executable
 * is on an **inspection-only allowlist** (no node/npm/rm/bare-git — nothing that
 * can mutate the repo or run arbitrary code), under a **timeout**, with the
 * host-signalling env stripped (shared `stripClaudeCodeEnv`), and never via a
 * shell. Anything off the allowlist is *skipped* (recorded, not run) and the
 * finding falls back to tier-1 grounding. The whole pass can be disabled with
 * `AUDIT_CODE_DISABLE_ANCHORS=1`.
 */
import { spawn } from "node:child_process";
import { stripClaudeCodeEnv } from "@audit-tools/shared";
import type {
  AnchorExpectation,
  ExecutableAnchor,
  Finding,
  FindingGrounding,
} from "@audit-tools/shared";
import { resolveRuntimeValidationSpawnCommand } from "../orchestrator/runtimeCommand.js";
import { normalizeForMatch } from "./quoteGrounding.js";

/** Per-anchor wall-clock budget; a slower command is killed and inconclusive. */
export const ANCHOR_TIMEOUT_MS = 60_000;

/**
 * Inspection-only executables a model-authored anchor may invoke. Every entry is
 * read-only with no write/exec flag that could mutate the repo: searchers
 * (grep/ripgrep/findstr), structural search (ast-grep), and the dependency-cycle
 * analyzer (madge). Deliberately excludes node/npm/npx (arbitrary code), rm/del
 * (destructive), and bare git (mutating subcommands) — git is allowed only for
 * the read-only subcommands below.
 */
export const ANCHOR_ALLOWLIST: ReadonlySet<string> = new Set([
  "grep",
  "rg",
  "ripgrep",
  "findstr",
  "madge",
  "ast-grep",
  "sg",
]);

/** Read-only git subcommands an anchor may run (no checkout/reset/clean/push/…). */
export const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "grep",
  "log",
  "diff",
  "show",
  "ls-files",
  "cat-file",
  "blame",
  "rev-parse",
  "status",
]);

/** Bare executable name: strip any directory and a Windows .cmd/.bat/.exe suffix. */
function executableBaseName(token: string): string {
  return token
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.(cmd|bat|exe)$/i, "")
    .toLowerCase();
}

/**
 * True when `command`'s executable is on the inspection-only allowlist (and, for
 * git, the subcommand is read-only). The single authority for what the tool will
 * auto-run on the model's behalf.
 */
export function isAllowedAnchorCommand(command: string[]): boolean {
  const exe = command[0];
  if (typeof exe !== "string" || exe.trim() === "") return false;
  const base = executableBaseName(exe);
  if (base === "git") {
    return GIT_READONLY_SUBCOMMANDS.has((command[1] ?? "").trim().toLowerCase());
  }
  return ANCHOR_ALLOWLIST.has(base);
}

/** Outcome of actually running an anchor command (injectable for tests). */
export interface AnchorRunOutcome {
  exit_code: number | null;
  timed_out: boolean;
  spawn_error?: string;
  /** Full combined stdout+stderr (bounded), used to evaluate output_* matches. */
  output: string;
}

export type AnchorRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<AnchorRunOutcome>;

const MAX_CAPTURED_OUTPUT = 256 * 1024;

const defaultAnchorRunner: AnchorRunner = (command, cwd, timeoutMs) =>
  new Promise((resolvePromise) => {
    const spawnCommand = resolveRuntimeValidationSpawnCommand(command);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: stripClaudeCodeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: unknown) => {
      if (output.length < MAX_CAPTURED_OUTPUT) output += String(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hardKill.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: null,
        timed_out: timedOut,
        spawn_error: error.message,
        output,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exit_code: code, timed_out: timedOut, output });
    });
  });

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
      summary: `\`${anchor.command[0]}\` is not in the inspection-only anchor allowlist; not auto-run`,
    };
  }

  const outcome = await run(anchor.command, repoRoot, ANCHOR_TIMEOUT_MS);
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
      summary: `anchor \`${display}\` timed out after ${ANCHOR_TIMEOUT_MS}ms`,
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
    return {
      status: "ungrounded",
      reason: `executable anchor refuted the claim: ${anchor.summary}`,
    };
  }
  return tier1;
}

/** One evidence line summarising the anchor run, appended to the finding's evidence. */
export function anchorEvidenceLine(anchor: AnchorResult): string {
  return `anchor: ${anchor.summary}`;
}

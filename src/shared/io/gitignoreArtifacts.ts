import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
} from "./auditToolsPaths.js";
import { FRICTION_CAPTURE_DIRNAME } from "./frictionCapture.js";
import { AGENT_FEEDBACK_FILENAME } from "../agentReflections.js";

/**
 * Install/ensure-time `.gitignore` management for the artifacts audit-tools emits
 * into a consuming repo's working tree. Single-sourced (TS, shared) so both
 * orchestrators and the postinstall agree on WHICH paths are build/install
 * artifacts vs. visibility-conditional deliverables — the ignore patterns are
 * derived from the same canonical filename constants the writers use, never
 * re-spelled here, so a renamed deliverable can never drift out of the ignore
 * set.
 *
 * Two tiers (from docs/backlog.md, Ethan 2026-06-22):
 *  - ALWAYS-ignore: generated host/skill/install assets + the per-run friction
 *    CAPTURE sidecar. These are build/install artifacts; never tracked, every
 *    platform, unconditionally.
 *  - VISIBILITY-CONDITIONAL: the process-conclusion deliverables
 *    (audit/remediation report + machine contract) and the meta-audit
 *    reflections file. Private repo => keep tracked; public repo => ignore by
 *    default (don't publish internal findings/reflections unless opted in).
 *
 * Everything here is OS-agnostic: `.gitignore` patterns are always written with
 * forward slashes and LF, regardless of host platform — git itself uses POSIX
 * separators in ignore files on every OS.
 */

/** Repo visibility as it drives the conditional ignore decision. */
export type RepoVisibility = "private" | "public";

/**
 * Always-ignored generated assets (build/install artifacts). Forward slashes +
 * trailing slash for directories so git treats them as dir matches on every OS.
 * `.audit-code/` is the host renderer / install-asset + generated-skill tree;
 * the friction CAPTURE sidecar is matched per-artifacts-dir (audit + remediation).
 */
export const ALWAYS_IGNORE_PATTERNS: readonly string[] = [
  ".audit-code/",
  `.audit-tools/*/${FRICTION_CAPTURE_DIRNAME}/`,
];

/**
 * Visibility-conditional ignores: the canonical deliverables (imported from the
 * shared filename constants, never hardcoded literals) promoted into
 * `.audit-tools/`, plus the meta-audit reflections file appended under each
 * artifacts dir. Ignored only when the repo is public.
 */
export const VISIBILITY_CONDITIONAL_PATTERNS: readonly string[] = [
  `.audit-tools/${AUDIT_REPORT_FILENAME}`,
  `.audit-tools/${AUDIT_FINDINGS_FILENAME}`,
  `.audit-tools/${REMEDIATION_REPORT_FILENAME}`,
  `.audit-tools/${REMEDIATION_OUTCOMES_FILENAME}`,
  `.audit-tools/*/${AGENT_FEEDBACK_FILENAME}`,
];

/** Anchored marker block so re-runs replace OUR lines and never clobber user lines. */
export const GITIGNORE_BLOCK_BEGIN = "# >>> audit-tools managed ignores >>>";
export const GITIGNORE_BLOCK_END = "# <<< audit-tools managed ignores <<<";

/**
 * Render the managed block body (between markers) for a given visibility. The
 * always-ignore patterns are present for BOTH private and public; the
 * conditional patterns appear only for public.
 */
export function renderGitignoreBlock(visibility: RepoVisibility): string {
  const lines: string[] = [
    GITIGNORE_BLOCK_BEGIN,
    "# Generated/install artifacts — always ignored (build artifacts, not source).",
    ...ALWAYS_IGNORE_PATTERNS,
  ];
  if (visibility === "public") {
    lines.push(
      "# Deliverables + meta-audit reflections — ignored because this repo is public.",
      ...VISIBILITY_CONDITIONAL_PATTERNS,
    );
  } else {
    lines.push(
      "# Deliverables + meta-audit reflections kept tracked (private repo).",
    );
  }
  lines.push(GITIGNORE_BLOCK_END);
  return lines.join("\n");
}

/**
 * Idempotent additive merge of the managed block into an existing `.gitignore`
 * body. If a prior managed block exists (matched by the anchored markers) it is
 * replaced in place; user lines outside the markers are never touched. A re-run
 * with the same visibility yields byte-identical output (no duplicate blocks).
 * Output is always LF-normalized with a single trailing newline.
 */
export function mergeGitignoreBlock(existing: string, block: string): string {
  const normalized = existing.replace(/\r\n/g, "\n");
  const beginIdx = normalized.indexOf(GITIGNORE_BLOCK_BEGIN);
  const endIdx = normalized.indexOf(GITIGNORE_BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = normalized.slice(0, beginIdx).replace(/\n+$/, "");
    const after = normalized
      .slice(endIdx + GITIGNORE_BLOCK_END.length)
      .replace(/^\n+/, "");
    const head = before.length > 0 ? `${before}\n\n` : "";
    const tail = after.length > 0 ? `\n\n${after}` : "";
    return `${head}${block}${tail}`.replace(/\n*$/, "\n");
  }

  const base = normalized.replace(/\n+$/, "");
  const head = base.length > 0 ? `${base}\n\n` : "";
  return `${head}${block}`.replace(/\n*$/, "\n");
}

/**
 * Detect repo visibility, degrade-safe. Order of authority:
 *  1. An explicit operator override (config flag / env) ALWAYS wins.
 *  2. Otherwise probe `gh repo view --json isPrivate` via the injected runner.
 *  3. If gh is missing/errors/returns unparseable output, fall back to the
 *     default-safe `unknown => private` (keep deliverables tracked). NEVER throws.
 *
 * `runGh` is injected so tests stub it (no live gh, OS-agnostic). It returns the
 * raw stdout of the gh call, or null on any failure.
 */
export function detectRepoVisibility(params: {
  repoRoot: string;
  /** Explicit operator override; when set it wins unconditionally. */
  override?: RepoVisibility | null;
  /** Injected gh runner: returns gh stdout, or null if gh is unavailable/failed. */
  runGh?: (repoRoot: string) => string | null;
}): RepoVisibility {
  if (params.override === "private" || params.override === "public") {
    return params.override;
  }
  if (typeof params.runGh !== "function") {
    return "private";
  }
  let stdout: string | null = null;
  try {
    stdout = params.runGh(params.repoRoot);
  } catch {
    return "private";
  }
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return "private";
  }
  try {
    const parsed = JSON.parse(stdout) as { isPrivate?: unknown };
    if (parsed && typeof parsed.isPrivate === "boolean") {
      return parsed.isPrivate ? "private" : "public";
    }
  } catch {
    // fall through to default-safe
  }
  return "private";
}

/**
 * Ensure the consuming repo's `.gitignore` carries the managed block for the
 * resolved visibility. Pure-ish: all side effects go through injected fs hooks
 * so tests run without touching disk. NEVER throws — any error degrades to a
 * no-op result so postinstall can never fail over gitignore management.
 *
 * Returns the resolved visibility and whether the file content changed.
 */
export function ensureArtifactGitignore(params: {
  repoRoot: string;
  override?: RepoVisibility | null;
  runGh?: (repoRoot: string) => string | null;
  /** Injected readers/writers (default to node:fs) for testability. */
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
}): { visibility: RepoVisibility; changed: boolean; path: string } {
  const gitignorePath = join(params.repoRoot, ".gitignore");
  const fileExists = params.fileExists ?? ((p) => existsSync(p));
  const readFile = params.readFile ?? ((p) => readFileSync(p, "utf8"));
  const writeFile =
    params.writeFile ?? ((p, c) => writeFileSync(p, c, "utf8"));

  const visibility = detectRepoVisibility({
    repoRoot: params.repoRoot,
    override: params.override,
    runGh: params.runGh,
  });

  try {
    const block = renderGitignoreBlock(visibility);
    const existing = fileExists(gitignorePath) ? readFile(gitignorePath) : "";
    const merged = mergeGitignoreBlock(existing, block);
    const changed = merged !== existing;
    if (changed) {
      writeFile(gitignorePath, merged);
    }
    return { visibility, changed, path: gitignorePath };
  } catch {
    // Degrade to a no-op: gitignore management must never fail the install.
    return { visibility, changed: false, path: gitignorePath };
  }
}

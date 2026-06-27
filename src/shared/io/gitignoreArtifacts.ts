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

/**
 * Repo visibility as it drives the conditional ignore decision.
 *  - `private` => keep deliverables tracked.
 *  - `public`  => ignore deliverables.
 *  - `unknown` => no authoritative signal resolved; we fall back to the
 *    tracked (private-equivalent) default AND emit a loud warning so the
 *    operator can pin it explicitly. NEVER silently treated as `private`.
 */
export type RepoVisibility = "private" | "public" | "unknown";

/**
 * Always-ignored generated assets (build/install artifacts). Forward slashes +
 * trailing slash for directories so git treats them as dir matches on every OS.
 * `.audit-code/` is the host renderer / install-asset + generated-skill tree;
 * the friction CAPTURE sidecar is matched at ANY depth UNDER THE ARTIFACT TREE
 * (an install-time-static, repo-relative any-depth glob built from the canonical
 * FRICTION_CAPTURE_DIRNAME path component, ANCHORED to `.audit-tools/`).
 * The anchor is load-bearing: a bare unanchored any-depth friction glob also
 * matches the `src/shared/friction/` SOURCE dir, which once silently dropped a
 * new source file from a node merge and broke the base build.
 */
export const ALWAYS_IGNORE_PATTERNS: readonly string[] = [
  ".audit-code/",
  `.audit-tools/**/${FRICTION_CAPTURE_DIRNAME}/`,
];

/**
 * Public-repo: ignore the WHOLE runtime artifact tree, deliverables included.
 * A single blanket dir-ignore — nothing under `.audit-tools/` is published.
 */
export const PUBLIC_TREE_IGNORE = ".audit-tools/" as const;

/**
 * The canonical deliverables (imported from the shared filename constants, never
 * hardcoded literals) that a PRIVATE repo keeps TRACKED. Expressed as git
 * RE-INCLUDE (`!`) lines layered over the runtime-tree ignore below.
 *
 * git constraint that drives this whole structure: a file CANNOT be re-included
 * if a parent directory is excluded. So the runtime tree is ignored at the
 * CONTENTS level (the per-level star globs in PRIVATE_TREE_PATTERNS) — never the
 * dir itself — and the dirs holding tracked files are re-included so git
 * descends into them.
 */
export const DELIVERABLE_REINCLUDES: readonly string[] = [
  `!.audit-tools/${AUDIT_REPORT_FILENAME}`,
  `!.audit-tools/${AUDIT_FINDINGS_FILENAME}`,
  `!.audit-tools/${REMEDIATION_REPORT_FILENAME}`,
  `!.audit-tools/${REMEDIATION_OUTCOMES_FILENAME}`,
];

/** Re-include of the per-artifacts-dir meta-audit reflections file (nested one level). */
export const AGENT_FEEDBACK_REINCLUDE = `!.audit-tools/*/${AGENT_FEEDBACK_FILENAME}` as const;

/**
 * The private-repo selective ignore: ignore everything under `.audit-tools/`
 * except the tracked deliverables + reflections. Ordering is load-bearing (git
 * applies patterns top-to-bottom, last match wins):
 *  1. ignore top-level contents; 2. re-include top-level deliverables;
 *  3. re-include subdirs (so git descends); 4. ignore subdir contents;
 *  5. re-include the nested reflections file.
 */
export const PRIVATE_TREE_PATTERNS: readonly string[] = [
  ".audit-tools/*",
  ...DELIVERABLE_REINCLUDES,
  "!.audit-tools/*/",
  ".audit-tools/*/*",
  AGENT_FEEDBACK_REINCLUDE,
];

/**
 * Operator override env var. `private`/`track` => private; `public`/`ignore` =>
 * public; anything else (incl. unset) => no override. Single-sourced here so the
 * TS detector and `scripts/postinstall.mjs` agree on the name + accepted values.
 */
export const REPO_VISIBILITY_ENV = "AUDIT_TOOLS_REPO_VISIBILITY";

/**
 * Committed, in-repo visibility pin. A repo-root file (`.audit-tools-visibility`)
 * whose contents are parsed by {@link parseVisibilityOverride} (`private`/`track`
 * => tracked deliverables; `public`/`ignore` => ignored). This is the DURABLE
 * way to force a decision that disagrees with `gh` detection — e.g. a public repo
 * that deliberately tracks its deliverables. Unlike the env var it survives across
 * machines/sessions and (being committed) keeps the generated block stable, so
 * `ensure` is idempotent instead of fighting gh on every run. Authority sits
 * between the env override and gh (see {@link detectRepoVisibility}).
 */
export const REPO_VISIBILITY_FILE = ".audit-tools-visibility";

/**
 * Parse a raw operator-supplied visibility string into a concrete
 * `private`/`public`, or null when it is unset/unrecognized (=> no override).
 * Accepts the intent aliases `track` (=> private, keep deliverables tracked) and
 * `ignore` (=> public, ignore deliverables).
 */
export function parseVisibilityOverride(
  raw: string | null | undefined,
): "private" | "public" | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "private" || value === "track") return "private";
  if (value === "public" || value === "ignore") return "public";
  return null;
}

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
      "# Whole runtime artifact tree ignored, deliverables included (public repo).",
      PUBLIC_TREE_IGNORE,
    );
  } else {
    lines.push(
      visibility === "unknown"
        ? `# Runtime tree ignored; deliverables + meta-audit reflections kept TRACKED (visibility UNKNOWN — set ${REPO_VISIBILITY_ENV} to pin).`
        : "# Runtime tree ignored; deliverables + meta-audit reflections kept TRACKED (private repo).",
      ...PRIVATE_TREE_PATTERNS,
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
 * Detect repo visibility, degrade-safe. Strict order of authority — each
 * fallback resolves to the next signal, and ONLY the final, fully-exhausted
 * fallback yields `unknown` (never a silent `private`):
 *  1. An explicit operator `override` (config flag) ALWAYS wins.
 *  2. The `AUDIT_TOOLS_REPO_VISIBILITY` env config/override (read via the
 *     injected `readEnv`, default `process.env`), parsed by
 *     {@link parseVisibilityOverride}.
 *  3. The committed `.audit-tools-visibility` repo-root file (via the injected
 *     `readVisibilityFile`, default reads `<repoRoot>/.audit-tools-visibility`) —
 *     the durable, cross-machine pin that survives gh re-detection.
 *  4. The `gh repo view --json isPrivate` boolean, via the injected `runGh`.
 *  5. `unknown` — no authoritative signal resolved. Callers fall back to the
 *     tracked default and warn; we do NOT pretend the repo is private.
 *
 * `runGh`/`readEnv`/`readVisibilityFile` are injected so tests stub them (no live
 * gh / env / disk, fully OS-agnostic). Each returns null on any failure and the
 * function NEVER throws.
 */
export function detectRepoVisibility(params: {
  repoRoot: string;
  /** Explicit operator override; when set it wins unconditionally. */
  override?: RepoVisibility | null;
  /** Injected gh runner: returns gh stdout, or null if gh is unavailable/failed. */
  runGh?: (repoRoot: string) => string | null;
  /** Injected env reader (default `process.env`) so the config/override is testable. */
  readEnv?: (name: string) => string | undefined;
  /** Injected reader for the committed pin file; default reads `<repoRoot>/.audit-tools-visibility`. */
  readVisibilityFile?: (repoRoot: string) => string | null;
}): RepoVisibility {
  // 1. Explicit operator override wins unconditionally.
  if (params.override === "private" || params.override === "public") {
    return params.override;
  }

  // 2. Env config/override.
  const readEnv =
    params.readEnv ?? ((name: string) => process.env[name]);
  const envOverride = parseVisibilityOverride(readEnv(REPO_VISIBILITY_ENV));
  if (envOverride) {
    return envOverride;
  }

  // 3. Committed in-repo pin (durable, survives gh re-detection).
  const readVisibilityFile =
    params.readVisibilityFile ?? defaultReadVisibilityFile;
  const fileOverride = parseVisibilityOverride(readVisibilityFile(params.repoRoot));
  if (fileOverride) {
    return fileOverride;
  }

  // 4. gh isPrivate boolean.
  if (typeof params.runGh === "function") {
    let stdout: string | null = null;
    try {
      stdout = params.runGh(params.repoRoot);
    } catch {
      stdout = null;
    }
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(stdout) as { isPrivate?: unknown };
        if (parsed && typeof parsed.isPrivate === "boolean") {
          return parsed.isPrivate ? "private" : "public";
        }
      } catch {
        // fall through to unknown
      }
    }
  }

  // 5. Nothing authoritative resolved.
  return "unknown";
}

/**
 * Default reader for the committed `.audit-tools-visibility` pin. Reads
 * `<repoRoot>/.audit-tools-visibility`, trimmed; returns null on any error
 * (missing file, unreadable) so the detector degrades to the next tier. Never throws.
 */
function defaultReadVisibilityFile(repoRoot: string): string | null {
  try {
    const path = join(repoRoot, REPO_VISIBILITY_FILE);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
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
  /** Injected env reader (default `process.env`) so the config/override is testable. */
  readEnv?: (name: string) => string | undefined;
  /** Injected reader for the committed pin file (default reads `<repoRoot>/.audit-tools-visibility`). */
  readVisibilityFile?: (repoRoot: string) => string | null;
  /** Injected warn sink (default `console.warn`) so the unknown-visibility warning is testable. */
  warn?: (message: string) => void;
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
  const warn = params.warn ?? ((m) => console.warn(m));

  const visibility = detectRepoVisibility({
    repoRoot: params.repoRoot,
    override: params.override,
    runGh: params.runGh,
    readEnv: params.readEnv,
    readVisibilityFile: params.readVisibilityFile,
  });

  if (visibility === "unknown") {
    warn(
      `[audit-tools] repo visibility could not be determined (gh unavailable and no ` +
        `override set) — keeping deliverables + meta-audit reflections TRACKED by default. ` +
        `If this repo is public, set ${REPO_VISIBILITY_ENV}=public (or =private to silence ` +
        `this warning) before installing, or pass an explicit override.`,
    );
  }

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

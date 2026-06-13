/**
 * Per-host asset render functions for audit-code install.
 * Each function produces the raw string content for one file format.
 * Extracted from audit-code-wrapper-install-hosts.mjs so each host's
 * render logic can be found, tested, and changed without reading the
 * whole bootstrap/verify orchestration.
 */

import { join, relative } from 'node:path';

export const INSTALLED_PROMPT_FILENAME = 'audit-code.import.md';

/** Return `targetPath` relative to `root`, using forward slashes. */
export function repoRelativePath(root, targetPath) {
  const value = relative(root, targetPath).replace(/\\/g, '/');
  return value.length > 0 ? value : '.';
}

/** Render the VS Code auditor agent markdown file. */
export function renderVSCodeAgentFile() {
  return [
    '---',
    'description: Plan and orchestrate /audit-code through the next-step machine before making code changes.',
    '---',
    '',
    '# Auditor Agent',
    '',
    'Use `audit-code next-step` as the primary integration surface for the audit workflow.',
    '',
    'When the user asks to run or continue `/audit-code`:',
    '',
    '- run `audit-code next-step` directly when shell access is available',
    '- prefer imported audit results and runtime updates over ad hoc manual state edits',
    '- treat the deterministic audit report as the final source of truth once the audit completes',
    '',
  ].join('\n');
}

/** Render the Codex re-audit automation recipe markdown. */
export function renderCodexAutomationRecipe() {
  return [
    '# Codex re-audit automation recipe',
    '',
    'Suggested recurring task:',
    '',
    '- Prompt: Re-run the autonomous audit workflow for this repository with `audit-code next-step`, summarize only new or regressed findings, and stop once the deterministic report is current.',
    '- Cadence: daily on active branches or before release cut-offs',
    '- Inputs: repository root',
    '',
    'Use this recipe as a starting point for a Codex automation once the local workflow is stable in your environment.',
    '',
  ].join('\n');
}

/** Render the Antigravity planning-mode guide for a given repo root. */
export function renderAntigravityPlanningGuide(root) {
  const promptAssetRelPath = repoRelativePath(root, join(root, '.audit-code', 'install', INSTALLED_PROMPT_FILENAME));
  return [
    '# Antigravity planning-mode guide',
    '',
    'Recommended workflow:',
    '',
    '1. Open Antigravity in Planning mode.',
    '2. Load the repo-local prompt asset or the AGENTS instructions before starting the audit conversation.',
    '3. Ask Antigravity to use `audit-code next-step` directly.',
    '4. Review Antigravity artifacts before accepting major code changes or imported evidence.',
    '',
    'Recommended repo-local paths:',
    `- prompt asset: \`${promptAssetRelPath}\``,
    '',
    'Artifact round-tripping policy:',
    '',
    '- Browser walkthroughs and validation artifacts should be converted into runtime validation updates before import.',
    '- Task-specific review artifacts should be normalized into `AuditResult` payloads before using `import_results`.',
    '',
  ].join('\n');
}

/**
 * Render the Gemini/Antigravity slash command TOML for a given prompt body.
 * Escapes backslashes and double-quotes so the TOML multi-line basic string
 * is valid regardless of prompt content.
 */
export function renderGeminiCommandToml(promptBody) {
  const escapedBody = promptBody.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '# /audit-code — Autonomous local-loop code auditing',
    '# Registered as a Gemini/Antigravity slash command.',
    '',
    'description = "Autonomous local-loop code auditing — loads one backend-rendered audit step at a time"',
    '',
    'prompt = """',
    escapedBody.trimEnd(),
    '"""',
    '',
  ].join('\n');
}

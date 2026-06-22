/**
 * Per-host asset render functions for audit-code install.
 *
 * Every host asset is derived from the ONE canonical loader prompt body via the
 * shared `renderHostAsset` helper (`audit-tools/shared`). These functions are
 * thin wrappers that pass the canonical body through with the right `kind` and
 * `toolName`; they do NOT re-author per-host loader prose. That makes it
 * impossible for a host asset to drift out of sync with the canonical body — to
 * silently drop the next-step capability handshake (including `--host-models`) or
 * to embed a wrong in-repo entrypoint. A no-drift guard test enforces this.
 */

import { renderHostAsset } from 'audit-tools/shared';

export const INSTALLED_PROMPT_FILENAME = 'audit-code.import.md';

const TOOL_NAME = 'audit-code';
const ASSET_DESCRIPTION =
  'Autonomous local-loop code auditing — loads one backend-rendered audit step at a time';

/** Render the VS Code auditor agent markdown file from the canonical body. */
export function renderVSCodeAgentFile(promptBody) {
  return renderHostAsset('vscode-agent', {
    promptBody,
    toolName: TOOL_NAME,
    description:
      'Plan and orchestrate /audit-code through the next-step machine before making code changes.',
  });
}

/** Render the Codex re-audit automation recipe markdown from the canonical body. */
export function renderCodexAutomationRecipe(promptBody) {
  return renderHostAsset('codex-recipe', {
    promptBody,
    toolName: TOOL_NAME,
  });
}

/** Render the Antigravity planning-mode guide from the canonical body. */
export function renderAntigravityPlanningGuide(promptBody) {
  return renderHostAsset('antigravity-guide', {
    promptBody,
    toolName: TOOL_NAME,
  });
}

/**
 * Render the Gemini/Antigravity slash command TOML for a given prompt body.
 * Escapes backslashes and double-quotes so the TOML multi-line basic string
 * is valid regardless of prompt content.
 */
export function renderGeminiCommandToml(promptBody) {
  return renderHostAsset('gemini-toml', {
    promptBody,
    toolName: TOOL_NAME,
    description: ASSET_DESCRIPTION,
  });
}

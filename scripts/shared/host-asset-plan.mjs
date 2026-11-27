// The host-asset install plan — ONE declaration, two installers.
//
// WHY THIS EXISTS (backlog 2026-08-27, "Three governance vocabularies are copied
// per consumer"). `scripts/audit/postinstall.mjs` and
// `scripts/remediate/postinstall.mjs` each built their own install list, their
// own OpenCode command entry and their own `installAntigravityPlugin` call
// around the SAME shared installer (`install-host-assets.mjs`). Every one of
// those was near-identical code differing only by a tool token, so a change to
// the shared install shape had to be made twice and the two could silently
// drift — the V3 residual entry's migration gap is one instance of that split,
// not its cause.
//
// Now the per-tool differences are ROWS here and the installers execute the
// plan. What stays per-tool is only what is genuinely per-tool POLICY: the
// OpenCode permission tables (what each workflow may touch) and the two prompt
// renderers. Everything structural — which hosts are served, what each target
// path is, which source file feeds it, what the command entry says — is derived
// from the row.
//
// PRE-BUILD: the postinstalls run under plain node from a possibly-never-built
// checkout, so this module imports nothing from `audit-tools/shared`.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitFrontmatter } from "./install-host-assets.mjs";

/** The package root, from this file's location (`scripts/shared/`). */
export const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * @typedef {object} HostAssetPlan
 * @property {string} tool            the bin name / tool token (`audit-code`)
 * @property {string} skillDir        `skills/<dir>` under the package root
 * @property {string} promptFile      the canonical prompt body's filename
 * @property {string} commandFile     filename installed as the Claude command
 * @property {string} description     one line for the host's command menu
 * @property {string} agentName       the OpenCode agent the command delegates to
 * @property {string} agentDescription one line for that agent
 * @property {string|'packageVersion'} pluginVersion the Antigravity plugin
 *   version — a literal where the plugin has its own version, or the string
 *   'packageVersion' where it tracks the package
 * @property {boolean} stripFrontmatter whether the Claude command carries the
 *   prompt's body only (remediate-code) or the file verbatim (audit-code)
 */

/** @type {Record<string, HostAssetPlan>} */
export const HOST_ASSET_PLANS = {
  "audit-code": {
    tool: "audit-code",
    skillDir: "audit-code",
    promptFile: "audit-code.prompt.md",
    commandFile: "audit-code.md",
    description: "Autonomous local loop code auditing",
    agentName: "auditor",
    agentDescription: "Read-heavy audit orchestration agent for the /audit-code workflow.",
    pluginVersion: "1.0.0",
    stripFrontmatter: false,
  },
  "remediate-code": {
    tool: "remediate-code",
    skillDir: "remediate-code",
    promptFile: "remediate-code.prompt.md",
    commandFile: "remediate-code.md",
    description: "Conversation-first code remediation",
    agentName: "remediator",
    agentDescription: "Bounded remediation orchestration agent for the /remediate-code workflow.",
    pluginVersion: "packageVersion",
    stripFrontmatter: true,
  },
};

/**
 * The source files a plan reads, all under the package root.
 * @param {HostAssetPlan} plan
 */
export function planSources(plan) {
  const dir = join(PKG_ROOT, "skills", plan.skillDir);
  return {
    prompt: join(dir, plan.promptFile),
    skill: join(dir, "SKILL.md"),
    codexUiMetadata: join(dir, "agents", "openai.yaml"),
  };
}

/**
 * The install targets every plan serves, in install order. Each is derived —
 * a row never names a path, so the two tools cannot disagree about WHERE a host
 * asset lands, only about what it contains.
 *
 * @param {HostAssetPlan} plan
 * @param {{homeDir?: string, promptContent: Buffer|string, skillContent: Buffer|string,
 *          codexUiMetadataContent?: Buffer|string}} content
 * @returns {{label: string, path: string, sourcePath: string, content: Buffer|string}[]}
 */
export function planInstalls(plan, { homeDir = homedir(), promptContent, skillContent, codexUiMetadataContent }) {
  const sources = planSources(plan);
  const codexDir = join(homeDir, ".codex", "skills", plan.skillDir);
  const installs = [
    {
      label: "Claude command",
      path: join(homeDir, ".claude", "commands", plan.commandFile),
      sourcePath: sources.prompt,
      content: promptContent,
    },
    {
      label: "Codex skill",
      path: join(codexDir, "SKILL.md"),
      sourcePath: sources.skill,
      content: skillContent,
    },
    {
      label: "Codex prompt",
      path: join(codexDir, plan.promptFile),
      sourcePath: sources.prompt,
      content: promptContent,
    },
  ];
  if (codexUiMetadataContent !== undefined) {
    installs.push({
      label: "Codex skill UI metadata",
      path: join(codexDir, "agents", "openai.yaml"),
      sourcePath: sources.codexUiMetadata,
      content: codexUiMetadataContent,
    });
  }
  return installs;
}

/** The OpenCode global config path — one location, both tools. */
export function planOpenCodeConfigPath({ homeDir = homedir() } = {}) {
  return join(homeDir, ".config", "opencode", "opencode.json");
}

/**
 * The OpenCode command entry a plan contributes to the merged global config.
 *
 * Only the host registration format differs; its workflow text is the canonical prompt body.
 *
 * @param {HostAssetPlan} plan
 * @param {string} promptSource the canonical prompt file
 */
export function planOpenCodeCommand(plan, promptSource) {
  return {
    template: splitFrontmatter(promptSource).body.trimStart(),
    description: plan.description,
    agent: plan.agentName,
    subtask: false,
  };
}

/**
 * The Claude Desktop plugin directory — the one host served by path convention
 * rather than by a config file.
 * @param {HostAssetPlan} plan
 * @param {{homeDir?: string}} [options]
 */
export function planClaudePluginDir(plan, { homeDir = homedir() } = {}) {
  return join(
    homeDir,
    ".claude",
    "plugins",
    "marketplaces",
    "claude-plugins-official",
    "external_plugins",
    plan.tool,
  );
}

#!/usr/bin/env node
// The remediate-code host-install entry.
//
// What this file owns: the REMEDIATE-CODE HALF OF THE PLAN — the OpenCode
// permission tables (what a remediator may touch, including the retired-rule
// migration) and the prompt renderer. Everything structural now comes from
// `scripts/shared/host-asset-plan.mjs`: which hosts are served, what each target
// path is, which source file feeds it, the command description, the agent name.
// Before that module existed, this file and its audit twin each carried their own
// copy of all of it — two installers built around one shared installer, differing
// only by a tool token, and free to drift the moment either changed.
import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import {
  readRequiredSource,
  readOptionalSource,
  objectValue,
  splitFrontmatter,
  resolveSharedOpenCodePermissions,
  runInstalls,
  installOpenCodeGlobalConfig,
  installAntigravityPlugin,
  finishPostinstall,
} from "../shared/install-host-assets.mjs";
import {
  HOST_ASSET_PLANS,
  PKG_ROOT,
  planInstalls,
  planOpenCodeCommand,
  planOpenCodeConfigPath,
  planSources,
} from "../shared/host-asset-plan.mjs";

const TOOL = "remediate-code";
const PLAN = HOST_ASSET_PLANS[TOOL];
const SOURCES = planSources(PLAN);
const packageVersion = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0";

const OPENCODE_REMEDIATE_EDIT_PERMISSION = {
  "*": "ask",
  ".remediation-artifacts/**": "allow",
  "remediation-report.md": "allow",
  "remediation-report.json": "allow",
  "remediation-closing-result.json": "allow",
};

const OPENCODE_REMEDIATE_BASH_PERMISSION = {
  "*": "ask",
  "remediate-code": "allow",
  "remediate-code ensure*": "allow",
  "remediate-code next-step*": "allow",
  "remediate-code validate*": "allow",
  "*remediate-code.mjs": "allow",
  "*remediate-code.mjs* ensure*": "allow",
  "*remediate-code.mjs* next-step*": "allow",
  "*remediate-code.mjs* validate*": "allow",
  "git status*": "allow",
  "git diff*": "allow",
  "grep *": "allow",
  "Select-String *": "allow",
  "rm *": "deny",
};

const RETIRED_REMEDIATE_CODE_BASH_RULES = [
  "remediate-code prepare-document-dispatch*",
  "remediate-code merge-document-results*",
  "remediate-code prepare-implement-dispatch*",
  "remediate-code merge-implement-results*",
  "remediate-code accept-node*",
  "*remediate-code.mjs* prepare-document-dispatch*",
  "*remediate-code.mjs* merge-document-results*",
  "*remediate-code.mjs* prepare-implement-dispatch*",
  "*remediate-code.mjs* merge-implement-results*",
  "*remediate-code.mjs* accept-node*",
];

function withoutRetiredRemediateCodeBashRules(rule) {
  const cleaned = { ...objectValue(rule) };
  for (const retired of RETIRED_REMEDIATE_CODE_BASH_RULES) {
    delete cleaned[retired];
  }
  return cleaned;
}

// The scoped OpenCode permission merge helpers are single-sourced in
// audit-tools/shared (global top-level scope vs. remediator agent scope).
// Resolved best-effort: on a fresh workspace checkout the shared dist may not
// be built yet, in which case the OpenCode config deployment below is
// skipped with a warning instead of failing the whole install.
const sharedOpenCodePermissions = /** @type {NonNullable<Awaited<ReturnType<typeof resolveSharedOpenCodePermissions>>>} */ (
  await resolveSharedOpenCodePermissions()
);

// A pre-hardening deploy wrote agent-scope bash['*']='allow' (the historically
// managed broad value). Migrate exactly that value away so the generated 'ask'
// seed wins on re-deploy; any other user-authored wildcard survives untouched.
// This mirrors the install wrapper so an upgrade that only ever runs
// `npm install` converges on the same hardened agent block — otherwise the
// postinstall is the one path that keeps a broad wildcard alive.
function withoutManagedBroadBashWildcard(rule) {
  const { withoutOpenCodeWildcard, OPENCODE_MANAGED_BROAD_VALUE } =
    sharedOpenCodePermissions;
  const existing = objectValue(rule);
  if (existing["*"] !== OPENCODE_MANAGED_BROAD_VALUE) {
    return rule;
  }
  return withoutOpenCodeWildcard(existing);
}

// Remediator agent scope: managed rules win for specific patterns; an
// existing user wildcard survives (the managed set is passed without "*").
function renderOpenCodeAgentPermissionConfig(existing) {
  const { mergeOpenCodeAgentPermissionRule, withoutOpenCodeWildcard } =
    sharedOpenCodePermissions;
  const existingPermission = objectValue(existing);
  const existingBash = withoutRetiredRemediateCodeBashRules(existingPermission.bash);
  return {
    ...existingPermission,
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: mergeOpenCodeAgentPermissionRule(
      existingPermission.edit,
      OPENCODE_REMEDIATE_EDIT_PERMISSION,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_EDIT_PERMISSION),
    ),
    bash: mergeOpenCodeAgentPermissionRule(
      withoutManagedBroadBashWildcard(existingBash),
      OPENCODE_REMEDIATE_BASH_PERMISSION,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_BASH_PERMISSION),
    ),
  };
}

// Global top-level scope: never seeds a bash wildcard or
// external_directory['*']='allow', keeps the denylist hygiene rules, and
// migrates away previously deployed broad rules whose value exactly matches
// the historically managed value ('allow'). Non-matching values are untouched.
function renderOpenCodeGlobalPermissionConfig(existing) {
  const {
    mergeOpenCodeAgentPermissionRule,
    mergeOpenCodeGlobalPermissionRule,
    migrateOpenCodeGlobalExternalDirectory,
    withoutOpenCodeWildcard,
  } = sharedOpenCodePermissions;
  const existingPermission = objectValue(existing);
  const existingBash = withoutRetiredRemediateCodeBashRules(existingPermission.bash);
  const merged = {
    ...existingPermission,
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: mergeOpenCodeAgentPermissionRule(
      existingPermission.edit,
      OPENCODE_REMEDIATE_EDIT_PERMISSION,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_EDIT_PERMISSION),
    ),
    bash: mergeOpenCodeGlobalPermissionRule(
      existingBash,
      OPENCODE_REMEDIATE_BASH_PERMISSION,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_BASH_PERMISSION),
    ),
  };
  const externalDirectory = migrateOpenCodeGlobalExternalDirectory(
    existingPermission.external_directory,
  );
  if (externalDirectory === undefined) {
    delete merged.external_directory;
  } else {
    merged.external_directory = externalDirectory;
  }
  return merged;
}

function mergeOpenCodeGlobalConfig(existing, promptBody) {
  const parsed = existing ? JSON.parse(existing) : {};
  const agent = objectValue(parsed.agent);
  const existingRemediator = objectValue(agent.remediator);
  return {
    ...parsed,
    command: {
      ...objectValue(parsed.command),
      [TOOL]: planOpenCodeCommand(PLAN, promptBody),
    },
    permission: renderOpenCodeGlobalPermissionConfig(parsed.permission),
    agent: {
      ...agent,
      [PLAN.agentName]: {
        ...existingRemediator,
        description: PLAN.agentDescription,
        permission: renderOpenCodeAgentPermissionConfig(existingRemediator.permission),
      },
    },
  };
}

const promptSource = readRequiredSource(SOURCES.prompt, "prompt", TOOL);
const skillSource = readRequiredSource(SOURCES.skill, "skill", TOOL);

if (!promptSource || !skillSource) {
  process.exit(0);
}

const postinstallStart = Date.now();
const counts = { succeeded: 0, failed: 0 };

const promptBody = splitFrontmatter(promptSource.toString("utf8")).body;
const codexOpenAiAgentSource = readOptionalSource(
  SOURCES.codexUiMetadata,
  "Codex skill UI metadata",
  TOOL,
);

runInstalls(
  TOOL,
  planInstalls(PLAN, {
    // This tool installs the prompt's BODY as the Claude command (the frontmatter
    // is host metadata); the plan's stripFrontmatter flag says which of the two
    // is the command content.
    promptContent: PLAN.stripFrontmatter ? Buffer.from(promptBody, "utf8") : promptSource,
    skillContent: skillSource,
    codexUiMetadataContent: codexOpenAiAgentSource ?? undefined,
  }),
  counts,
);

const opencodeGlobalConfig = planOpenCodeConfigPath();
installOpenCodeGlobalConfig(
  {
    toolName: TOOL,
    path: opencodeGlobalConfig,
    sharedOpenCodePermissions,
    buildMerged: (existing) => mergeOpenCodeGlobalConfig(existing, promptBody),
    label: "OpenCode command",
  },
  counts,
);

// Install Antigravity plugin (global skill for Gemini IDE / Antigravity Hub)
installAntigravityPlugin(
  {
    toolName: TOOL,
    homeDir: homedir(),
    pluginName: TOOL,
    pluginVersion: PLAN.pluginVersion === "packageVersion" ? packageVersion : PLAN.pluginVersion,
    skillSource,
  },
  counts,
);

finishPostinstall(TOOL, counts, postinstallStart);

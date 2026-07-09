#!/usr/bin/env node
import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
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

const TOOL = "remediate-code";
const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
const promptSourceFile = join(
  pkgRoot,
  "skills",
  "remediate-code",
  "remediate-code.prompt.md",
);
const skillSourceFile = join(pkgRoot, "skills", "remediate-code", "SKILL.md");
const codexOpenAiAgentSourceFile = join(
  pkgRoot,
  "skills",
  "remediate-code",
  "agents",
  "openai.yaml",
);

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
  "remediate-code prepare-document-dispatch*": "allow",
  "remediate-code merge-document-results*": "allow",
  "remediate-code prepare-implement-dispatch*": "allow",
  "remediate-code merge-implement-results*": "allow",
  "remediate-code validate-artifacts*": "allow",
  "*remediate-code.mjs": "allow",
  "*remediate-code.mjs* ensure*": "allow",
  "*remediate-code.mjs* next-step*": "allow",
  "*remediate-code.mjs* prepare-document-dispatch*": "allow",
  "*remediate-code.mjs* merge-document-results*": "allow",
  "*remediate-code.mjs* prepare-implement-dispatch*": "allow",
  "*remediate-code.mjs* merge-implement-results*": "allow",
  "*remediate-code.mjs* validate-artifacts*": "allow",
  "git status*": "allow",
  "git diff*": "allow",
  "grep *": "allow",
  "Select-String *": "allow",
  "rm *": "deny",
};

// The scoped OpenCode permission merge helpers are single-sourced in
// audit-tools/shared (global top-level scope vs. remediator agent scope).
// Resolved best-effort: on a fresh workspace checkout the shared dist may not
// be built yet, in which case the OpenCode config deployment below is
// skipped with a warning instead of failing the whole install.
const sharedOpenCodePermissions = await resolveSharedOpenCodePermissions();

// Remediator agent scope: managed rules win for specific patterns; an
// existing user wildcard survives (the managed set is passed without "*").
function renderOpenCodeAgentPermissionConfig(existing) {
  const { mergeOpenCodeAgentPermissionRule, withoutOpenCodeWildcard } =
    sharedOpenCodePermissions;
  const existingPermission = objectValue(existing);
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
      existingPermission.bash,
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
      existingPermission.bash,
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
      "remediate-code": {
        template: promptBody.trimStart(),
        description: "Conversation-first code remediation",
        agent: "remediator",
        subtask: false,
      },
    },
    permission: renderOpenCodeGlobalPermissionConfig(parsed.permission),
    agent: {
      ...agent,
      remediator: {
        ...existingRemediator,
        description:
          "Bounded remediation orchestration agent for the /remediate-code workflow.",
        permission: renderOpenCodeAgentPermissionConfig(existingRemediator.permission),
      },
    },
  };
}

const promptSource = readRequiredSource(promptSourceFile, "prompt", TOOL);
const skillSource = readRequiredSource(skillSourceFile, "skill", TOOL);

if (!promptSource || !skillSource) {
  process.exit(0);
}

const postinstallStart = Date.now();
const counts = { succeeded: 0, failed: 0 };

const promptBody = splitFrontmatter(promptSource.toString("utf8")).body;
const codexOpenAiAgentSource = readOptionalSource(
  codexOpenAiAgentSourceFile,
  "Codex skill UI metadata",
  TOOL,
);

const installs = [
  {
    label: "Claude command",
    path: join(homedir(), ".claude", "commands", "remediate-code.md"),
    sourcePath: promptSourceFile,
    content: Buffer.from(promptBody, "utf8"),
  },
  {
    label: "Codex skill",
    path: join(homedir(), ".codex", "skills", "remediate-code", "SKILL.md"),
    sourcePath: skillSourceFile,
    content: skillSource,
  },
  {
    label: "Codex prompt",
    path: join(
      homedir(),
      ".codex",
      "skills",
      "remediate-code",
      "remediate-code.prompt.md",
    ),
    sourcePath: promptSourceFile,
    content: promptSource,
  },
  ...(codexOpenAiAgentSource
    ? [
        {
          label: "Codex skill UI metadata",
          path: join(
            homedir(),
            ".codex",
            "skills",
            "remediate-code",
            "agents",
            "openai.yaml",
          ),
          sourcePath: codexOpenAiAgentSourceFile,
          content: codexOpenAiAgentSource,
        },
      ]
    : []),
];

runInstalls(TOOL, installs, counts);

const opencodeGlobalConfig = join(
  homedir(),
  ".config",
  "opencode",
  "opencode.json",
);
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
    pluginName: "remediate-code",
    pluginVersion: packageVersion,
    skillSource,
  },
  counts,
);

finishPostinstall(TOOL, counts, postinstallStart);

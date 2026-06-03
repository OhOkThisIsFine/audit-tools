#!/usr/bin/env node
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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

function readRequiredSource(path, label) {
  if (!existsSync(path)) {
    console.warn(
      `remediate-code: ${label} source not found at ${path} - skipping global command install`,
    );
    process.exitCode = 0;
    return null;
  }
  return readFileSync(path);
}

function readOptionalSource(path, label) {
  if (!existsSync(path)) {
    console.warn(
      `remediate-code: ${label} source not found at ${path} - skipping optional install`,
    );
    return null;
  }
  return readFileSync(path);
}

function writeGeneratedFile(path, content) {
  const action = existsSync(path) ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return action;
}

function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
  return { body: match ? normalized.slice(match[0].length) : normalized };
}

const OPENCODE_REMEDIATE_EDIT_PERMISSION = {
  "*": "ask",
  ".remediation-artifacts/**": "allow",
  "remediation-report.md": "allow",
  "remediation-report.json": "allow",
  "remediation-closing-result.json": "allow",
};

const OPENCODE_REMEDIATE_BASH_PERMISSION = {
  "*": "ask",
  "remediate-code run*": "deny",
  "*dist*index.js* run*": "deny",
  "*remediate-code.mjs* run*": "deny",
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

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function mergeOpenCodePermissionRule(existingRule, generatedRule, managedRules) {
  const existing = objectValue(existingRule);
  return {
    "*": existing["*"] ?? generatedRule["*"] ?? "ask",
    ...generatedRule,
    ...existing,
    ...managedRules,
  };
}

function renderOpenCodePermissionConfig(existing) {
  const existingPermission = objectValue(existing);
  return {
    ...existingPermission,
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: mergeOpenCodePermissionRule(
      existingPermission.edit,
      OPENCODE_REMEDIATE_EDIT_PERMISSION,
      OPENCODE_REMEDIATE_EDIT_PERMISSION,
    ),
    bash: mergeOpenCodePermissionRule(
      existingPermission.bash,
      OPENCODE_REMEDIATE_BASH_PERMISSION,
      OPENCODE_REMEDIATE_BASH_PERMISSION,
    ),
  };
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
    permission: renderOpenCodePermissionConfig(parsed.permission),
    agent: {
      ...agent,
      remediator: {
        ...existingRemediator,
        description:
          "Bounded remediation orchestration agent for the /remediate-code workflow.",
        permission: renderOpenCodePermissionConfig(existingRemediator.permission),
      },
    },
  };
}

function installMergedJson(path, buildMerged) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const merged = buildMerged(existing);
  const action = existing ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return action;
}

const promptSource = readRequiredSource(promptSourceFile, "prompt");
const skillSource = readRequiredSource(skillSourceFile, "skill");

if (!promptSource || !skillSource) {
  process.exit(0);
}

const postinstallStart = Date.now();
let succeeded = 0;
let failed = 0;

const promptBody = splitFrontmatter(promptSource.toString("utf8")).body;
const codexOpenAiAgentSource = readOptionalSource(
  codexOpenAiAgentSourceFile,
  "Codex skill UI metadata",
);

const installs = [
  {
    label: "Claude command",
    path: join(homedir(), ".claude", "commands", "remediate-code.md"),
    sourcePath: promptSourceFile,
    content: promptSource,
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

for (const install of installs) {
  try {
    const action = writeGeneratedFile(install.path, install.content);
    console.log(
      `remediate-code: ${action} global ${install.label} at ${install.path}`,
    );
    succeeded++;
  } catch (err) {
    console.warn(
      `remediate-code: could not install global ${install.label} (${err.message})`,
    );
    console.warn("  To install manually, copy from:");
    console.warn(`    ${install.sourcePath}`);
    console.warn("  to:");
    console.warn(`    ${install.path}`);
    failed++;
  }
}

const opencodeGlobalConfig = join(
  homedir(),
  ".config",
  "opencode",
  "opencode.json",
);
try {
  const action = installMergedJson(opencodeGlobalConfig, (existing) =>
    mergeOpenCodeGlobalConfig(existing, promptBody),
  );
  console.log(
    `remediate-code: ${action} global OpenCode command in ${opencodeGlobalConfig}`,
  );
  succeeded++;
} catch (err) {
  console.warn(
    `remediate-code: could not install global OpenCode command (${err.message})`,
  );
  failed++;
}

// Install Antigravity plugin (global skill for Gemini IDE / Antigravity Hub)
const antigravityPluginDir = join(
  homedir(),
  ".gemini",
  "config",
  "plugins",
  "remediate-code",
);
const antigravityPluginJsonPath = join(antigravityPluginDir, "plugin.json");
const antigravityPluginSkillPath = join(
  antigravityPluginDir,
  "skills",
  "SKILL.md",
);

try {
  const pluginJsonAction = writeGeneratedFile(
    antigravityPluginJsonPath,
    Buffer.from(
      JSON.stringify(
        { name: "remediate-code", version: "1.0.0" },
        null,
        2,
      ) + "\n",
    ),
  );
  console.log(
    `remediate-code: ${pluginJsonAction} Antigravity plugin manifest at ${antigravityPluginJsonPath}`,
  );

  const skillAction = writeGeneratedFile(antigravityPluginSkillPath, skillSource);
  console.log(
    `remediate-code: ${skillAction} Antigravity plugin skill at ${antigravityPluginSkillPath}`,
  );
  succeeded++;
} catch (err) {
  console.warn(
    `remediate-code: could not install Antigravity plugin (${err.message})`,
  );
  failed++;
}

console.log(`remediate-code: postinstall complete — ${succeeded} succeeded, ${failed} failed (${Date.now() - postinstallStart}ms)`);

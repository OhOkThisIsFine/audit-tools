import { Command } from "commander";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./utils/commands.js";
import { decideNextStep } from "./steps/nextStep.js";
import {
  mergeDocumentResults,
  mergeImplementResults,
  prepareDocumentDispatch,
  prepareImplementDispatch,
} from "./steps/dispatch.js";
import { validateArtifacts } from "./validation/artifacts.js";
import { setQuotaStateDir } from "@audit-tools/shared";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { version: pkgVersion } = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as { version: string };

const _opencodeJson = JSON.parse(
  readFileSync(join(pkgRoot, "opencode.json"), "utf8"),
) as { agent?: { remediator?: { permission?: { edit?: Record<string, string>; bash?: Record<string, string> } } } };
const _remediatorPermission = _opencodeJson.agent?.remediator?.permission ?? {};
const OPENCODE_REMEDIATE_EDIT_PERMISSION: Record<string, string> =
  _remediatorPermission.edit ?? {};
const OPENCODE_REMEDIATE_BASH_PERMISSION: Record<string, string> =
  _remediatorPermission.bash ?? {};

const program = new Command();

program
  .name("remediate-code")
  .description("Autonomous remediation orchestrator")
  .version(pkgVersion);

program
  .command("run")
  .description("Deprecated compatibility alias for next-step")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .option("--input <path>", "Path to audit report or finding list")
  .option(
    "--host-can-dispatch-subagents <value>",
    "Whether the current host can dispatch callable subagents",
  )
  .option(
    "--host-max-concurrent <n>",
    "Maximum number of subagents the host can run concurrently",
  )
  .option(
    "--finalize-closing",
    "Finalize a closing remediation state from a generated close_run step",
  )
  .action(async (options) => {
    console.error(
      "remediate-code: `run` is deprecated; use `remediate-code next-step`. " +
        "`run` now renders one backend step instead of executing a synchronous loop.",
    );
    const step = await withBackendLogsOnStderr(() =>
      decideNextStep({
        root: options.root,
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        input: options.input,
        hostCanDispatchSubagents: parseOptionalBoolean(
          options.hostCanDispatchSubagents,
        ),
        hostMaxConcurrent: options.hostMaxConcurrent
          ? parseInt(options.hostMaxConcurrent, 10) || undefined
          : undefined,
        finalizeClosing: options.finalizeClosing === true,
      }),
    );
    console.log(JSON.stringify(step, null, 2));
  });

program
  .command("next-step")
  .description("Write and print one backend-rendered remediation step")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .option("--input <path>", "Path to audit report or feedback document")
  .option(
    "--host-can-dispatch-subagents <value>",
    "Whether the current host can dispatch callable subagents",
  )
  .option(
    "--host-max-concurrent <n>",
    "Maximum number of subagents the host can run concurrently",
  )
  .option(
    "--finalize-closing",
    "Finalize a closing remediation state from a generated close_run step",
  )
  .action(async (options) => {
    const step = await withBackendLogsOnStderr(() =>
      decideNextStep({
        root: options.root,
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        input: options.input,
        hostCanDispatchSubagents: parseOptionalBoolean(
          options.hostCanDispatchSubagents,
        ),
        hostMaxConcurrent: options.hostMaxConcurrent
          ? parseInt(options.hostMaxConcurrent, 10) || undefined
          : undefined,
        finalizeClosing: options.finalizeClosing === true,
      }),
    );
    console.log(JSON.stringify(step, null, 2));
  });

program
  .command("prepare-document-dispatch")
  .description("Prepare bounded document prompts for pending findings")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .action(async (options) => {
    const plan = await withBackendLogsOnStderr(() =>
      prepareDocumentDispatch(
        {
          root: resolve(options.root),
          artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        },
        options.runId,
      ),
    );
    console.log(JSON.stringify(plan, null, 2));
  });

program
  .command("merge-document-results")
  .description("Validate and merge document worker results")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .action(async (options) => {
    const state = await mergeDocumentResults(
      {
        root: resolve(options.root),
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
      },
      options.runId,
    );
    console.log(JSON.stringify({ status: "ok", state_status: state.status }, null, 2));
  });

program
  .command("prepare-implement-dispatch")
  .description("Prepare bounded implementation prompts for documented work")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .action(async (options) => {
    const plan = await withBackendLogsOnStderr(() =>
      prepareImplementDispatch(
        {
          root: resolve(options.root),
          artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        },
        options.runId,
      ),
    );
    console.log(JSON.stringify(plan, null, 2));
  });

program
  .command("merge-implement-results")
  .description("Validate and merge implementation worker results")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .action(async (options) => {
    const state = await mergeImplementResults(
      {
        root: resolve(options.root),
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
      },
      options.runId,
    );
    console.log(JSON.stringify({ status: "ok", state_status: state.status }, null, 2));
  });

program
  .command("install")
  .description("Deprecated compatibility alias for global install repair")
  .option("--root <path>", "Repository root", ".")
  .action(async (options) => {
    installRepoAssets(options.root, false);
  });

program
  .command("ensure")
  .description("Repair/check global /remediate-code host assets")
  .option("--root <path>", "Repository root", ".")
  .option("--quiet", "Suppress all output")
  .action(async (options) => {
    ensureGlobalAssets(options.quiet ?? false, console.log, homedir(), resolve(options.root));
  });

program
  .command("validate-artifacts")
  .description("Validate remediation runtime artifacts")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".remediation-artifacts",
  )
  .action(async (options) => {
    const result = await validateArtifacts(
      resolveArtifactsDirOption(options.root, options.artifactsDir),
      resolve(options.root),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "ok" ? 0 : 1);
  });

program
  .command("validate")
  .description("Validate TypeScript types and schema contracts")
  .action(async () => {
    process.exit(runValidateCommand());
  });

// Only parse argv when run directly; skip when imported as a module (e.g. in tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  setQuotaStateDir(join(homedir(), ".remediate-code"));
  program.parse(process.argv);
}

// --- helpers ---

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("--host-can-dispatch-subagents must be true or false.");
}

async function withBackendLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function resolveArtifactsDirOption(root: string, artifactsDir: string): string {
  const resolvedRoot = resolve(root);
  return resolve(
    artifactsDir === ".remediation-artifacts"
      ? join(resolvedRoot, ".remediation-artifacts")
      : artifactsDir,
  );
}

export function runValidateCommand(
  deps: {
    run?: typeof runCommand;
    log?: (message: string) => void;
    error?: (message: string) => void;
  } = {},
): number {
  const run = deps.run ?? runCommand;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const result = run("npx", ["tsc", "--noEmit"], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    error("Type check failed.");
    return result.status ?? 1;
  }
  log("validate: TypeScript types OK");
  return 0;
}

export function installRepoAssets(
  root: string,
  quiet: boolean,
  log: (msg: string) => void = console.log,
  homeDir = homedir(),
): void {
  if (!quiet) {
    log(
      "remediate-code: repo-local install is deprecated; repairing global assets instead.",
    );
    log(`remediate-code: no repo-local files were written under ${resolve(root)}.`);
  }
  ensureGlobalAssets(quiet, log, homeDir, resolve(root));
}

function splitFrontmatter(text: string): { body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
  return { body: match ? normalized.slice(match[0].length) : normalized };
}

function writeGeneratedFile(path: string, content: Buffer): string {
  const action = existsSync(path) ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return action;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeOpenCodePermissionRule(
  existingRule: unknown,
  generatedRule: Record<string, string>,
  managedRules: Record<string, string>,
): Record<string, string> {
  const existing =
    existingRule && typeof existingRule === "object" && !Array.isArray(existingRule)
      ? (existingRule as Record<string, string>)
      : {};
  return { "*": existing["*"] ?? generatedRule["*"] ?? "ask", ...generatedRule, ...existing, ...managedRules };
}

function renderOpenCodePermissionConfig(existing?: unknown): Record<string, unknown> {
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

function installOpenCodeGlobalConfig(promptBody: string, homeDir = homedir()): string {
  const configPath = join(homeDir, ".config", "opencode", "opencode.json");
  const parsed = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  const agent = objectValue(parsed.agent);
  const existingRemediator = objectValue(agent.remediator);
  const merged = {
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
  const action = existsSync(configPath) ? "updated" : "installed";
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return `${action} global OpenCode command in ${configPath}`;
}

export function ensureGlobalAssets(
  quiet: boolean,
  log: (msg: string) => void = console.log,
  homeDir = homedir(),
  root = process.cwd(),
): void {
  const promptSource = join(
    pkgRoot,
    "skills",
    "remediate-code",
    "remediate-code.prompt.md",
  );
  const skillSource = join(pkgRoot, "skills", "remediate-code", "SKILL.md");
  const metadataSource = join(
    pkgRoot,
    "skills",
    "remediate-code",
    "agents",
    "openai.yaml",
  );

  const prompt = readFileSync(promptSource);
  const skill = readFileSync(skillSource);
  const installs = [
    {
      label: "Claude command",
      path: join(homeDir, ".claude", "commands", "remediate-code.md"),
      content: prompt,
    },
    {
      label: "Codex skill",
      path: join(homeDir, ".codex", "skills", "remediate-code", "SKILL.md"),
      content: skill,
    },
    {
      label: "Codex prompt",
      path: join(
        homeDir,
        ".codex",
        "skills",
        "remediate-code",
        "remediate-code.prompt.md",
      ),
      content: prompt,
    },
    ...(existsSync(metadataSource)
      ? [
          {
            label: "Codex skill UI metadata",
            path: join(
              homeDir,
              ".codex",
              "skills",
              "remediate-code",
              "agents",
              "openai.yaml",
            ),
            content: readFileSync(metadataSource),
          },
        ]
      : []),
  ];

  for (const install of installs) {
    const action = writeGeneratedFile(install.path, install.content);
    if (!quiet) {
      log(`remediate-code: ${action} global ${install.label} at ${install.path}`);
    }
  }

  const message = installOpenCodeGlobalConfig(
    splitFrontmatter(prompt.toString("utf8")).body,
    homeDir,
  );
  if (!quiet) log(`remediate-code: ${message}`);

  const antigravitySkillPath = join(resolve(root), ".agent", "skills", "remediate-code", "SKILL.md");
  const antigravityAction = writeGeneratedFile(antigravitySkillPath, skill);
  if (!quiet) {
    log(`remediate-code: ${antigravityAction} Antigravity skill at ${antigravitySkillPath}`);
  }
}

import { Command } from "commander";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./utils/commands.js";
import { splitFrontmatter, writeGeneratedFile, objectValue } from "./utils/hostAssets.js";
import { decideNextStep } from "./steps/nextStep.js";
import {
  mergeImplementResults,
  prepareImplementDispatch,
} from "./steps/dispatch.js";
import { advanceHostRolling, reverifyQuarantinedNode } from "./steps/rollingSession.js";
import { validateArtifacts } from "./validation/artifacts.js";
import { CONTRACT_PIPELINE_VALIDATORS } from "./validation/contractPipeline.js";
import {
  CP_ARTIFACT_NAMES,
  isEnvelope,
  stampToolCreatedAt,
  type ContractPipelineArtifactName,
} from "./contractPipeline/artifactStore.js";
import {
  setQuotaStateDir,
  parseHostModelRoster,
  PROVIDER_NAMES,
  type ProviderName,
  remediationArtifactsDir,
  resolveRepoRoot,
  mergeOpenCodeAgentPermissionRule,
  mergeOpenCodeGlobalPermissionRule,
  migrateOpenCodeGlobalExternalDirectory,
  withoutOpenCodeWildcard,
} from "audit-tools/shared";

// src/remediate/index.ts (source) or dist/remediate/index.js (built) → three
// dirnames up is the package root, holding package.json + skills/ + opencode.json.
const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { version: pkgVersion } = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as { version: string };

// opencode.json is optional package data (shipped with the package). Read it
// best-effort so a missing/unshipped config can never crash the CLI on startup —
// default to no extra permissions instead.
let _opencodeJson: {
  agent?: {
    remediator?: {
      permission?: { edit?: Record<string, string>; bash?: Record<string, string> };
    };
  };
} = {};
try {
  _opencodeJson = JSON.parse(readFileSync(join(pkgRoot, "opencode.json"), "utf8"));
} catch {
  // No opencode config available — proceed with empty permissions.
}
/**
 * Commander parser for `--host-provider`: constrain the value to a known
 * ProviderName so a typo fails LOUDLY at parse time (the identity is a
 * quota-attribution key — a silently-wrong value would mis-charge fan-out).
 */
function parseHostProviderOption(value: string): ProviderName {
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) {
    return value as ProviderName;
  }
  throw new Error(
    `--host-provider must be one of: ${PROVIDER_NAMES.join(", ")} (got "${value}")`,
  );
}

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
  .command("next-step")
  .description("Write and print one backend-rendered remediation step")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  // Repeatable: each `--input <path>` accumulates into a string[] via a collect
  // reducer (NOT a variadic `<path...>`, which would greedily swallow following
  // tokens). A single `--input` still yields `["<path>"]`; downstream
  // `inputValues`/`resolveInputPaths` normalize the one-vs-many shape and the
  // source manifest is the first-wins-deduped union of the resolved paths.
  .option(
    "--input <path>",
    "Path to audit report or feedback document (repeatable; unioned into intake)",
    // Accumulator defaults to []; guard against an undefined `previous` so the
    // first occurrence starts the array cleanly even if the default was cleared.
    (value: string, previous: string[] | undefined) =>
      (previous ?? []).concat([value]),
    [] as string[],
  )
  .option(
    "--guidance-file <path>",
    "Single-step bootstrap: write this file's contents to intake/conversation-start.md (sole, idempotent writer) before deciding the step",
  )
  // True boolean (no <value>): a bare flag resolves true and never swallows the
  // next token. The paired --no- form (and the =false form, normalized below)
  // resolves false; absence stays undefined so the tristate reaches
  // resolveHostDispatchCapability intact.
  .option(
    "--host-can-dispatch-subagents",
    "Whether the current host can dispatch callable subagents",
  )
  .option(
    "--no-host-can-dispatch-subagents",
    "Declare that the current host cannot dispatch callable subagents",
  )
  .option(
    "--host-max-concurrent <n>",
    "Maximum number of subagents the host can run concurrently",
  )
  .option(
    "--host-context-tokens <n>",
    "Context window of the model the host's dispatch subagents run on",
  )
  .option(
    "--host-output-tokens <n>",
    "Output-token cap of the model the host's dispatch subagents run on",
  )
  .option(
    "--host-models <json>",
    "Ordered JSON roster of dispatchable models (lowest rank first): [{rank, context_tokens, output_tokens, model_id?}]",
  )
  .option(
    "--host-model-id <id>",
    "Opaque model identity used only to key quota learning (provider/<id>)",
  )
  .option(
    "--host-provider <name>",
    "Override the auto-detected conversation-host provider that dispatch fan-out is charged to (default: detected from the run's own session env)",
    parseHostProviderOption,
  )
  .option(
    "--finalize-closing",
    "Finalize a closing remediation state from a generated close_run step",
  )
  .option(
    "--force-replan",
    "Rebuild the remediation plan from the existing intake artifacts",
  )
  .action(async (options) => {
    const artifactsDir = resolveArtifactsDirOption(
      options.root,
      options.artifactsDir,
    );
    // Single-step bootstrap: fold the optional guidance file into
    // intake/conversation-start.md in this same invocation, then decide the
    // step — no separate write-then-call dance for the host to remember.
    if (options.guidanceFile) {
      applyGuidanceFile(artifactsDir, options.guidanceFile);
    }
    const step = await withBackendLogsOnStderr(() =>
      decideNextStep({
        root: options.root,
        artifactsDir,
        input: options.input,
        guidanceFileSupplied: Boolean(options.guidanceFile),
        hostCanDispatchSubagents: options.hostCanDispatchSubagents,
        hostMaxConcurrent: options.hostMaxConcurrent
          ? parseInt(options.hostMaxConcurrent, 10) || undefined
          : undefined,
        hostContextTokens: options.hostContextTokens
          ? parseInt(options.hostContextTokens, 10) || undefined
          : undefined,
        hostOutputTokens: options.hostOutputTokens
          ? parseInt(options.hostOutputTokens, 10) || undefined
          : undefined,
        hostModels: options.hostModels
          ? parseHostModelRoster(options.hostModels)
          : undefined,
        hostModelId: options.hostModelId || undefined,
        hostProvider: options.hostProvider as ProviderName | undefined,
        finalizeClosing: options.finalizeClosing === true,
        forceReplan: options.forceReplan === true,
      }),
    );
    console.log(JSON.stringify(step, null, 2));
  });

program
  .command("prepare-implement-dispatch")
  .description("Prepare bounded implementation prompts for documented work")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
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
    ".audit-tools/remediation",
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
  .command("accept-node")
  .description(
    "Host-subagent rolling callback: accept a finished node (commit/verify/merge) and get the next node to dispatch",
  )
  .requiredOption("--id <blockId>", "Block id of the node that just finished")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .action(async (options) => {
    const directive = await withBackendLogsOnStderr(() =>
      advanceHostRolling({
        root: resolve(options.root),
        artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        runId: options.runId,
        blockId: options.id,
      }),
    );
    const { kind, ...rest } = directive;
    console.log(JSON.stringify({ directive: kind, ...rest }, null, 2));
  });

program
  .command("reverify-node")
  .description(
    "Re-drive a quarantined implement node: replay its preserved commit through the tool's verify/scope/merge gate and land it on green (recovery after a fixed verify cause)",
  )
  .requiredOption("--id <blockId>", "Block id of the quarantined node")
  .requiredOption("--run-id <id>", "Run id")
  .option("--root <path>", "Repository root", ".")
  .option(
    "--artifacts-dir <path>",
    "Artifacts directory",
    ".audit-tools/remediation",
  )
  .action(async (options) => {
    const result = await withBackendLogsOnStderr(() =>
      reverifyQuarantinedNode(
        {
          root: resolve(options.root),
          artifactsDir: resolveArtifactsDirOption(options.root, options.artifactsDir),
        },
        options.runId,
        options.id,
      ),
    );
    console.log(JSON.stringify(result, null, 2));
    // Non-zero exit when nothing landed, so a scripted retry can branch on it.
    process.exit(result.status === "reverified" ? 0 : 1);
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
    ".audit-tools/remediation",
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
  .command("validate-artifact")
  .description(
    "Validate a single contract-pipeline artifact payload against its contract (write-time self-check)",
  )
  .requiredOption(
    "--name <name>",
    "Contract-pipeline artifact name (e.g. obligation_ledger, test_validator_plan)",
  )
  .option("--file <path>", "Path to the artifact JSON file (defaults to stdin)")
  .action(async (options) => {
    const name = options.name as ContractPipelineArtifactName;
    const validator = CONTRACT_PIPELINE_VALIDATORS[name];
    if (!validator) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            message: `Unknown contract-pipeline artifact "${options.name}". Valid names: ${CP_ARTIFACT_NAMES.join(", ")}.`,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }
    let raw: string;
    try {
      raw = options.file
        ? readFileSync(resolve(options.file), "utf8")
        : readFileSync(0, "utf8");
    } catch (err) {
      console.log(
        JSON.stringify(
          { status: "error", message: `Could not read artifact input: ${(err as Error).message}` },
          null,
          2,
        ),
      );
      process.exit(2);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.log(
        JSON.stringify(
          { status: "error", message: `Artifact is not valid JSON: ${(err as Error).message}` },
          null,
          2,
        ),
      );
      process.exit(2);
    }
    // Unwrap a stored content-hash envelope so the bare payload is validated
    // against its contract; a plain payload validates as-is. Uses the canonical
    // isEnvelope predicate so CLI self-check and ingest unwrap identically.
    const unwrapped = isEnvelope(parsed) ? parsed.payload : parsed;
    // Stamp the tool-owned `created_at` (host has no clock) so the self-check
    // matches ingest: a host payload without a timestamp is valid here too (B4).
    const payload = stampToolCreatedAt(unwrapped, new Date().toISOString());
    const issues = validator(payload, name);
    const errors = issues.filter((issue) => issue.severity === "error");
    console.log(
      JSON.stringify(
        {
          status: errors.length === 0 ? "ok" : "error",
          name,
          issue_count: issues.length,
          issues,
        },
        null,
        2,
      ),
    );
    process.exit(errors.length === 0 ? 0 : 1);
  });

program
  .command("validate")
  .description("Validate TypeScript types and schema contracts")
  .action(async () => {
    process.exit(runValidateCommand());
  });

// Exported so tests can construct argv and parse it through the real program
// instead of re-deriving option semantics.
export { program };

/**
 * Parse argv through the program after normalizing the `=value` form of the
 * tristate `--host-can-dispatch-subagents` boolean into commander's bare /
 * negatable forms. Commander treats `--flag=value` on a value-less boolean as an
 * unknown option, so `--host-can-dispatch-subagents=true|false` is rewritten to
 * the bare flag / `--no-` flag here. This keeps the flag a true boolean (a bare
 * flag never swallows the next token) while still accepting the `=false` spelling.
 */
export function parseProgram(argv: string[]): void {
  program.parse(normalizeBooleanFlagArgv(argv, "--host-can-dispatch-subagents"));
}

// Only parse argv when run directly; skip when imported as a module (e.g. in tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  setQuotaStateDir(join(homedir(), ".remediate-code"));
  parseProgram(process.argv);
}

// --- helpers ---

/**
 * Rewrite `<flag>=true` → `<flag>` and `<flag>=false` → `--no-<flag>` so a
 * value-less commander boolean can still be set false via the `=` spelling. A
 * non-boolean `<flag>=<other>` value fails loudly rather than silently defaulting.
 */
export function normalizeBooleanFlagArgv(argv: string[], flag: string): string[] {
  const negated = `--no-${flag.replace(/^--/, "")}`;
  return argv.map((token) => {
    if (token === `${flag}=true`) return flag;
    if (token === `${flag}=false`) return negated;
    if (token.startsWith(`${flag}=`)) {
      throw new Error(`${flag} must be true or false.`);
    }
    return token;
  });
}

/**
 * Single-step bootstrap writer for `intake/conversation-start.md`.
 *
 * Sole writer + idempotent-on-target (INV-CC-03): re-applying the identical
 * guidance is a byte-identical no-op (the existing file is left untouched, never
 * appended to), and a pre-existing file with DIFFERING content is never silently
 * clobbered — that case fails loudly so host/conversation-authored guidance can't
 * be lost. The guidance file's bytes are written verbatim.
 */
export function applyGuidanceFile(
  artifactsDir: string,
  guidanceFilePath: string,
): string {
  const target = join(artifactsDir, "intake", "conversation-start.md");
  const resolvedSource = resolve(guidanceFilePath);
  if (resolve(target) === resolvedSource) {
    // The guidance file already IS the target — nothing to copy, and reading
    // then rewriting it would be a pointless self-write.
    return target;
  }
  const incoming = readFileSync(resolvedSource);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.equals(incoming)) {
      // Identical re-apply: byte-identical no-op, no rewrite, no append.
      return target;
    }
    throw new Error(
      `Refusing to overwrite existing ${target} with differing guidance from ${resolvedSource}. ` +
        `Remove or reconcile the existing conversation-start.md before re-bootstrapping.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, incoming);
  return target;
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

/**
 * Resolve the remediation artifacts dir. An explicit `--artifacts-dir` is
 * honored verbatim; the unchanged commander default (`.audit-tools/remediation`)
 * rebases onto the anchored `--root` via the shared `remediationArtifactsDir()`
 * helper, so `--root <X>` lands the default under `<X>/.audit-tools/remediation`.
 * The `.audit-tools/...` join literal lives only in the shared path module, and
 * `resolveRepoRoot()` climbs the root out of a drifted cwd so a bare `--root .`
 * run from inside `.audit-tools/` cannot mint a phantom nested tree.
 */
export function resolveArtifactsDirOption(
  root: string,
  artifactsDir: string,
): string {
  return artifactsDir === ".audit-tools/remediation"
    ? remediationArtifactsDir(resolveRepoRoot(root))
    : resolve(artifactsDir);
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

// Remediator agent scope: managed rules win for specific patterns; an
// existing user wildcard survives (the managed set is passed without "*").
function renderOpenCodeAgentPermissionConfig(existing?: unknown): Record<string, unknown> {
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
function renderOpenCodeGlobalPermissionConfig(existing?: unknown): Record<string, unknown> {
  const existingPermission = objectValue(existing);
  const merged: Record<string, unknown> = {
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

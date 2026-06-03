import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifactBundle, AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import { readOptionalJsonFile, readOptionalTextFile } from "@audit-tools/shared";
import { deriveAuditState } from "../orchestrator/state.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import {
  buildAuditCodeHandoff,
  type AuditCodeHandoff,
} from "../supervisor/operatorHandoff.js";
import { readSessionConfigFile } from "../supervisor/sessionConfig.js";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import type { SessionConfig } from "@audit-tools/shared";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, "..", "..");
const wrapperPath = join(packageRoot, "audit-code.mjs");
const packageJsonPath = join(packageRoot, "package.json");
const PROTOCOL_VERSION = "2025-06-18";
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;

interface ServerOptions {
  root: string;
  artifactsDir: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface CliExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ToolCallContext {
  root: string;
  artifactsDir: string;
}

function getFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseServerOptions(argv: string[]): ServerOptions {
  const root = resolve(getFlag(argv, "--root") ?? ".");
  const artifactsDir = resolve(
    getFlag(argv, "--artifacts-dir") ?? join(root, ".audit-artifacts"),
  );
  return { root, artifactsDir };
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function getToolContext(
  params: Record<string, unknown> | undefined,
  defaults: ServerOptions,
): ToolCallContext {
  const root = hasValue(params?.root)
    ? resolve(params.root)
    : defaults.root;
  const artifactsDir = hasValue(params?.artifacts_dir)
    ? resolve(params.artifacts_dir)
    : hasValue(params?.artifactsDir)
      ? resolve(params.artifactsDir)
      : defaults.artifactsDir;
  return { root, artifactsDir };
}

async function packageVersion(): Promise<string> {
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "0.0.0";
}

function writeMessage(payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(header);
  process.stdout.write(body);
}

function success(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

export function parseContentLength(headerBlock: string): number {
  const headers = headerBlock.split("\r\n");
  const contentLengthHeader = headers.find((header) =>
    header.toLowerCase().startsWith("content-length:"),
  );
  if (!contentLengthHeader) {
    throw new Error("missing Content-Length");
  }

  const rawValue = contentLengthHeader.split(":")[1]?.trim();
  const contentLength = Number(rawValue);
  if (
    rawValue?.length === 0 ||
    !Number.isInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_CONTENT_LENGTH_BYTES
  ) {
    throw new Error("bad Content-Length");
  }

  return contentLength;
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function runWrapperCommand(
  args: string[],
  options: ToolCallContext,
): Promise<CliExecutionResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      wrapperPath,
      ...args,
      "--root",
      options.root,
      "--artifacts-dir",
      options.artifactsDir,
    ], {
      cwd: options.root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

const SUBPROCESS_STDERR_TAIL_CHARS = 2000;

async function parseCliJson(
  args: string[],
  options: ToolCallContext,
  allowNonZero = false,
): Promise<unknown> {
  const result = await runWrapperCommand(args, options);
  const combined = result.stdout.trim() || result.stderr.trim();
  if (!allowNonZero && result.code !== 0) {
    throw new Error(combined || `Command failed with exit code ${result.code}.`);
  }
  if (combined.length === 0) {
    throw new Error("Command completed without JSON output.");
  }
  // On a successful (or tolerated-nonzero) call we parse stdout for the JSON
  // payload and otherwise discard stderr. Surface any captured stderr as a
  // tail so subprocess diagnostics (warnings, structured stderr lines) are not
  // lost when the command still succeeded.
  const stderrTail = result.stderr.trim();
  if (stderrTail.length > 0) {
    process.stderr.write(
      `[audit-code] mcp: subprocess stderr: ${stderrTail.slice(-SUBPROCESS_STDERR_TAIL_CHARS)}\n`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    try {
      return JSON.parse(result.stderr);
    } catch {
      throw new Error(combined);
    }
  }
}

async function getStatusPayload(
  context: ToolCallContext,
): Promise<Record<string, unknown>> {
  const bundle = await loadArtifactBundle(context.artifactsDir);
  const decision = decideNextStep(bundle);
  const auditState = bundle.audit_state ?? deriveAuditState(bundle);
  const rawSessionConfig = await readSessionConfigFile(context.artifactsDir);
  const providerName =
    rawSessionConfig && typeof rawSessionConfig === "object"
      ? resolveFreshSessionProviderName(
          undefined,
          rawSessionConfig as SessionConfig,
        )
      : null;
  const handoff = buildAuditCodeHandoff({
    root: context.root,
    artifactsDir: context.artifactsDir,
    state: auditState,
    bundle,
    providerName,
    progressSummary: "Current artifact and handoff status.",
  });

  return {
    repo_root: context.root,
    artifacts_dir: context.artifactsDir,
    audit_state: auditState,
    selected_obligation: decision.selected_obligation,
    selected_executor: decision.selected_executor,
    next_likely_step:
      auditState.status === "complete" ? null : decision.selected_obligation,
    handoff,
  };
}

function asTextContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: asTextContent(value),
      },
    ],
    structuredContent:
      value && typeof value === "object" ? value : { value },
  };
}

interface ResourceRegistryEntry {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (context: ToolCallContext) => Promise<{ mimeType: string; text: string }>;
}

export const resourceRegistry: ResourceRegistryEntry[] = [
  {
    uri: "audit-code://artifacts/current",
    name: "current_artifacts",
    description: "Current artifact bundle as JSON.",
    mimeType: "application/json",
    async read(context) {
      const bundle = await loadArtifactBundle(context.artifactsDir);
      return { mimeType: this.mimeType, text: JSON.stringify(bundle) };
    },
  },
  {
    uri: "audit-code://handoff/current",
    name: "operator_handoff",
    description: "Current operator handoff payload as JSON.",
    mimeType: "application/json",
    async read(context) {
      const status = (await getStatusPayload(context)).handoff as AuditCodeHandoff;
      return { mimeType: this.mimeType, text: JSON.stringify(status) };
    },
  },
  {
    uri: "audit-code://install/guide",
    name: "install_guide",
    description: "Repo-local install guide for supported IDE hosts.",
    mimeType: "text/markdown",
    async read(context) {
      const path = join(context.root, ".audit-code", "install", "GETTING-STARTED.md");
      const guide =
        (await readOptionalTextFile(path)) ??
        "Run `audit-code install` from the repository root to generate the repo-local setup guide.";
      return { mimeType: this.mimeType, text: guide };
    },
  },
  {
    uri: "audit-code://report/current",
    name: "audit_report",
    description: "Current deterministic audit report if available.",
    mimeType: "text/markdown",
    async read(context) {
      const report =
        (await readOptionalTextFile(join(context.artifactsDir, AUDIT_REPORT_FILENAME))) ??
        (await readOptionalTextFile(join(context.root, AUDIT_REPORT_FILENAME))) ??
        "The audit report has not been rendered yet.";
      return { mimeType: this.mimeType, text: report };
    },
  },
];

async function readResource(
  uri: string,
  context: ToolCallContext,
): Promise<{ mimeType: string; text: string }> {
  const entry = resourceRegistry.find((r) => r.uri === uri);
  if (!entry) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }
  return entry.read(context);
}

function resourceListPayload() {
  return resourceRegistry.map((entry) => ({
    uri: entry.uri,
    name: entry.name,
    description: entry.description,
    mimeType: entry.mimeType,
  }));
}

interface PromptRegistryEntry {
  name: string;
  description: string;
  arguments: Array<{ name: string; required?: boolean; description: string }>;
  render: (args: Record<string, unknown> | undefined) => string;
}

export const promptRegistry: PromptRegistryEntry[] = [
  {
    name: "audit-code",
    description:
      "Start or continue the autonomous audit loop through the next-step machine.",
    arguments: [],
    render() {
      return [
        "Use `audit-code next-step` as the canonical interface to the backend wrapper.",
        "1. Prefer running `audit-code next-step` directly from the repository root.",
        "2. If this MCP adapter is your only available integration, call `start_audit` or `continue_audit`; both return the same one-step contract.",
        "3. If the audit is blocked, inspect `audit-code://handoff/current`.",
        "   Do not read `audit-code://artifacts/current` unless explicitly needed for a specific task; it is massive and consumes your context window.",
        "4. When the user provides additional evidence, call `import_results` or `import_runtime_updates`.",
      ].join("\n");
    },
  },
  {
    name: "review-task",
    description:
      "Inspect one audit task with explain_task and the current artifacts before reviewing code.",
    arguments: [
      {
        name: "task_id",
        required: true,
        description: "Audit task id to inspect.",
      },
    ],
    render(args) {
      return [
        `Use \`explain_task\` for task \`${String(args?.task_id ?? "")}\` before you inspect code manually.`,
        "Do not read the full `audit-code://artifacts/current` bundle unless specifically needed, as it is massive.",
      ].join("\n");
    },
  },
  {
    name: "synthesize-report",
    description:
      "Read the current audit report resource and summarize the highest-signal findings.",
    arguments: [],
    render() {
      return [
        "Read `audit-code://report/current`.",
        "Summarize the final audit report as work blocks first, then highlight the most important risks and remediation priorities.",
      ].join("\n");
    },
  },
];

function promptDefinitions() {
  return promptRegistry.map((entry) => ({
    name: entry.name,
    description: entry.description,
    arguments: entry.arguments,
  }));
}

function renderPrompt(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const entry = promptRegistry.find((p) => p.name === name);
  if (!entry) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  return entry.render(args);
}

async function runContinueAudit(context: ToolCallContext, extraArgs: string[] = ["next-step"]): Promise<unknown> {
  const step = await parseCliJson(extraArgs, context);
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  const s = step as Record<string, unknown>;

  if (hasValue(s.prompt_path as string)) {
    try {
      s.prompt_content = await readFile(s.prompt_path as string, "utf8");
    } catch {
      // ignore — prompt_path is a fallback for hosts that can read files
    }
  }

  if (s.step_kind === "dispatch_review") {
    const paths = s.artifact_paths as Record<string, string> | undefined;
    if (hasValue(paths?.dispatch_plan)) {
      const plan = await readOptionalJson(paths!.dispatch_plan);
      if (plan !== undefined) s.dispatch_plan_entries = plan;
    }
    if (hasValue(paths?.dispatch_quota)) {
      const quota = await readOptionalJson(paths!.dispatch_quota);
      if (quota !== undefined) s.dispatch_quota = quota;
    }
  }

  return s;
}

async function handleToolCall(
  name: string,
  params: Record<string, unknown> | undefined,
  defaults: ServerOptions,
): Promise<Record<string, unknown>> {
  const context = getToolContext(params, defaults);
  switch (name) {
    case "start_audit":
      return toolResult(await runContinueAudit(context));
    case "continue_audit":
      return toolResult(await runContinueAudit(context));
    case "get_status":
      return toolResult(await getStatusPayload(context));
    case "explain_task": {
      if (!hasValue(params?.task_id) && !hasValue(params?.taskId)) {
        throw new Error("explain_task requires task_id.");
      }
      const taskId = hasValue(params?.task_id)
        ? params.task_id
        : (params?.taskId as string);
      return toolResult(await parseCliJson(["explain-task", taskId], context));
    }
    case "validate_artifacts":
      return toolResult(await parseCliJson(["validate"], context, true));
    case "import_results": {
      if (!hasValue(params?.results_path) && !hasValue(params?.resultsPath)) {
        throw new Error("import_results requires results_path.");
      }
      const resultsPath = hasValue(params?.results_path)
        ? params.results_path
        : (params?.resultsPath as string);
      return toolResult(
        await parseCliJson(["--results", resolve(resultsPath)], context),
      );
    }
    case "import_runtime_updates": {
      if (!hasValue(params?.updates_path) && !hasValue(params?.updatesPath)) {
        throw new Error("import_runtime_updates requires updates_path.");
      }
      const updatesPath = hasValue(params?.updates_path)
        ? params.updates_path
        : (params?.updatesPath as string);
      return toolResult(
        await parseCliJson(["--updates", resolve(updatesPath)], context),
      );
    }
    case "merge_and_ingest": {
      const runId = hasValue(params?.run_id)
        ? (params.run_id as string)
        : hasValue(params?.runId)
          ? (params.runId as string)
          : undefined;
      if (!runId) throw new Error("merge_and_ingest requires run_id.");
      return toolResult(
        await parseCliJson(["merge-and-ingest", "--run-id", runId], context, true),
      );
    }
    case "report_capability": {
      const extraArgs: string[] = [];
      const canDispatch =
        params?.can_dispatch_subagents ?? params?.canDispatchSubagents;
      if (canDispatch !== undefined) {
        extraArgs.push("--host-can-dispatch-subagents", String(Boolean(canDispatch)));
      }
      const canRestrict =
        params?.can_restrict_subagent_tools ?? params?.canRestrictSubagentTools;
      if (canRestrict !== undefined) {
        extraArgs.push("--host-can-restrict-subagent-tools", String(Boolean(canRestrict)));
      }
      const canSelect =
        params?.can_select_subagent_model ?? params?.canSelectSubagentModel;
      if (canSelect !== undefined) {
        extraArgs.push("--host-can-select-subagent-model", String(Boolean(canSelect)));
      }
      const maxActiveSubagents =
        params?.max_active_subagents ?? params?.maxActiveSubagents;
      if (maxActiveSubagents !== undefined) {
        extraArgs.push("--host-max-active-subagents", String(maxActiveSubagents));
      }
      return toolResult(await runContinueAudit(context, ["next-step", ...extraArgs]));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolDefinitions() {
  return [
    {
      name: "start_audit",
      description:
        "Compatibility adapter over audit-code next-step; returns one step contract.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
      },
    },
    {
      name: "get_status",
      description:
        "Inspect the current artifact bundle and operator handoff without mutating state.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
      },
    },
    {
      name: "continue_audit",
      description:
        "Compatibility adapter over audit-code next-step from the current artifacts directory.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
      },
    },
    {
      name: "explain_task",
      description:
        "Resolve a task id into coverage scope, matching findings, and pending work.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task id to explain.",
          },
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "validate_artifacts",
      description:
        "Validate the current artifact bundle plus provider/session-config readiness.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
      },
    },
    {
      name: "import_results",
      description:
        "Import structured audit results into the same backend wrapper flow.",
      inputSchema: {
        type: "object",
        properties: {
          results_path: {
            type: "string",
            description: "Path to an AuditResult JSON payload.",
          },
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
        required: ["results_path"],
      },
    },
    {
      name: "import_runtime_updates",
      description:
        "Import runtime validation evidence updates into the backend wrapper flow.",
      inputSchema: {
        type: "object",
        properties: {
          updates_path: {
            type: "string",
            description: "Path to a runtime validation update JSON payload.",
          },
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
        required: ["updates_path"],
      },
    },
    {
      name: "merge_and_ingest",
      description:
        "Merge completed packet submissions into the artifact bundle after all dispatch subagents finish.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Review run ID from the dispatch_review step response.",
          },
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
        required: ["run_id"],
      },
    },
    {
      name: "report_capability",
      description:
        "Compatibility adapter that calls audit-code next-step with host subagent capability flags.",
      inputSchema: {
        type: "object",
        properties: {
          can_dispatch_subagents: {
            type: "boolean",
            description: "Whether this host can dispatch subagents (e.g. via the task tool).",
          },
          can_restrict_subagent_tools: {
            type: "boolean",
            description: "Whether this host can restrict tools per subagent.",
          },
          can_select_subagent_model: {
            type: "boolean",
            description: "Whether this host can select a model per subagent.",
          },
          max_active_subagents: {
            type: "integer",
            minimum: 1,
            description:
              "Known hard cap on simultaneously active subagents for this host, if available.",
          },
          root: { type: "string", description: "Repository root override." },
          artifacts_dir: {
            type: "string",
            description: "Artifacts directory override.",
          },
        },
        required: ["can_dispatch_subagents"],
      },
    },
  ];
}

/**
 * Extract zero or more complete Content-Length framed messages from a buffer.
 * Returns an array of parsed body strings and the remaining unconsumed buffer.
 * On framing errors, emits a framing error response via `emit` and resets the buffer.
 */
export function extractFrames(
  buffer: Buffer,
  emit: (response: JsonRpcResponse) => void,
): { bodies: string[]; remaining: Buffer<ArrayBufferLike> } {
  const bodies: string[] = [];
  let current = buffer;

  while (true) {
    const separator = current.indexOf("\r\n\r\n");
    if (separator < 0) {
      break;
    }

    let contentLength: number;
    try {
      const headerBlock = current.slice(0, separator).toString("utf8");
      contentLength = parseContentLength(headerBlock);
    } catch (error) {
      current = Buffer.alloc(0);
      emit(
        failure(
          null,
          -32700,
          `Invalid MCP framing: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        ),
      );
      break;
    }

    const frameLength = separator + 4 + contentLength;
    if (current.length < frameLength) {
      break;
    }

    bodies.push(current.slice(separator + 4, frameLength).toString("utf8"));
    current = current.slice(frameLength);
  }

  return { bodies, remaining: current };
}

interface DispatchContext {
  version: string;
  defaults: ServerOptions;
  shutdownRequested: boolean;
}

/**
 * Dispatch a single JSON-RPC request and return the response(s) to send,
 * plus updated shutdown state.
 */
export async function dispatchRequest(
  request: JsonRpcRequest,
  ctx: DispatchContext,
): Promise<{ responses: JsonRpcResponse[]; shutdownRequested: boolean; exit?: number }> {
  const responses: JsonRpcResponse[] = [];
  let { shutdownRequested } = ctx;

  if (!request.method) {
    responses.push(failure(request.id ?? null, -32600, "Missing method."));
    return { responses, shutdownRequested };
  }

  try {
    switch (request.method) {
      case "initialize": {
        const requestedVersion =
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : PROTOCOL_VERSION;
        const negotiatedVersion =
          requestedVersion <= PROTOCOL_VERSION
            ? requestedVersion
            : PROTOCOL_VERSION;
        responses.push(
          success(request.id ?? null, {
            protocolVersion: negotiatedVersion,
            serverInfo: {
              name: "audit-code",
              version: ctx.version,
            },
            instructions:
              "Use audit-code next-step as the primary backend loop. These MCP tools are compatibility adapters that return the same one-step contract.",
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
          }),
        );
        break;
      }
      case "notifications/initialized":
        break;
      case "ping":
        if (request.id !== undefined) {
          responses.push(success(request.id, {}));
        }
        break;
      case "tools/list":
        responses.push(success(request.id ?? null, { tools: toolDefinitions() }));
        break;
      case "tools/call": {
        const params = parseObject(request.params);
        const toolName = params.name;
        if (!hasValue(toolName)) {
          throw new Error("tools/call requires a tool name.");
        }
        responses.push(
          success(
            request.id ?? null,
            await handleToolCall(
              toolName,
              parseObject(params.arguments),
              ctx.defaults,
            ),
          ),
        );
        break;
      }
      case "resources/list":
        responses.push(
          success(request.id ?? null, {
            resources: resourceListPayload(),
          }),
        );
        break;
      case "resources/read": {
        const params = parseObject(request.params);
        if (!hasValue(params.uri)) {
          throw new Error("resources/read requires uri.");
        }
        const resource = await readResource(params.uri, ctx.defaults);
        responses.push(
          success(request.id ?? null, {
            contents: [
              {
                uri: params.uri,
                mimeType: resource.mimeType,
                text: resource.text,
              },
            ],
          }),
        );
        break;
      }
      case "prompts/list":
        responses.push(
          success(request.id ?? null, {
            prompts: promptDefinitions(),
          }),
        );
        break;
      case "prompts/get": {
        const params = parseObject(request.params);
        if (!hasValue(params.name)) {
          throw new Error("prompts/get requires name.");
        }
        responses.push(
          success(request.id ?? null, {
            description: promptDefinitions().find(
              (prompt) => prompt.name === params.name,
            )?.description,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: renderPrompt(params.name, parseObject(params.arguments)),
                },
              },
            ],
          }),
        );
        break;
      }
      case "shutdown":
        shutdownRequested = true;
        responses.push(success(request.id ?? null, {}));
        break;
      case "exit":
        return { responses, shutdownRequested, exit: shutdownRequested ? 0 : 1 };
      default:
        responses.push(
          failure(
            request.id ?? null,
            -32601,
            `Unknown method: ${request.method}`,
          ),
        );
    }
  } catch (error) {
    responses.push(
      failure(
        request.id ?? null,
        -32000,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  return { responses, shutdownRequested };
}

export async function runAuditCodeMcpServer(argv: string[]): Promise<void> {
  const defaults = parseServerOptions(argv);
  const version = await packageVersion();
  let shutdownRequested = false;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  process.stdin.on("data", async (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    const { bodies, remaining } = extractFrames(buffer, writeMessage);
    buffer = remaining;

    for (const body of bodies) {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch (error) {
        writeMessage(
          failure(
            null,
            -32700,
            "Invalid JSON-RPC payload.",
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }

      const result = await dispatchRequest(request, {
        version,
        defaults,
        shutdownRequested,
      });
      shutdownRequested = result.shutdownRequested;

      for (const response of result.responses) {
        writeMessage(response);
      }

      if (result.exit !== undefined) {
        process.exit(result.exit);
      }
    }
  });
}

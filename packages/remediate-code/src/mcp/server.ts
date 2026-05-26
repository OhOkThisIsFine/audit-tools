import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../state/store.js";
import { decideNextStep, type NextStepOptions } from "../steps/nextStep.js";

type JsonRpcId = string | number | null;

interface McpRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface McpServerContext {
  root: string;
  artifactsDir: string;
  stdout: Pick<NodeJS.WritableStream, "write">;
  nextStep: typeof decideNextStep;
}

export interface RunRemediatorMcpServerDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  nextStep?: typeof decideNextStep;
}

// Single in-process guard prevents concurrent next-step writes from
// overlapping when multiple MCP tool calls arrive in rapid succession.
let nextStepRunning = false;

export function resetMcpServerStateForTests(): void {
  nextStepRunning = false;
}

function requestId(request: McpRequest): JsonRpcId {
  return request.id ?? null;
}

function logNextStepError(
  err: unknown,
  context: McpServerContext,
  details: { requestId: JsonRpcId; toolName: string },
): void {
  console.error(
    `MCP next-step error: tool=${details.toolName} requestId=${String(
      details.requestId,
    )} root=${context.root} artifactsDir=${context.artifactsDir}`,
    err,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function renderNextStep(
  context: McpServerContext,
  options: Omit<NextStepOptions, "root" | "artifactsDir">,
): Promise<
  | { type: "busy" }
  | { type: "step"; step: Awaited<ReturnType<typeof decideNextStep>> }
> {
  if (nextStepRunning) return { type: "busy" };
  nextStepRunning = true;
  try {
    const step = await context.nextStep({
      root: context.root,
      artifactsDir: context.artifactsDir,
      ...options,
    });
    return { type: "step", step };
  } finally {
    nextStepRunning = false;
  }
}

const PROTOCOL_VERSION = "2025-06-18";

function writeMessage(
  stdout: Pick<NodeJS.WritableStream, "write">,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  stdout.write(header);
  stdout.write(body);
}

function writeResult(
  context: McpServerContext,
  id: JsonRpcId,
  result: unknown,
): void {
  writeMessage(context.stdout, { jsonrpc: "2.0", id, result });
}

function writeTextResult(
  context: McpServerContext,
  id: JsonRpcId,
  text: string,
): void {
  writeResult(context, id, { content: [{ type: "text", text }] });
}

function writeError(
  context: McpServerContext,
  id: JsonRpcId,
  code: number,
  message: string,
): void {
  writeMessage(context.stdout, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

type ParseFrameResult =
  | { type: "incomplete" }
  | { type: "framing_error"; message: string; remaining: Buffer<ArrayBuffer> }
  | { type: "json_error"; message: string; remaining: Buffer<ArrayBuffer> }
  | { type: "ok"; request: unknown; remaining: Buffer<ArrayBuffer> };

// Pure framing parser with no I/O side effects.
export function parseFrame(buffer: Buffer): ParseFrameResult {
  const separator = buffer.indexOf("\r\n\r\n");
  if (separator < 0) return { type: "incomplete" };
  const bodyStart = separator + 4;

  function recoverRemaining(): Buffer<ArrayBuffer> {
    const remaining = buffer.slice(bodyStart);
    const nextHeader = remaining.indexOf("Content-Length:");
    if (nextHeader < 0) return Buffer.alloc(0);
    return Buffer.from(remaining.slice(nextHeader));
  }

  const headerBlock = buffer.slice(0, separator).toString("utf8");
  const headers = headerBlock.split("\r\n");
  const clHeader = headers.find((h) =>
    h.toLowerCase().startsWith("content-length:"),
  );
  if (!clHeader) {
    return {
      type: "framing_error",
      message: "Invalid MCP framing: missing Content-Length.",
      remaining: recoverRemaining(),
    };
  }

  const contentLength = Number(clHeader.split(":")[1]?.trim());
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return {
      type: "framing_error",
      message: "Invalid Content-Length header.",
      remaining: recoverRemaining(),
    };
  }

  const frameLength = bodyStart + contentLength;
  if (buffer.length < frameLength) return { type: "incomplete" };

  const body = buffer.slice(separator + 4, frameLength).toString("utf8");
  const remaining = Buffer.from(buffer.slice(frameLength));

  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch (e) {
    return { type: "json_error", message: (e as Error).message, remaining };
  }
  return { type: "ok", request, remaining };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequest(value: unknown): McpRequest | null {
  if (!isRecord(value)) return null;
  const params = isRecord(value.params) ? value.params : undefined;
  const args = isRecord(params?.arguments) ? params.arguments : undefined;
  return {
    jsonrpc: typeof value.jsonrpc === "string" ? value.jsonrpc : undefined,
    id:
      typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null
        ? value.id
        : undefined,
    method: typeof value.method === "string" ? value.method : undefined,
    params: params
      ? {
          name: typeof params.name === "string" ? params.name : undefined,
          arguments: args,
        }
      : undefined,
  };
}

function handleInitialize(request: McpRequest, context: McpServerContext): void {
  writeResult(context, requestId(request), {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: "remediator-lambda", version: "0.1.0" },
    instructions:
      "Deprecated compatibility bridge. Prefer `remediate-code next-step`; MCP tools render the same one-step contract.",
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
  });
}

function handleToolsList(request: McpRequest, context: McpServerContext): void {
  const nextStepInputSchema = {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "Path to audit report or finding list",
      },
      host_can_dispatch_subagents: {
        type: "boolean",
        description:
          "Whether the current host can dispatch callable subagents",
      },
      host_max_concurrent: {
        type: "integer",
        description: "Maximum number of subagents the host can run concurrently",
      },
      finalize_closing: {
        type: "boolean",
        description: "Finalize a generated close_run step",
      },
    },
  };

  writeResult(context, requestId(request), {
    tools: [
      {
        name: "next_step",
        description: "Render one canonical remediation next-step JSON contract",
        inputSchema: nextStepInputSchema,
      },
      {
        name: "start_remediation",
        description:
          "Deprecated alias for next_step; renders one next-step JSON contract",
        inputSchema: nextStepInputSchema,
      },
      {
        name: "get_status",
        description: "Get the current remediation status",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "submit_clarifications",
        description:
          "Submit resolutions for pending clarifications and render next_step",
        inputSchema: {
          type: "object",
          properties: { resolutions: { type: "object" } },
        },
      },
      {
        name: "submit_triage",
        description:
          "Submit triage resolutions for blocked items and render next_step",
        inputSchema: {
          type: "object",
          properties: { resolutions: { type: "object" } },
        },
      },
    ],
  });
}

function booleanArgument(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = args?.[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function numberArgument(
  args: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nextStepOptionsFromRequest(
  request: McpRequest,
): Omit<NextStepOptions, "root" | "artifactsDir"> {
  const args = request.params?.arguments;
  return {
    input: typeof args?.input === "string" ? args.input : undefined,
    hostCanDispatchSubagents: booleanArgument(
      args,
      "host_can_dispatch_subagents",
    ),
    hostMaxConcurrent: numberArgument(args, "host_max_concurrent"),
    finalizeClosing: booleanArgument(args, "finalize_closing") === true,
  };
}

function requestWithoutResolutionPayload(request: McpRequest): McpRequest {
  const { resolutions: _resolutions, ...nextStepArgs } =
    request.params?.arguments ?? {};
  return {
    ...request,
    params: { ...request.params, arguments: nextStepArgs },
  };
}

async function handleNextStep(
  request: McpRequest,
  context: McpServerContext,
  toolName: string,
): Promise<void> {
  const id = requestId(request);
  try {
    const result = await renderNextStep(
      context,
      nextStepOptionsFromRequest(request),
    );
    if (result.type === "busy") {
      writeTextResult(context, id, "A next-step request is already running.");
      return;
    }
    writeTextResult(context, id, JSON.stringify(result.step, null, 2));
  } catch (err) {
    logNextStepError(err, context, { requestId: id, toolName });
    writeError(context, id, -32000, errorMessage(err));
  }
}

async function handleStartRemediation(
  request: McpRequest,
  context: McpServerContext,
): Promise<void> {
  await handleNextStep(request, context, "start_remediation");
}

async function handleGetStatus(
  request: McpRequest,
  context: McpServerContext,
): Promise<void> {
  const store = new StateStore(context.artifactsDir);
  const state = await store.loadState();
  writeTextResult(
    context,
    requestId(request),
    JSON.stringify(state ?? { status: "not_started" }, null, 2),
  );
}

async function writeResolutionFile(
  context: McpServerContext,
  filename: string,
  resolutions: unknown,
): Promise<void> {
  if (resolutions === undefined) return;
  await mkdir(context.artifactsDir, { recursive: true });
  await writeFile(
    join(context.artifactsDir, filename),
    JSON.stringify(resolutions, null, 2),
    "utf8",
  );
}

async function handleSubmitClarifications(
  request: McpRequest,
  context: McpServerContext,
): Promise<void> {
  await writeResolutionFile(
    context,
    "clarification_resolution.json",
    request.params?.arguments?.resolutions,
  );
  await handleNextStep(
    requestWithoutResolutionPayload(request),
    context,
    "submit_clarifications",
  );
}

async function handleSubmitTriage(
  request: McpRequest,
  context: McpServerContext,
): Promise<void> {
  await writeResolutionFile(
    context,
    "triage_resolution.json",
    request.params?.arguments?.resolutions,
  );
  await handleNextStep(
    requestWithoutResolutionPayload(request),
    context,
    "submit_triage",
  );
}

async function dispatchToolCall(
  request: McpRequest,
  context: McpServerContext,
): Promise<void> {
  const name = request.params?.name;
  switch (name) {
    case "next_step":
      await handleNextStep(request, context, "next_step");
      break;
    case "start_remediation":
      await handleStartRemediation(request, context);
      break;
    case "get_status":
      await handleGetStatus(request, context);
      break;
    case "submit_clarifications":
      await handleSubmitClarifications(request, context);
      break;
    case "submit_triage":
      await handleSubmitTriage(request, context);
      break;
    default:
      writeError(context, requestId(request), -32601, "Tool not found");
  }
}

async function dispatchRequest(
  rawRequest: unknown,
  context: McpServerContext,
): Promise<void> {
  const request = normalizeRequest(rawRequest);
  if (!request) {
    writeError(context, null, -32600, "Invalid request");
    return;
  }

  if (request.method === "initialize") {
    handleInitialize(request, context);
  } else if (request.method === "tools/list") {
    handleToolsList(request, context);
  } else if (request.method === "tools/call") {
    await dispatchToolCall(request, context);
  } else if (request.method === "exit") {
    process.exit(0);
  } else if (request.id !== undefined && request.id !== null) {
    writeError(
      context,
      request.id,
      -32601,
      `Method not found: ${request.method ?? ""}`,
    );
  }
}

export async function runRemediatorMcpServer(
  root: string,
  artifactsDir: string,
  deps: RunRemediatorMcpServerDeps = {},
): Promise<void> {
  let buffer: Buffer<ArrayBuffer> = Buffer.alloc(0);
  const stdin = deps.stdin ?? process.stdin;
  const context: McpServerContext = {
    root,
    artifactsDir,
    stdout: deps.stdout ?? process.stdout,
    nextStep: deps.nextStep ?? decideNextStep,
  };

  stdin.on("data", async (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const result = parseFrame(buffer);

      if (result.type === "incomplete") return;

      if (result.type === "framing_error") {
        buffer = result.remaining;
        writeError(context, null, -32700, result.message);
        if (buffer.length > 0) continue;
        return;
      }

      if (result.type === "json_error") {
        buffer = result.remaining;
        console.error(
          "MCP: failed to parse JSON frame, skipping:",
          result.message,
        );
        writeError(context, null, -32700, `Invalid JSON frame: ${result.message}`);
        continue;
      }

      buffer = result.remaining;
      await dispatchRequest(result.request, context);
    }
  });
}

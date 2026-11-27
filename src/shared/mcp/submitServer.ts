// sites-pinned: tests/shared/submit-mcp-server.test.ts, tests/audit/result-submit.test.ts, tests/audit/gate-submit.test.ts
/**
 * The submit-only MCP server both bins serve (decision 4, 2026-11-06).
 *
 * `submit_result`, plus optional bin-owned gate submission. A reader passes its result as a structured
 * object, so no shell and no escaping stand between the reader and the bound
 * path — the defect class the dogfood audit measured (a backslash in a quote
 * lost on its way through a shell). The server returns no step and no prompt:
 * `next-step` stays the one copy of the step contract (a80cb74f). The file
 * route (`<bin> submit --work-item <id> --from <file>`) stays first-class for a
 * host whose sub-agents do not receive the parent's MCP tools.
 *
 * Each bin supplies its own submit core; the server owns only the transport,
 * the argument shape and the verdict wording.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, parse } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorMessage } from "../io/json.js";

/** What the server hands the bin's submit core. Resolution of the paths is the bin's. */
export interface SubmitToolRequest {
  readonly root: string;
  readonly artifactsDir: string | undefined;
  readonly workItemId: string;
  /** The result object, serialized once here. */
  readonly source: string;
}

export interface GateSubmitToolRequest {
  readonly root: string;
  readonly artifactsDir: string | undefined;
  readonly lane: string;
  readonly workItemId?: string;
  readonly source: string;
}

export interface SubmitServerOptions {
  readonly name: string;
  readonly version: string;
  readonly submissionDescription?: string;
  readonly gateSubmission?: {
    readonly lanes: readonly [string, ...string[]];
    readonly description?: string;
    readonly submit: (request: GateSubmitToolRequest) => Promise<{ readonly written: boolean }>;
  };
  readonly submit: (request: SubmitToolRequest) => Promise<{ readonly written: boolean }>;
}

function packageIdentity(manifest: URL) {
  const root = statSync(new URL(".", manifest), { bigint: true });
  const file = statSync(manifest, { bigint: true });
  const metadata: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof metadata !== "object" || metadata === null ||
      !("name" in metadata) || metadata.name !== "audit-tools" ||
      !("version" in metadata) || typeof metadata.version !== "string" || !metadata.version) {
    throw new Error("Invalid audit-tools package manifest");
  }
  return {
    version: metadata.version,
    // npm may force-reinstall the same version. Check the package and manifest
    // filesystem identities, not just the version advertised during handshake.
    installation: `${root.dev}:${root.ino}:${file.dev}:${file.ino}:${file.mtimeNs}:${file.size}`,
  };
}

function requireAbsolutePaths(request: { root: string; artifactsDir?: string }, relativeDefault?: string) {
  const absolute = (path: string) =>
    isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
  if (!absolute(request.root)) throw new Error("Use the absolute repository root named by the prompt.");
  if (request.artifactsDir !== undefined && request.artifactsDir !== relativeDefault && !absolute(request.artifactsDir)) {
    throw new Error("Use the absolute artifacts directory named by the prompt, or omit it to use the repository default.");
  }
}

const SUBMIT_TOOL_DESCRIPTION =
  "Submit the result of ONE work item. Pass the result as a JSON object, not a string. " +
  "The tool checks it with the rules ingestion applies and writes it to the item's bound path only when it passes. " +
  "On an error, correct the result and call this tool again.";

/** One tool reply: the report as JSON (an error when nothing was written), or the thrown message. */
async function toolReply(run: () => Promise<{ readonly written: boolean }>) {
  try {
    const report = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      ...(report.written ? {} : { isError: true }),
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true };
  }
}

export function createSubmitMcpServer(options: SubmitServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  server.registerTool(
    "submit_result",
    {
      description: options.submissionDescription ?? SUBMIT_TOOL_DESCRIPTION,
      inputSchema: {
        root: z.string().describe("Absolute path of the repository root your prompt names"),
        artifacts_dir: z
          .string()
          .optional()
          .describe("The artifacts directory, only when your prompt names one"),
        work_item_id: z.string().describe("The work-item id your prompt names"),
        result: z.record(z.string(), z.unknown()).describe("The result document, as a JSON object"),
      },
    },
    (args) =>
      toolReply(() =>
        options.submit({
          root: args.root,
          artifactsDir: args.artifacts_dir,
          workItemId: args.work_item_id,
          source: JSON.stringify(args.result, null, 2),
        }),
      ),
  );
  // sites-pinned: tests/audit/gate-submit.test.ts
  const gate = options.gateSubmission;
  if (gate) server.registerTool("submit_gate", {
    description: gate.description ?? "Submit a supported gate result as a JSON object or array, as required by its lane. Validates and writes its bound submission path; does not advance the workflow. Run next-step afterward.",
    inputSchema: {
      root: z.string().describe("Absolute repository root named by the prompt"),
      artifacts_dir: z.string().optional(),
      lane: z.enum(gate.lanes),
      work_item_id: z.string().optional().describe("Work-item id, required for item-bound gate lanes"),
      result: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    },
  }, args => toolReply(() => gate.submit({ root: args.root, artifactsDir: args.artifacts_dir, lane: args.lane, ...(args.work_item_id === undefined ? {} : { workItemId: args.work_item_id }), source: JSON.stringify(args.result, null, 2) })));
  return server;
}

/**
 * Serve the submit tool over stdio until the host closes the stream.
 *
 * stdout IS the protocol stream, so every console write the submit core makes
 * goes to stderr: one stray `console.log` line would corrupt the stream, and
 * the cores were written for a CLI that prints freely.
 */
export async function serveSubmitMcpOverStdio(
  options: Omit<SubmitServerOptions, "version">,
  relativeDefault?: string,
): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  // src/shared/mcp/ and dist/shared/mcp/ both sit three levels under the package root.
  const manifest = new URL("../../../package.json", import.meta.url);
  const original = packageIdentity(manifest);
  // Refuse a submit when the installation already changed. This is not a lock
  // against an upgrade beginning while a submission is already in flight.
  const requireOriginalPackage = () => {
    try {
      const current = packageIdentity(manifest);
      if (current.installation === original.installation && current.version === original.version) return;
    } catch {
      // npm may be in the middle of replacing the directory.
    }
    throw new Error("The audit-tools installation changed or is unavailable. Restart this MCP server before resubmitting. No result was written.");
  };
  const checkRequest = (request: { root: string; artifactsDir?: string }) => {
    requireOriginalPackage();
    requireAbsolutePaths(request, relativeDefault);
  };
  const gate = options.gateSubmission;
  await createSubmitMcpServer({
    ...options,
    version: original.version,
    submit: request => { checkRequest(request); return options.submit(request); },
    ...(gate && { gateSubmission: { ...gate, submit: request => { checkRequest(request); return gate.submit(request); } } }),
  }).connect(new StdioServerTransport());
}

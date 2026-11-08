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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
  readonly source: string;
}

export interface SubmitServerOptions {
  readonly name: string;
  readonly version: string;
  readonly gateSubmission?: {
    readonly lanes: readonly [string, ...string[]];
    readonly description?: string;
    readonly submit: (request: GateSubmitToolRequest) => Promise<{ readonly written: boolean }>;
  };
  readonly submit: (request: SubmitToolRequest) => Promise<{ readonly written: boolean }>;
}

const SUBMIT_TOOL_DESCRIPTION =
  "Submit the result of ONE work item. Pass the result as a JSON object, not a string. " +
  "The tool checks it with the rules ingestion applies and writes it to the item's bound path only when it passes. " +
  "On an error, correct the result and call this tool again.";

export function createSubmitMcpServer(options: SubmitServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  server.registerTool(
    "submit_result",
    {
      description: SUBMIT_TOOL_DESCRIPTION,
      inputSchema: {
        root: z.string().describe("Absolute path of the repository root your prompt names"),
        artifacts_dir: z
          .string()
          .optional()
          .describe("The artifacts directory, only when your prompt names one"),
        work_item_id: z.string().describe("The work-item id your prompt names"),
        result: z.record(z.unknown()).describe("The result document, as a JSON object"),
      },
    },
    async (args) => {
      try {
        const report = await options.submit({
          root: args.root,
          artifactsDir: args.artifacts_dir,
          workItemId: args.work_item_id,
          source: JSON.stringify(args.result, null, 2),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
          ...(report.written ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
  // sites-pinned: tests/audit/gate-submit.test.ts
  const gate = options.gateSubmission;
  if (gate) server.registerTool("submit_gate", {
    description: gate.description ?? "Submit a supported gate result as a JSON object or array, as required by its lane. Validates and writes its bound submission path; does not advance the workflow. Run next-step afterward.",
    inputSchema: {
      root: z.string().describe("Absolute repository root named by the prompt"),
      artifacts_dir: z.string().optional(),
      lane: z.enum(gate.lanes),
      result: z.union([z.record(z.unknown()), z.array(z.unknown())]),
    },
  }, async args => {
    try {
      const report = await gate.submit({ root: args.root, artifactsDir: args.artifacts_dir, lane: args.lane, source: JSON.stringify(args.result, null, 2) });
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }], ...(report.written ? {} : { isError: true }) };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}

/**
 * Serve the submit tool over stdio until the host closes the stream.
 *
 * stdout IS the protocol stream, so every console write the submit core makes
 * goes to stderr: one stray `console.log` line would corrupt the stream, and
 * the cores were written for a CLI that prints freely.
 */
export async function serveSubmitMcpOverStdio(options: Omit<SubmitServerOptions, "version">): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  // src/shared/mcp/ and dist/shared/mcp/ both sit three levels under the package root.
  const { version } = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  await createSubmitMcpServer({ ...options, version }).connect(new StdioServerTransport());
}

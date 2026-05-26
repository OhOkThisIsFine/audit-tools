import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  parseFrame,
  resetMcpServerStateForTests,
  runRemediatorMcpServer,
} from "../src/mcp/server.js";

function makeFrame(body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const header = `Content-Length: ${bodyBuf.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), bodyBuf]);
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function parseOutputFrames(buffer: Buffer): any[] {
  const frames: any[] = [];
  let remaining = buffer;
  while (remaining.length > 0) {
    const parsed = parseFrame(remaining);
    if (parsed.type !== "ok") break;
    frames.push(parsed.request);
    remaining = parsed.remaining;
  }
  return frames;
}

function makeStep(overrides: Record<string, unknown> = {}): any {
  return {
    contract_version: "remediate-code-step/v1alpha1",
    step_kind: "locate_input",
    status: "blocked",
    prompt_path: "/artifacts/steps/current-prompt.md",
    run_id: "INPUT-1",
    repo_root: "/repo",
    artifacts_dir: "/artifacts",
    allowed_commands: ["remediate-code next-step --input <path>"],
    stop_condition: "Stop after asking the user for an input path.",
    artifact_paths: {},
    ...overrides,
  };
}

describe("parseFrame — framing", () => {
  it("returns incomplete when buffer has no header separator", () => {
    const result = parseFrame(Buffer.from("Content-Length: 10"));
    expect(result.type).toBe("incomplete");
  });

  it("returns incomplete when body is shorter than Content-Length", () => {
    const result = parseFrame(Buffer.from("Content-Length: 100\r\n\r\n{}"));
    expect(result.type).toBe("incomplete");
  });

  it("returns framing_error when Content-Length header is absent", () => {
    const result = parseFrame(Buffer.from("X-Custom: foo\r\n\r\n{}"));
    expect(result.type).toBe("framing_error");
    expect((result as any).message).toMatch(/Content-Length/);
  });

  it("returns framing_error when Content-Length is not a number", () => {
    const result = parseFrame(Buffer.from("Content-Length: abc\r\n\r\n{}"));
    expect(result.type).toBe("framing_error");
    expect((result as any).message).toMatch(/Content-Length/);
  });

  it("returns framing_error when Content-Length is negative", () => {
    const result = parseFrame(Buffer.from("Content-Length: -1\r\n\r\n{}"));
    expect(result.type).toBe("framing_error");
  });
});

describe("parseFrame — JSON parsing", () => {
  it("returns ok with parsed request for a valid frame", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const result = parseFrame(makeFrame(payload));
    expect(result.type).toBe("ok");
    expect((result as any).request).toMatchObject({ method: "initialize" });
  });

  it("returns json_error for a valid frame with invalid JSON body", () => {
    const header = "Content-Length: 5\r\n\r\n";
    const buf = Buffer.concat([
      Buffer.from(header, "utf8"),
      Buffer.from("{bad}", "utf8"),
    ]);
    const result = parseFrame(buf);
    expect(result.type).toBe("json_error");
  });

  it("remaining buffer contains bytes after the consumed frame", () => {
    const payload1 = JSON.stringify({ id: 1, method: "a" });
    const payload2 = JSON.stringify({ id: 2, method: "b" });
    const combined = Buffer.concat([makeFrame(payload1), makeFrame(payload2)]);

    const first = parseFrame(combined);
    expect(first.type).toBe("ok");

    const second = parseFrame((first as any).remaining);
    expect(second.type).toBe("ok");
    expect((second as any).request).toMatchObject({ method: "b" });
  });

  it("handles case-insensitive Content-Length header", () => {
    const body = JSON.stringify({ id: 1, method: "ping" });
    const bodyBuf = Buffer.from(body, "utf8");
    const header = `content-length: ${bodyBuf.length}\r\n\r\n`;
    const buf = Buffer.concat([Buffer.from(header, "utf8"), bodyBuf]);
    const result = parseFrame(buf);
    expect(result.type).toBe("ok");
  });

  it("preserves a following well-formed frame after a framing_error", () => {
    const payload = JSON.stringify({ id: 2, method: "b" });
    const result = parseFrame(
      Buffer.concat([
        Buffer.from("Bad-Header: val\r\n\r\nignored body", "utf8"),
        makeFrame(payload),
      ]),
    );
    expect(result.type).toBe("framing_error");
    const next = parseFrame((result as any).remaining);
    expect(next.type).toBe("ok");
    expect((next as any).request).toMatchObject({ method: "b" });
  });
});

describe("parseFrame — concurrent guard precondition", () => {
  it("parses start_remediation tool call frame correctly", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "start_remediation", arguments: { input: "audit.md" } },
    });
    const result = parseFrame(makeFrame(payload));
    expect(result.type).toBe("ok");
    const req = (result as any).request;
    expect(req.method).toBe("tools/call");
    expect(req.params.name).toBe("start_remediation");
    expect(req.params.arguments.input).toBe("audit.md");
  });

  it("parses get_status tool call frame correctly", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_status", arguments: {} },
    });
    const result = parseFrame(makeFrame(payload));
    expect(result.type).toBe("ok");
    expect((result as any).request.params.name).toBe("get_status");
  });
});

describe("runRemediatorMcpServer — next-step compatibility bridge", () => {
  it("dispatches initialize and tools/list through the stdin frame loop", async () => {
    resetMcpServerStateForTests();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await runRemediatorMcpServer("/repo", "/artifacts", {
      stdin,
      stdout: stdout as any,
      nextStep: async () => makeStep(),
    });

    stdin.write(
      Buffer.concat([
        makeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })),
        makeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
      ]),
    );
    await flushAsync();

    const responses = parseOutputFrames(Buffer.concat(chunks));
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    const toolNames = responses[1].result.tools.map((tool: any) => tool.name);
    expect(toolNames).toContain("next_step");
    expect(toolNames).toContain("start_remediation");
  });

  it("dispatches start_remediation through the next-step adapter", async () => {
    resetMcpServerStateForTests();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    const nextStepCalls: any[] = [];
    await runRemediatorMcpServer("/repo", "/artifacts", {
      stdin,
      stdout: stdout as any,
      nextStep: async (options) => {
        nextStepCalls.push(options);
        return makeStep({
          step_kind: "extract_findings",
          status: "ready",
          artifact_paths: { input: options.input ?? "" },
        });
      },
    });

    stdin.write(
      makeFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "start_remediation",
            arguments: {
              input: "audit-report.md",
              host_can_dispatch_subagents: true,
              host_max_concurrent: 2,
            },
          },
        }),
      ),
    );
    await flushAsync();

    const responses = parseOutputFrames(Buffer.concat(chunks));
    const step = JSON.parse(responses[0].result.content[0].text);
    expect(nextStepCalls).toHaveLength(1);
    expect(nextStepCalls[0]).toMatchObject({
      input: "audit-report.md",
      hostCanDispatchSubagents: true,
      hostMaxConcurrent: 2,
      root: "/repo",
      artifactsDir: "/artifacts",
    });
    expect(step.step_kind).toBe("extract_findings");
    expect(step.artifact_paths.input).toBe("audit-report.md");
    resetMcpServerStateForTests();
  });
});

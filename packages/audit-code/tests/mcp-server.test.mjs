import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const distEntry = join(repoRoot, "dist", "index.js");

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function createMcpClient(root) {
  const artifactsDir = join(root, ".audit-artifacts");
  const child = spawn(process.execPath, [
    distEntry,
    "mcp",
    "--root",
    root,
    "--artifacts-dir",
    artifactsDir,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const frame = parseFramedMessage(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.slice(frame.consumed);

      const { payload } = frame;
      if (pending.has(payload.id)) {
        pending.get(payload.id)(payload);
        pending.delete(payload.id);
      }
    }
  });

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      pending.set(id, (payload) => {
        if (payload.error) {
          reject(new Error(payload.error.message));
          return;
        }
        resolve(payload.result);
      });
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      );
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        method,
        params,
      }),
    );
  }

  async function close() {
    await request("shutdown", "shutdown");
    notify("exit");
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
  }

  return { request, notify, close, child, artifactsDir };
}

function parseFramedMessage(buffer) {
  const separator = buffer.indexOf("\r\n\r\n");
  if (separator < 0) return null;
  const headerBlock = buffer.slice(0, separator).toString("utf8");
  const contentLengthHeader = headerBlock
    .split("\r\n")
    .find((header) => header.toLowerCase().startsWith("content-length:"));
  if (!contentLengthHeader) return null;
  const contentLength = Number(contentLengthHeader.split(":")[1]?.trim());
  const frameLength = separator + 4 + contentLength;
  if (buffer.length < frameLength) return null;
  return {
    payload: JSON.parse(buffer.slice(separator + 4, frameLength).toString("utf8")),
    consumed: frameLength,
  };
}

function readFramedPayload(stream) {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for MCP response."));
    }, 5000);

    function cleanup() {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const result = parseFramedMessage(buffer);
      if (result) {
        cleanup();
        resolve(result.payload);
      }
    }

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-mcp-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "test-repo", version: "0.0.0" }, null, 2) + "\n",
    );
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code MCP server rejects malformed Content-Length headers", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const child = spawn(process.execPath, [
      distEntry,
      "mcp",
      "--root",
      root,
      "--artifacts-dir",
      join(root, ".audit-artifacts"),
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      child.stdin.write(Buffer.from("Content-Length: 1.5\r\n\r\n{}", "utf8"));
      const payload = await readFramedPayload(child.stdout);

      assert.equal(payload.error.code, -32700);
      assert.match(payload.error.message, /bad Content-Length/i);
    } finally {
      child.kill();
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });
});

test("audit-code MCP server exposes tools, resources, prompts, and wrapper-backed workflow calls", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const client = createMcpClient(root);
    try {
      const initialize = await client.request("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      });
      assert.equal(initialize.protocolVersion, "2025-06-18");
      assert.equal(initialize.serverInfo.name, "audit-code");

      client.notify("notifications/initialized");

      const tools = await client.request("tools", "tools/list");
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        [
          "start_audit",
          "get_status",
          "continue_audit",
          "explain_task",
          "validate_artifacts",
          "import_results",
          "import_runtime_updates",
          "merge_and_ingest",
          "report_capability",
        ],
      );

      const resources = await client.request("resources", "resources/list");
      assert.deepEqual(
        resources.resources.map((resource) => resource.uri),
        [
          "audit-code://artifacts/current",
          "audit-code://handoff/current",
          "audit-code://install/guide",
          "audit-code://report/current",
        ],
      );

      const prompts = await client.request("prompts", "prompts/list");
      assert.deepEqual(
        prompts.prompts.map((prompt) => prompt.name),
        ["audit-code", "review-task", "synthesize-report"],
      );

      const initialStatus = await client.request("status", "tools/call", {
        name: "get_status",
        arguments: {},
      });
      assert.equal(
        initialStatus.structuredContent.audit_state.status,
        "not_started",
      );

      let started = await client.request("start", "tools/call", {
        name: "start_audit",
        arguments: {},
      });
      assert.equal(
        started.structuredContent.contract_version,
        "audit-code-step/v1alpha1",
      );
      // Pass the structure-phase pauses: the graph-enrichment install prompt
      // (skip the optional analyzers) and the design review (empty findings).
      const incomingDir = join(root, ".audit-artifacts", "incoming");
      for (
        let i = 0;
        i < 4 && started.structuredContent.step_kind !== "dispatch_review";
        i++
      ) {
        const kind = started.structuredContent.step_kind;
        await mkdir(incomingDir, { recursive: true });
        if (kind === "analyzer_install") {
          await writeFile(
            join(incomingDir, "analyzer-decisions.json"),
            JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
          );
        } else if (kind === "design_review") {
          await writeFile(
            join(incomingDir, "design-review-findings.json"),
            JSON.stringify([], null, 2) + "\n",
          );
        } else {
          break;
        }
        started = await client.request(`start-continue-${i}`, "tools/call", {
          name: "continue_audit",
          arguments: {},
        });
      }
      assert.equal(
        started.structuredContent.step_kind,
        "dispatch_review",
      );
      assert.match(started.structuredContent.prompt_content, /merge-and-ingest/);

      const continued = await client.request("continue", "tools/call", {
        name: "continue_audit",
        arguments: {},
      });
      assert.equal(continued.structuredContent.contract_version, "audit-code-step/v1alpha1");
      assert.equal(continued.structuredContent.step_kind, "dispatch_review");

      const reported = await client.request("capability", "tools/call", {
        name: "report_capability",
        arguments: { can_dispatch_subagents: true },
      });
      assert.equal(reported.structuredContent.contract_version, "audit-code-step/v1alpha1");
      assert.equal(reported.structuredContent.step_kind, "dispatch_review");
      assert.ok(Array.isArray(reported.structuredContent.dispatch_plan_entries));

      const handoff = await client.request("handoff", "resources/read", {
        uri: "audit-code://handoff/current",
      });
      assert.match(handoff.contents[0].text, /"status":"blocked"/);
    } finally {
      await client.close();
    }
  });
});

function spawnMcpChild(root) {
  const artifactsDir = join(root, ".audit-artifacts");
  return spawn(process.execPath, [
    distEntry,
    "mcp",
    "--root",
    root,
    "--artifacts-dir",
    artifactsDir,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Spawn an MCP child, complete the initialize handshake, then run `fn(child)`
// for the post-initialize interaction. Always kills the child and awaits exit.
// Tests that intentionally exercise pre-initialization error handling should
// use spawnMcpChild directly instead.
async function withInitializedChild(root, fn) {
  const child = spawnMcpChild(root);
  try {
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    );
    await readFramedPayload(child.stdout);
    return await fn(child);
  } finally {
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
  }
}

test("MCP server returns parse error for invalid JSON payload", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const child = spawnMcpChild(root);
    try {
      const body = Buffer.from("{not valid json}", "utf8");
      child.stdin.write(
        Buffer.concat([
          Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
          body,
        ]),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.error.code, -32700);
    } finally {
      child.kill();
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });
});

test("MCP server returns error for request with missing method", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const child = spawnMcpChild(root);
    try {
      child.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id: "no-method" }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "no-method");
    } finally {
      child.kill();
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });
});

test("MCP server returns -32601 for unknown JSON-RPC methods", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    await withInitializedChild(root, async (child) => {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: "unknown-method",
          method: "totally/unknown",
        }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "unknown-method");
      assert.equal(payload.error.code, -32601);
    });
  });
});

test("MCP server validates tools/call requires a tool name", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    await withInitializedChild(root, async (child) => {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: "tools-no-name",
          method: "tools/call",
          params: {},
        }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "tools-no-name");
    });
  });
});

test("MCP server validates resources/read requires a uri", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    await withInitializedChild(root, async (child) => {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: "resource-no-uri",
          method: "resources/read",
          params: {},
        }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "resource-no-uri");
    });
  });
});

test("MCP server validates prompts/get requires a prompt name", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    await withInitializedChild(root, async (child) => {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: "prompt-no-name",
          method: "prompts/get",
          params: {},
        }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "prompt-no-name");
    });
  });
});

// --- MAINT-004: Resource and prompt registry tests ---

test("resources/list returns URIs derived from the resource registry", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const client = createMcpClient(root);
    try {
      await client.request("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");

      const resources = await client.request("res", "resources/list");
      const uris = resources.resources.map((r) => r.uri);
      assert.deepEqual(uris, [
        "audit-code://artifacts/current",
        "audit-code://handoff/current",
        "audit-code://install/guide",
        "audit-code://report/current",
      ]);
      // Each resource has description and mimeType from the registry
      for (const r of resources.resources) {
        assert.ok(typeof r.description === "string" && r.description.length > 0,
          `Resource ${r.uri} must have a non-empty description`);
        assert.ok(typeof r.mimeType === "string" && r.mimeType.length > 0,
          `Resource ${r.uri} must have a non-empty mimeType`);
      }
    } finally {
      await client.close();
    }
  });
});

test("resources/read succeeds for each registered resource URI", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const client = createMcpClient(root);
    try {
      await client.request("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");

      // Start audit to create artifacts so resources can be read
      await client.request("start", "tools/call", {
        name: "start_audit",
        arguments: {},
      });

      const registeredUris = [
        "audit-code://artifacts/current",
        "audit-code://handoff/current",
        "audit-code://install/guide",
        "audit-code://report/current",
      ];
      for (const uri of registeredUris) {
        const result = await client.request(`read-${uri}`, "resources/read", { uri });
        assert.ok(result.contents, `resources/read should return contents for ${uri}`);
        assert.equal(result.contents[0].uri, uri);
        assert.ok(typeof result.contents[0].text === "string");
      }
    } finally {
      await client.close();
    }
  });
});

test("prompts/list returns prompt metadata derived from the prompt registry", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const client = createMcpClient(root);
    try {
      await client.request("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");

      const prompts = await client.request("prompts", "prompts/list");
      const names = prompts.prompts.map((p) => p.name);
      assert.deepEqual(names, ["audit-code", "review-task", "synthesize-report"]);
      // Each prompt has a description
      for (const p of prompts.prompts) {
        assert.ok(typeof p.description === "string" && p.description.length > 0,
          `Prompt ${p.name} must have a non-empty description`);
      }
      // review-task has a required task_id argument
      const reviewTask = prompts.prompts.find((p) => p.name === "review-task");
      assert.ok(reviewTask.arguments.length > 0, "review-task must declare arguments");
      assert.equal(reviewTask.arguments[0].name, "task_id");
      assert.equal(reviewTask.arguments[0].required, true);
    } finally {
      await client.close();
    }
  });
});

test("prompts/get returns rendered messages for each registered prompt", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    const client = createMcpClient(root);
    try {
      await client.request("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");

      // audit-code prompt
      const auditCode = await client.request("p1", "prompts/get", {
        name: "audit-code",
        arguments: {},
      });
      assert.ok(auditCode.messages[0].content.text.includes("audit-code next-step"));
      assert.ok(auditCode.messages[0].content.text.includes("start_audit"));

      // review-task prompt
      const reviewTask = await client.request("p2", "prompts/get", {
        name: "review-task",
        arguments: { task_id: "TASK-42" },
      });
      assert.ok(reviewTask.messages[0].content.text.includes("TASK-42"));

      // synthesize-report prompt
      const synth = await client.request("p3", "prompts/get", {
        name: "synthesize-report",
        arguments: {},
      });
      assert.ok(synth.messages[0].content.text.includes("audit-code://report/current"));
    } finally {
      await client.close();
    }
  });
});

test("prompts/get returns error for unknown prompt name", { timeout: 30000 }, async () => {
  await withTempRepo(async (root) => {
    await withInitializedChild(root, async (child) => {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: "unknown-prompt",
          method: "prompts/get",
          params: { name: "nonexistent-prompt" },
        }),
      );
      const payload = await readFramedPayload(child.stdout);
      assert.ok(payload.error);
      assert.equal(payload.id, "unknown-prompt");
    });
  });
});

// --- MAINT-005: Frame parser and dispatch helper tests ---

test("extractFrames buffers partial frames until complete", async () => {
  const { extractFrames } = await import("../src/mcp/server.ts");
  const errors = [];
  const emit = (resp) => errors.push(resp);

  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const body = Buffer.from(payload, "utf8");
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);

  // Split the frame into two partial chunks
  const half = Math.floor(frame.length / 2);
  const part1 = frame.slice(0, half);
  const part2 = frame.slice(half);

  // First chunk: no complete frame yet
  const result1 = extractFrames(part1, emit);
  assert.equal(result1.bodies.length, 0);
  assert.equal(errors.length, 0);

  // Combine both chunks: now the frame is complete
  const combined = Buffer.concat([result1.remaining, part2]);
  const result2 = extractFrames(combined, emit);
  assert.equal(result2.bodies.length, 1);
  assert.deepEqual(JSON.parse(result2.bodies[0]), { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(errors.length, 0);
});

test("extractFrames processes multiple frames in one buffer", async () => {
  const { extractFrames } = await import("../src/mcp/server.ts");
  const errors = [];
  const emit = (resp) => errors.push(resp);

  function makeFrame(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
      body,
    ]);
  }

  const msg1 = { jsonrpc: "2.0", id: 1, method: "ping" };
  const msg2 = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const combined = Buffer.concat([makeFrame(msg1), makeFrame(msg2)]);

  const result = extractFrames(combined, emit);
  assert.equal(result.bodies.length, 2);
  assert.deepEqual(JSON.parse(result.bodies[0]), msg1);
  assert.deepEqual(JSON.parse(result.bodies[1]), msg2);
  assert.equal(result.remaining.length, 0);
  assert.equal(errors.length, 0);
});

test("extractFrames emits framing error and resets buffer on bad Content-Length", async () => {
  const { extractFrames } = await import("../src/mcp/server.ts");
  const errors = [];
  const emit = (resp) => errors.push(resp);

  const badFrame = Buffer.from("Content-Length: -5\r\n\r\n{}", "utf8");
  const result = extractFrames(badFrame, emit);
  assert.equal(result.bodies.length, 0);
  assert.equal(result.remaining.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, -32700);
});

test("dispatchRequest returns correct responses for standard methods", async () => {
  const { dispatchRequest } = await import("../src/mcp/server.ts");

  const ctx = {
    version: "0.0.0-test",
    defaults: { root: ".", artifactsDir: ".audit-artifacts" },
    shutdownRequested: false,
  };

  // initialize
  const initResult = await dispatchRequest(
    { jsonrpc: "2.0", id: "i1", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    ctx,
  );
  assert.equal(initResult.responses.length, 1);
  assert.equal(initResult.responses[0].result.serverInfo.name, "audit-code");

  // tools/list
  const toolsResult = await dispatchRequest(
    { jsonrpc: "2.0", id: "t1", method: "tools/list" },
    ctx,
  );
  assert.equal(toolsResult.responses.length, 1);
  assert.ok(Array.isArray(toolsResult.responses[0].result.tools));

  // resources/list
  const resResult = await dispatchRequest(
    { jsonrpc: "2.0", id: "r1", method: "resources/list" },
    ctx,
  );
  assert.equal(resResult.responses.length, 1);
  assert.ok(Array.isArray(resResult.responses[0].result.resources));

  // prompts/list
  const promptResult = await dispatchRequest(
    { jsonrpc: "2.0", id: "p1", method: "prompts/list" },
    ctx,
  );
  assert.equal(promptResult.responses.length, 1);
  assert.ok(Array.isArray(promptResult.responses[0].result.prompts));

  // shutdown
  const shutdownResult = await dispatchRequest(
    { jsonrpc: "2.0", id: "s1", method: "shutdown" },
    ctx,
  );
  assert.equal(shutdownResult.shutdownRequested, true);
  assert.equal(shutdownResult.responses[0].result !== undefined, true);
});

test("dispatchRequest returns -32601 for unknown methods", async () => {
  const { dispatchRequest } = await import("../src/mcp/server.ts");
  const ctx = {
    version: "0.0.0-test",
    defaults: { root: ".", artifactsDir: ".audit-artifacts" },
    shutdownRequested: false,
  };

  const result = await dispatchRequest(
    { jsonrpc: "2.0", id: "u1", method: "totally/unknown" },
    ctx,
  );
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].error.code, -32601);
  assert.equal(result.responses[0].id, "u1");
});

test("dispatchRequest formats exceptions through error response", async () => {
  const { dispatchRequest } = await import("../src/mcp/server.ts");
  const ctx = {
    version: "0.0.0-test",
    defaults: { root: ".", artifactsDir: ".audit-artifacts" },
    shutdownRequested: false,
  };

  // tools/call without name triggers an exception
  const result = await dispatchRequest(
    { jsonrpc: "2.0", id: "err1", method: "tools/call", params: {} },
    ctx,
  );
  assert.equal(result.responses.length, 1);
  assert.ok(result.responses[0].error);
  assert.equal(result.responses[0].error.code, -32000);
  assert.equal(result.responses[0].id, "err1");
});

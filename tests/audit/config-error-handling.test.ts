import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

interface RunNodeResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runNode(
  entryPath: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<RunNodeResult> {
  return new Promise<RunNodeResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: options.cwd ?? repoRoot,
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
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function withTempRepo<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-config-errors-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "src", "lib", "session.ts"),
      [
        "export interface Session {",
        "  id: string;",
        "}",
        "",
      ].join("\n"),
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code next-step emits a blocked step for malformed canonical session intent", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "session-config.json"), "{not-json\n");

    const result = await runNode(wrapperPath, ["next-step"], { cwd: root });
    const combined = `${result.stderr}\n${result.stdout}`;

    // A controlled blocker is a successfully emitted step contract, not an
    // abnormal command failure. Fatal throws still exit nonzero through the
    // shared blocked-step backstop.
    expect(result.code).toBe(0);
    expect(combined).toMatch(/session-config\.json/i);
    expect(combined).toMatch(/json|parse|invalid/i);
    const handoff = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    expect(handoff.status).toBe("blocked");
    expect(handoff.summary).toMatch(/session-config\.json/i);
  });
});

test("audit-code next-step emits a blocked step for invalid session-intent fields", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ review_mode: "sometimes" }, null, 2),
    );

    const result = await runNode(wrapperPath, ["next-step"], { cwd: root });
    const combined = `${result.stderr}\n${result.stdout}`;

    expect(result.code).toBe(0);
    expect(combined).toMatch(/session-config\.json/i);
    expect(combined).toMatch(/review_mode/i);
    expect(combined).toMatch(/attended|autonomous/i);
    const handoff = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    expect(handoff.status).toBe("blocked");
    expect(handoff.summary).toMatch(/review_mode/i);
  });
});

test("validate fails loudly on corrupted artifact json", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "repo_manifest.json"), "{not-json\n");

    const result = await runNode(
      wrapperPath,
      ["validate", "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const combined = `${result.stderr}\n${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(combined).toMatch(/repo_manifest\.json/i);
    expect(combined).toMatch(/json|parse|invalid/i);
  });
});

test("loadSessionIntent fails closed on an invalid config field (no permissive default)", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // A transport-owned field is outside the strict canonical intent contract.
    // Fail-closed means loadSessionIntent rejects rather than dropping it.
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        { command: "external-runner" },
        null,
        2,
      ),
    );

    const { loadSessionIntent } = await import("../../src/shared/sessionConfig.js");
    await expect(loadSessionIntent(root)).rejects.toThrow(
      /session-config\.json/i,
    );
  });
});

test("loadSessionIntent returns canonical defaults without creating a config file", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    const { loadSessionIntent } = await import("../../src/shared/sessionConfig.js");
    const loaded = await loadSessionIntent(root);
    expect(loaded).toEqual({
      status: "not_configured",
      intent: { review_mode: "attended", observability: "standard" },
    });
    await expect(
      readFile(join(artifactsDir, "session-config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

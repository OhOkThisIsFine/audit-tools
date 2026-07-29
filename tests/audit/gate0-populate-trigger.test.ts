/**
 * The Gate-0 proxy-catalog POPULATE trigger must key on the SAME seam Gate-0 does.
 *
 * Gate-0's obligation is `!has(bundle.provider_confirmation)` — the PER-TOOL artifact
 * `<artifacts-dir>/provider_confirmation.json`. The populate trigger used to key on the
 * SHARED, repo-level `.audit-tools/provider-confirmation.json` instead. Those are
 * different lifetimes: the shared artifact survives across runs and across tools
 * (remediate writes it too), so a fresh audit run in a repo that had ever confirmed
 * before found the shared file present, skipped the populate, and then rendered the
 * Gate-0 roster from an unrefreshed catalog cache — the operator confirmed a provider
 * table that omitted the proxied lane, in the very invocation that was building it.
 */

import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";

const { sharedProviderConfirmationPath, SHARED_PROVIDER_CONFIRMATION_VERSION } =
  await import("../../src/shared/providers/sharedProviderConfirmation.js");

/** A minimal, parseable prior-run shared confirmation. */
const PRIOR_RUN_SHARED_CONFIRMATION = {
  schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
  session_level: true,
  confirmed_at: new Date().toISOString(),
  provider_pool: [],
};

/**
 * A loopback port with nothing listening: the populate fetch fails fast
 * (ECONNREFUSED) instead of reaching the network, so the ATTEMPT is what the test
 * observes — the tool's own "populate did not refresh the cache" warning.
 */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePort(address.port);
    });
  });
  await new Promise<void>((done) => {
    server.close(() => done());
  });
  return port;
}

test(
  "a stale prior-run SHARED confirmation does not suppress the populate while Gate-0 is still pending",
  { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
  async () => {
    const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
    const tempDir = await mkdtemp(join(tmpdir(), "gate0-populate-trigger-"));
    const root = join(tempDir, "repo");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const stateDir = join(tempDir, "state");
    const priorStateDir = process.env.AUDIT_CODE_STATE_DIR;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    const realConsoleLog = console.log;
    const stderrChunks: string[] = [];

    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "gate0-populate-fixture", version: "0.0.0" }, null, 2) + "\n",
      );
      await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n");

      // The PRIOR RUN's shared confirmation — repo-level, cross-tool, outlives the
      // audit artifact dir. THIS run's per-tool Gate-0 artifact is deliberately
      // absent, so the Gate-0 obligation is still `missing`.
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(
        sharedProviderConfirmationPath(root),
        JSON.stringify(PRIOR_RUN_SHARED_CONFIRMATION, null, 2) + "\n",
      );

      // A declared (but dead) proxy lane, so the populate has something to do.
      const port = await reserveClosedPort();
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "sources-declared.json"),
        JSON.stringify({ proxy: { endpoint: `http://127.0.0.1:${port}` } }, null, 2) + "\n",
      );
      process.env.AUDIT_CODE_STATE_DIR = stateDir;

      process.stderr.write = (...args: [chunk: string | Uint8Array, ...rest: unknown[]]): boolean => {
        const chunk = args[0];
        stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
        return Reflect.apply(realStderrWrite, process.stderr, args);
      };
      // The emitted step JSON is irrelevant here and drowns the test output.
      console.log = () => {};

      await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    } finally {
      process.stderr.write = realStderrWrite;
      console.log = realConsoleLog;
      if (priorStateDir === undefined) {
        delete process.env.AUDIT_CODE_STATE_DIR;
      } else {
        process.env.AUDIT_CODE_STATE_DIR = priorStateDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(
      stderrChunks.join(""),
      "Gate-0 is pending (no per-tool provider_confirmation.json), so this invocation IS the " +
        "confirmation build and must attempt the proxy-catalog populate — a prior run's shared " +
        "confirmation must not suppress it",
    ).toMatch(/proxy catalog populate did not refresh the cache/);
  },
);

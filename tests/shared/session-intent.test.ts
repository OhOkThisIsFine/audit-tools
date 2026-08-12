/**
 * Failing-first contract for the one provider-neutral repository session intent.
 *
 * This suite exercises the shared canonical loader directly plus remediation's
 * consumer seam. Both must have identical read-only, fail-closed behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const ioTrace = vi.hoisted(() => ({
  activeRoot: null as string | null,
  deniedPath: null as string | null,
  reads: [] as Array<{ operation: string; path: string }>,
  writes: [] as Array<{ operation: string; path: string }>,
  actions: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const normalized = (value: unknown): string =>
    String(value).replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase();
  const trackedPath = (value: unknown): string | undefined => {
    if (typeof value !== "string" && !(value instanceof URL)) return undefined;
    const path = normalized(value);
    const root = ioTrace.activeRoot;
    if (root === null || (path !== root && !path.startsWith(root + "/"))) {
      return undefined;
    }
    return path;
  };
  const read = async (
    operation: string,
    implementation: (...args: never[]) => unknown,
    args: unknown[],
  ): Promise<unknown> => {
    const path = trackedPath(args[0]);
    if (path !== undefined) {
      ioTrace.reads.push({ operation, path });
      if (path === ioTrace.deniedPath) {
        throw Object.assign(
          new Error(`EACCES: permission denied, open '${String(args[0])}'`),
          { code: "EACCES", path: String(args[0]), syscall: "open" },
        );
      }
    }
    return await Reflect.apply(implementation, actual, args);
  };
  const write = async (
    operation: string,
    implementation: (...args: never[]) => unknown,
    args: unknown[],
  ): Promise<unknown> => {
    const path = trackedPath(args[0]);
    if (path !== undefined) ioTrace.writes.push({ operation, path });
    return await Reflect.apply(implementation, actual, args);
  };

  return {
    ...actual,
    access: (...args: unknown[]) => read("access", actual.access, args),
    appendFile: (...args: unknown[]) => write("appendFile", actual.appendFile, args),
    chmod: (...args: unknown[]) => write("chmod", actual.chmod, args),
    copyFile: (...args: unknown[]) => write("copyFile", actual.copyFile, args),
    cp: (...args: unknown[]) => write("cp", actual.cp, args),
    lstat: (...args: unknown[]) => read("lstat", actual.lstat, args),
    mkdir: (...args: unknown[]) => write("mkdir", actual.mkdir, args),
    open: (...args: unknown[]) => read("open", actual.open, args),
    readFile: (...args: unknown[]) => read("readFile", actual.readFile, args),
    readdir: (...args: unknown[]) => read("readdir", actual.readdir, args),
    readlink: (...args: unknown[]) => read("readlink", actual.readlink, args),
    realpath: (...args: unknown[]) => read("realpath", actual.realpath, args),
    rename: (...args: unknown[]) => write("rename", actual.rename, args),
    rm: (...args: unknown[]) => write("rm", actual.rm, args),
    stat: (...args: unknown[]) => read("stat", actual.stat, args),
    symlink: (...args: unknown[]) => write("symlink", actual.symlink, args),
    truncate: (...args: unknown[]) => write("truncate", actual.truncate, args),
    unlink: (...args: unknown[]) => write("unlink", actual.unlink, args),
    writeFile: (...args: unknown[]) => write("writeFile", actual.writeFile, args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const guarded = (name: string, implementation: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      if (ioTrace.activeRoot !== null) {
        ioTrace.actions.push("process:" + name);
        throw new Error("forbidden process action: " + name);
      }
      return Reflect.apply(implementation, actual, args);
    };
  return {
    ...actual,
    exec: guarded("exec", actual.exec),
    execFile: guarded("execFile", actual.execFile),
    execFileSync: guarded("execFileSync", actual.execFileSync),
    execSync: guarded("execSync", actual.execSync),
    fork: guarded("fork", actual.fork),
    spawn: guarded("spawn", actual.spawn),
    spawnSync: guarded("spawnSync", actual.spawnSync),
  };
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

const { loadSessionIntent } = await import("../../src/shared/sessionConfig.js");
const { loadRemediateSessionConfig } = await import(
  "../../src/remediate/steps/sessionConfigLoad.js"
);

const FAILURE_SIGNATURE =
  "contract:canonical-session-intent:not-yet-satisfied";
const CANONICAL_RELATIVE_PATH = ".audit-tools/audit/session-config.json";
const CANONICAL_TRACE_PATH = "<root>/" + CANONICAL_RELATIVE_PATH;
const DEFAULT_RESULT = {
  status: "not_configured",
  intent: { review_mode: "attended", observability: "standard" },
} as const;
const LEGACY_PATHS = [
  ["session-config.json"],
  [".remediation-artifacts", "session-config.json"],
  [".audit-tools", "remediation", "session-config.json"],
] as const;

interface Observation {
  readonly root: string;
  readonly result: unknown;
  readonly error: unknown;
  readonly reads: readonly { readonly operation: string; readonly path: string }[];
  readonly writes: readonly { readonly operation: string; readonly path: string }[];
  readonly actions: readonly string[];
}

interface Consumer {
  readonly name: "audit" | "remediation";
  readonly load: (root: string) => Promise<unknown>;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase();
}

const CONSUMERS: readonly Consumer[] = [
  {
    name: "audit",
    load: (root) => loadSessionIntent(root),
  },
  {
    name: "remediation",
    load: (root) => loadRemediateSessionConfig({ root }),
  },
];

const cleanupRoots: string[] = [];

async function temporaryRoot(prefix = "session-intent-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

async function writeAt(
  root: string,
  segments: readonly string[],
  contents: string,
): Promise<void> {
  const path = join(root, ...segments);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function writeCanonical(root: string, contents: string): Promise<void> {
  await writeAt(root, CANONICAL_RELATIVE_PATH.split("/"), contents);
}

async function observe(
  root: string,
  load: () => Promise<unknown>,
  deniedPath?: string,
): Promise<Observation> {
  ioTrace.activeRoot = normalizedPath(root);
  ioTrace.deniedPath = deniedPath ? normalizedPath(deniedPath) : null;
  ioTrace.reads.length = 0;
  ioTrace.writes.length = 0;
  ioTrace.actions.length = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    ioTrace.actions.push("network:fetch");
    throw new Error("forbidden network action: fetch");
  }) as typeof fetch;

  let result: unknown;
  let error: unknown;
  try {
    result = await load();
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = originalFetch;
    ioTrace.activeRoot = null;
    ioTrace.deniedPath = null;
  }

  return {
    root,
    result,
    error,
    reads: structuredClone(ioTrace.reads),
    writes: structuredClone(ioTrace.writes),
    actions: [...ioTrace.actions],
  };
}

function tracePath(path: string, root: string): string {
  const normalized = normalizedPath(path);
  const normalizedRoot = normalizedPath(root);
  if (normalized === normalizedRoot) return "<root>";
  if (normalized.startsWith(normalizedRoot + "/")) {
    return "<root>/" + normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function normalizedError(error: unknown, root: string): string | null {
  if (error === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replaceAll("\\", "/");
  const rootToken = root.replaceAll("\\", "/");
  return normalized.split(rootToken).join("<root>");
}

function summarize(observation: Observation) {
  const error = normalizedError(observation.error, observation.root);
  return {
    result: observation.result,
    error: error === null ? null : "present",
    error_path_qualified:
      error === null ? false : error.includes(CANONICAL_TRACE_PATH),
    reads: observation.reads.map(
      (entry) => entry.operation + ":" + tracePath(entry.path, observation.root),
    ),
    writes: observation.writes.map(
      (entry) => entry.operation + ":" + tracePath(entry.path, observation.root),
    ),
    actions: observation.actions,
  };
}

afterEach(async () => {
  process.chdir(PROJECT_CWD);
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const PROJECT_CWD = process.cwd();

describe(FAILURE_SIGNATURE, () => {
  it.each(CONSUMERS)(
    "$name: missing canonical intent is non-fatal, defaulted, single-read, and read-only",
    async (consumer) => {
      const root = await temporaryRoot();
      const observation = await observe(root, () => consumer.load(root));

      expect(summarize(observation), FAILURE_SIGNATURE).toEqual({
        result: DEFAULT_RESULT,
        error: null,
        error_path_qualified: false,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      });
    },
  );

  it.each([
    {
      label: "empty object expands both defaults",
      input: {},
      expected: {
        status: "configured",
        intent: { review_mode: "attended", observability: "standard" },
      },
    },
    {
      label: "review intent remains inert and observability defaults",
      input: { review_mode: "autonomous" },
      expected: {
        status: "configured",
        intent: { review_mode: "autonomous", observability: "standard" },
      },
    },
    {
      label: "both explicit enum values survive exactly",
      input: { review_mode: "attended", observability: "verbose" },
      expected: {
        status: "configured",
        intent: { review_mode: "attended", observability: "verbose" },
      },
    },
  ])("configured: $label", async ({ input, expected }) => {
    const summaries = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      await writeCanonical(root, JSON.stringify(input));
      const observation = await observe(root, () => consumer.load(root));
      summaries.push({ consumer: consumer.name, ...summarize(observation) });
    }

    expect(summaries, FAILURE_SIGNATURE).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        result: expected,
        error: null,
        error_path_qualified: false,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );
  });

  it.each([
    { label: "malformed JSON", contents: "{not-json" },
    { label: "non-object JSON", contents: "[]" },
    { label: "unknown key", contents: JSON.stringify({ unexpected: true }) },
    {
      label: "invalid review_mode",
      contents: JSON.stringify({ review_mode: "headless" }),
    },
    {
      label: "invalid observability",
      contents: JSON.stringify({ observability: "debug" }),
    },
    {
      label: "execution authority key",
      contents: JSON.stringify({ execute_implementation: true }),
    },
  ])("invalid canonical: $label fails closed", async ({ contents }) => {
    const observations = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      await writeCanonical(root, contents);
      observations.push({
        consumer: consumer.name,
        observation: await observe(root, () => consumer.load(root)),
      });
    }

    expect(
      observations.map(({ consumer, observation }) => ({
        consumer,
        ...summarize(observation),
      })),
      FAILURE_SIGNATURE,
    ).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        result: undefined,
        error: "present",
        error_path_qualified: true,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );

    const messages = observations.map(({ observation }) =>
      normalizedError(observation.error, observation.root),
    );
    expect(messages[0], FAILURE_SIGNATURE).toBe(messages[1]);
  });

  it("an unreadable canonical file is path-qualified and never falls back", async () => {
    const summaries = [];
    const messages = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      const canonicalPath = join(root, ...CANONICAL_RELATIVE_PATH.split("/"));
      await writeCanonical(root, "{}");
      const observation = await observe(
        root,
        () => consumer.load(root),
        canonicalPath,
      );
      summaries.push({ consumer: consumer.name, ...summarize(observation) });
      messages.push(normalizedError(observation.error, root));
    }

    expect(summaries, FAILURE_SIGNATURE).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        result: undefined,
        error: "present",
        error_path_qualified: true,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );
    expect(messages[0], FAILURE_SIGNATURE).toBe(messages[1]);
  });

  it.each([
    { label: "root legacy only", paths: [LEGACY_PATHS[0]] },
    { label: "remediation artifact legacy only", paths: [LEGACY_PATHS[1]] },
    { label: "advertised remediation legacy only", paths: [LEGACY_PATHS[2]] },
    { label: "all legacy paths together", paths: LEGACY_PATHS },
  ])("legacy-only: $label is ignored", async ({ paths }) => {
    const summaries = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      for (const path of paths) {
        await writeAt(
          root,
          path,
          JSON.stringify({ review_mode: "autonomous", observability: "verbose" }),
        );
      }
      const observation = await observe(root, () => consumer.load(root));
      summaries.push({ consumer: consumer.name, ...summarize(observation) });
    }

    expect(summaries, FAILURE_SIGNATURE).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        result: DEFAULT_RESULT,
        error: null,
        error_path_qualified: false,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );
  });

  it("canonical intent wins over every populated legacy path", async () => {
    const summaries = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      await writeCanonical(root, JSON.stringify({ observability: "verbose" }));
      for (const path of LEGACY_PATHS) {
        await writeAt(root, path, JSON.stringify({ review_mode: "autonomous" }));
      }
      const observation = await observe(root, () => consumer.load(root));
      summaries.push({ consumer: consumer.name, ...summarize(observation) });
    }

    expect(summaries, FAILURE_SIGNATURE).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        result: {
          status: "configured",
          intent: { review_mode: "attended", observability: "verbose" },
        },
        error: null,
        error_path_qualified: false,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );
  });

  it("uses the supplied absolute root rather than current working directory", async () => {
    const summaries = [];
    for (const consumer of CONSUMERS) {
      const root = await temporaryRoot();
      const stray = await temporaryRoot("session-intent-stray-");
      const strayDeep = join(stray, "nested", "cwd");
      await mkdir(strayDeep, { recursive: true });
      await writeCanonical(root, JSON.stringify({ observability: "verbose" }));
      await writeCanonical(stray, JSON.stringify({ review_mode: "autonomous" }));

      process.chdir(strayDeep);
      try {
        const before = process.cwd();
        const observation = await observe(root, () => consumer.load(root));
        summaries.push({
          consumer: consumer.name,
          cwd_unchanged: process.cwd() === before,
          ...summarize(observation),
        });
      } finally {
        process.chdir(PROJECT_CWD);
      }
    }

    expect(summaries, FAILURE_SIGNATURE).toEqual(
      CONSUMERS.map((consumer) => ({
        consumer: consumer.name,
        cwd_unchanged: true,
        result: {
          status: "configured",
          intent: { review_mode: "attended", observability: "verbose" },
        },
        error: null,
        error_path_qualified: false,
        reads: ["readFile:" + CANONICAL_TRACE_PATH],
        writes: [],
        actions: [],
      })),
    );
  });

  it.each(CONSUMERS)(
    "$name: rejects a relative repository root before filesystem access",
    async (consumer) => {
      const sandbox = await temporaryRoot("session-intent-relative-");
      process.chdir(sandbox);
      const relativeRoot = "relative-repository-root";
      expect(isAbsolute(relativeRoot)).toBe(false);

      const observation = await observe(relativeRoot, () =>
        consumer.load(relativeRoot),
      );
      expect(
        {
          result: observation.result,
          error: observation.error === undefined ? null : "present",
          reads: observation.reads,
          writes: observation.writes,
          actions: observation.actions,
        },
        FAILURE_SIGNATURE,
      ).toEqual({
        result: undefined,
        error: "present",
        reads: [],
        writes: [],
        actions: [],
      });
    },
  );
});

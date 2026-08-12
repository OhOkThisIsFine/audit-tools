import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";

import {
  artifactNameForId,
  auditArtifactsDir,
  isCanonicalResultFilename,
  quotePromptCommandArg,
  renderPromptCommand,
  resolveRepoRoot,
  toPromptPathToken,
} from "audit-tools/shared";

export const DIRECT_CLI_DEFAULTS = {
  rootDir: ".",
  artifactsDir: ".audit-tools/audit",
  timeoutMs: 30 * 60 * 1000,
};

function isLongFlagToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("--");
}

export function getFlag(
  argv: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const candidate = argv[index + 1];
  if (!candidate || isLongFlagToken(candidate)) return fallback;
  return candidate;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function optionalBooleanEnv(
  value: string | undefined,
): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export { digestId, safeArtifactStem } from "audit-tools/shared";
export { artifactNameForId, isCanonicalResultFilename };

export const quoteCommandArg = quotePromptCommandArg;
export const toPosixCommandToken = toPromptPathToken;

export function renderCommand(argv: string[]): string {
  return renderPromptCommand(argv);
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function parsePositiveIntegerFlag(
  argv: string[],
  name: string,
): number | undefined {
  const raw = getFlag(argv, name);
  return raw === undefined ? undefined : normalizePositiveInteger(Number(raw));
}

export function getRootDir(argv: string[]): string {
  return resolveRepoRoot(
    getFlag(argv, "--root", DIRECT_CLI_DEFAULTS.rootDir) as string,
  );
}

export function getArtifactsDir(argv: string[]): string {
  const explicit = getFlag(argv, "--artifacts-dir");
  return explicit === undefined
    ? auditArtifactsDir(getRootDir(argv))
    : resolve(explicit);
}

export function warnIfNotGitRepo(root: string): void {
  if (!existsSync(join(root, ".git"))) {
    console.warn(
      `Warning: target directory '${root}' does not appear to be a git repository. Diff-based signals will be unavailable.`,
    );
  }
}

export function getBatchResultsDir(argv: string[]): string | undefined {
  const value = getFlag(argv, "--batch-results");
  return value ? resolve(value) : undefined;
}

export function getTimeoutMs(argv: string[]): number {
  return (
    parsePositiveIntegerFlag(argv, "--timeout") ??
    DIRECT_CLI_DEFAULTS.timeoutMs
  );
}

export function looksLikeCliFlag(value: string | undefined): boolean {
  return isLongFlagToken(value);
}

export async function countLines(path: string): Promise<number> {
  return await new Promise((resolveCount, reject) => {
    let lines = 0;
    let byteCount = 0;
    let lastByte = -1;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteCount += buffer.length;
      for (const byte of buffer) {
        if (byte === 10) lines += 1;
        lastByte = byte;
      }
    });
    stream.on("end", () => {
      resolveCount(byteCount === 0 ? 0 : lastByte === 10 ? lines : lines + 1);
    });
    stream.on("error", reject);
  });
}

export async function listBatchResultFiles(batchDir: string): Promise<string[]> {
  const entries = await readdir(batchDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".json") &&
        isCanonicalResultFilename(entry.name),
    )
    .map((entry) => join(batchDir, entry.name))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No canonical audit result files (<stem>_<digest>.json) found in ${batchDir}.`,
    );
  }
  return files;
}

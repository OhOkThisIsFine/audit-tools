import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ioError(
  action: "read" | "write" | "append" | "prepare parent directory",
  path: string,
  error: unknown,
): Error {
  return new Error(`Failed to ${action} ${path}: ${errorMessage(error)}`);
}

async function ensureParentDirectory(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw ioError("prepare parent directory", path, error);
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await ensureParentDirectory(path);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  } catch (error) {
    throw ioError("write", path, error);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function readJsonFile<T>(path: string): Promise<T> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      throw error;
    }
    throw ioError("read", path, error);
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${errorMessage(error)}`);
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export async function appendNdjsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await ensureParentDirectory(path);
  try {
    await appendFile(path, JSON.stringify(value) + "\n", "utf8");
  } catch (error) {
    throw ioError("append", path, error);
  }
}

export async function readNdjsonFile<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf8");
    const values: T[] = [];
    let sawContent = false;

    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      sawContent = true;
      try {
        values.push(JSON.parse(line) as T);
      } catch (error) {
        throw new Error(
          `Invalid NDJSON in ${path} at line ${index + 1}: ${errorMessage(error)}`,
        );
      }
    }

    if (!sawContent && content.length > 0) {
      throw new Error(
        `NDJSON file ${path} contains only whitespace — possible truncated write`,
      );
    }
    return values;
  } catch (error) {
    if (isFileMissingError(error)) {
      throw error;
    }
    if (error instanceof Error && error.message.includes(path)) {
      throw error;
    }
    throw ioError("read", path, error);
  }
}

export async function readOptionalJsonFile<T>(
  path: string,
): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readOptionalNdjsonFile<T>(
  path: string,
): Promise<T[] | undefined> {
  try {
    return await readNdjsonFile<T>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeNdjsonFile(
  path: string,
  values: unknown[],
): Promise<void> {
  const content =
    values.length === 0
      ? ""
      : values.map((v) => JSON.stringify(v)).join("\n") + "\n";
  await writeFileAtomic(path, content);
}

export async function readOptionalTextFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw ioError("read", path, error);
  }
}

export async function writeTextFile(
  path: string,
  value: string,
): Promise<void> {
  await writeFileAtomic(path, value);
}

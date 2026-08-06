/**
 * Captures stderr output during a synchronous or async function execution.
 * Extracted from: MNT-9efc91e1, MNT-5c23c519-2, MNT-e7feb447-3
 * (Duplicated stderr capture pattern across test files)
 */

export function withCapturedStderr<T>(
  fn: () => T,
): {
  result: T;
  stderrChunks: string[];
} {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];

  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    const result = fn();
    return { result, stderrChunks: chunks };
  } finally {
    process.stderr.write = original;
  }
}

export async function withCapturedStderrAsync<T>(
  fn: () => Promise<T>,
): Promise<{
  result: T;
  stderrChunks: string[];
}> {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];

  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    const result = await fn();
    return { result, stderrChunks: chunks };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * Save and restore an environment variable for test isolation.
 * Extracted from: MNT-e7feb447-3
 * (Duplicated environment variable save/restore pattern)
 */
export function withEnvVar(
  varName: string,
  value: string | undefined,
  fn: () => void,
): void {
  const original = process.env[varName];
  if (value === undefined) {
    delete process.env[varName];
  } else {
    process.env[varName] = value;
  }

  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[varName];
    } else {
      process.env[varName] = original;
    }
  }
}

export async function withEnvVarAsync(
  varName: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = process.env[varName];
  if (value === undefined) {
    delete process.env[varName];
  } else {
    process.env[varName] = value;
  }

  try {
    await fn();
  } finally {
    if (original === undefined) {
      delete process.env[varName];
    } else {
      process.env[varName] = original;
    }
  }
}

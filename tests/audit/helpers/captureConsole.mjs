/**
 * Runs `fn`, captures everything written to console.log / console.error, and
 * returns `{ code, stdout, stderr }` after the callback resolves.  console and
 * process.exitCode are always restored, even when `fn` throws.
 *
 * @param {() => Promise<void> | void} fn
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function captureConsole(fn) {
  const previousExitCode = process.exitCode;
  const previousConsoleLog = console.log;
  const previousConsoleError = console.error;
  let stdout = "";
  let stderr = "";
  process.exitCode = 0;
  console.log = (...values) => {
    stdout += `${values.join(" ")}\n`;
  };
  console.error = (...values) => {
    stderr += `${values.join(" ")}\n`;
  };
  try {
    await fn();
    return { code: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.exitCode = previousExitCode;
    console.log = previousConsoleLog;
    console.error = previousConsoleError;
  }
}

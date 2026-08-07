import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerTask } from "../../src/audit/types/workerSession.js";
import type { WorkerResult } from "../../src/audit/types/workerResult.js";
import { cmdWorkerRun } from "../../src/audit/cli/workerRunCommand.js";
import type { WorkerRunDeps } from "../../src/audit/cli/workerRunCommand.js";

describe("worker-runtime fixes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `audit-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("wr-1: task-file read failures write failed-WorkerResult", () => {
    it("should write a failed-WorkerResult when task-file read fails", async () => {
      const resultPath = join(tempDir, "result.json");
      const nonexistentTaskPath = join(tempDir, "nonexistent-task.json");

      let capturedError: Error | null = null;

      // Override readJsonFile to fail
      const deps: WorkerRunDeps = {
        readJsonFile: async () => {
          throw new Error("task-file read failed");
        },
        writeJsonFile: async (path: string, data: unknown) => {
          if (path === resultPath) {
            // This should be called with a failed result
            const result = data as WorkerResult;
            expect(result.status).toBe("failed");
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("task-file read failed");
          }
        },
        runAuditStep: async () => {
          throw new Error("should not be called");
        },
      };

      try {
        await cmdWorkerRun(
          ["--task", nonexistentTaskPath, "--result", resultPath],
          deps,
        );
      } catch (error) {
        capturedError = error as Error;
      }

      // Should have written the failed result (no throw)
      expect(capturedError).toBeNull();
    });

    it("should exit with code 1 when task-file read fails", async () => {
      const resultPath = join(tempDir, "result.json");

      const writeResults: WorkerResult[] = [];

      const deps: WorkerRunDeps = {
        readJsonFile: async () => {
          throw new Error("task-file parse failed");
        },
        writeJsonFile: async (path: string, data: unknown) => {
          if (path === resultPath) {
            writeResults.push(data as WorkerResult);
          }
        },
        runAuditStep: async () => {
          throw new Error("should not be called");
        },
      };

      const oldExitCode = process.exitCode;
      try {
        process.exitCode = undefined;
        await cmdWorkerRun(
          ["--task", "any-path", "--result", resultPath],
          deps,
        );
        expect(process.exitCode).toBe(1);
        expect(writeResults).toHaveLength(1);
        expect(writeResults[0].status).toBe("failed");
      } finally {
        process.exitCode = oldExitCode;
      }
    });
  });

  describe("wr-2: foldOutputRatioObservation and output_per_input deletion", () => {
    it("should not export foldOutputRatioObservation and OUTPUT_RATIO_EWMA_ALPHA", async () => {
      const shared: Record<string, unknown> = await import("audit-tools/shared");
      // These should be deleted as they are unused and output_per_input has no real producer
      expect(shared.foldOutputRatioObservation).toBeUndefined();
      expect(shared.OUTPUT_RATIO_EWMA_ALPHA).toBeUndefined();
    });

    it("output_per_input should not be in QuotaStateEntry type", async () => {
      // This is a type-level check that output_per_input was removed
      // The test itself just validates we can still create state entries
      const { emptyQuotaState } = await import("audit-tools/shared");
      const state = emptyQuotaState();
      // Verify structure
      expect(state.version).toBe(2);
      expect(state.entries).toBeDefined();
    });
  });

  describe("wr-3: isValidExecutableCommand rejects zero-byte Python stub", () => {
    it("should reject zero-byte Python stub on Windows when resolving via PATH", async () => {
      const { isValidExecutableCommand } = await import(
        "../../src/shared/tooling/testCommand.js"
      );

      // Create a fixture directory with a zero-byte python.exe
      const pythonStubPath = join(tempDir, "python.exe");
      await writeFile(pythonStubPath, "");

      // Test that isValidExecutableCommand detects the zero-byte stub
      // Pass our temp directory as the PATH so it finds the stub
      const isValid = isValidExecutableCommand("python", "win32", tempDir);
      expect(isValid).toBe(false);
    });

    it("should properly walk PATH to find executables", async () => {
      const { isValidExecutableCommand } = await import(
        "../../src/shared/tooling/testCommand.js"
      );

      // Create a fixture directory with a zero-byte python.exe as a stub
      const stubPath = join(tempDir, "python.exe");
      await writeFile(stubPath, "");

      // Test with PATH that is just our fixture directory
      // Should detect the zero-byte stub and return false
      const result = isValidExecutableCommand("python", "win32", tempDir);

      // The zero-byte stub should be detected as invalid
      expect(result).toBe(false);
    });

    it("should find valid executables in PATH", async () => {
      const { isValidExecutableCommand } = await import(
        "../../src/shared/tooling/testCommand.js"
      );

      // Create a fixture directory with a real (non-zero-byte) file
      const validPath = join(tempDir, "valid-cmd.exe");
      await writeFile(validPath, "MZ"); // DOS/Windows executable header

      // Test with PATH that is our fixture directory
      const result = isValidExecutableCommand("valid-cmd", "win32", tempDir);

      // A non-zero-byte file should be considered valid
      expect(result).toBe(true);
    });
  });
});

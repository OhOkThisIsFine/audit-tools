import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { errorMessage } from "./io/json.js";
import { assertWithinRoot } from "./io/pathContainment.js";
import { formatSchemaFailure } from "./validation/schemaFailure.js";

export const SESSION_INTENT_RELATIVE_PATH =
  ".audit-tools/audit/session-config.json" as const;

export const SessionIntentV1Schema = z
  .object({
    review_mode: z.enum(["attended", "autonomous"]).default("attended"),
    observability: z.enum(["standard", "verbose"]).default("standard"),
  })
  .strict();

export type SessionIntentV1 = z.infer<typeof SessionIntentV1Schema>;

export type SessionIntentLoadResult =
  | { readonly status: "not_configured"; readonly intent: SessionIntentV1 }
  | { readonly status: "configured"; readonly intent: SessionIntentV1 };

function resolveIntentPath(repositoryRoot: string): string {
  if (!isAbsolute(repositoryRoot)) {
    throw new Error(
      `Repository root must be absolute: ${JSON.stringify(repositoryRoot)}`,
    );
  }
  return assertWithinRoot(repositoryRoot, SESSION_INTENT_RELATIVE_PATH, {
    allowRoot: false,
  });
}

function isMissingFileError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "ENOENT" } {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Load the one provider-neutral repository session intent.
 *
 * The supplied repository root is authoritative and must already be absolute.
 * Exactly one filesystem read is attempted. Only ENOENT is interpreted as an
 * absent configuration; every present-but-invalid or unreadable file fails
 * closed with the canonical path in the diagnostic.
 */
export async function loadSessionIntent(
  repositoryRoot: string,
): Promise<SessionIntentLoadResult> {
  const configPath = resolveIntentPath(repositoryRoot);

  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: "not_configured",
        intent: SessionIntentV1Schema.parse({}),
      };
    }
    throw new Error(
      `Unable to read ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${configPath}: malformed JSON (${errorMessage(error)})`,
      { cause: error },
    );
  }

  const validated = SessionIntentV1Schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Invalid ${configPath}: ${formatSchemaFailure(validated.error)}`,
      { cause: validated.error },
    );
  }

  return { status: "configured", intent: validated.data };
}

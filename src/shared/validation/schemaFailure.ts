import type { z } from "zod";

/**
 * The ONE rendering of a zod parse failure into a single-line message: each
 * issue as `<dotted path>: <message>`, joined by `; `, with `<root>` standing in
 * for an issue that carries no path. Single-sourced so two callers refusing the
 * same malformed document cannot describe it differently.
 */
export function formatSchemaFailure(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

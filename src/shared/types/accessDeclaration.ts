import { z } from "zod";

export const AccessDeclarationSchema = z
  .object({
    read_paths: z.array(z.string()),
    write_paths: z.array(z.string()),
    forbidden_patterns: z.array(z.string()).optional(),
  })
  .strict();
export type AccessDeclaration = z.infer<typeof AccessDeclarationSchema>;

import { z } from "zod";

export const FileDispositionStatusSchema = z.enum([
  "included",
  "excluded",
  "generated",
  "vendor",
  "binary",
  "doc_only",
]);
export type FileDispositionStatus = z.infer<typeof FileDispositionStatusSchema>;

export const FileDispositionItemSchema = z
  .object({
    path: z.string(),
    status: FileDispositionStatusSchema,
    reason: z.string().optional(),
  })
  .strict();
export type FileDispositionItem = z.infer<typeof FileDispositionItemSchema>;

export const FileDispositionSchema = z
  .object({
    files: z.array(FileDispositionItemSchema),
  })
  .strict();
export type FileDisposition = z.infer<typeof FileDispositionSchema>;

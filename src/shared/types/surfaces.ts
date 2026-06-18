import { z } from "zod";

export const SurfaceKindSchema = z.enum(["interface", "background"]);
export const SURFACE_KINDS = SurfaceKindSchema.options;
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

/** Discovered execution surfaces that define where the product can be reached. */
export const SurfaceRecordSchema = z
  .object({
    id: z.string(),
    kind: SurfaceKindSchema,
    entrypoint: z.string(),
    exposure: z.enum(["network", "local"]).optional(),
    methods: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type SurfaceRecord = z.infer<typeof SurfaceRecordSchema>;

/** Intake output that summarizes externally reachable product surfaces. */
export const SurfaceManifestSchema = z
  .object({
    surfaces: z.array(SurfaceRecordSchema),
  })
  .strict();
export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;

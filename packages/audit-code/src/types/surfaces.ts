export const SURFACE_KINDS = ["interface", "background"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Discovered execution surfaces that define where the product can be reached. */
export interface SurfaceRecord {
  id: string;
  kind: SurfaceKind;
  entrypoint: string;
  exposure?: string;
  methods?: string[];
  notes?: string[];
}

/** Intake output that summarizes externally reachable product surfaces. */
export interface SurfaceManifest {
  surfaces: SurfaceRecord[];
}

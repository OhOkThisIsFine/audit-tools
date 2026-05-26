export interface ToolingManifest {
  generated_at: string;
  package_root: string;
  package_version: string | null;
  implementation_hash: string;
  inputs: string[];
}

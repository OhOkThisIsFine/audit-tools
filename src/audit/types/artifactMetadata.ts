export interface ArtifactMetadataEntry {
  revision: number;
  content_hash: string;
  dependency_revisions: Record<string, number>;
}

export interface ArtifactMetadataManifest {
  artifacts: Record<string, ArtifactMetadataEntry>;
}

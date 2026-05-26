export type FileDispositionStatus =
  | "included"
  | "excluded"
  | "generated"
  | "vendor"
  | "binary"
  | "doc_only";

export interface FileDispositionItem {
  path: string;
  status: FileDispositionStatus;
  reason?: string;
}

export interface FileDisposition {
  files: FileDispositionItem[];
}

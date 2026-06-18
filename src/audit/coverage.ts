import type {
  ClassificationStatus,
  CoverageFileRecord,
  CoverageMatrix,
  FileCoverageRecord,
  Lens,
} from "./types.js";

function buildFileIndex(matrix: CoverageMatrix): Map<string, CoverageFileRecord> {
  return new Map(matrix.files.map((f) => [f.path, f]));
}

export function createCoverageMatrix(paths: string[]): CoverageMatrix {
  return {
    files: paths.map((path) => ({
      path,
      unit_ids: [],
      classification_status: "unclassified",
      audit_status: "pending",
      required_lenses: [],
      completed_lenses: [],
    })),
  };
}

export function markExcludedPath(
  matrix: CoverageMatrix,
  path: string,
  classificationStatus: ClassificationStatus,
): void {
  const record = matrix.files.find((f) => f.path === path);
  if (!record) return;

  record.classification_status = classificationStatus;
  record.audit_status = "excluded";
  record.required_lenses = [];
  record.completed_lenses = [];
  record.unit_ids = [];
}

export function applyUnitCoverage(
  matrix: CoverageMatrix,
  path: string,
  unitId: string,
  requiredLenses: string[],
): void {
  const record = matrix.files.find((f) => f.path === path);
  if (!record || record.audit_status === "excluded") return;

  if (!record.unit_ids.includes(unitId)) {
    record.unit_ids.push(unitId);
  }

  record.classification_status = "classified";
  record.required_lenses = [
    ...new Set([...record.required_lenses, ...requiredLenses]),
  ];
}

export function applyFileCoverage(
  matrix: CoverageMatrix,
  fileCoverage: FileCoverageRecord[],
): void {
  const index = buildFileIndex(matrix);
  for (const coverage of fileCoverage) {
    const record = index.get(coverage.path);
    if (!record || record.audit_status === "excluded") continue;

    if (
      coverage.lens &&
      record.required_lenses.includes(coverage.lens) &&
      !record.completed_lenses.includes(coverage.lens)
    ) {
      record.completed_lenses.push(coverage.lens);
    }
  }

  for (const file of matrix.files) {
    if (file.audit_status === "excluded") continue;
    const hasAllRequired = file.required_lenses.every((lens) =>
      file.completed_lenses.includes(lens),
    );
    if (hasAllRequired && file.required_lenses.length > 0) {
      file.audit_status = "complete";
    } else if (file.completed_lenses.length > 0) {
      file.audit_status = "partial";
    }
  }
}

export function findUncoveredFiles(
  matrix: CoverageMatrix,
): CoverageFileRecord[] {
  return matrix.files.filter((file) => {
    if (file.audit_status === "excluded") return false;
    return file.audit_status !== "complete";
  });
}

export function buildRequeueTargets(matrix: CoverageMatrix): Array<{
  path: string;
  missing_lenses: string[];
}> {
  return matrix.files
    .filter((file) => file.audit_status !== "excluded")
    .map((file) => ({
      path: file.path,
      missing_lenses: file.required_lenses.filter(
        (lens) => !file.completed_lenses.includes(lens),
      ),
    }))
    .filter((item) => item.missing_lenses.length > 0);
}

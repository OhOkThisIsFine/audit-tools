import {
  applyUnitCoverage,
  createCoverageMatrix,
  markExcludedPath,
} from "../coverage.js";
import type {
  CoverageMatrix,
  Lens,
  RepoManifest,
  UnitManifest,
} from "../types.js";
import type { FileDisposition } from "audit-tools/shared";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { isAuditExcludedStatus } from "../extractors/disposition.js";
import { hasBrowserExtensionManifestFile } from "../extractors/browserExtension.js";
import { deriveRequiredLensesForPath } from "./unitBuilder.js";

type LensMapping = [keywords: string[], lenses: Lens[]];

const CATEGORY_LENS_TABLE: LensMapping[] = [
  [["security", "secret"], ["security", "correctness"]],
  [["dependency", "vuln"], ["security", "config_deployment"]],
  [["tests", "coverage"], ["tests"]],
  [["data"], ["data_integrity", "correctness"]],
  [["reliability", "concurrency"], ["reliability", "correctness"]],
  [["maintainability", "lint", "style"], ["maintainability"]],
];

function analyzerCategoryToLenses(category: string): Lens[] {
  const normalized = category.toLowerCase();
  for (const [keywords, lenses] of CATEGORY_LENS_TABLE) {
    if (keywords.some((kw) => normalized.includes(kw))) {
      return lenses;
    }
  }
  return ["correctness"];
}

function applyAnalyzerCoverage(
  coverage: CoverageMatrix,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): void {
  if (!externalAnalyzerResults || externalAnalyzerResults.length === 0) {
    return;
  }

  const coverageByPath = new Map(
    coverage.files.map((file) => [file.path, file]),
  );

  const results = externalAnalyzerResults.flatMap((tool) =>
    Array.isArray(tool.results) ? tool.results : [],
  );
  for (const result of results) {
    if (
      !result ||
      typeof result.path !== "string" ||
      typeof result.category !== "string"
    ) {
      continue;
    }
    const record = coverageByPath.get(result.path);
    if (!record || record.audit_status === "excluded") {
      continue;
    }

    const extraLenses = analyzerCategoryToLenses(result.category);
    record.required_lenses = [
      ...new Set([...record.required_lenses, ...extraLenses]),
    ];
    if (record.classification_status === "unclassified") {
      record.classification_status = "classified";
    }
  }
}

export function initializeCoverageFromPlan(
  repoManifest: RepoManifest,
  unitManifest: UnitManifest,
  disposition: FileDisposition,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): CoverageMatrix {
  const coverage = createCoverageMatrix(
    repoManifest.files.map((file) => file.path),
  );
  const isBrowserExtensionProject = hasBrowserExtensionManifestFile(repoManifest);
  const dispositionMap = new Map(
    disposition.files.map((item) => [item.path, item.status]),
  );

  for (const file of repoManifest.files) {
    const status = dispositionMap.get(file.path);
    if (status && isAuditExcludedStatus(status)) {
      markExcludedPath(coverage, file.path, status);
    }
  }

  const unitIdsByPath = new Map<string, string[]>();
  for (const unit of unitManifest.units) {
    for (const path of unit.files) {
      const existing = unitIdsByPath.get(path) ?? [];
      if (!existing.includes(unit.unit_id)) {
        existing.push(unit.unit_id);
      }
      unitIdsByPath.set(path, existing);
    }
  }

  for (const file of repoManifest.files) {
    const unitIds = unitIdsByPath.get(file.path) ?? [];
    const requiredLenses = deriveRequiredLensesForPath(file.path, {
      isBrowserExtensionProject,
    });

    for (const unitId of unitIds) {
      applyUnitCoverage(coverage, file.path, unitId, requiredLenses);
    }
  }

  applyAnalyzerCoverage(coverage, externalAnalyzerResults);
  return coverage;
}

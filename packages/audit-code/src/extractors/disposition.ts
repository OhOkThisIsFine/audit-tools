import type { RepoManifest } from "../types.js";
import type {
  FileDisposition,
  FileDispositionItem,
  FileDispositionStatus,
} from "../types/disposition.js";
import {
  isNodeModulesOrGit,
  isBuildOutput,
  isVendorPath,
  isBinaryArtifact,
  isLicensePath,
  isLockfilePath,
  isLogPath,
  isDocPath,
  isGeneratedPath,
  isAuditArtifactPath,
  isGeneratedTestArtifactPath,
  isGeneratedInstallArtifactPath,
  isExamplesOrFixturesPath,
  normalizeExtractorPath,
} from "./pathPatterns.js";

function inferDisposition(path: string): FileDispositionItem {
  const normalized = normalizeExtractorPath(path);

  if (isNodeModulesOrGit(normalized)) {
    return { path, status: "excluded", reason: "node_modules or .git excluded by convention." };
  }
  if (isBuildOutput(normalized)) {
    return { path, status: "generated", reason: "Build output path." };
  }
  if (isVendorPath(normalized)) {
    return { path, status: "vendor", reason: "Vendor or third-party path." };
  }
  if (isBinaryArtifact(normalized)) {
    return {
      path,
      status: "binary",
      reason: "Non-source binary-like artifact.",
    };
  }
  if (isLogPath(normalized)) {
    return { path, status: "generated", reason: "Runtime log artifact." };
  }
  if (isLicensePath(normalized)) {
    return { path, status: "doc_only", reason: "License file is not auditable code." };
  }
  if (isLockfilePath(normalized)) {
    return { path, status: "generated", reason: "Lockfile excluded from code audit scope." };
  }
  if (isAuditArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated audit artifact.",
    };
  }
  if (isGeneratedPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated artifact path.",
    };
  }
  if (isGeneratedTestArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated test artifact.",
    };
  }
  if (isDocPath(normalized)) {
    return { path, status: "doc_only", reason: "Documentation artifact." };
  }
  if (isGeneratedInstallArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated install/bootstrap artifact.",
    };
  }
  if (isExamplesOrFixturesPath(normalized)) {
    return { path, status: "doc_only", reason: "Examples and fixtures are support artifacts, not auditable code." };
  }

  return {
    path,
    status: "included",
    reason: "Default included source or config artifact.",
  };
}

/**
 * Applies shared path heuristics to mark files that should be excluded or
 * down-scoped before audit planning begins.
 */
export function buildFileDisposition(
  repoManifest: RepoManifest,
): FileDisposition {
  return {
    files: repoManifest.files.map((file) => inferDisposition(file.path)),
  };
}

export function isAuditExcludedStatus(status: FileDispositionStatus): boolean {
  return (
    status === "excluded" ||
    status === "generated" ||
    status === "vendor" ||
    status === "binary" ||
    status === "doc_only"
  );
}

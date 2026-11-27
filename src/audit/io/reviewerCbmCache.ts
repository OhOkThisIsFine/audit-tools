import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hashContent } from "audit-tools/shared";

/** CBM validates the full ancestry of its Windows coordination endpoint. Keep
 * its runtime and index together under the user profile, not under shared
 * Windows Temp. The absolute artifacts directory binds the cache to one run
 * workspace without letting an artifact or graph manifest choose its path. */
export function reviewerCbmCacheDirectory(artifactsDir: string): string {
  if (process.platform !== "win32") return join(artifactsDir, "review-cbm");
  return join(homedir(), ".audit-tools", "review-cbm", hashContent(resolve(artifactsDir).toLowerCase()));
}

export async function removeWindowsReviewerCbmCache(artifactsDir: string): Promise<void> {
  if (process.platform === "win32") {
    await rm(reviewerCbmCacheDirectory(artifactsDir), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

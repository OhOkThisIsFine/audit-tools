// sites-pinned: tests/review-evidence.test.mjs
import { realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashContent, isFileMissingError } from "audit-tools/shared";

/** CBM validates the full ancestry of its Windows coordination endpoint. Keep
 * its runtime and index together under the user profile, not under shared
 * Windows Temp. The absolute artifacts directory binds the cache to one run
 * workspace without letting an artifact or graph manifest choose its path. */
export async function reviewerCbmCacheDirectory(artifactsDir: string): Promise<string> {
  if (process.platform !== "win32") return join(artifactsDir, "review-cbm");
  return join(homedir(), ".audit-tools", "review-cbm", hashContent(await realpath(artifactsDir)));
}

export async function removeWindowsReviewerCbmCache(artifactsDir: string): Promise<void> {
  if (process.platform === "win32") {
    // With no workspace, there is no canonical path to authorize removal.
    const cache = await reviewerCbmCacheDirectory(artifactsDir).catch(error => {
      if (!isFileMissingError(error)) throw error;
    });
    if (cache) await rm(cache, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

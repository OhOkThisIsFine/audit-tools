// sites-pinned: tests/audit/submission-staging.test.ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError } from "../../shared/io/json.js";

export const foldReceiptPath = (root: string): string => join(root, ".fold-receipt.json");

export async function hasPendingFoldReceipt(root: string): Promise<boolean> {
  try {
    await stat(foldReceiptPath(root));
    return true;
  } catch (error) {
    if (isFileMissingError(error)) return false;
    throw error;
  }
}

export async function assertNoPendingFoldReceipt(root: string): Promise<void> {
  if (await hasPendingFoldReceipt(root)) {
    throw new Error("The audit has an incomplete fold receipt. Run next-step to recover it first.");
  }
}

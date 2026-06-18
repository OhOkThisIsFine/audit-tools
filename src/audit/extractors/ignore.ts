import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function loadIgnoreFile(
  root: string,
  fileName = ".auditorignore",
): Promise<string[]> {
  const path = join(root, fileName);
  try {
    await access(path, constants.F_OK);
  } catch {
    return [];
  }

  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

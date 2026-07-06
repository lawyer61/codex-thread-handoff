import { readFile } from "node:fs/promises";
import { join } from "node:path";

function matchesPattern(path, pattern) {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
  return path === pattern || path.startsWith(`${pattern}/`);
}

export async function loadThreadHandoffIgnore(repoRoot) {
  let patterns = [];

  try {
    patterns = (await readFile(join(repoRoot, ".threadhandoffignore"), "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    patterns = [];
  }

  return (path) => patterns.some((pattern) => matchesPattern(path, pattern));
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const GITIGNORE_ENTRIES = [
  ".codex/thread-memory/",
  ".handoffs/",
  ".thread-handoff/"
];

export async function ensureProjectLocalIgnored(repoRoot) {
  const gitignorePath = join(repoRoot, ".gitignore");
  let existing = "";

  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    existing = "";
  }

  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return;

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const block = `${prefix}${existing.includes("# codex-thread-handoff") ? "" : "# codex-thread-handoff\n"}${missing.join("\n")}\n`;
  await mkdir(dirname(gitignorePath), { recursive: true });
  await writeFile(gitignorePath, `${existing}${block}`, { mode: 0o600 });
}

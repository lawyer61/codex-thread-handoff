import { createHash } from "node:crypto";
import { join } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveProjectPaths(input = {}, config = {}, env = {}) {
  const repoRoot = input.cwd || env.PWD || process.cwd();
  const storageRoot = config.projectLocal
    ? join(repoRoot, ".codex", "thread-memory")
    : join(env.PLUGIN_DATA || join(process.cwd(), ".thread-handoff-data"), "codex-thread-handoff");
  const projectHash = input.project_hash_override ||
    sha256(`${repoRoot}\n${input.git_remote || ""}`).slice(0, 16);
  const projectDir = join(storageRoot, "projects", projectHash);
  const activeThreadPath = join(projectDir, "active_thread");

  return {
    storageRoot,
    projectLocal: Boolean(config.projectLocal),
    projectHash,
    repoRoot,
    projectDir,
    activeThreadPath,
    threadDirFor: (logicalThreadId) => join(projectDir, "threads", logicalThreadId)
  };
}

export function attachThreadPaths(paths, logicalThreadId) {
  const threadDir = paths.threadDirFor(logicalThreadId);
  paths.threadDir = threadDir;
  paths.statePath = join(threadDir, "state.json");
  paths.latestPath = join(threadDir, "latest.md");
  paths.injectPath = join(threadDir, "latest.inject.md");
  paths.eventsPath = join(threadDir, "events.jsonl");
  paths.snapshotsDir = join(threadDir, "snapshots");
  return paths;
}

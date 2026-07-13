import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveProjectPaths(input = {}, config = {}, env = {}) {
  const repoRoot = input.cwd || env.PWD || process.cwd();
  const storageRoot = config.projectLocal
    ? projectLocalStorageRoot(repoRoot)
    : join(env.PLUGIN_DATA || join(process.cwd(), ".thread-handoff-data"), "codex-thread-handoff");
  const projectHash = input.project_hash_override ||
    sha256(`${repoRoot}\n${input.git_remote || ""}`).slice(0, 16);
  const projectDir = join(storageRoot, "projects", projectHash);
  const activeThreadPath = join(projectDir, "active_thread");
  const threadsDir = join(projectDir, "threads");
  const sessionsDir = join(projectDir, "sessions");

  return {
    storageRoot,
    projectLocal: Boolean(config.projectLocal),
    projectHash,
    repoRoot,
    projectDir,
    activeThreadPath,
    threadsDir,
    sessionsDir,
    threadRoutingLockPath: join(projectDir, "thread-routing.lock"),
    sessionBindingPathFor: (sessionId) => join(sessionsDir, `${sha256(String(sessionId))}.json`),
    threadDirFor: (logicalThreadId) => join(threadsDir, logicalThreadId)
  };
}

function projectLocalStorageRoot(repoRoot) {
  const dotCodex = join(repoRoot, ".codex");

  try {
    if (!statSync(dotCodex).isDirectory()) {
      return join(repoRoot, ".thread-handoff");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      return join(repoRoot, ".thread-handoff");
    }
  }

  return join(dotCodex, "thread-memory");
}

export function attachThreadPaths(paths, logicalThreadId) {
  const threadDir = paths.threadDirFor(logicalThreadId);
  paths.logicalThreadId = logicalThreadId;
  paths.threadDir = threadDir;
  paths.statePath = join(threadDir, "state.json");
  paths.latestPath = join(threadDir, "latest.md");
  paths.injectPath = join(threadDir, "latest.inject.md");
  paths.eventsPath = join(threadDir, "events.jsonl");
  paths.snapshotsDir = join(threadDir, "snapshots");
  return paths;
}

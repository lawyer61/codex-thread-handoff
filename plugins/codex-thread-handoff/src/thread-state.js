import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { attachThreadPaths } from "./paths.js";
import { writeJsonAtomic } from "./json-store.js";

function newLogicalThreadId() {
  const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `lt_${ymd}_${randomBytes(4).toString("hex")}`;
}

function sessionRecord(input, source) {
  return {
    session_id: input.session_id || input.codex_session_id || "unknown",
    source,
    transcript_path: input.transcript_path || null,
    started_at: new Date().toISOString()
  };
}

async function readActiveThread(paths) {
  try {
    const value = (await readFile(paths.activeThreadPath, "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function readState(paths, logicalThreadId) {
  attachThreadPaths(paths, logicalThreadId);
  try {
    return JSON.parse(await readFile(paths.statePath, "utf8"));
  } catch {
    return null;
  }
}

function createState(paths, logicalThreadId, input, source) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    logical_thread_id: logicalThreadId,
    project_hash: paths.projectHash,
    repo_root: paths.repoRoot,
    git_branch: input.git_branch || null,
    git_head: input.git_head || null,
    context_epoch: 1,
    created_at: now,
    last_updated_at: now,
    last_compacted_at: null,
    codex_sessions: [sessionRecord(input, source)],
    handoff: {
      latest_path: "latest.md",
      inject_path: "latest.inject.md",
      last_model_written_at: null,
      last_event_seq: 0,
      freshness: "missing"
    }
  };
}

export async function loadOrCreateThreadState(paths, input = {}, source = "startup") {
  await mkdir(paths.projectDir, { recursive: true, mode: 0o700 });

  const shouldCreate = source === "clear";
  const activeThreadId = shouldCreate ? null : await readActiveThread(paths);
  const logicalThreadId = activeThreadId || newLogicalThreadId();
  attachThreadPaths(paths, logicalThreadId);
  await mkdir(paths.threadDir, { recursive: true, mode: 0o700 });

  let state = shouldCreate ? null : await readState(paths, logicalThreadId);
  if (!state) {
    state = createState(paths, logicalThreadId, input, source);
  } else {
    state = {
      ...state,
      last_updated_at: new Date().toISOString(),
      codex_sessions: [
        ...(state.codex_sessions || []),
        sessionRecord(input, source)
      ]
    };
  }

  await writeFile(paths.activeThreadPath, `${logicalThreadId}\n`, { mode: 0o600 });
  await writeJsonAtomic(paths.statePath, state);
  return state;
}

export function advanceContextEpoch(state) {
  return {
    ...state,
    context_epoch: (state.context_epoch || 0) + 1,
    last_compacted_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString()
  };
}

export async function saveThreadState(paths, state) {
  await writeJsonAtomic(paths.statePath, state);
}

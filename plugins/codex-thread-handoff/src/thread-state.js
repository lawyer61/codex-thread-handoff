import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { attachThreadPaths } from "./paths.js";
import { writeJsonAtomic, writeTextAtomic } from "./json-store.js";
import { withLock } from "./lock.js";
import { ensureProjectLocalIgnored } from "./project-local.js";

function newLogicalThreadId() {
  const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `lt_${ymd}_${randomBytes(4).toString("hex")}`;
}

function sessionRecord(input, source) {
  return {
    session_id: sessionIdFromInput(input) || "unknown",
    source,
    transcript_path: input.transcript_path || null,
    started_at: new Date().toISOString()
  };
}

function sessionIdFromInput(input) {
  const value = input.session_id || input.codex_session_id;
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function withSessionRecord(state, input, source) {
  const nextRecord = sessionRecord(input, source);
  const existing = state.codex_sessions || [];
  if (existing.some((record) => record.session_id === nextRecord.session_id)) {
    return existing;
  }
  return [...existing, nextRecord];
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
  try {
    return JSON.parse(await readFile(join(paths.threadDirFor(logicalThreadId), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

async function readSessionBinding(paths, sessionId) {
  if (!sessionId) return null;
  try {
    const binding = JSON.parse(await readFile(paths.sessionBindingPathFor(sessionId), "utf8"));
    if (binding.session_id !== sessionId || typeof binding.logical_thread_id !== "string") {
      return null;
    }
    return binding;
  } catch {
    return null;
  }
}

async function readSessionBindings(paths) {
  let entries;
  try {
    entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const bindings = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const binding = JSON.parse(await readFile(join(paths.sessionsDir, entry.name), "utf8"));
      if (typeof binding.session_id === "string" && typeof binding.logical_thread_id === "string") {
        bindings.push(binding);
      }
    } catch {
      // Ignore invalid legacy or partially written binding files.
    }
  }
  return bindings;
}

function stateMatchesSession(state, sessionId, transcriptPath) {
  const records = Array.isArray(state?.codex_sessions) ? state.codex_sessions : [];
  if (sessionId && records.some((record) => record.session_id === sessionId)) {
    return true;
  }
  return Boolean(
    transcriptPath &&
    records.some((record) => record.transcript_path && record.transcript_path === transcriptPath)
  );
}

function stateIsLegacyUnbound(state) {
  const records = state?.codex_sessions;
  return !Array.isArray(records) || records.length === 0 || records.every((record) => (
    !record.session_id || record.session_id === "unknown"
  ));
}

function stateRecency(state) {
  const timestamp = state?.last_updated_at || state?.created_at || "";
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

async function findThreadForSession(paths, sessionId, transcriptPath) {
  if (!sessionId && !transcriptPath) return null;

  let entries;
  try {
    entries = await readdir(paths.threadsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readState(paths, entry.name);
    if (state && stateMatchesSession(state, sessionId, transcriptPath)) {
      matches.push({ logicalThreadId: entry.name, state });
    }
  }

  matches.sort((left, right) => stateRecency(right.state) - stateRecency(left.state));
  const bindings = await readSessionBindings(paths);
  return matches.find((match) => {
    const owners = bindings.filter((binding) => (
      binding.logical_thread_id === match.logicalThreadId && binding.session_id !== sessionId
    ));
    return owners.every((binding) => (
      transcriptPath && binding.transcript_path === transcriptPath
    ));
  }) || null;
}

async function resolveExistingThread(paths, input, source, sessionId) {
  if (source === "clear") return null;

  const binding = await readSessionBinding(paths, sessionId);
  if (binding) {
    const state = await readState(paths, binding.logical_thread_id);
    if (state) {
      return { logicalThreadId: binding.logical_thread_id, state, binding };
    }
  }

  const matched = await findThreadForSession(paths, sessionId, input.transcript_path || null);
  if (matched) return matched;

  const activeThreadId = await readActiveThread(paths);
  if (!activeThreadId) return null;
  const activeState = await readState(paths, activeThreadId);
  if (!activeState) return null;

  if (!sessionId || stateIsLegacyUnbound(activeState)) {
    return { logicalThreadId: activeThreadId, state: activeState };
  }

  return null;
}

async function writeSessionBinding(paths, sessionId, logicalThreadId, input, source, existing) {
  if (!sessionId) return;
  const now = new Date().toISOString();
  await writeJsonAtomic(paths.sessionBindingPathFor(sessionId), {
    schema_version: 1,
    session_id: sessionId,
    logical_thread_id: logicalThreadId,
    transcript_path: input.transcript_path || existing?.transcript_path || null,
    source,
    created_at: existing?.created_at || now,
    updated_at: now
  });
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
  if (paths.projectLocal) {
    await ensureProjectLocalIgnored(paths.repoRoot);
  }

  await mkdir(paths.projectDir, { recursive: true, mode: 0o700 });
  return withLock(paths.threadRoutingLockPath, async () => {
    const sessionId = sessionIdFromInput(input);
    const existing = await resolveExistingThread(paths, input, source, sessionId);
    const logicalThreadId = existing?.logicalThreadId || newLogicalThreadId();
    const createdThread = !existing;
    attachThreadPaths(paths, logicalThreadId);
    await mkdir(paths.threadDir, { recursive: true, mode: 0o700 });

    const state = existing?.state
      ? {
          ...existing.state,
          last_updated_at: new Date().toISOString(),
          codex_sessions: withSessionRecord(existing.state, input, source)
        }
      : createState(paths, logicalThreadId, input, source);

    await writeJsonAtomic(paths.statePath, state);
    await writeSessionBinding(paths, sessionId, logicalThreadId, input, source, existing?.binding);
    if (createdThread || !(await readActiveThread(paths))) {
      await writeTextAtomic(paths.activeThreadPath, `${logicalThreadId}\n`);
    }
    return state;
  });
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

export async function readThreadState(paths) {
  return JSON.parse(await readFile(paths.statePath, "utf8"));
}

export async function readThreadStateFor(paths, logicalThreadId) {
  attachThreadPaths(paths, logicalThreadId);
  return readThreadState(paths);
}

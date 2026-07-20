import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { resolveProjectPaths } from "../src/paths.js";
import {
  advanceContextEpoch,
  advanceContextEpochForInput,
  loadOrCreateThreadState,
  mergeHandoffState
} from "../src/thread-state.js";

test("config defaults match the ADR MVP", () => {
  const config = resolveConfig({});

  assert.equal(config.mode, "strict");
  assert.equal(config.injectBudgetTokens, 6000);
  assert.equal(config.projectLocal, false);
  assert.equal(config.useCtx, true);
  assert.equal(config.redactSecrets, true);
  assert.equal(config.injectOnResume, false);
  assert.equal(config.injectOnUserPrompt, false);
  assert.equal(config.injectOnSubagentStart, true);
  assert.equal(config.stopSummarizerEnabled, false);
  assert.equal(config.stopHookContinuation, false);
  assert.equal(config.summarizerProvider, "openai-compatible");
  assert.equal(config.summarizerModel, "gpt-5.4");
  assert.equal(config.summarizerApiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.summarizerContextTokens, 200000);
  assert.equal(config.precompactSummarizerTimeoutMs, 8000);
  assert.equal(config.summarizerReasoningEffort, "low");
  assert.equal(config.summarizerCodexReasoningEffort, "low");
  assert.deepEqual(config.summarizerExtraHeaderNames, []);
  assert.equal(config.transcriptTailBytes, 200000);
});

test("resume injection can be enabled by env", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_INJECT_ON_RESUME: "true"
  });

  assert.equal(config.injectOnResume, true);
});

test("user-prompt handoff injection can be enabled by env", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_INJECT_ON_USER_PROMPT: "true"
  });

  assert.equal(config.injectOnUserPrompt, true);
});

test("subagent-start handoff injection can be disabled by env", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_INJECT_ON_SUBAGENT_START: "false"
  });

  assert.equal(config.injectOnSubagentStart, false);
});

test("stop summarizer can be enabled by env", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED: "true"
  });

  assert.equal(config.stopSummarizerEnabled, true);
});

test("summarizer reasoning effort can be set to future values", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_SUMMARIZER_REASONING_EFFORT: "ultra"
  });

  assert.equal(config.summarizerReasoningEffort, "ultra");
  assert.equal(config.summarizerCodexReasoningEffort, "ultra");
});

test("codex-cli reasoning effort override wins over generic summarizer effort", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_SUMMARIZER_REASONING_EFFORT: "high",
    THREAD_HANDOFF_SUMMARIZER_CODEX_REASONING_EFFORT: "ultra"
  });

  assert.equal(config.summarizerReasoningEffort, "high");
  assert.equal(config.summarizerCodexReasoningEffort, "ultra");
});

test("summarizer extra header config exposes names but not values", () => {
  const config = resolveConfig({
    THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON: JSON.stringify({
      "X-Trace": "secret-static"
    }),
    THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON: JSON.stringify({
      "X-Tenant": "THREAD_HANDOFF_TEST_TENANT"
    }),
    THREAD_HANDOFF_TEST_TENANT: "secret-env"
  });

  assert.deepEqual(config.summarizerExtraHeaderNames, ["X-Tenant", "X-Trace"]);
  assert.equal(JSON.stringify(config).includes("secret-static"), false);
  assert.equal(JSON.stringify(config).includes("secret-env"), false);
});

function sessionBindingPath(paths, sessionId) {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(paths.projectDir, "sessions", `${digest}.json`);
}

test("logical thread id is durable per Codex session and distinct from session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-"));

  try {
    const env = { PLUGIN_DATA: root };
    const input = {
      session_id: "codex-session-1",
      cwd: "/repo/app",
      hook_event_name: "SessionStart",
      source: "startup"
    };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths(input, config, env);
    const first = await loadOrCreateThreadState(paths, input, "startup");
    const resumed = await loadOrCreateThreadState(paths, input, "resume");
    const other = await loadOrCreateThreadState(paths, {
      ...input,
      session_id: "codex-session-2"
    }, "startup");
    const resumedAfterOther = await loadOrCreateThreadState(paths, input, "resume");

    assert.match(first.logical_thread_id, /^lt_/);
    assert.notEqual(first.logical_thread_id, "codex-session-1");
    assert.equal(resumed.logical_thread_id, first.logical_thread_id);
    assert.notEqual(other.logical_thread_id, first.logical_thread_id);
    assert.equal(resumedAfterOther.logical_thread_id, first.logical_thread_id);
    assert.equal(
      (await readFile(paths.activeThreadPath, "utf8")).trim(),
      other.logical_thread_id
    );

    const advanced = advanceContextEpoch(resumed);
    assert.equal(advanced.context_epoch, resumed.context_epoch + 1);

    const stateJson = JSON.parse(await readFile(
      join(paths.threadDirFor(first.logical_thread_id), "state.json"),
      "utf8"
    ));
    assert.equal(stateJson.logical_thread_id, first.logical_thread_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thread-spawned agents share the root logical thread and keep execution lanes", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-agent-lanes-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const rootInput = {
      session_id: "shared-session",
      transcript_path: "/transcripts/root.jsonl",
      cwd: "/repo/app"
    };
    const paths = resolveProjectPaths(rootInput, config, env);
    const rootState = await loadOrCreateThreadState(paths, rootInput, "startup");
    const childState = await loadOrCreateThreadState(paths, {
      session_id: "shared-session",
      turn_id: "turn-child-1",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl",
      cwd: "/repo/app"
    }, "resume");

    assert.equal(childState.logical_thread_id, rootState.logical_thread_id);
    assert.equal(childState.agent_lanes?.length, 1);
    const [lane] = childState.agent_lanes;
    assert.equal(lane.agent_id, "agent-child-1");
    assert.equal(lane.agent_type, "worker");
    assert.equal(lane.transcript_path, "/transcripts/child-1.jsonl");
    assert.equal(lane.parent_transcript_path, null);
    assert.equal(lane.context_epoch, 1);
    assert.equal(lane.status, "active");
    assert.equal(typeof lane.started_at, "string");
    assert.equal(typeof lane.last_updated_at, "string");
    assert.equal(lane.completed_at, null);

    const binding = JSON.parse(await readFile(
      sessionBindingPath(paths, "shared-session"),
      "utf8"
    ));
    assert.equal(binding.transcript_path, "/transcripts/root.jsonl");
    assert.equal(childState.codex_sessions[0].transcript_path, "/transcripts/root.jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent child hooks retain every agent execution lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-concurrent-agent-lanes-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const rootInput = {
      session_id: "shared-session",
      transcript_path: "/transcripts/root.jsonl",
      cwd: "/repo/app"
    };
    const paths = resolveProjectPaths(rootInput, config, env);
    await loadOrCreateThreadState(paths, rootInput, "startup");

    await Promise.all(Array.from({ length: 12 }, (_, index) => loadOrCreateThreadState(
      resolveProjectPaths(rootInput, config, env),
      {
        session_id: "shared-session",
        turn_id: `turn-child-${index}`,
        agent_id: `agent-child-${index}`,
        agent_type: "worker",
        transcript_path: `/transcripts/child-${index}.jsonl`,
        cwd: "/repo/app"
      },
      "resume"
    )));

    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(state.agent_lanes.length, 12);
    assert.equal(new Set(state.agent_lanes.map((lane) => lane.agent_id)).size, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context epochs advance independently for the root and each child agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-agent-epochs-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const rootInput = {
      session_id: "shared-session",
      transcript_path: "/transcripts/root.jsonl",
      cwd: "/repo/app"
    };
    const paths = resolveProjectPaths(rootInput, config, env);
    await loadOrCreateThreadState(paths, rootInput, "startup");
    await loadOrCreateThreadState(paths, {
      ...rootInput,
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    }, "resume");

    const afterChildCompact = await advanceContextEpochForInput(paths, {
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    });
    assert.equal(afterChildCompact.context_epoch, 1);
    assert.equal(afterChildCompact.agent_lanes[0].context_epoch, 2);

    const afterRootCompact = await advanceContextEpochForInput(paths, rootInput);
    assert.equal(afterRootCompact.context_epoch, 2);
    assert.equal(afterRootCompact.agent_lanes[0].context_epoch, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff metadata updates preserve concurrently registered agent lanes", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-state-merge-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const rootInput = {
      session_id: "shared-session",
      transcript_path: "/transcripts/root.jsonl",
      cwd: "/repo/app"
    };
    const paths = resolveProjectPaths(rootInput, config, env);
    const staleRootState = await loadOrCreateThreadState(paths, rootInput, "startup");
    await loadOrCreateThreadState(paths, {
      ...rootInput,
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    }, "resume");

    const merged = await mergeHandoffState(paths, {
      ...staleRootState,
      handoff: {
        ...staleRootState.handoff,
        freshness: "fresh",
        last_event_seq: 9
      }
    });

    assert.equal(merged.handoff.freshness, "fresh");
    assert.equal(merged.handoff.last_event_seq, 9);
    assert.equal(merged.agent_lanes.length, 1);
    assert.equal(merged.agent_lanes[0].agent_id, "agent-child-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear only rebinds the current Codex session", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-clear-isolation-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths({ cwd: "/repo/app" }, config, env);
    const firstA = await loadOrCreateThreadState(paths, {
      session_id: "session-a",
      cwd: "/repo/app"
    }, "startup");
    const firstB = await loadOrCreateThreadState(paths, {
      session_id: "session-b",
      cwd: "/repo/app"
    }, "startup");
    const secondA = await loadOrCreateThreadState(paths, {
      session_id: "session-a",
      cwd: "/repo/app"
    }, "clear");
    const resumedB = await loadOrCreateThreadState(paths, {
      session_id: "session-b",
      cwd: "/repo/app"
    }, "resume");

    assert.notEqual(firstA.logical_thread_id, firstB.logical_thread_id);
    assert.notEqual(secondA.logical_thread_id, firstA.logical_thread_id);
    assert.notEqual(secondA.logical_thread_id, firstB.logical_thread_id);
    assert.equal(resumedB.logical_thread_id, firstB.logical_thread_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent first hooks create one logical thread per Codex session", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-concurrent-sessions-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const sessions = Array.from({ length: 12 }, (_, index) => `session-${index}`);
    const states = await Promise.all(sessions.map((sessionId) => {
      const input = { session_id: sessionId, cwd: "/repo/app" };
      const paths = resolveProjectPaths(input, config, env);
      return loadOrCreateThreadState(paths, input, "startup");
    }));

    assert.equal(new Set(states.map((state) => state.logical_thread_id)).size, sessions.length);
    const paths = resolveProjectPaths({ cwd: "/repo/app" }, config, env);
    assert.equal((await readdir(paths.sessionsDir)).length, sessions.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed Codex session with the same transcript keeps the logical thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-transcript-lineage-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths({ cwd: "/repo/app" }, config, env);
    const first = await loadOrCreateThreadState(paths, {
      session_id: "session-before-resume",
      transcript_path: "/transcripts/task.jsonl",
      cwd: "/repo/app"
    }, "startup");
    const resumed = await loadOrCreateThreadState(paths, {
      session_id: "session-after-resume",
      transcript_path: "/transcripts/task.jsonl",
      cwd: "/repo/app"
    }, "resume");

    assert.equal(resumed.logical_thread_id, first.logical_thread_id);
    assert.equal(resumed.codex_sessions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing session is migrated from active_thread to a session binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-migration-"));

  try {
    const env = { PLUGIN_DATA: root };
    const input = { session_id: "legacy-session", cwd: "/repo/app" };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths(input, config, env);
    const threadDir = paths.threadDirFor("lt_legacy");
    await mkdir(threadDir, { recursive: true });
    await writeFile(paths.activeThreadPath, "lt_legacy\n");
    await writeFile(join(threadDir, "state.json"), JSON.stringify({
      schema_version: 1,
      logical_thread_id: "lt_legacy",
      project_hash: paths.projectHash,
      repo_root: paths.repoRoot,
      context_epoch: 1,
      codex_sessions: [{
        session_id: "legacy-session",
        source: "startup",
        transcript_path: null,
        started_at: "2026-07-01T00:00:00.000Z"
      }],
      handoff: { freshness: "missing" }
    }));

    const state = await loadOrCreateThreadState(paths, input, "resume");
    const binding = JSON.parse(await readFile(sessionBindingPath(paths, "legacy-session"), "utf8"));

    assert.equal(state.logical_thread_id, "lt_legacy");
    assert.equal(binding.session_id, "legacy-session");
    assert.equal(binding.logical_thread_id, "lt_legacy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration does not bind unrelated legacy sessions back to one thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-migration-split-"));

  try {
    const env = { PLUGIN_DATA: root };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths({ cwd: "/repo/app" }, config, env);
    const threadDir = paths.threadDirFor("lt_shared_legacy");
    await mkdir(threadDir, { recursive: true });
    await writeFile(paths.activeThreadPath, "lt_shared_legacy\n");
    await writeFile(join(threadDir, "state.json"), JSON.stringify({
      schema_version: 1,
      logical_thread_id: "lt_shared_legacy",
      project_hash: paths.projectHash,
      repo_root: paths.repoRoot,
      context_epoch: 1,
      created_at: "2026-07-01T00:00:00.000Z",
      last_updated_at: "2026-07-01T00:00:00.000Z",
      codex_sessions: [
        { session_id: "legacy-a", transcript_path: "/transcripts/a.jsonl" },
        { session_id: "legacy-b", transcript_path: "/transcripts/b.jsonl" }
      ],
      handoff: { freshness: "missing" }
    }));

    const migratedA = await loadOrCreateThreadState(paths, {
      session_id: "legacy-a",
      transcript_path: "/transcripts/a.jsonl",
      cwd: "/repo/app"
    }, "resume");
    const migratedB = await loadOrCreateThreadState(paths, {
      session_id: "legacy-b",
      transcript_path: "/transcripts/b.jsonl",
      cwd: "/repo/app"
    }, "resume");

    assert.equal(migratedA.logical_thread_id, "lt_shared_legacy");
    assert.notEqual(migratedB.logical_thread_id, "lt_shared_legacy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated hooks from the same Codex session do not bloat state session history", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-dedupe-"));

  try {
    const env = { PLUGIN_DATA: root };
    const input = { session_id: "codex-session-1", cwd: "/repo/app" };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths(input, config, env);
    await loadOrCreateThreadState(paths, input, "startup");
    await loadOrCreateThreadState(paths, input, "resume");
    await loadOrCreateThreadState(paths, input, "resume");

    const stateJson = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(stateJson.codex_sessions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear starts a new logical thread unless configured otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-clear-"));

  try {
    const env = { PLUGIN_DATA: root };
    const input = { session_id: "s1", cwd: "/repo/app" };
    const config = resolveConfig(env);
    const paths = resolveProjectPaths(input, config, env);
    const first = await loadOrCreateThreadState(paths, input, "startup");
    const second = await loadOrCreateThreadState(paths, input, "clear");

    assert.notEqual(second.logical_thread_id, first.logical_thread_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

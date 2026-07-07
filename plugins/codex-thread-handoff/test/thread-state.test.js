import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { resolveProjectPaths } from "../src/paths.js";
import {
  advanceContextEpoch,
  loadOrCreateThreadState
} from "../src/thread-state.js";

test("config defaults match the ADR MVP", () => {
  const config = resolveConfig({});

  assert.equal(config.mode, "strict");
  assert.equal(config.injectBudgetTokens, 6000);
  assert.equal(config.projectLocal, false);
  assert.equal(config.useCtx, true);
  assert.equal(config.redactSecrets, true);
  assert.equal(config.stopHookContinuation, false);
  assert.equal(config.summarizerProvider, "openai-compatible");
  assert.equal(config.summarizerModel, "gpt-5.4");
  assert.equal(config.summarizerApiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.summarizerContextTokens, 200000);
  assert.equal(config.precompactSummarizerTimeoutMs, 8000);
  assert.equal(config.summarizerCodexReasoningEffort, "low");
  assert.equal(config.transcriptTailBytes, 200000);
});

test("logical thread id is durable and distinct from codex session id", async () => {
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
    const second = await loadOrCreateThreadState(paths, {
      ...input,
      session_id: "codex-session-2"
    }, "resume");

    assert.match(first.logical_thread_id, /^lt_/);
    assert.notEqual(first.logical_thread_id, "codex-session-1");
    assert.equal(second.logical_thread_id, first.logical_thread_id);

    const advanced = advanceContextEpoch(second);
    assert.equal(advanced.context_epoch, second.context_epoch + 1);

    const stateJson = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(stateJson.logical_thread_id, first.logical_thread_id);
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

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

async function seed(root) {
  const projectDir = join(root, "codex-thread-handoff", "projects", "preseed");
  const threadDir = join(projectDir, "threads", "lt_test");
  await mkdir(threadDir, { recursive: true });
  await writeFile(join(projectDir, "active_thread"), "lt_test\n");
  await writeFile(
    join(threadDir, "latest.inject.md"),
    "<THREAD_HANDOFF_MEMORY>parent handoff</THREAD_HANDOFF_MEMORY>\n"
  );
  await writeFile(join(threadDir, "state.json"), JSON.stringify({
    schema_version: 1,
    logical_thread_id: "lt_test",
    project_hash: "preseed",
    repo_root: "/repo",
    context_epoch: 3,
    codex_sessions: [{
      session_id: "shared-session",
      source: "startup",
      transcript_path: "/transcripts/root.jsonl",
      started_at: "2026-07-20T00:00:00.000Z"
    }],
    agent_lanes: [],
    handoff: { freshness: "fresh" }
  }));
  return threadDir;
}

test("plugin hooks register subagent lifecycle and multi-agent control tools", async () => {
  const hooks = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const matcher = new Set(hooks.hooks.PostToolUse[0].matcher.split("|"));

  assert.equal(hooks.hooks.SubagentStart[0].hooks[0].command.includes("subagent-start"), true);
  assert.equal(hooks.hooks.SubagentStop[0].hooks[0].command.includes("subagent-stop"), true);
  assert.equal(matcher.has("spawn_agent"), true);
  assert.equal(matcher.has("wait"), true);
  assert.equal(matcher.has("send_input"), true);
  assert.equal(matcher.has("resume_agent"), true);
  assert.equal(matcher.has("close_agent"), true);
});

test("SubagentStart records an execution lane and injects the bounded handoff by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-subagent-start-"));

  try {
    const threadDir = await seed(root);
    const result = await runCli(["subagent-start"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.match(output.hookSpecificOutput.additionalContext, /parent handoff/);

    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.context_epoch, 3);
    assert.equal(state.agent_lanes.length, 1);
    assert.equal(state.agent_lanes[0].agent_id, "agent-child-1");
    assert.equal(state.agent_lanes[0].context_epoch, 1);

    const events = (await readFile(join(threadDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events[0].type, "subagent_started");
    assert.equal(events[0].agent_id, "agent-child-1");
    assert.equal(events[0].context_epoch, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SubagentStart injection can be disabled without disabling lifecycle recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-subagent-start-disabled-"));

  try {
    const threadDir = await seed(root);
    const result = await runCli(["subagent-start"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_INJECT_ON_SUBAGENT_START: "false"
    });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(await readFile(join(threadDir, "events.jsonl"), "utf8"), /subagent_started/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SubagentStop records and redacts the child result without scheduling a summarizer", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-subagent-stop-"));

  try {
    const threadDir = await seed(root);
    await runCli(["subagent-start"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    }), { PLUGIN_DATA: root });

    const result = await runCli(["subagent-stop"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/root.jsonl",
      agent_transcript_path: "/transcripts/child-1.jsonl",
      last_assistant_message: "finished with token=abc123"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED: "true",
      OPENAI_API_KEY: "unused-test-key"
    });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});

    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.agent_lanes[0].status, "completed");
    assert.equal(state.agent_lanes[0].parent_transcript_path, "/transcripts/root.jsonl");
    assert.equal(state.agent_lanes[0].transcript_path, "/transcripts/child-1.jsonl");
    assert.equal(typeof state.agent_lanes[0].completed_at, "string");

    const events = await readFile(join(threadDir, "events.jsonl"), "utf8");
    assert.match(events, /subagent_completed/);
    assert.match(events, /finished with token=\[REDACTED:generic_secret\]/);
    assert.doesNotMatch(events, /summary_job_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child task wording cannot clear or rebind the shared root session", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-subagent-new-task-"));

  try {
    const threadDir = await seed(root);
    const result = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl",
      prompt: "new task: inspect the parser independently"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    const projectDir = join(root, "codex-thread-handoff", "projects", "preseed");
    const activeThread = (await readFile(join(projectDir, "active_thread"), "utf8")).trim();
    assert.equal(activeThread, "lt_test");
    assert.match(await readFile(join(threadDir, "events.jsonl"), "utf8"), /inspect the parser/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a follow-up child turn reactivates the existing execution lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-subagent-followup-"));

  try {
    const threadDir = await seed(root);
    const baseInput = {
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "shared-session",
      turn_id: "turn-child-1",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl"
    };
    await runCli(["subagent-start"], JSON.stringify({
      ...baseInput,
      hook_event_name: "SubagentStart"
    }), { PLUGIN_DATA: root });
    await runCli(["subagent-stop"], JSON.stringify({
      ...baseInput,
      hook_event_name: "SubagentStop",
      transcript_path: "/transcripts/root.jsonl",
      agent_transcript_path: "/transcripts/child-1.jsonl",
      last_assistant_message: "first child turn complete"
    }), { PLUGIN_DATA: root });

    await runCli(["user-prompt-submit"], JSON.stringify({
      ...baseInput,
      turn_id: "turn-child-2",
      hook_event_name: "UserPromptSubmit",
      prompt: "inspect one more file"
    }), { PLUGIN_DATA: root });

    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.agent_lanes.length, 1);
    assert.equal(state.agent_lanes[0].status, "active");
    assert.equal(state.agent_lanes[0].completed_at, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

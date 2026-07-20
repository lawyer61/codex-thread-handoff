import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordToolObservation, recordUserPrompt } from "../src/events.js";

test("recordUserPrompt appends a redacted user_prompt event", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-events-"));

  try {
    const paths = { threadDir: root, eventsPath: join(root, "events.jsonl") };
    const state = { logical_thread_id: "lt_test", context_epoch: 1 };
    const event = await recordUserPrompt(paths, state, {
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-child-1",
      agent_id: "agent-child-1",
      agent_type: "worker",
      transcript_path: "/transcripts/child-1.jsonl",
      prompt: "use token=abc123"
    }, { redactSecrets: true });

    assert.equal(event.type, "user_prompt");
    assert.equal(event.privacy.redacted, true);
    assert.equal(event.turn_id, "turn-child-1");
    assert.equal(event.agent_id, "agent-child-1");
    assert.equal(event.agent_type, "worker");
    assert.equal(event.transcript_path, "/transcripts/child-1.jsonl");

    const rows = (await readFile(paths.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(rows[0].prompt_summary, "use token=[REDACTED:generic_secret]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recordToolObservation stores summaries and touched files", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-tool-"));

  try {
    const paths = { threadDir: root, eventsPath: join(root, "events.jsonl") };
    const state = {
      logical_thread_id: "lt_test",
      context_epoch: 2,
      agent_lanes: [{ agent_id: "agent-child-2", context_epoch: 4 }]
    };
    const event = await recordToolObservation(paths, state, {
      hook_event_name: "PostToolUse",
      turn_id: "turn-child-2",
      agent_id: "agent-child-2",
      agent_type: "reviewer",
      transcript_path: "/transcripts/child-2.jsonl",
      tool_name: "Bash",
      tool_use_id: "tool-use-2",
      tool_input: { command: "npm test -- parser" },
      tool_response: { exit_code: 1, output: "3 failing parser tests" },
      files_touched: ["src/parser.js", "test/parser.test.js"]
    }, { redactSecrets: true });

    assert.equal(event.type, "tool_observation");
    assert.equal(event.tool, "Bash");
    assert.equal(event.turn_id, "turn-child-2");
    assert.equal(event.agent_id, "agent-child-2");
    assert.equal(event.agent_type, "reviewer");
    assert.equal(event.transcript_path, "/transcripts/child-2.jsonl");
    assert.equal(event.tool_use_id, "tool-use-2");
    assert.equal(event.context_epoch, 4);
    assert.deepEqual(event.files_touched, ["src/parser.js", "test/parser.test.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent event writes allocate unique monotonic sequence numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-event-seq-"));

  try {
    const paths = { threadDir: root, eventsPath: join(root, "events.jsonl") };
    const state = { logical_thread_id: "lt_test", context_epoch: 1 };

    await Promise.all(Array.from({ length: 40 }, (_, index) => recordToolObservation(
      paths,
      state,
      {
        hook_event_name: "PostToolUse",
        turn_id: `turn-${index}`,
        agent_id: `agent-${index % 2}`,
        agent_type: "worker",
        tool_name: "Bash",
        tool_use_id: `tool-${index}`,
        tool_input: { command: `printf ${index}` },
        tool_response: { output: `ok ${index}` }
      },
      { redactSecrets: true }
    )));

    const rows = (await readFile(paths.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const sequences = rows.map((row) => row.seq);

    assert.equal(rows.length, 40);
    assert.equal(new Set(sequences).size, 40);
    assert.deepEqual([...sequences].sort((left, right) => left - right),
      Array.from({ length: 40 }, (_, index) => index + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

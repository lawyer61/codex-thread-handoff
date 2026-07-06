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
      prompt: "use token=abc123"
    }, { redactSecrets: true });

    assert.equal(event.type, "user_prompt");
    assert.equal(event.privacy.redacted, true);

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
    const state = { logical_thread_id: "lt_test", context_epoch: 2 };
    const event = await recordToolObservation(paths, state, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test -- parser" },
      tool_response: { exit_code: 1, output: "3 failing parser tests" },
      files_touched: ["src/parser.js", "test/parser.test.js"]
    }, { redactSecrets: true });

    assert.equal(event.type, "tool_observation");
    assert.equal(event.tool, "Bash");
    assert.deepEqual(event.files_touched, ["src/parser.js", "test/parser.test.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

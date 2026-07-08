import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

async function seedHandoff(root) {
  const projectDir = join(root, "codex-thread-handoff", "projects", "preseed");
  const threadDir = join(projectDir, "threads", "lt_test");
  await mkdir(threadDir, { recursive: true });
  await writeFile(join(projectDir, "active_thread"), "lt_test\n");
  await writeFile(
    join(threadDir, "latest.inject.md"),
    "<THREAD_HANDOFF_MEMORY>ready</THREAD_HANDOFF_MEMORY>\n"
  );
  await writeFile(join(threadDir, "state.json"), JSON.stringify({
    schema_version: 1,
    logical_thread_id: "lt_test",
    project_hash: "preseed",
    repo_root: "/repo",
    context_epoch: 1,
    handoff: { freshness: "fresh" }
  }));
}

test("UserPromptSubmit records continue prompts but does not inject by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-user-prompt-default-"));

  try {
    await seedHandoff(root);

    const result = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const events = await readFile(
      join(root, "codex-thread-handoff", "projects", "preseed", "threads", "lt_test", "events.jsonl"),
      "utf8"
    );
    assert.match(events, /user_prompt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit injects continue prompts when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-user-prompt-enabled-"));

  try {
    await seedHandoff(root);

    const result = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_INJECT_ON_USER_PROMPT: "true"
    });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /THREAD_HANDOFF_MEMORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

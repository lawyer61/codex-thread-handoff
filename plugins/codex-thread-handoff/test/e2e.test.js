import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("captures prompt, captures tool result, and allows permissive compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-e2e-"));

  try {
    const env = { PLUGIN_DATA: root, THREAD_HANDOFF_MODE: "permissive" };
    const prompt = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), env);
    assert.equal(prompt.code, 0);

    const tool = await runCli(["post-tool-use"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      tool_name: "Bash",
      tool_input: { command: "npm test -- parser" },
      tool_response: { exit_code: 0, output: "parser tests passed" },
      files_touched: ["src/parser.js"]
    }), env);
    assert.equal(tool.code, 0);

    const compact = await runCli(["pre-compact"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      trigger: "manual"
    }), env);
    assert.equal(JSON.parse(compact.stdout).continue, true);

    const projectRoot = join(root, "codex-thread-handoff", "projects");
    const [projectHash] = await readdir(projectRoot);
    const activeThread = (await readFile(join(projectRoot, projectHash, "active_thread"), "utf8")).trim();
    const events = await readFile(join(projectRoot, projectHash, "threads", activeThread, "events.jsonl"), "utf8");
    assert.match(events, /user_prompt/);
    assert.match(events, /tool_observation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

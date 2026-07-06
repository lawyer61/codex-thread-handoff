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

test("off mode does not create thread state from hook traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-off-"));

  try {
    const result = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_MODE: "off"
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "{}\n");
    await assert.rejects(() => readdir(join(root, "codex-thread-handoff", "projects")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new task language starts a new logical thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-new-task-"));

  try {
    const env = { PLUGIN_DATA: root };
    await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), env);

    const projectRoot = join(root, "codex-thread-handoff", "projects");
    const [projectHash] = await readdir(projectRoot);
    const projectDir = join(projectRoot, projectHash);
    const firstThread = (await readFile(join(projectDir, "active_thread"), "utf8")).trim();

    await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: "/repo",
      session_id: "session-1",
      prompt: "新任务：不要沿用之前，重新开始"
    }), env);

    const secondThread = (await readFile(join(projectDir, "active_thread"), "utf8")).trim();
    assert.notEqual(secondThread, firstThread);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project-local mode writes storage under repo and protects it with gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-project-local-"));

  try {
    const result = await runCli(["user-prompt-submit"], JSON.stringify({
      cwd: root,
      session_id: "session-1",
      prompt: "continue the parser fix"
    }), {
      THREAD_HANDOFF_PROJECT_LOCAL: "true"
    });

    assert.equal(result.code, 0);
    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignored, /\.codex\/thread-memory\//);
    assert.ok((await readdir(join(root, ".codex", "thread-memory", "projects"))).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

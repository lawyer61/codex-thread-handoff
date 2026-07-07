import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("SessionStart compact injects latest.inject.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-"));

  try {
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

    const result = await runCli(["session-start"], JSON.stringify({
      source: "compact",
      cwd: "/repo",
      project_hash_override: "preseed"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /THREAD_HANDOFF_MEMORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStart resume does not inject by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-resume-default-"));

  try {
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

    const result = await runCli(["session-start"], JSON.stringify({
      source: "resume",
      cwd: "/repo",
      project_hash_override: "preseed"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStart resume injects when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-session-resume-enabled-"));

  try {
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

    const result = await runCli(["session-start"], JSON.stringify({
      source: "resume",
      cwd: "/repo",
      project_hash_override: "preseed"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_INJECT_ON_RESUME: "true"
    });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /THREAD_HANDOFF_MEMORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
